import { mkdirSync } from 'fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'ground-shots';
const label = process.argv[3] || 'new';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
    headless: false,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-gpu-watchdog', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const logs = [];
page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || /WebGPU|shader|Shader|validation/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 600)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => {
    const pinned = { v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: 'high', adaptiveResolution: false, editMode: true };
    localStorage.setItem('canonical-editor/prefs', JSON.stringify(pinned));
});
await page.goto('http://localhost:8101/');
await page.waitForFunction(() => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'), null, { polling: 200, timeout: 240_000 });
await page.evaluate(() => document.querySelector('.start-screen:not([hidden]) .start-close')?.click());

const ids = await page.evaluate(async () => {
    const ed = window.__editor;
    const catalogUrl = new URL('library/catalog.json', document.baseURI).href;
    const catalog = await (await fetch(catalogUrl)).json();
    const item = (id) => {
        const it = catalog.items.find((i) => i.id === id);
        if (!it) throw new Error(`${id} is not in the Library`);
        const abs = (p) => new URL(p, catalogUrl).href;
        const maps = it.maps ?? {};
        return { ...it, url: abs(it.file), mapUrls: Object.fromEntries(Object.entries(maps).map(([k, v]) => [k, abs(v)])), catalog: catalogUrl };
    };
    const terrain = await ed.createTerrain({ shape: 'island', size: [160, 160], height: 22, resolution: 257, waterLevel: 0, seed: 7, at: [0, 0, 0] });
    // Four slots, then the terrain's layers follow them.
    const slots = { dirt: 'm_dirt', sand: 'm_sand', stones: 'm_stones', rock: 'm_rock' };
    ed.store.commit('Slots', (d) => {
        for (const [name, id] of Object.entries(slots)) d.design.materials.push({ id, name, description: '', swatch: null, color: '#ffffff', roughness: 0.9, metallic: 0, tile: 2 });
        const t = d.nodes.find((n) => n.id === terrain).terrain;
        const layer = (slot, height, slope, heightBlend = 1, slopeBlend = 6, debris = 0, grass = 1) => ({ slot, albedo: null, normal: null, arm: null, heightMap: null, tile: 2, color: '#ffffff', roughness: 1, height, slope, heightBlend, slopeBlend, onlyPainted: false, debris, grass });
        t.layers = [layer(slots.dirt, [-1e4, 1e4], [0, 90], 1, 6, 0.15), layer(slots.sand, [-1e4, 1.4], [0, 25], 0.8, 6, 0, 0.05), layer(slots.stones, [1, 1e4], [10, 34], 1, 6, 0.6, 0.5), layer(slots.rock, [-1e4, 1e4], [34, 90], 1, 6, 0, 0)];
    });
    await ed.addLibraryMaterial(item('polyhaven/brown-mud-leaves-01'), slots.dirt);
    await ed.addLibraryMaterial(item('polyhaven/sandstone-cracks'), slots.sand);
    await ed.addLibraryMaterial(item('polyhaven/forest-ground-04'), slots.stones);
    await ed.addLibraryMaterial(item('polyhaven/rock-face-03'), slots.rock);
    const water = ed.createWater();
    ed.store.commit('Place water', (d) => {
        const w = d.nodes.find((n) => n.id === water);
        w.position = [0, 0, 0];
        w.mesh.geometry = { ...w.mesh.geometry, width: 600, height: 600 };
    });
    // Rocks in clusters on the stones layer.
    const rock = await ed.addFromLibrary(item('polyhaven/rock-moss-set-01'), { place: false });
    const scatter = ed.createScatter({
        sources: [{ model: rock.asset.id, weight: 1, scale: [0.6, 1.6], solid: 'box' }],
        size: [160, 160], count: 260, seed: 3, spacing: 1.2, ground: terrain, height: [0.5, 1e4], slope: [0, 40], avoid: [], margin: 1,
        align: 0.7, sink: 0.05, bury: 0.6, tilt: 25, clusters: 0.8, clusterSize: 18, layer: 3, distance: 0, castShadow: true, soil: 0.4, moss: 0.35, mossColor: '#55602f', vary: 0.4,
    }, { name: 'Rocks', at: [0, 0, 0] });
    // Rain over part of the beach: wet ground and puddles.
    const rain = ed.createRain();
    ed.store.commit('Place rain', (d) => {
        const r = d.nodes.find((n) => n.id === rain);
        r.position = [55, 6, 0];
        r.rain.size = [24, 12, 24];
    });
    // Ferns swaying in the wind on the grass.
    const fern = await ed.addFromLibrary(item('polyhaven/fern-02'), { place: false });
    ed.createScatter({
        sources: [{ model: fern.asset.id, weight: 1, scale: [0.8, 1.4], solid: 'none' }],
        size: [20, 20], count: 60, seed: 5, spacing: 1, ground: terrain, height: [1, 1e4], slope: [0, 30], avoid: [], margin: 0,
        align: 0.5, sink: 0, bury: 0, tilt: 0, clusters: 0.5, clusterSize: 6, layer: 0, distance: 0, castShadow: true, soil: 0, moss: 0, mossColor: '#55602f', vary: 0.3, sway: 0.25,
    }, { name: 'Ferns', at: [30, 0, 14] });
    // Grass over the shore and the slope above it: it grows as the layers, rocks and water let it.
    const grass = ed.createGrass();
    ed.store.commit('Grass on the island', (d) => {
        const g = d.nodes.find((n) => n.id === grass);
        g.position = [30, 0, 14];
        g.grass = { ...g.grass, count: 30000, size: [20, 20], ground: terrain, heights: [0.6, 1.5], sizes: 'patches', distance: 30, gaps: 0.25 };
    });
    ed.store.select([]);
    return { terrain, water, scatter, rain, grass };
});
await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.evaluate(() => {
    const ed = window.__editor;
    ed.runtime.setQualityOverride('high');
    ed.store.commit('Env', (d) => { d.environment.weather = { ...d.environment.weather, enable: true, time: 16, preset: 'fair' }; d.environment.clouds = { ...d.environment.clouds, enable: true }; }, { env: true });
    ed.store.setCamera({ target: [30, 6, 14], yaw: 95, pitch: 12, distance: 30, fov: 60 });
});
// Frame interval (SwiftShader: a rough stand-in for GPU cost) and the profiler's rows.
const measure = async (label) => {
    await page.waitForTimeout(8000);
    const r = await page.evaluate(async () => {
        const t = [];
        let last = performance.now();
        await new Promise((res) => { let n = 0; const f = () => { const now = performance.now(); t.push(now - last); last = now; if (++n < 40) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
        t.sort((a, b) => a - b);
        const ed = window.__editor;
        const s = ed.runtime.stats;
        const snap = s.snapshot();
        return {
            frameMs: t[Math.floor(t.length / 2)].toFixed(0),
            cpu: snap.cpu.median.toFixed(2),
            draws: snap.peak.draws, tris: snap.peak.triangles, dispatches: snap.peak.dispatches, passes: snap.peak.renderPasses, bindGroups: snap.peak.bindGroups, upload: snap.peak.uploadBytes,
            mem: Object.fromEntries(Object.entries(snap.memory).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v])),
            rows: s.passes(40).filter((p) => p.cpu > 0.05 || p.draws > 0).map((p) => `${p.name}: cpu ${p.cpu.toFixed(2)} gpu ${p.gpu?.toFixed(2) ?? '-'} draws ${p.draws.toFixed(0)} tris ${Math.round(p.triangles)}`),
            env: [...(ed.sync.environmentReport?.() ?? []), ...(ed.runtime.environmentReport?.() ?? [])].map((x) => x.join(': ')),
        };
    });
    console.log(`\n== ${label}: frame ${r.frameMs} ms, cpu ${r.cpu} ms, draws ${r.draws}, tris ${r.tris}, dispatches ${r.dispatches}, renderPasses ${r.passes}, bindGroups ${r.bindGroups}, upload ${r.upload}`);
    if (label === 'all') { console.log(r.rows.join('\n')); console.log(r.env.join('\n')); console.log(JSON.stringify(r.mem)); }
};
await measure('all');
await page.evaluate(() => window.__editor.store.commit('x', (d) => { d.environment.clouds.enable = false; d.environment.weather.preset = 'clear'; }, { env: true }));
await measure('no clouds');
await page.evaluate(() => window.__editor.store.commit('x', (d) => { for (const n of d.nodes) if (n.grass) n.visible = false; }));
await measure('no clouds, no grass');
await page.evaluate(() => window.__editor.store.commit('x', (d) => { for (const n of d.nodes) if (n.scatter) n.visible = false; }));
await measure('no clouds, grass, scatter');
await page.evaluate(() => window.__editor.store.commit('x', (d) => { for (const n of d.nodes) if (n.mesh && n.name?.toLowerCase().includes('water')) n.visible = false; }));
await measure('and no water');
await page.evaluate(() => window.__editor.runtime.setQualityOverride('low'));
await measure('low tier, same');
console.log('LOGS\n' + logs.join('\n'));
await browser.close();

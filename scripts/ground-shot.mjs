// Visual check of the ground, rocks and sky: opens the built editor (vite
// preview on :8101) with WebGPU on SwiftShader, makes an island with four
// layers from Library materials (dirt, sand by the water, stones, rock on
// cliffs), the Water around it, clustered rocks on the stones layer and a
// rain box on the beach, and screenshots the shore, the puddles, a wide
// view (aerial perspective) and the same view at sunset. Prints console
// errors and WebGPU messages.
//
//   pnpm editor:build
//   npx vite preview --config editor/vite.config.js --port 8101 --strictPort &
//   xvfb-run -a node scripts/ground-shot.mjs <out dir> <label>
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
    const pinned = { v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: 'high', editMode: true };
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
        const layer = (slot, height, slope, heightBlend = 1, slopeBlend = 6) => ({ slot, albedo: null, normal: null, arm: null, heightMap: null, tile: 2, color: '#ffffff', roughness: 1, height, slope, heightBlend, slopeBlend, onlyPainted: false });
        t.layers = [layer(slots.dirt, [-1e4, 1e4], [0, 90]), layer(slots.sand, [-1e4, 1.4], [0, 25], 0.8), layer(slots.stones, [1, 1e4], [10, 34]), layer(slots.rock, [-1e4, 1e4], [34, 90])];
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
        align: 0.7, sink: 0.05, bury: 0.6, tilt: 25, clusters: 0.8, clusterSize: 18, layer: 3, distance: 0, castShadow: true,
    }, { name: 'Rocks', at: [0, 0, 0] });
    // Rain over part of the beach: wet ground and puddles.
    const rain = ed.createRain();
    ed.store.commit('Place rain', (d) => {
        const r = d.nodes.find((n) => n.id === rain);
        r.position = [55, 6, 0];
        r.rain.size = [24, 12, 24];
    });
    ed.store.select([]);
    return { terrain, water, scatter, rain };
});
console.log('created', JSON.stringify(ids));

await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.evaluate(() => window.__editor.sync.whenLoaded?.());
await page.waitForTimeout(10000);

// A page screenshot clipped to the view: SwiftShader draws this scene slowly, and an element
// screenshot waits for the canvas to settle.
const shot = async (name, c) => {
    await page.evaluate((c) => window.__editor.store.setCamera(c), c);
    await page.waitForTimeout(7000);
    const clip = await page.locator('.viewport canvas.gpu').boundingBox();
    await page.screenshot({ path: `${out}/${label}-${name}.png`, clip: clip ?? undefined, timeout: 180_000 });
    console.log('shot', name);
};
process.on('exit', () => console.log('LOGS\n' + logs.join('\n')));
await shot('shore', { target: [58, 1, 18], yaw: 100, pitch: 14, distance: 22, fov: 60 });
await shot('close', { target: [50, 2, -20], yaw: 80, pitch: 28, distance: 9, fov: 60 });
await shot('rain', { target: [55, 0.5, 0], yaw: 90, pitch: 32, distance: 16, fov: 60 });
await shot('wide', { target: [0, 0, 0], yaw: 135, pitch: 10, distance: 170, fov: 60 });
// Sunset: the key light low in the west; the sky's sun and the light's color follow it.
await page.evaluate(() => {
    const ed = window.__editor;
    ed.store.commit('Sunset', (d) => {
        const sun = d.nodes.find((n) => n.light?.type === 'directional');
        sun.rotation = [5, 120, 0];
    });
});
await shot('sunset', { target: [0, 0, 0], yaw: 135, pitch: 10, distance: 170, fov: 60 });
await browser.close();

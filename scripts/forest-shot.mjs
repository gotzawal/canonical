// Visual and load check of a forest: opens the built editor (vite preview on
// :8101) with WebGPU on SwiftShader, scatters oaks, birches and spruces over
// a meadow, and screenshots the forest's edge, the view from above and from
// inside it. Prints what the trees draw (copies by level of detail,
// triangles), the draws of each pass and the editor's time per frame, and
// console errors and WebGPU messages.
//
//   pnpm editor:build
//   npx vite preview --config editor/vite.config.js --port 8101 --strictPort &
//   xvfb-run -a node scripts/forest-shot.mjs <out dir> <label> [count] [viewport quality]
import { mkdirSync } from 'fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'forest-shots';
const label = process.argv[3] || 'new';
const count = Number(process.argv[4] || 500);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
    headless: false,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-gpu-watchdog', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const logs = [];
page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning' || /WebGPU|shader|Shader|validation/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 900)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
process.on('exit', () => console.log('LOGS\n' + logs.slice(0, 60).join('\n')));
// SwiftShader draws on the CPU: a large forest renders at a lower resolution here.
await page.addInitScript((quality) => {
    localStorage.setItem('canonical-editor/prefs', JSON.stringify({ v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: quality, adaptiveResolution: false, editMode: false }));
}, process.argv[5] || 'high');
await page.goto('http://localhost:8101/');
await page.waitForFunction(() => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'), null, { polling: 200, timeout: 240_000 });
await page.evaluate(() => document.querySelector('.start-screen:not([hidden]) .start-close')?.click());

const ids = await page.evaluate((count) => {
    const ed = window.__editor;
    const before = new Set(ed.store.doc.nodes.map((n) => n.id));
    ed.createPrimitive('plane');
    const ground = ed.store.doc.nodes.find((n) => !before.has(n.id)).id;
    const tree = (species, seed, height) => ({ species, seed, height, width: 1, trunk: 1, branches: 1, leaves: 1, leafSize: 1, gnarl: 0.5, autumn: 0, leafTint: '#ffffff', barkTint: '#ffffff', translucency: 0.6, vary: 0.5, wind: 1, castShadow: true, solid: true });
    const forest = ed.createScatter({
        sources: [
            { model: null, tree: tree('oak', 11, 15), weight: 3, scale: [0.75, 1.2], solid: 'trunk' },
            { model: null, tree: tree('birch', 12, 15), weight: 2, scale: [0.8, 1.15], solid: 'trunk' },
            { model: null, tree: tree('spruce', 13, 19), weight: 3, scale: [0.7, 1.25], solid: 'trunk' },
        ],
        size: [320, 320], count, seed: 4, spacing: 4.5, ground, height: [-1e4, 1e4], slope: [0, 40], avoid: [], margin: 0,
        align: 0, sink: 0.05, bury: 0, tilt: 0, clusters: 0.35, clusterSize: 40, layer: 0, distance: 0, castShadow: true,
        soil: 0, moss: 0, mossColor: '#55602f', vary: 0.4, sway: 0,
    }, { name: 'Forest', at: [0, 0, 0] });
    ed.store.commit('Set up', (d) => {
        d.nodes = d.nodes.filter((n) => n.light || n.id === ground || n.id === forest || n.camera);
        const g = d.nodes.find((n) => n.id === ground);
        g.position = [0, 0, 0];
        g.mesh.geometry = { ...g.mesh.geometry, width: 800, height: 800 };
        g.mesh.material = { ...g.mesh.material, color: '#4c5a2e', roughness: 1 };
        const sun = d.nodes.find((n) => n.light?.type === 'directional');
        if (sun) sun.rotation = [40, 150, 0];
    });
    ed.store.select([]);
    return { ground, forest };
}, count);
console.log('created', JSON.stringify(ids));
await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.evaluate(() => window.__editor.sync.whenLoaded());
await page.waitForTimeout(20000);
const report = () => page.evaluate(() => {
    const ed = window.__editor;
    const rows = ed.sync.environmentReport().filter(([k]) => /Scatter|Tree/.test(k)).map(([k, v]) => `${k}: ${v}`);
    const passes = ed.runtime.stats?.passes(10)?.filter((p) => p.draws > 0.5).map((p) => `${p.name} ${p.draws.toFixed(0)} draws ${(p.triangles / 1e6).toFixed(2)}M tris ${p.cpu.toFixed(2)}ms`) ?? [];
    return rows.join(' | ') + '\n   ' + passes.join('\n   ');
});
const shot = async (name, c, wait = 12000) => {
    await page.evaluate((c) => window.__editor.store.setCamera(c), c);
    await page.waitForTimeout(wait);
    const clip = await page.locator('.viewport canvas.gpu').boundingBox();
    await page.screenshot({ path: `${out}/${label}-${name}.png`, clip: clip ?? undefined, timeout: 600_000 });
    console.log('shot', name, '|', await report());
};
console.log('placed', await page.evaluate((id) => window.__editor.sync.scatterPlacements(id).length, ids.forest));
await shot('edge', { target: [0, 8, 175], yaw: 0, pitch: 4, distance: 40, fov: 60 });
await shot('above', { target: [0, 0, 0], yaw: 30, pitch: 35, distance: 260, fov: 60 });
// Inside: from the clearing nearest the middle that has no trunk within 4 m of the camera.
const inside = await page.evaluate((id) => {
    const at = window.__editor.sync.scatterPlacements(id).map((p) => p.position);
    for (let r = 0; r < 120; r += 2) {
        for (let a = 0; a < 16; a++) {
            const x = 6 + r * Math.cos((a * Math.PI) / 8), z = 20 + r * Math.sin((a * Math.PI) / 8);
            if (at.every((p) => Math.hypot(p[0] - x, p[2] - z) > 4)) return [x, z];
        }
    }
    return [6, 20];
}, ids.forest);
await shot('inside', { target: [inside[0], 2.2, inside[1]], yaw: 40, pitch: 8, distance: 0.6, fov: 70 });
await browser.close();

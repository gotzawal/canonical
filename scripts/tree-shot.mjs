// Visual check of trees: opens the built editor (vite preview on :8101) with
// WebGPU on SwiftShader, grows an oak, a birch and a spruce on a meadow, and
// screenshots them near, from under the oak's crown against the sun, their
// shadows from above and from afar (simpler levels of detail). Prints each
// tree's levels and triangles, and console errors and WebGPU messages.
//
//   pnpm editor:build
//   npx vite preview --config editor/vite.config.js --port 8101 --strictPort &
//   xvfb-run -a node scripts/tree-shot.mjs <out dir> <label> [shot...]
import { mkdirSync } from 'fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'tree-shots';
const label = process.argv[3] || 'new';
const only = process.argv.slice(4);
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
await page.addInitScript(() => {
    localStorage.setItem('canonical-editor/prefs', JSON.stringify({ v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: 'high', adaptiveResolution: false, editMode: false }));
});
await page.goto('http://localhost:8101/');
await page.waitForFunction(() => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'), null, { polling: 200, timeout: 240_000 });
await page.evaluate(() => document.querySelector('.start-screen:not([hidden]) .start-close')?.click());

const ids = await page.evaluate(() => {
    const ed = window.__editor;
    const before = new Set(ed.store.doc.nodes.map((n) => n.id));
    ed.createPrimitive('plane');
    const ground = ed.store.doc.nodes.find((n) => !before.has(n.id)).id;
    const oak = ed.createTree('oak', [0, 0, 0]);
    const birch = ed.createTree('birch', [10, 0, -4]);
    const spruce = ed.createTree('spruce', [-11, 0, -5]);
    ed.store.commit('Set up', (d) => {
        // Only the meadow and the trees: the starting cube and sphere go.
        d.nodes = d.nodes.filter((n) => n.light || n.id === ground || n.tree || n.camera);
        const g = d.nodes.find((n) => n.id === ground);
        g.position = [0, 0, 0];
        g.mesh.geometry = { ...g.mesh.geometry, width: 240, height: 240 };
        g.mesh.material = { ...g.mesh.material, color: '#4c5a2e', roughness: 1 };
        for (const [id, seed] of [[oak, 3], [birch, 5], [spruce, 7]]) d.nodes.find((n) => n.id === id).tree.seed = seed;
        const sun = d.nodes.find((n) => n.light?.type === 'directional');
        if (sun) sun.rotation = [42, 150, 0];
    });
    ed.store.select([]);
    return { ground, oak, birch, spruce };
});
console.log('created', JSON.stringify(ids));
await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.waitForTimeout(15000);
const report = () => page.evaluate(() => window.__editor.sync.environmentReport().filter(([k]) => k.startsWith('Tree')).map(([k, v]) => `${k}: ${v}`).join(' | '));
const shot = async (name, c, wait = 9000) => {
    if (only.length && !only.includes(name)) return;
    await page.evaluate((c) => window.__editor.store.setCamera(c), c);
    await page.waitForTimeout(wait);
    const clip = await page.locator('.viewport canvas.gpu').boundingBox();
    await page.screenshot({ path: `${out}/${label}-${name}.png`, clip: clip ?? undefined, timeout: 180_000 });
    console.log('shot', name, '|', await report());
};
await shot('group', { target: [0, 6, -2], yaw: 0, pitch: 6, distance: 34, fov: 55 });
await shot('oak', { target: [0, 7, 0], yaw: 20, pitch: 4, distance: 18, fov: 55 });
await shot('crown', { target: [1.5, 8, 0.5], yaw: 30, pitch: -10, distance: 6, fov: 60 });
await shot('under', { target: [0, 9, 0], yaw: 150, pitch: -55, distance: 5, fov: 70 });
await shot('backlit', { target: [0, 8, 0], yaw: 150, pitch: 8, distance: 17, fov: 55 });
await shot('birch', { target: [10, 7, -4], yaw: -15, pitch: 4, distance: 16, fov: 55 });
await shot('spruce', { target: [-11, 8, -5], yaw: 10, pitch: 4, distance: 20, fov: 55 });
await shot('bark', { target: [0, 1.2, 0], yaw: 20, pitch: 5, distance: 2.6, fov: 55 });
await shot('shadows', { target: [0, 0, 4], yaw: 0, pitch: 70, distance: 34, fov: 55 });
await shot('far', { target: [0, 6, -2], yaw: 0, pitch: 5, distance: 140, fov: 55 });
await browser.close();

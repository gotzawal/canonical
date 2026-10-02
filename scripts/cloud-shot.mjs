// Visual check of the volumetric clouds: opens the built editor (vite
// preview on :8101) with WebGPU on SwiftShader, makes hills, turns the
// clouds on and screenshots the sky by day, overcast and at sunset, and
// the ground under their shadows. Prints console errors and WebGPU messages.
//
//   pnpm editor:build
//   npx vite preview --config editor/vite.config.js --port 8101 --strictPort &
//   xvfb-run -a node scripts/cloud-shot.mjs <out dir> <label>
import { mkdirSync } from 'fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'cloud-shots';
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
    if (m.type() === 'error' || m.type() === 'warning' || /WebGPU|shader|Shader|validation/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 800)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
process.on('exit', () => console.log('LOGS\n' + logs.join('\n')));
await page.addInitScript(() => {
    localStorage.setItem('canonical-editor/prefs', JSON.stringify({ v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: 'high', editMode: true }));
});
await page.goto('http://localhost:8101/');
await page.waitForFunction(() => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'), null, { polling: 200, timeout: 240_000 });
await page.evaluate(() => document.querySelector('.start-screen:not([hidden]) .start-close')?.click());
await page.evaluate(async () => {
    const ed = window.__editor;
    await ed.createTerrain({ shape: 'hills', size: [400, 400], height: 40, resolution: 257, seed: 4, at: [0, 0, 0] });
    ed.store.commit('Clouds', (d) => {
        d.environment.clouds = { ...d.environment.clouds, enable: true, coverage: 0.5, type: 0.7 };
    }, { env: true });
    ed.store.select([]);
});
await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.waitForTimeout(8000);
const setSun = (rot) => page.evaluate((rot) => window.__editor.store.commit('Sun', (d) => {
    d.nodes.find((n) => n.light?.type === 'directional').rotation = rot;
}), rot);
const shot = async (name, c) => {
    await page.evaluate((c) => window.__editor.store.setCamera(c), c);
    await page.waitForTimeout(7000);
    const clip = await page.locator('.viewport canvas.gpu').boundingBox();
    await page.screenshot({ path: `${out}/${label}-${name}.png`, clip: clip ?? undefined, timeout: 180_000 });
    console.log('shot', name);
};
const sky = { target: [0, 60, 0], yaw: 30, pitch: -12, distance: 60, fov: 70 };
await setSun([40, 150, 0]);
await shot('day', sky);
await shot('ground', { target: [0, 10, 0], yaw: 30, pitch: 35, distance: 260, fov: 60 });
// Water over the valleys: the clouds in its reflection (the environment cube).
await page.evaluate(() => {
    const ed = window.__editor;
    const water = ed.createWater();
    ed.store.commit('Place water', (d) => {
        const w = d.nodes.find((n) => n.id === water);
        w.position = [0, 30, 0];
        w.mesh.geometry = { ...w.mesh.geometry, width: 2000, height: 2000 };
    });
    ed.store.select([]);
});
await page.evaluate(() => window.__editor.shaders.whenIdle());
await shot('water', { target: [0, 32, 0], yaw: 30, pitch: 10, distance: 40, fov: 70 });
// The same without the clouds in the environment cube, to compare.
await page.evaluate(() => { window.__editor.runtime.postList().get('CloudPost').reflections = false; });
await shot('water-plain', { target: [0, 32, 0], yaw: 30, pitch: 10, distance: 40, fov: 70 });
await page.evaluate(() => { window.__editor.runtime.postList().get('CloudPost').reflections = true; });
// A chrome ball: the clouds on a glossy material.
await page.evaluate(() => {
    const ed = window.__editor;
    ed.createPrimitive('sphere');
    ed.store.commit('Chrome', (d) => {
        const n = d.nodes.at(-1);
        n.position = [0, 40, 0];
        n.scale = [8, 8, 8];
        Object.assign(n.mesh.material, { color: '#ffffff', metallic: 1, roughness: 0.05 });
    });
    ed.store.select([]);
});
await shot('chrome', { target: [0, 40, 0], yaw: 210, pitch: -5, distance: 22, fov: 60 });
await page.evaluate(() => { window.__editor.runtime.postList().get('CloudPost').reflections = false; });
await shot('chrome-plain', { target: [0, 40, 0], yaw: 210, pitch: -5, distance: 22, fov: 60 });
await page.evaluate(() => { window.__editor.runtime.postList().get('CloudPost').reflections = true; });
await page.evaluate(() => window.__editor.store.commit('Overcast', (d) => { d.environment.clouds.coverage = 0.85; d.environment.clouds.type = 0.2; }, { env: true }));
await shot('overcast', sky);
await page.evaluate(() => window.__editor.store.commit('Fair', (d) => { d.environment.clouds.coverage = 0.45; d.environment.clouds.type = 0.8; }, { env: true }));
await setSun([6, 210, 0]);
await shot('sunset', { target: [0, 60, 0], yaw: 210, pitch: -8, distance: 60, fov: 70 });
await browser.close();

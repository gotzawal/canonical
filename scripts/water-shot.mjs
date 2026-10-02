// Visual check of the water: opens the built editor (vite preview on :8101)
// with WebGPU on SwiftShader, makes an island, the Water and a tall box at
// the waterline, and screenshots the same views with and without the Mirror,
// after a resize and in Play. Prints console errors and WebGPU messages.
//
//   pnpm editor:build
//   npx vite preview --config editor/vite.config.js --port 8101 --strictPort &
//   xvfb-run -a node scripts/water-shot.mjs <out dir> <label>
import { mkdirSync } from 'fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'water-shots';
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
    const terrain = await ed.createTerrain({ shape: 'island', size: [160, 160], height: 22, resolution: 257, waterLevel: 0, seed: 7, at: [0, 0, 0] });
    const water = ed.createWater();
    ed.createPrimitive('box');
    const box = d => d.nodes.find((n) => n.name === 'Cube');
    ed.store.commit('Place water', (d) => {
        const w = d.nodes.find((n) => n.id === water);
        w.position = [0, 0, 0];
        w.mesh.geometry = { ...w.mesh.geometry, width: 600, height: 600 };
        const b = box(d);
        if (b) { b.position = [66, 0, 4]; b.scale = [2, 5, 2]; }
    });
    ed.store.select([]);
    return { terrain, water };
});
console.log('created', JSON.stringify(ids));

// Shaders compile and the heightmap loads.
await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.waitForTimeout(8000);

const cam = { target: [60, 0.5, 2], yaw: 90, pitch: 9, distance: 28, fov: 60 };
await page.evaluate((c) => window.__editor.store.setCamera(c), cam);
await page.waitForTimeout(1500);
// Put the box at the waterline between the camera and the island.
const placed = await page.evaluate(() => {
    const ed = window.__editor;
    const c = ed.runtime.view.camera.transform.worldPosition;
    const t = [60, 0, 2];
    const k = 0.35;
    const at = [t[0] + (c.x - t[0]) * k, 0, t[2] + (c.z - t[2]) * k];
    ed.store.commit('Box', (d) => {
        const b = d.nodes.find((n) => n.name === 'Cube');
        b.position = at;
        b.scale = [1.5, 6, 1.5];
    });
    return { cam: [c.x, c.y, c.z], at };
});
console.log('placed', JSON.stringify(placed));
const canvas = page.locator('.viewport canvas.gpu');
const shot = async (name, c) => {
    await page.evaluate((c) => window.__editor.store.setCamera(c), c);
    await page.waitForTimeout(6000);
    await canvas.screenshot({ path: `${out}/${label}-${name}.png` });
    console.log('shot', name);
};
await shot('low', cam);
await shot('wide', { target: [0, 0, 0], yaw: 135, pitch: 12, distance: 150, fov: 60 });
await shot('down', { target: [55, 0, 0], yaw: 180, pitch: 55, distance: 25, fov: 60 });
// The same low view without the Mirror component: only the sky is reflected.
await page.evaluate((id) => window.__editor.store.commit('No mirror', (d) => { delete d.nodes.find((n) => n.id === id).mirror; }), ids.water);
await shot('low-nomirror', cam);
// Resize the window: the scene textures are made again and the water must follow.
await page.setViewportSize({ width: 820, height: 560 });
await page.waitForTimeout(4000);
await shot('resized', { target: [55, 0, 0], yaw: 180, pitch: 55, distance: 25, fov: 60 });
// Play mode draws the same scene through the player.
await page.evaluate(() => window.__editor.play());
await page.waitForFunction(() => window.__editor.player.time.frame >= 20, null, { polling: 200, timeout: 180_000 });
await canvas.screenshot({ path: `${out}/${label}-play.png` });
console.log('shot play');
console.log('LOGS\n' + logs.join('\n'));
await browser.close();

// Visual check of grass: opens the built editor (vite preview on :8101) with
// WebGPU on SwiftShader, makes a ground and a field of mixed blades (plain,
// broad leaves, needles; sizes in patches) in chunks, screenshots it close
// up and from afar, and prints each chunk's level of detail and whether it
// is drawn. Prints console errors and WebGPU messages.
//
//   pnpm editor:build
//   npx vite preview --config editor/vite.config.js --port 8101 --strictPort &
//   xvfb-run -a node scripts/grass-shot.mjs <out dir> <label>
import { mkdirSync } from 'fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'grass-shots';
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
process.on('exit', () => console.log('LOGS\n' + logs.join('\n')));
await page.addInitScript(() => {
    localStorage.setItem('canonical-editor/prefs', JSON.stringify({ v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: 'high', editMode: true }));
});
await page.goto('http://localhost:8101/');
await page.waitForFunction(() => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'), null, { polling: 200, timeout: 240_000 });
await page.evaluate(() => document.querySelector('.start-screen:not([hidden]) .start-close')?.click());

const id = await page.evaluate(() => {
    const ed = window.__editor;
    ed.createPrimitive('plane');
    let ground = '';
    ed.store.commit('Ground', (d) => {
        const g = d.nodes.find((n) => n.name === 'Plane');
        g.position = [0, 0, 0];
        g.mesh.geometry = { ...g.mesh.geometry, width: 120, height: 120 };
        g.mesh.material = { ...g.mesh.material, color: '#4a3b26' };
        ground = g.id;
    });
    ed.store.commit('Grass', (d) => {
        const g = d.nodes.find((n) => n.id === ground);
        g.grass = {
            count: 12000, size: [40, 40], ground: g.id, height: 0.45, width: 0.07,
            heights: [0.5, 1.8], widths: [0.6, 1.6], sizes: 'patches',
            shapes: { blade: 3, leaf: 1, needle: 1 }, shapeSpread: 'mixed', curvature: [0.1, 0.6], patchSize: 5,
            bottomColor: '#28461c', topColor: '#7cab45', wind: 0.6, windSpeed: 3, windDirection: 35,
            texture: null, windMap: null, distance: 60, castShadow: false,
        };
    });
    ed.store.select([]);
    return ground;
});
await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.waitForTimeout(8000);
const shot = async (name, c) => {
    await page.evaluate((c) => window.__editor.store.setCamera(c), c);
    await page.waitForTimeout(6000);
    const clip = await page.locator('.viewport canvas.gpu').boundingBox();
    await page.screenshot({ path: `${out}/${label}-${name}.png`, clip: clip ?? undefined, timeout: 180_000 });
    console.log('shot', name);
    console.log('chunks', JSON.stringify(await page.evaluate((gid) => window.__editor.sync.entries.get(gid).grass.renderers.map((r) => `${r.enable ? 'on' : 'off'}:${r.lodLevel}`), id)));
};
await shot('close', { target: [0, 0.3, 0], yaw: 30, pitch: 12, distance: 3, fov: 60 });
await shot('field', { target: [0, 0, 0], yaw: 30, pitch: 18, distance: 30, fov: 60 });
await shot('far', { target: [0, 0, 0], yaw: 30, pitch: 14, distance: 75, fov: 60 });
await browser.close();

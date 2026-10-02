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
    localStorage.setItem('canonical-editor/prefs', JSON.stringify({ v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: 'high', adaptiveResolution: false, editMode: true }));
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
// The noise volumes are made in a worker: wait for them.
await page.waitForFunction(() => (window.__editor.runtime.postList().get('CloudPost')?._shapeNoise?.width ?? 0) > 1, null, { polling: 500, timeout: 120_000 });
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
const preset = (look) => page.evaluate((look) => window.__editor.store.commit('Look', (d) => {
    d.environment.clouds = { ...d.environment.clouds, ...look };
}, { env: true }), look);
await setSun([40, 150, 0]);
await shot('day', sky);
await shot('ground', { target: [0, 10, 0], yaw: 30, pitch: 35, distance: 260, fov: 60 });
// The presets of the Scene tab (core/clouds.ts).
const presets = {
    fair: { coverage: 0.35, type: 0.85, size: 0.8, softness: 0.2, detail: 0.6, density: 1, bottom: 1200, thickness: 1500 },
    broken: { coverage: 0.7, type: 0.6, size: 1.6, softness: 0.35, detail: 0.5, density: 1.2, bottom: 1500, thickness: 2200 },
    overcast: { coverage: 0.95, type: 0.2, size: 2.5, softness: 0.6, detail: 0.3, density: 1.5, bottom: 1200, thickness: 1800 },
    towering: { coverage: 0.55, type: 1, size: 1.5, softness: 0.15, detail: 0.7, density: 1.4, bottom: 1200, thickness: 5000 },
    sheets: { coverage: 0.6, type: 0.05, size: 2.5, softness: 0.8, detail: 0.8, density: 0.5, bottom: 6000, thickness: 800 },
};
for (const [name, look] of Object.entries(presets)) {
    await preset(look);
    await shot(name, sky);
}
await preset({ coverage: 0.5, type: 0.75, size: 1.2, softness: 0.3, detail: 0.6, density: 1, bottom: 1500, thickness: 2000 });
// Water over the valleys and a chrome ball: the clouds in reflections (the environment cube).
await page.evaluate(() => {
    const ed = window.__editor;
    const water = ed.createWater();
    ed.store.commit('Place water', (d) => {
        const w = d.nodes.find((n) => n.id === water);
        w.position = [0, 30, 0];
        w.mesh.geometry = { ...w.mesh.geometry, width: 2000, height: 2000 };
    });
    ed.createPrimitive('sphere');
    ed.store.commit('Chrome', (d) => {
        const n = d.nodes.at(-1);
        n.position = [0, 40, 0];
        n.scale = [8, 8, 8];
        Object.assign(n.mesh.material, { color: '#ffffff', metallic: 1, roughness: 0.05 });
    });
    ed.store.select([]);
});
await page.evaluate(() => window.__editor.shaders.whenIdle());
await shot('chrome', { target: [0, 40, 0], yaw: 210, pitch: -5, distance: 22, fov: 60 });
await setSun([6, 210, 0]);
await shot('sunset', { target: [0, 60, 0], yaw: 210, pitch: -8, distance: 60, fov: 70 });
await browser.close();

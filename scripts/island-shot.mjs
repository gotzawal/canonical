// Visual and load check of the Island example: opens the built editor (vite
// preview on :8101) with WebGPU on SwiftShader, builds the example (as on a
// phone with `light`), and screenshots it from the opening view, from above
// and from behind the player; then plays, walks the player forward and
// screenshots its camera. Prints what the trees, grass and scatters draw,
// where the player starts and how far it walked, and console errors and
// WebGPU messages.
//
//   pnpm editor:build
//   npx vite preview --config editor/vite.config.js --port 8101 --strictPort &
//   xvfb-run -a node scripts/island-shot.mjs <out dir> <label> [light]
import { mkdirSync } from 'fs';
import { chromium } from '@playwright/test';

const out = process.argv[2] || 'island-shots';
const label = process.argv[3] || 'new';
const light = process.argv[4] === 'light';
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
// SwiftShader draws on the CPU: the view renders at a lower resolution here.
await page.addInitScript(() => {
    localStorage.setItem('canonical-editor/prefs', JSON.stringify({ v: 2, backgroundCompression: false, compressImports: false, viewportFps: 30, viewportQuality: 'low', adaptiveResolution: false, editMode: false }));
});
await page.goto('http://localhost:8101/');
await page.waitForFunction(() => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'), null, { polling: 200, timeout: 240_000 });
await page.evaluate(() => document.querySelector('.start-screen:not([hidden]) .start-close')?.click());

const t0 = Date.now();
await page.evaluate(async (light) => {
    const ed = window.__editor;
    // A phone's tier: the island it builds is the light one.
    if (light) Object.defineProperty(ed.runtime, 'deviceQuality', { value: 'low' });
    // An empty scene: nothing to confirm before it is replaced.
    ed.loadDoc({ ...ed.store.doc, nodes: [] });
    await ed.newScene('island');
}, light);
console.log('built in', Date.now() - t0, 'ms');
await page.evaluate(() => window.__editor.shaders.whenIdle());
await page.evaluate(() => window.__editor.sync.whenLoaded());
await page.waitForTimeout(15000);

const report = () => page.evaluate(() => {
    const ed = window.__editor;
    const rows = ed.sync.environmentReport().filter(([k]) => /Scatter|Tree|Grass|Terrain/.test(k)).map(([k, v]) => `${k}: ${v}`);
    const passes = ed.runtime.stats?.passes(10)?.filter((p) => p.draws > 0.5).map((p) => `${p.name} ${p.draws.toFixed(0)} draws ${(p.triangles / 1e6).toFixed(2)}M tris ${p.cpu.toFixed(2)}ms`) ?? [];
    return `${ed.runtime.fps.toFixed(1)} fps\n   ` + rows.join('\n   ') + '\n   ' + passes.join('\n   ');
});
const start = await page.evaluate(() => {
    const ed = window.__editor;
    const p = ed.store.doc.nodes.find((n) => n.player);
    const scatters = ed.store.doc.nodes.filter((n) => n.scatter).map((n) => `${n.name}: ${ed.sync.scatterPlacements(n.id).length} placed of ${n.scatter.count}`);
    return { player: p && { position: p.position, rotation: p.rotation }, scatters, grass: ed.store.doc.nodes.find((n) => n.grass)?.grass.count };
});
console.log('start', JSON.stringify(start));

const shot = async (name, c, wait = 12000) => {
    if (c) await page.evaluate((c) => window.__editor.store.setCamera(c), c);
    await page.waitForTimeout(wait);
    const clip = await page.locator('.viewport canvas.gpu').boundingBox();
    await page.screenshot({ path: `${out}/${label}-${name}.png`, clip: clip ?? undefined, timeout: 600_000 });
    console.log('shot', name, '|\n   ' + (await report()));
};
await shot('overview', null, 1000);
await shot('above', { target: [0, 0, 0], yaw: 210, pitch: 62, distance: 210, fov: 60 });
const [x, y, z] = start.player.position;
const yaw = start.player.rotation[1];
// The editor's orbit camera behind the player, as its game camera will be.
// Near the ground SwiftShader takes many seconds a frame (trees, grass and their shadows up close).
await shot('start', { target: [x, y + 0.6, z], yaw: yaw + 180, pitch: 14, distance: 7, fov: 60 }, 45000);

// Play: the player's camera; then walk forward for twelve frames.
await page.evaluate(() => window.__editor.play());
await page.waitForFunction(() => window.__editor.player.time.frame >= 5, null, { polling: 200, timeout: 240_000 });
await shot('play', null, 45000);
// Keys reach Play from the page itself (or the view), not from a focused button. W is held for
// a number of frames: SwiftShader takes seconds a frame here, and a frame moves at most 0.1 s of play.
await page.evaluate(() => document.activeElement?.blur?.());
const before = await page.evaluate(() => window.__editor.player.time.frame);
await page.keyboard.down('w');
console.log('holding w:', await page.evaluate(() => window.__editor.player.input.key('w')));
await page.waitForFunction((f) => window.__editor.player.time.frame >= f + 12, before, { polling: 200, timeout: 900_000 });
await page.keyboard.up('w');
const walked = await page.evaluate(() => {
    const ed = window.__editor;
    const o = ed.player.playerObject;
    const m = o?.transform.worldMatrix.rawData;
    return { frames: ed.player.time.frame, at: m ? [m[12], m[13], m[14]].map((v) => +v.toFixed(2)) : null, issues: ed.player.issues.map((i) => i.message) };
});
console.log('walked', JSON.stringify(walked), 'from', JSON.stringify(start.player.position));
await shot('walk', null, 30000);
await page.evaluate(() => window.__editor.stopPlay());
await browser.close();

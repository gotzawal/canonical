// Fog, god rays, volumetric fog, shadows and graphics quality tiers
// (Environment, engine/runtime.ts), drawn by the engine.

import { expect, test } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { setEnv, chain, pixels, band, differing, flatGround } from './scenery';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

test('runs fog over ambient occlusion, and bloom over both', async () => {
    const page = editor.page();
    await setEnv(page, { bloom: { enable: true, intensity: 0 }, ao: { enable: true }, fog: { enable: true, near: 1, far: 30 } });
    const order = (await chain(page)).map(([name]) => name);
    const idx = (n: string) => order.indexOf(n);
    expect(idx('GTAOPost')).toBeGreaterThanOrEqual(0);
    expect(idx('GTAOPost')).toBeLessThan(idx('GlobalFog'));
    expect(idx('GlobalFog')).toBeLessThan(idx('BloomPost'));
    expect(idx('BloomPost')).toBeLessThan(idx('FXAAPost'));

    // Bloom still shows with fog on: a glowing cube blooms or not with the intensity.
    await page.evaluate(() =>
        window.__editor.store.commit('Glow', (d) => {
            const cube = d.nodes.find((n) => n.name === 'Cube')!;
            cube.mesh!.material.emissive = '#ffffff';
            cube.mesh!.material.emissiveIntensity = 8;
        }),
    );
    await measure(page, 2);
    const plain = await pixels(page);
    await setEnv(page, { bloom: { intensity: 3 } });
    const bloomed = await pixels(page);
    expect(differing(plain, bloomed)).toBeGreaterThan(0.01);
});

test('fogs more with distance, and low down with height fog', async () => {
    const page = editor.page();
    await flatGround(page);
    await setEnv(page, { fog: { enable: true, mode: 'exponential', color: '#ff0000', near: 0, density: 0.05, sunScatter: 0, sky: 0 } });
    const exp = await pixels(page);
    // The ground just below the middle is far away, the bottom rows are near: the far ground is redder.
    const far = band(exp, 0.52, 0.6), near = band(exp, 0.9, 1);
    const redness = (c: number[]) => c[0] - (c[1] + c[2]) / 2;
    expect(redness(far)).toBeGreaterThan(redness(near) + 20);

    // Height fog on a tall wall ahead: thick at its foot, thin at its top.
    await page.evaluate(() =>
        window.__editor.store.commit('Wall', (d) => {
            const wall = JSON.parse(JSON.stringify(d.nodes.find((n) => n.name === 'Ground')!));
            wall.id = 'wall';
            wall.name = 'Wall';
            wall.mesh.geometry = { type: 'box', width: 60, height: 40, depth: 1 };
            wall.position = [0, 20, -45];
            d.nodes.push(wall);
        }),
    );
    await setEnv(page, { fog: { mode: 'height', density: 0.3, height: 0, heightFalloff: 0.25 } });
    await page.evaluate(() => window.__editor.store.setCamera({ ...window.__editor.store.camera, target: [0, 8, -40], yaw: 180, pitch: 0, distance: 30 }));
    const height = await pixels(page);
    expect(redness(band(height, 0.6, 0.7))).toBeGreaterThan(redness(band(height, 0.1, 0.2)) + 20);
});

test('adds god rays and volumetric fog, and leaves the costly effects out on the low tier', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    await setEnv(page, { ao: { enable: true } });
    await measure(page, 2);
    const off = await pixels(page);
    await setEnv(page, { godRays: { enable: true, intensity: 2 }, volumetricFog: { enable: true, density: 0.08 } });
    // Their shaders compile first (half a minute in SwiftShader).
    await measure(page, 2);
    const on = await pixels(page);
    const posts = Object.fromEntries(await chain(page));
    expect(posts.GodRayPost).toBe(true);
    expect(posts.VolumetricFogPost).toBe(true);
    expect(differing(off, on)).toBeGreaterThan(0.05);

    await page.evaluate(() => window.__editor.store.setPrefs({ previewQuality: 'low' }));
    const low = Object.fromEntries(await chain(page));
    expect(low.GodRayPost).toBe(false);
    expect(low.GTAOPost).toBe(false);
    expect(low.VolumetricFogPost).toBe(true);
    const shadow = await page.evaluate(() => ({ every: window.__editor.runtime.engine.setting.shadow.updateFrameRate, level: window.__editor.runtime.qualityLevel }));
    expect(shadow).toEqual({ every: 2, level: 'low' });

    await page.evaluate(() => window.__editor.store.setPrefs({ previewQuality: 'scene' }));
    const back = Object.fromEntries(await chain(page));
    expect(back.GodRayPost).toBe(true);
    expect(back.GTAOPost).toBe(true);
});

// What the environment draws, all at once: the physical sky with clouds,
// height fog, ambient occlusion, bloom, god rays, volumetric fog and the
// shadows of a lamp next to the sun's. SwiftShader compiles each effect's
// shaders the first time it draws, so they are turned on together and
// checked in one go, with the graphics quality tiers that drop some.
import { expect, test } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { chain, setEnv } from './scenery';

const problems: string[] = [];
const editor = sharedEditor(async (page) => {
    // WebGPU validation errors show in the console only.
    page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
    });
});

test.beforeEach(async () => {
    await editor.reset();
    problems.length = 0;
});
test.afterEach(() => {
    expect(editor.errors).toEqual([]);
    expect(problems).toEqual([]);
});

test('draws the physical sky, fog, light effects and shadows together, and the low tier leaves out the costly ones', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    // A glowing cube for the bloom, and a lamp that casts shadows next to the sun.
    await page.evaluate(() => {
        window.__editor.store.commit('Lamp', (d) => {
            const cube = d.nodes.find((n) => n.name === 'Cube')!;
            cube.mesh!.material.emissive = '#ffffff';
            cube.mesh!.material.emissiveIntensity = 8;
            const lamp = JSON.parse(JSON.stringify(d.nodes.find((n) => n.name === 'Sun')!));
            lamp.id = 'lamp';
            lamp.name = 'Lamp';
            lamp.light = { ...lamp.light, type: 'point', intensity: 60, range: 20, radius: 0.1, castShadow: true };
            lamp.position = [-1.5, 1.5, 1];
            lamp.rotation = [0, 0, 0];
            d.nodes.push(lamp);
        });
    });
    await setEnv(page, {
        sky: 'physical',
        atmosphere: { clouds: true },
        fog: { enable: true, mode: 'height', density: 0.05, height: 0 },
        ao: { enable: true },
        bloom: { enable: true, intensity: 1.5 },
        godRays: { enable: true, intensity: 2 },
        volumetricFog: { enable: true, density: 0.08 },
    });
    // Every effect's shaders compile first (minutes in SwiftShader), then frames draw.
    expect((await measure(page, 3)).draws).toBeGreaterThan(0);

    // The physical sky with its clouds lights the scene.
    const sky = await page.evaluate(() => {
        const rt = window.__editor.runtime as any;
        return { physical: !!rt.physical, clouds: !!rt.physical?.enableClouds, lights: rt.scene.envMap === rt.physical?.atmosphericScatteringSky };
    });
    expect(sky).toEqual({ physical: true, clouds: true, lights: true });
    // Fog over ambient occlusion, light shafts over fog, bloom over all of them, each on.
    const posts = await chain(page);
    const order = posts.map(([name]) => name);
    const at = (n: string) => order.indexOf(n);
    expect(at('GTAOPost')).toBeGreaterThanOrEqual(0);
    expect(at('GTAOPost')).toBeLessThan(at('GlobalFog'));
    expect(at('GlobalFog')).toBeLessThan(at('GodRayPost'));
    expect(at('GodRayPost')).toBeLessThan(at('BloomPost'));
    expect(Object.fromEntries(posts)).toMatchObject({ GTAOPost: true, GlobalFog: true, VolumetricFogPost: true, GodRayPost: true, BloomPost: true });
    // The lamp got a cube shadow map next to the sun's.
    expect(await page.evaluate(() => (window.__editor.sync.entries.get('lamp') as any).light.lightData.castShadowIndex)).toBe(0);

    // The low tier leaves out god rays and ambient occlusion, and draws shadows every other frame.
    await page.evaluate(() => window.__editor.store.setPrefs({ previewQuality: 'low' }));
    expect(Object.fromEntries(await chain(page))).toMatchObject({ GodRayPost: false, GTAOPost: false, VolumetricFogPost: true });
    expect(await page.evaluate(() => ({ every: window.__editor.runtime.engine.setting.shadow.updateFrameRate, level: window.__editor.runtime.qualityLevel }))).toEqual({ every: 2, level: 'low' });
    await page.evaluate(() => window.__editor.store.setPrefs({ previewQuality: 'scene' }));
    expect(Object.fromEntries(await chain(page))).toMatchObject({ GodRayPost: true, GTAOPost: true });
});

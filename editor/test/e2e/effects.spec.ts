// What the environment draws, all at once: the physical sky with clouds,
// height fog, ambient occlusion, bloom, god rays, volumetric fog and the
// shadows of a lamp next to the sun's. SwiftShader compiles each effect's
// shaders the first time it draws, so they are turned on together and
// checked in one go, with the graphics quality tiers that drop some; and
// likewise the reflections, cascaded shadows, grass and instancing.
import { expect, test } from '@playwright/test';
import { playFrames, sharedEditor } from './editor';
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
    // An effect switched off leaves the chain (it gives its textures back).
    const low = Object.fromEntries(await chain(page));
    expect([low.GodRayPost ?? false, low.GTAOPost ?? false, low.VolumetricFogPost]).toEqual([false, false, true]);
    expect(await page.evaluate(() => ({ every: window.__editor.runtime.engine.setting.shadow.updateFrameRate, level: window.__editor.runtime.qualityLevel }))).toEqual({ every: 2, level: 'low' });
    await page.evaluate(() => window.__editor.store.setPrefs({ previewQuality: 'scene' }));
    expect(Object.fromEntries(await chain(page))).toMatchObject({ GodRayPost: true, GTAOPost: true });
});

test('draws a mirror, screen-space reflections, cascaded sun shadows, grass and instanced copies together', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    // A mirror with a tree by it, grass on the ground, and copies of the
    // cube drawn instanced with it; the cube and the sphere are moved under
    // other objects, which must not hide them.
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.createTree('birch', [2.5, 0, 5.5]);
        ed.store.commit('Features', (d) => {
            const cube = d.nodes.find((n) => n.name === 'Cube')!;
            const ground = d.nodes.find((n) => n.name === 'Ground')!;
            const copy = (id: string, patch: object) => ({ ...JSON.parse(JSON.stringify(cube)), id, name: id, ...patch });
            d.nodes.push(copy('pool', { position: [0, 0.02, 3], mesh: { ...cube.mesh!, geometry: { type: 'plane', width: 4, height: 3 } }, mirror: { resolution: 0.5 } }));
            ground.grass = { ...ed.grassFor(ground), count: 2000, size: [12, 12] };
            const group = copy('copies', { instancing: {} });
            delete group.mesh;
            d.nodes.push(group);
            for (let i = 0; i < 6; i++) d.nodes.push(copy(`copy${i}`, { parent: 'copies', position: [i * 1.5 - 4, 0.5, -3] }));
        });
        ed.store.commit('Move', (d) => {
            d.nodes.find((n) => n.name === 'Cube')!.parent = 'copies';
            d.nodes.find((n) => n.name === 'Sphere')!.parent = 'pool';
        });
    });
    await setEnv(page, { ssr: { enable: true } });
    await page.evaluate(() => window.__editor.store.commit('Cascades', (d) => {
        d.nodes.find((n) => n.name === 'Sun')!.light!.shadow.coverage = 'cascades';
    }));
    expect((await measure(page, 3)).draws).toBeGreaterThan(0);

    const seen = () => page.evaluate(() => {
        const { sync, store } = window.__editor;
        const id = (name: string) => store.doc.nodes.find((n) => n.name === name)!.id;
        const cube = sync.entries.get(id('Cube'))!.mesh!;
        const mirror = sync.entries.get('pool')!.mirror!;
        return {
            instancing: sync.instancingOf('copies'),
            cube: { shown: sync.shown(cube), alone: cube.enable },
            sphere: sync.entries.get(id('Sphere'))!.mesh!.enable,
            standing: sync.entries.get(id('Ground'))!.grass!.renderers.reduce((n, r) => n + r.nodes.filter((b) => b.localScale.y > 0).length, 0),
            mirror: !!mirror.captureComponent && !!mirror.material,
            cascades: (sync.entries.get(id('Sun'))!.light as any).enableCSM,
        };
    });
    // One draw for the seven cubes, every blade on the ground.
    expect(await seen()).toEqual({ instancing: { meshes: 7, draws: 1 }, cube: { shown: true, alone: false }, sphere: true, standing: 2000, mirror: true, cascades: true });
    expect(Object.fromEntries(await chain(page))).toMatchObject({ SSRPost: true });

    // The mirror draws the tree's copies by their runs: a tree's level of
    // detail only counts its changes (for the shadow maps), and after a few
    // it is past the levels its shape has.
    await page.evaluate(() => {
        const { sync, store } = window.__editor;
        sync.treeView(store.doc.nodes.find((n) => n.tree)!.id)!.renderer!.lodLevel = 9;
    });
    expect((await measure(page, 3)).draws).toBeGreaterThan(0);

    // A group none of whose copies casts a shadow is no shadow caster.
    await page.evaluate(() => window.__editor.store.commit('No shadows', (d) => {
        for (const n of d.nodes) if (n.parent === 'copies' && n.mesh) n.mesh.castShadow = false;
    }));
    await measure(page, 3);
    expect(await page.evaluate(() => window.__editor.sync.entries.get('copies')!.instancer!.castShadow)).toBe(false);

    // Without instancing they draw on their own again.
    await page.evaluate(() => window.__editor.store.commit('Off', (d) => {
        delete d.nodes.find((n) => n.id === 'copies')!.instancing;
    }));
    await measure(page, 3);
    expect(await seen()).toMatchObject({ instancing: null, cube: { shown: true, alone: true } });
});

test('plays a scene with rain and stops it, the rain back as it was', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    await page.evaluate(() => window.__editor.store.commit('Rain', (d) => {
        d.nodes.push({
            id: 'rain', name: 'Rain', parent: null, visible: true, position: [0, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            rain: { size: [12, 6, 12], amount: 1, spacing: 1, dropWidth: 0.01, streak: 1, speed: 5, wind: 0, density: 8, brightness: 1, color: '#e8f0f8', nearFade: 3, shelter: null, light: null, lightGain: 0.45 },
        });
    }));
    expect((await measure(page, 3)).draws).toBeGreaterThan(0);
    await playFrames(page, 3);
    // Stop rebuilds the scene: the rain's volume goes with the rest and comes back.
    await page.evaluate(() => window.__editor.stopPlay());
    expect(await page.evaluate(() => window.__editor.player.state)).toBe('stopped');
    expect(await page.evaluate(() => !!window.__editor.sync.entries.get('rain')?.rain)).toBe(true);
});

test('keeps the sun\'s shadow map while nothing moves, with particles and copies a script may move in it', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    // Smoke, and instanced copies of the cube that cast no shadow, one with a script.
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.createParticles('smoke');
        ed.store.commit('Copies', (d) => {
            const cube = d.nodes.find((n) => n.name === 'Cube')!;
            const copy = (id: string, patch: object) => ({ ...JSON.parse(JSON.stringify(cube)), id, name: id, ...patch });
            const group = copy('copies', { instancing: {} });
            delete group.mesh;
            d.nodes.push(group);
            for (let i = 0; i < 3; i++) d.nodes.push(copy(`copy${i}`, { parent: 'copies', position: [i * 1.5 - 2, 0.5, -3], mesh: { ...cube.mesh!, castShadow: false } }));
        });
        ed.createScript({ name: 'Turn', code: 'export default class Turn extends Script {\n    update(dt) { this.object3D.rotationY += 90 * dt; }\n}\n', attachTo: ['copy0'], open: false });
    });
    expect((await measure(page, 3)).draws).toBeGreaterThan(0);
    // Neither is a caster that changes every frame: the map drawn once is kept.
    const drawn = await page.evaluate(async () => {
        const rt = window.__editor.runtime;
        const pass = rt.view.renderGraph!.getPass('ShadowPass') as any;
        const out: number[] = [];
        for (let i = 0; i < 6; i++) {
            await new Promise<void>((resolve) => {
                const off = rt.onFrame(() => {
                    off();
                    resolve();
                });
            });
            out.push(pass.drawnMaps);
        }
        return out;
    });
    expect(drawn).toEqual([0, 0, 0, 0, 0, 0]);
});

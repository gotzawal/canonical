// Shadows (range, follow, lamps next to the sun), effects through the Play
// camera, and the quality tier a built game starts at.
import { expect, test } from '@playwright/test';
import { PREVIEW_KEY } from '../../src/build/gameFile';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { setEnv, pixels, differing, flatGround } from './scenery';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

test('draws fog and ambient occlusion through the camera Play renders with', async () => {
    const page = editor.page();
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.store.commit('Camera', (d) => {
            d.nodes.push({ id: 'cam', name: 'Game Camera', parent: null, visible: true, position: [4, 3, 6], rotation: [15, 210, 0], scale: [1, 1, 1], camera: { fov: 60, near: 0.1, far: 500, main: true } } as any);
        });
    });
    await setEnv(page, { fog: { enable: true }, ao: { enable: true } });
    await measure(page, 2);
    await page.evaluate(() => window.__editor.play());
    await measure(page, 3);
    const bound = await page.evaluate(() => {
        const rt = window.__editor.runtime;
        const pass = (rt.view.renderGraph as any).getPass('PostPass');
        const fog = pass.postList.get('GlobalFog');
        const ao = pass.postList.get('GTAOPost');
        return {
            playCamera: rt.view.camera !== rt.camera,
            fog: fog._cameraBindings.get(fog.fogCompute) === rt.view.camera,
            ao: ao._cameraBindings.get(ao.gtaoCompute) === rt.view.camera,
        };
    });
    await page.evaluate(() => window.__editor.stopPlay());
    expect(bound).toEqual({ playCamera: true, fog: true, ao: true });
});

test('covers the shadow range around the camera with follow', async () => {
    const page = editor.page();
    await flatGround(page);
    // A tall box far from the Sun object (at the origin): out of its 60 m of shadows.
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.store.commit('Far Box', (d) => {
            const cube = JSON.parse(JSON.stringify(d.nodes.find((n) => n.name === 'Ground')!));
            cube.id = 'far';
            cube.name = 'Far Box';
            cube.mesh.geometry = { type: 'box', width: 2, height: 6, depth: 2 };
            cube.mesh.castShadow = true;
            cube.position = [120, 3, 0];
            d.nodes.push(cube);
        });
        ed.store.setCamera({ ...ed.store.camera, target: [120, 0, 0], yaw: 30, pitch: 50, distance: 18 });
    });
    await measure(page, 2);
    const around = await pixels(page);
    await setEnv(page, { shadow: { follow: true } });
    const followed = await pixels(page);
    expect(differing(around, followed)).toBeGreaterThan(0.01);
});

test('casts the shadows of a lamp while the sun casts its own', async () => {
    const page = editor.page();
    await flatGround(page);
    // A post, and a lamp just left of it at half its height: its shadow falls to the right.
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.store.commit('Lamp', (d) => {
            const ground = d.nodes.find((n) => n.name === 'Ground')!;
            const post = JSON.parse(JSON.stringify(ground));
            post.id = 'post';
            post.name = 'Post';
            post.mesh.geometry = { type: 'box', width: 0.5, height: 2, depth: 0.5 };
            post.mesh.castShadow = true;
            post.position = [0, 1, -10];
            d.nodes.push(post);
            const sun = d.nodes.find((n) => n.name === 'Sun')!;
            const lamp = JSON.parse(JSON.stringify(sun));
            lamp.id = 'lamp';
            lamp.name = 'Lamp';
            lamp.light = { ...lamp.light, type: 'point', intensity: 60, range: 20, radius: 0.1, castShadow: false };
            lamp.position = [-1.5, 1, -10];
            lamp.rotation = [0, 0, 0];
            d.nodes.push(lamp);
        });
        ed.store.setCamera({ ...ed.store.camera, target: [1, 0, -10], yaw: 0, pitch: 70, distance: 9 });
    });
    await measure(page, 2);
    const unshadowed = await pixels(page);
    await page.evaluate(() => window.__editor.store.commit('Lamp Shadows', (d) => (d.nodes.find((n) => n.id === 'lamp')!.light!.castShadow = true)));
    await measure(page, 2);
    const shadowed = await pixels(page);
    // The lamp got a cube shadow map next to the sun's, and its shadow shows.
    const slot = await page.evaluate(() => (window.__editor.sync.entries.get('lamp') as any).light.lightData.castShadowIndex);
    expect(slot).toBe(0);
    expect(differing(unshadowed, shadowed)).toBeGreaterThan(0.01);
});

test('starts a built game at the quality tier of its device, or the one asked for', async ({ browser }) => {
    test.setTimeout(300_000);
    // The scene goes to the player as the editor's Run hands it over.
    const data = await editor.page().evaluate(() => {
        const ed = window.__editor;
        return JSON.stringify({ title: 'Tier', scene: ed.store.doc, camera: ed.store.camera, trusted: true });
    });
    const tierOf = async (query: string) => {
        const context = await browser.newContext();
        try {
            await context.addInitScript(({ key, data }) => localStorage.setItem(key, data), { key: PREVIEW_KEY, data });
            const game = await context.newPage();
            await game.goto(`/player.html?preview&stats${query}`);
            await game.waitForFunction(() => !!(window as any).__player, null, { polling: 200, timeout: 150_000 });
            return await game.evaluate(() => {
                const p = (window as any).__player;
                const s = p.runtime.engine.setting.shadow;
                const m = p.runtime.stats.snapshot().memory;
                return { quality: p.quality, level: p.runtime.qualityLevel, shadowMap: s.maxShadowMapWidth, pointShadow: s.pointShadowSize, textures: m.textures.target.bytes + m.textures.other.bytes };
            });
        } finally {
            await context.close();
        }
    };
    // SwiftShader, as a device, gets the low tier.
    const auto = await tierOf('');
    expect(auto).toMatchObject({ quality: 'low', level: 'low', shadowMap: 1024, pointShadow: 256 });
    const high = await tierOf('&quality=high');
    expect(high).toMatchObject({ quality: 'high', level: 'high', shadowMap: 2048, pointShadow: 1024 });
    console.log(`Shadow and render target memory: high ${(high.textures / 2 ** 20).toFixed(0)} MiB, low ${(auto.textures / 2 ** 20).toFixed(0)} MiB`);
    expect(auto.textures).toBeLessThan(high.textures - 300 * 2 ** 20);
});

// Fog, god rays, volumetric fog, shadows and graphics quality tiers
// (Environment, engine/runtime.ts), drawn by the engine.

import { expect, test, type Page } from '@playwright/test';
import { PREVIEW_KEY } from '../../src/build/gameFile';
import type { EnvironmentDoc } from '../../src/core/types';
import { sharedEditor } from './editor';
import { measure } from './measure';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

type EnvPatch = { [K in keyof EnvironmentDoc]?: EnvironmentDoc[K] extends object ? Partial<EnvironmentDoc[K]> : EnvironmentDoc[K] };

function setEnv(page: Page, patch: EnvPatch) {
    return page.evaluate((patch) => {
        const store = window.__editor.store;
        store.commit('Environment', (d) => {
            for (const [k, v] of Object.entries(patch)) {
                const cur = (d.environment as any)[k];
                (d.environment as any)[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cur, ...v } : v;
            }
        }, { env: true });
    }, patch as any);
}

/** The post effects in the order they run, with whether each is on. */
function chain(page: Page): Promise<[string, boolean][]> {
    return page.evaluate(() => {
        const pass = (window.__editor.runtime.view.renderGraph as any).getPass('PostPass');
        return Array.from(pass.postList.entries() as Iterable<[string, any]>).map(([name, post]) => [name, !!post.enable] as [string, boolean]);
    });
}

/** The view as RGB rows, after `frames` frames; `crop` in CSS pixels. */
function pixels(page: Page, crop?: { x: number; y: number; w: number; h: number }): Promise<{ w: number; h: number; data: number[] }> {
    return page.evaluate(async (crop) => {
        const rt = window.__editor.runtime;
        const blob = await rt.captureFrame({ type: 'image/png', frames: 4, maxWidth: 320, ...(crop ? { crop } : {}) });
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const out: number[] = [];
        for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
        return { w: bmp.width, h: bmp.height, data: out };
    }, crop);
}

/** Mean RGB of a band of rows (0..1 from the top) of an image. */
function band(img: { w: number; h: number; data: number[] }, from: number, to: number): [number, number, number] {
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = Math.floor(from * img.h); y < Math.floor(to * img.h); y++) {
        for (let x = 0; x < img.w; x++) {
            for (let k = 0; k < 3; k++) sum[k] += img.data[(y * img.w + x) * 3 + k];
            n++;
        }
    }
    return sum.map((v) => v / Math.max(1, n)) as [number, number, number];
}

function differing(a: { data: number[] }, b: { data: number[] }): number {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 3) {
        if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 12) n++;
    }
    return n / (a.data.length / 3);
}

/** A large flat gray ground and the camera low over it, looking along it. */
async function flatGround(page: Page) {
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.store.commit('Ground', (d) => {
            d.nodes = d.nodes.filter((n) => n.name === 'Sun' || n.name === 'Ground');
            const g = d.nodes.find((n) => n.name === 'Ground')!;
            g.mesh!.geometry = { type: 'plane', width: 400, height: 400 };
            g.mesh!.material.color = '#b0b0b0';
            d.environment.sky = 'color';
            d.environment.skyColor = '#b0b0b0';
        });
        ed.store.setCamera({ ...ed.store.camera, target: [0, 1.5, -40], yaw: 180, pitch: 2, distance: 40 });
    });
    await measure(page, 2);
}

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

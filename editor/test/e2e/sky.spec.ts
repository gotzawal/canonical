// The skies (Environment.sky): the fast atmospheric sky, the physical sky
// of packages/atmosphere with its optional clouds, and a flat color; each
// lights the scene (scene.envMap).
import { expect, test, type Page } from '@playwright/test';
import type { EnvironmentDoc } from '../../src/core/types';
import { sharedEditor } from './editor';
import { measure } from './measure';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

type EnvPatch = { [K in keyof EnvironmentDoc]?: EnvironmentDoc[K] extends object ? Partial<EnvironmentDoc[K]> : EnvironmentDoc[K] };

function setEnv(page: Page, patch: EnvPatch) {
    return page.evaluate((patch) => {
        window.__editor.store.commit('Environment', (d) => {
            for (const [k, v] of Object.entries(patch)) {
                const cur = (d.environment as any)[k];
                (d.environment as any)[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cur, ...v } : v;
            }
        }, { env: true });
    }, patch as any);
}

/** Only the Sun, and the camera near the ground looking up into the sky. */
async function lookUp(page: Page) {
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.store.commit('Sky Only', (d) => (d.nodes = d.nodes.filter((n) => n.name === 'Sun')));
        ed.store.setCamera({ ...ed.store.camera, target: [0, 2, 0], yaw: 200, pitch: -25, distance: 5 });
    });
}

/** Which sky the runtime shows, and whether it lights the scene. */
function shownSky(page: Page) {
    return page.evaluate(() => {
        const rt = window.__editor.runtime as any;
        const env = rt.scene.envMap;
        return {
            atmospheric: !!rt.atmosphere,
            physical: !!rt.physical,
            color: !!rt.solidSky,
            lights: rt.physical ? env === rt.physical.atmosphericScatteringSky : rt.atmosphere ? env === rt.atmosphere.map : env === rt.solidSkyTexture,
        };
    });
}

/** Mean RGB of the upper half of the view. */
function upperSky(page: Page): Promise<number[]> {
    return page.evaluate(async () => {
        const rt = window.__editor.runtime;
        const [w, h] = rt.cssSize;
        const blob = await rt.captureFrame({ type: 'image/png', frames: 3, maxWidth: 160, crop: { x: 0, y: 0, w, h: h / 2 } });
        const bmp = await createImageBitmap(blob);
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
        return sum.map((v) => Math.round(v / (d.length / 4)));
    });
}

const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('switches between the atmospheric, physical and color skies, which light the scene', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    await lookUp(page);
    await measure(page, 2);
    expect(await shownSky(page)).toEqual({ atmospheric: true, physical: false, color: false, lights: true });
    const atmospheric = await upperSky(page);

    await setEnv(page, { sky: 'physical' });
    await measure(page, 3);
    expect(await shownSky(page)).toEqual({ atmospheric: false, physical: true, color: false, lights: true });
    const physical = await upperSky(page);
    console.log(`Upper sky: atmospheric ${atmospheric} (luma ${luma(atmospheric).toFixed(0)}), physical ${physical} (luma ${luma(physical).toFixed(0)})`);
    // A day sky: blue over red, and about the brightness of the atmospheric one (calibrated, packages/atmosphere V2_SCALE).
    expect(physical[2]).toBeGreaterThan(physical[0]);
    expect(luma(physical)).toBeGreaterThan(luma(atmospheric) * 0.8);
    expect(luma(physical)).toBeLessThan(luma(atmospheric) * 1.25);

    // Several switches within one frame: each waits for the sky before it to start.
    await page.evaluate(() => {
        const ed = window.__editor;
        for (const sky of ['color', 'physical', 'atmospheric', 'physical'] as const) ed.store.commit('Sky', (d) => (d.environment.sky = sky), { env: true });
    });
    await measure(page, 3);
    expect(await shownSky(page)).toEqual({ atmospheric: false, physical: true, color: false, lights: true });

    await setEnv(page, { sky: 'color', skyColor: '#204060' });
    await measure(page, 2);
    expect(await shownSky(page)).toEqual({ atmospheric: false, physical: false, color: true, lights: true });
});

test('moves the sun of the physical sky, and draws its clouds', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    await lookUp(page);
    await setEnv(page, { sky: 'physical' });
    await measure(page, 3);
    const day = await upperSky(page);
    // The sun just under the horizon: dusk.
    await setEnv(page, { sunY: 0.49 });
    await measure(page, 3);
    const dusk = await upperSky(page);
    expect(luma(dusk)).toBeLessThan(luma(day) * 0.6);
    await setEnv(page, { sunY: 0.62, atmosphere: { clouds: true } });
    await measure(page, 3);
    const clouds = await upperSky(page);
    console.log(`Physical sky: day ${day}, dusk ${dusk}, clouds ${clouds}`);
    expect(await page.evaluate(() => (window.__editor.runtime as any).physical.enableClouds)).toBe(true);
});

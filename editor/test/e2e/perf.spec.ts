// What scenes cost to draw, counted at the WebGPU API (engine/gpuStats.ts):
// draw calls, render passes and GPU memory per frame, on the scenes of
// test/bench/scene.ts. Counts do not depend on the machine, so they are
// held to budgets; CPU time here shares the CPU with SwiftShader and is
// only reported.

import { expect, test, type Page } from '@playwright/test';
import type { SceneDoc } from '../../src/core/types';
import { aiLevelScene, outdoorScene } from '../bench/scene';
import { sharedEditor } from './editor';
import { measure, type Measure } from './measure';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

async function load(page: Page, doc: SceneDoc) {
    await page.evaluate((d) => window.__editor.loadDoc(d), doc);
}

const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const report = (name: string, m: Measure) =>
    console.log(`${name}: ${m.draws} draws (peak ${m.peak}) in ${m.passes} passes, ${m.triangles} triangles, ${m.api} pipeline/bind group changes, ${m.pipelines} pipelines made; GPU memory ${MB(m.memory.stable)} (images ${MB(m.memory.images)}, targets ${MB(m.memory.targets)}, buffers ${MB(m.memory.buffers)}); engine CPU ${m.cpu.toFixed(2)} ms${m.settled ? '' : ' (counts still changing)'}`);

test('counts the draws of a scene and shows them in the status bar', async () => {
    const page = editor.page();
    const base = await measure(page);
    report('New scene', base);
    expect(base.settled).toBe(true);
    expect(base.draws).toBeGreaterThan(0);

    // One more box: a draw in each pass it is in (depth, shadow, color).
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.createPrimitive('box');
        ed.store.commit('Move', (d) => (d.nodes[d.nodes.length - 1].position = [3, 0.5, 0]));
    });
    const box = await measure(page);
    report('New scene + box', box);
    console.log(`A box adds ${box.draws - base.draws} draws.`);
    expect(box.draws).toBeGreaterThan(base.draws);

    await expect(page.locator('.statusbar .gpu-cost')).toHaveText(/^[\d,]+ draws · [\d.]+ [KM]?B$/);
    await expect(page.locator('.statusbar .gpu-cost')).toHaveAttribute('title', /draw calls in \d+ render passes/);
    // The frame rate stays the only button of its kind there.
    await expect(page.locator('.statusbar button.status-item')).toHaveCount(1);
});

test('measures a level as the assistant builds it', async () => {
    const page = editor.page();
    const doc = aiLevelScene();
    await load(page, doc);
    const m = await measure(page);
    report(`AI level (${doc.nodes.length} objects)`, m);
    expect(m.settled).toBe(true);
});

/** Share of pixels that differ between the view drawn with frustum culling and without, for each camera. */
async function cullingDifference(page: Page, cameras: { target: [number, number, number]; yaw: number; pitch: number; distance: number }[]): Promise<number[]> {
    return page.evaluate(async (cameras) => {
        const ed = window.__editor;
        const rt = ed.runtime;
        const render = rt.engine.setting.render;
        const shot = async () => {
            const blob = await rt.captureFrame({ type: 'image/png', frames: 3 });
            const bmp = await createImageBitmap(blob);
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            const g = c.getContext('2d')!;
            g.drawImage(bmp, 0, 0);
            return g.getImageData(0, 0, bmp.width, bmp.height).data;
        };
        const out: number[] = [];
        for (const cam of cameras) {
            ed.store.setCamera({ ...ed.store.camera, ...cam });
            render.frustumCulling = true;
            const culled = await shot();
            render.frustumCulling = false;
            const all = await shot();
            render.frustumCulling = true;
            let differ = 0;
            for (let i = 0; i < culled.length; i += 4) {
                if (Math.abs(culled[i] - all[i]) > 2 || Math.abs(culled[i + 1] - all[i + 1]) > 2 || Math.abs(culled[i + 2] - all[i + 2]) > 2) differ++;
            }
            out.push(differ / (culled.length / 4));
        }
        return out;
    }, cameras);
}

test('culls what the camera cannot see without changing the picture', async () => {
    // Four captures of a level of 390 objects: over a minute here, about twice that on a CI runner.
    test.setTimeout(300_000);
    const page = editor.page();
    await load(page, aiLevelScene());
    // Shaders compile first (SwiftShader takes a while).
    await measure(page, 1);
    // From outside, and from inside a room (walls and props behind the camera cast shadows in view).
    const diff = await cullingDifference(page, [
        { target: [0, 1, 0], yaw: 30, pitch: 35, distance: 30 },
        { target: [-8, 1.5, -2.5], yaw: 200, pitch: 10, distance: 1 },
    ]);
    console.log(`Pixels that differ with culling: ${diff.map((d) => (d * 100).toFixed(3) + '%').join(', ')}`);
    for (const d of diff) expect(d).toBeLessThan(0.0005);
});

test('measures a large outdoor scene', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    const doc = outdoorScene(2000);
    await load(page, doc);
    const m = await measure(page, 3);
    report(`Outdoor (${doc.nodes.length} objects)`, m);
});

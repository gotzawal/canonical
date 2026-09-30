// Objects whose materials are the same share one engine material (and
// objects of the same shape one geometry): a change to one object's
// material gives it a material of its own, and the others keep theirs.

import { expect, test, type Page } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

/** Makes `count` red boxes in a row (ids box0...) and returns their ids. */
async function boxes(page: Page, count: number): Promise<string[]> {
    return page.evaluate((count) => {
        const ed = window.__editor;
        const ids: string[] = [];
        ed.store.commit('Boxes', (d) => {
            const cube = d.nodes.find((n) => n.name === 'Cube')!;
            for (let i = 0; i < count; i++) {
                const n = JSON.parse(JSON.stringify(cube));
                n.id = `box${i}`;
                n.name = `Box ${i}`;
                n.position = [-6 + (i % 10) * 1.3, 0.5, 2 + Math.floor(i / 10) * 1.3];
                n.mesh.material.color = '#d03030';
                d.nodes.push(n);
                ids.push(n.id);
            }
        });
        return ids;
    }, count);
}

/** The engine material each object shows (as an index into the distinct ones), and the distinct count. */
function materials(page: Page, ids: string[]) {
    return page.evaluate((ids) => {
        const sync = window.__editor.sync;
        const mats = ids.map((id) => sync.entries.get(id)!.mesh!.materials[0]);
        const distinct = [...new Set(mats)];
        return { of: mats.map((m) => distinct.indexOf(m)), distinct: distinct.length, geometries: new Set(ids.map((id) => sync.entries.get(id)!.mesh!.geometry)).size };
    }, ids);
}

/** Average color of the pixels around an object's center, as drawn. */
function colorAt(page: Page, id: string): Promise<[number, number, number]> {
    return page.evaluate(async (id) => {
        const ed = window.__editor;
        ed.picker.update();
        const n = ed.store.node(id)!;
        const p = ed.picker.project([n.position[0], n.position[1] + 0.3, n.position[2]]);
        const blob = await ed.runtime.captureFrame({ crop: { x: p.x - 3, y: p.y - 3, w: 6, h: 6 }, type: 'image/png', frames: 3 });
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
        const n4 = d.length / 4;
        return sum.map((v) => Math.round(v / n4)) as [number, number, number];
    }, id);
}

test('shares one material among objects that look the same, and gives an edited one its own', async () => {
    const page = editor.page();
    const ids = await boxes(page, 20);
    await measure(page, 2);
    let m = await materials(page, ids);
    expect(m.distinct).toBe(1);
    expect(m.geometries).toBe(1);

    // Recolor one: it gets a material of its own; the others keep theirs.
    await page.evaluate(() => window.__editor.store.commit('Recolor', (d) => (d.nodes.find((n) => n.id === 'box3')!.mesh!.material.color = '#2050e0')));
    m = await materials(page, ids);
    expect(m.distinct).toBe(2);
    expect(m.of.filter((i) => i === m.of[3]).length).toBe(1);
    await page.evaluate(() => window.__editor.store.setCamera({ ...window.__editor.store.camera, target: [0, 0.5, 3], yaw: 0, pitch: 25, distance: 12 }));
    const blue = await colorAt(page, 'box3');
    const red = await colorAt(page, 'box4');
    expect(blue[2]).toBeGreaterThan(blue[0]);
    expect(red[0]).toBeGreaterThan(red[2]);

    // Undo: it looks like the others again, and shares theirs.
    await page.evaluate(() => window.__editor.store.undo());
    m = await materials(page, ids);
    expect(m.distinct).toBe(1);

    // A hidden sharer does not stop changes reaching the others: hide one, recolor the rest alike.
    await page.evaluate((ids) => {
        const store = window.__editor.store;
        store.commit('Hide', (d) => (d.nodes.find((n) => n.id === 'box0')!.visible = false));
        store.commit('Recolor All', (d) => {
            for (const n of d.nodes) if (ids.includes(n.id)) n.mesh!.material.color = '#20c040';
        });
    }, ids);
    const green = await colorAt(page, 'box5');
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(green[1]).toBeGreaterThan(green[2]);

    // Deleting all but one keeps the last one drawn.
    await page.evaluate((ids) => window.__editor.store.commit('Delete', (d) => (d.nodes = d.nodes.filter((n) => !ids.slice(0, 19).includes(n.id)))), ids);
    const last = await colorAt(page, ids[19]);
    expect(last[1]).toBeGreaterThan(last[0]);
    expect((await measure(page, 1)).settled).toBe(true);
});

test('draws objects of one material after one another, binding it once', async () => {
    const page = editor.page();
    await boxes(page, 30);
    const shared = await measure(page, 3);
    // Every box its own material (a different color each): the bindings change with every draw.
    await page.evaluate(() =>
        window.__editor.store.commit('Colors', (d) => {
            let i = 0;
            for (const n of d.nodes) if (n.id.startsWith('box')) n.mesh!.material.color = `#${(0x102030 + i++ * 0x050301).toString(16).slice(-6)}`;
        }),
    );
    const own = await measure(page, 3);
    console.log(`30 boxes: ${shared.api} pipeline/bind group changes a frame sharing one material, ${own.api} with one each.`);
    expect(shared.draws).toBe(own.draws);
    expect(shared.api).toBeLessThan(own.api / 2);
});

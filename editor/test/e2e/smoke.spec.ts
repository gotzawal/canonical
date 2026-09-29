import { expect, test } from '@playwright/test';
import { playFrames, sharedEditor } from './editor';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

test('starts on a new scene, edits it and undoes the edit', async () => {
    const page = editor.page();
    const names = () => page.evaluate(() => window.__editor.store.doc.nodes.map((n) => n.name));
    expect(await names()).toEqual(['Sun', 'Ground', 'Cube', 'Sphere']);

    await page.evaluate(() => window.__editor.createPrimitive('cylinder'));
    expect(await names()).toEqual(['Sun', 'Ground', 'Cube', 'Sphere', 'Cylinder']);
    // The new object is selected and shown in the hierarchy.
    await expect(page.locator('.hierarchy').getByText('Cylinder')).toBeVisible();
    await page.evaluate(() => window.__editor.store.undo());
    expect(await names()).toEqual(['Sun', 'Ground', 'Cube', 'Sphere']);
});

test('moves an object under another by dragging its row in the hierarchy, and undoes that', async () => {
    const page = editor.page();
    const ids = await page.evaluate(() => {
        const id = (name: string) => window.__editor.store.doc.nodes.find((n) => n.name === name)!.id;
        return { cube: id('Cube'), sphere: id('Sphere') };
    });
    const row = (id: string) => page.locator(`.hierarchy .tree-row[data-id="${id}"]`);
    await expect(row(ids.sphere)).toHaveAttribute('aria-level', '1');
    // The events a drag makes (Playwright's own drag waits on frames, which SwiftShader can stall).
    await page.evaluate(({ from, to }) => {
        const src = document.querySelector(`.hierarchy .tree-row[data-id="${from}"]`)!;
        const dst = document.querySelector(`.hierarchy .tree-row[data-id="${to}"]`)!;
        const r = dst.getBoundingClientRect();
        const data = new DataTransfer();
        const fire = (type: string, el: Element, y: number) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: r.left + 30, clientY: y }));
        fire('dragstart', src, 0);
        // The middle of a row drops inside it.
        fire('dragover', dst, r.top + r.height / 2);
        fire('drop', dst, r.top + r.height / 2);
        fire('dragend', src, 0);
    }, { from: ids.sphere, to: ids.cube });
    expect(await page.evaluate((id) => window.__editor.store.node(id)?.parent, ids.sphere)).toBe(ids.cube);
    await expect(row(ids.sphere)).toHaveAttribute('aria-level', '2');
    await expect(row(ids.cube)).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(() => window.__editor.store.undo());
    await expect(row(ids.sphere)).toHaveAttribute('aria-level', '1');
});

test('plays a script and restores the scene on Stop', async () => {
    const page = editor.page();
    await page.evaluate(() => {
        const ed = window.__editor;
        const cube = ed.store.doc.nodes.find((n) => n.name === 'Cube')!;
        ed.createScript({
            name: 'Lift',
            code: 'export default class Lift extends Script {\n    speed = 2;\n    start() { this.log("lift started"); }\n    update(dt) { this.object3D.y += this.speed * dt; }\n}\n',
            attachTo: [cube.id],
            open: false,
        });
    });
    await playFrames(page, 10);
    const cubeY = () => page.evaluate(() => {
        const ed = window.__editor;
        return ed.sync.entries.get(ed.store.doc.nodes.find((n) => n.name === 'Cube')!.id)!.obj.y;
    });
    expect(await cubeY()).toBeGreaterThan(0.5);
    const run = await page.evaluate(() => ({ logs: window.__editor.player.logs.map((l) => l.text), issues: window.__editor.player.issues }));
    expect(run.issues).toEqual([]);
    expect(run.logs).toContain('[Lift.js on Cube] lift started');

    await page.evaluate(() => window.__editor.stopPlay());
    expect(await page.evaluate(() => window.__editor.player.state)).toBe('stopped');
    expect(await cubeY()).toBe(0.5);
    expect(await page.evaluate(() => window.__editor.store.doc.scripts.length)).toBe(1);
});

test('switches the view to the walk camera or the reference room, and back to the scene for Play', async () => {
    const page = editor.page();
    const view = () => page.evaluate(() => window.__editor.view);
    await page.evaluate(() => window.__editor.setView('walk'));
    await expect(page.locator('.walk-hud')).toBeVisible();
    await page.evaluate(() => window.__editor.emit('show-room', [{ name: 'Gray', color: '#808080', roughness: 0.8, metallic: 0, tile: 1 }]));
    await expect(page.locator('.room-hud')).toBeVisible();
    await expect(page.locator('.walk-hud')).toBeHidden();
    expect(await view()).toBe('room');

    await page.evaluate(() => window.__editor.play());
    await expect(page.locator('.room-hud')).toBeHidden();
    expect(await view()).toBe('scene');
    // The editor tells the user why through core/messages, which the UI shows.
    await page.evaluate(() => window.__editor.setView('walk'));
    await expect(page.locator('.toast', { hasText: 'Stop Play mode first.' })).toBeVisible();
    expect(await view()).toBe('scene');
    await page.evaluate(() => window.__editor.stopPlay());
});

test('reopens a saved scene the same', async () => {
    const same = await editor.page().evaluate(() => {
        const ed = window.__editor;
        ed.createPrimitive('torus');
        const saved = JSON.stringify(ed.store.doc);
        ed.loadDoc(JSON.parse(saved));
        return JSON.stringify(ed.store.doc) === saved;
    });
    expect(same).toBe(true);
});

test('checks the level from the Design tab', async () => {
    const page = editor.page();
    // Clicks in the page: SwiftShader can stall the frames Playwright's actionability checks wait for.
    const click = (text: string) => page.evaluate((t) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === t)!.click(), text);
    await click('Design');
    await click('Check the level');
    await expect(page.locator('.level-check .design-note')).toHaveText(/\S/);
    await expect(page.locator('.level-map')).toHaveAttribute('src', /^data:image\/png/);
    await click('Close');
    await expect(page.locator('.level-check')).toHaveCount(0);
});

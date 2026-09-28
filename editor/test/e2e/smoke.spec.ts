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

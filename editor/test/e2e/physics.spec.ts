import { expect, test } from '@playwright/test';
import { playFrames, sharedEditor } from './editor';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

test('drops bodies onto the level and tells their scripts what they hit', async () => {
    const page = editor.page();
    await page.evaluate(() => {
        const ed = window.__editor;
        const cube = ed.store.doc.nodes.find((n) => n.name === 'Cube')!;
        ed.store.commit('Drop the Cube', (d) => {
            const n = d.nodes.find((x) => x.id === cube.id)!;
            n.position = [0, 3, 0];
            n.body = { type: 'dynamic', shape: 'auto', mass: 1, friction: 0.5, bounce: 0, drag: 0, angularDrag: 0.05, gravity: 1, lockRotation: false, fast: false, sensor: false };
        });
        ed.createScript({
            name: 'Landing',
            code: [
                'export default class Landing extends Script {',
                '    start() { this.spawn("sphere", { name: "Ball", position: [2, 4, 0], body: { bounce: 0.6 } }); }',
                '    onCollisionEnter(other) { this.log("hit " + other.name); }',
                '}',
            ].join('\n'),
            attachTo: [cube.id],
            open: false,
        });
    });
    await playFrames(page, 10);
    const y = (name: string) => page.evaluate((n) => window.__editor.player.find(n)!.y, name);
    // It falls through the air, then rests on the ground plane (half its height up).
    await expect.poll(() => y('Cube'), { timeout: 60_000 }).toBeLessThan(0.52);
    expect(await y('Cube')).toBeGreaterThan(0.45);
    await expect.poll(() => y('Ball'), { timeout: 60_000 }).toBeLessThan(0.6);
    const run = await page.evaluate(() => ({ logs: window.__editor.player.logs.map((l) => l.text), issues: window.__editor.player.issues }));
    expect(run.issues).toEqual([]);
    expect(run.logs).toContain('[Landing.js on Cube] hit Ground');

    await page.evaluate(() => window.__editor.stopPlay());
    expect(await page.evaluate(() => window.__editor.store.doc.nodes.find((n) => n.name === 'Cube')!.position)).toEqual([0, 3, 0]);
});

test('lets characters walk through triggers and push bodies out of their way', async () => {
    const page = editor.page();
    await page.evaluate(() => {
        const ed = window.__editor;
        const body = { type: 'dynamic' as const, shape: 'auto' as const, mass: 2, friction: 0.5, bounce: 0, drag: 0, angularDrag: 0.05, gravity: 1, lockRotation: false, fast: false, sensor: false };
        ed.createPrimitive('capsule');
        const walker = ed.store.primary!.id;
        ed.store.commit('Setup', (d) => {
            for (const n of d.nodes) {
                if (n.name === 'Cube') Object.assign(n, { position: [2, 0.5, 0], body });
                if (n.name === 'Sphere') Object.assign(n, { position: [-1.5, 1, 0], body: { ...body, type: 'fixed', sensor: true } });
                if (n.id === walker) {
                    Object.assign(n, { name: 'Walker', position: [-4, 0.9, 0] });
                    n.character = { speed: 1.5, runSpeed: 6, jump: 4.5, gravity: 14, height: 1.8, radius: 0.35, eyeHeight: 1.65, stepHeight: 0.3, collide: true };
                }
            }
        });
        ed.createScript({ name: 'Walk', code: 'export default class Walk extends Script {\n    update() { this.character.move(1, 0); }\n}\n', attachTo: [walker], open: false });
        const zone = ed.store.doc.nodes.find((n) => n.name === 'Sphere')!.id;
        ed.createScript({ name: 'Zone', code: 'export default class Zone extends Script {\n    onTriggerEnter(o) { this.log("enter " + o.name); }\n}\n', attachTo: [zone], open: false });
    });
    await playFrames(page, 5);
    const x = (name: string) => page.evaluate((n) => window.__editor.player.find(n)!.x, name);
    await expect.poll(() => x('Cube'), { timeout: 90_000 }).toBeGreaterThan(2.5);
    // The crate stays ahead of the walker that pushes it.
    expect((await x('Cube')) - (await x('Walker'))).toBeGreaterThan(0.8);
    expect(await page.evaluate(() => window.__editor.player.logs.map((l) => l.text))).toContain('[Zone.js on Sphere] enter Walker');
    await page.evaluate(() => window.__editor.stopPlay());
});

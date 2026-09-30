// The editor's core on a device like many phones: without the optional GPU
// features (bgra8unorm-storage, depth-clip-control, depth32float-stencil8,
// indirect-first-instance, rg11b10ufloat-renderable, BC texture
// compression). The engine asks only for what the adapter has, so the
// editor starts, draws, edits, plays and simulates there too.
import { expect, test } from '@playwright/test';
import { playFrames, sharedEditor } from './editor';
import { measure } from './measure';

const HIDDEN = ['bgra8unorm-storage', 'depth-clip-control', 'depth32float-stencil8', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'texture-compression-bc'];

const problems: string[] = [];
const editor = sharedEditor(async (page) => {
    // WebGPU validation errors show in the console only.
    page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
    });
    await page.addInitScript((hidden) => {
        const proto = (globalThis as any).GPUAdapter?.prototype;
        if (!proto) return;
        const features = Object.getOwnPropertyDescriptor(proto, 'features')!.get!;
        // The adapter lists fewer features, and a device asking for a hidden one fails as it would there.
        Object.defineProperty(proto, 'features', {
            get(this: GPUAdapter) {
                const all = features.call(this) as GPUSupportedFeatures;
                return new Set(Array.from(all).filter((f) => !hidden.includes(f)));
            },
        });
        const request = proto.requestDevice;
        proto.requestDevice = function (desc?: GPUDeviceDescriptor) {
            const asked = Array.from(desc?.requiredFeatures ?? []);
            const missing = asked.filter((f) => hidden.includes(f));
            if (missing.length) return Promise.reject(new TypeError(`Unsupported features: ${missing.join(', ')}`));
            return request.call(this, desc);
        };
    }, HIDDEN);
});

test.beforeEach(async () => {
    await editor.reset();
    problems.length = 0;
});
test.afterEach(() => {
    expect(editor.errors).toEqual([]);
    expect(problems).toEqual([]);
});

const names = () => editor.page().evaluate(() => window.__editor.store.doc.nodes.map((n) => n.name));

test('starts and draws without the optional GPU features, edits the scene and undoes the edit', async () => {
    const page = editor.page();
    const device = await page.evaluate(() => {
        const ctx = window.__editor.runtime.engine.context3D;
        return { features: Array.from(ctx.device.features as unknown as Set<string>), support: ctx.compressedTextureSupport };
    });
    for (const f of HIDDEN) expect(device.features).not.toContain(f);
    expect(device.support.bc).toBe(false);
    expect((await measure(page, 3)).draws).toBeGreaterThan(0);

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

test('shares one material among objects that look the same, and gives an edited one its own', async () => {
    const page = editor.page();
    const ids = await page.evaluate(() => {
        const out: string[] = [];
        window.__editor.store.commit('Boxes', (d) => {
            const cube = d.nodes.find((n) => n.name === 'Cube')!;
            for (let i = 0; i < 6; i++) {
                const n = JSON.parse(JSON.stringify(cube));
                n.id = `box${i}`;
                n.name = `Box ${i}`;
                n.position = [-4 + i * 1.3, 0.5, 2];
                n.mesh.material.color = '#d03030';
                d.nodes.push(n);
                out.push(n.id);
            }
        });
        return out;
    });
    await measure(page, 2);
    /** The engine material each box shows (an index into the distinct ones), and how many geometries they use. */
    const materials = () =>
        page.evaluate((ids) => {
            const sync = window.__editor.sync;
            const mats = ids.map((id) => sync.entries.get(id)!.mesh!.materials[0]);
            const distinct = [...new Set(mats)];
            return { of: mats.map((m) => distinct.indexOf(m)), distinct: distinct.length, geometries: new Set(ids.map((id) => sync.entries.get(id)!.mesh!.geometry)).size };
        }, ids);
    expect(await materials()).toMatchObject({ distinct: 1, geometries: 1 });
    // Recolor one: it gets a material of its own; the others keep theirs.
    await page.evaluate(() => window.__editor.store.commit('Recolor', (d) => (d.nodes.find((n) => n.id === 'box3')!.mesh!.material.color = '#2050e0')));
    const m = await materials();
    expect(m.distinct).toBe(2);
    expect(m.of.filter((i) => i === m.of[3]).length).toBe(1);
    // Undo: it looks like the others again, and shares theirs.
    await page.evaluate(() => window.__editor.store.undo());
    expect((await materials()).distinct).toBe(1);
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

test('draws the viewport at its frame rate and quality, and captures at full resolution', async () => {
    const page = editor.page();
    const state = () =>
        page.evaluate(() => {
            const rt = window.__editor.runtime;
            return { fps: rt.engine.frameRate, limit: rt.fpsLimit, ratio: rt.canvas.width / rt.canvas.clientWidth };
        });
    const dpr = await page.evaluate(() => Math.min(window.devicePixelRatio || 1, 2));
    // The tests draw as a phone does (editor.ts): 30 fps, low quality.
    const low = await state();
    expect([low.fps, low.limit]).toEqual([30, 30]);
    expect(low.ratio).toBeCloseTo(Math.max(0.75, dpr / 2), 1);
    await expect(page.locator('.statusbar button.status-item')).toHaveAttribute('title', /at most 30 frames per second in low quality/);

    // A capture (the assistant's, a shot's) is sharp whatever the viewport shows.
    const capture = await page.evaluate(async () => {
        const rt = window.__editor.runtime;
        const url = await rt.capture(4000);
        const img = new Image();
        img.src = url;
        await img.decode();
        return { width: img.naturalWidth, css: rt.canvas.clientWidth, after: rt.canvas.width };
    });
    expect(capture.width).toBeGreaterThanOrEqual(Math.floor(capture.css * dpr) - 1);
    expect(capture.after).toBeLessThan(capture.width);

    await page.evaluate(() => window.__editor.store.setPrefs({ viewportFps: 0, viewportQuality: 'high' }));
    const high = await state();
    expect(high.fps).toBeGreaterThanOrEqual(360);
    expect(high.limit).toBe(0);
    expect(high.ratio).toBeCloseTo(dpr, 1);
    await page.evaluate(() => window.__editor.store.setPrefs({ viewportFps: 30, viewportQuality: 'low' }));
});

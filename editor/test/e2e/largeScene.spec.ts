// A large scene (thousands of objects, test/bench/scene.ts): the hierarchy
// keeps only the rows in view, a gizmo drag costs its listeners little, and
// the viewport draws at a limited frame rate and resolution by default.

import { expect, test } from '@playwright/test';
import { syntheticScene } from '../bench/scene';
import { sharedEditor } from './editor';

// Listener timing (core/perf.ts) is on in this page.
const editor = sharedEditor((page) => page.addInitScript(() => localStorage.setItem('canonical-editor/perf', 'true')));

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

const SCENE = syntheticScene({ nodes: 2500, models: false });

async function loadLarge() {
    const page = editor.page();
    await page.evaluate((doc) => window.__editor.loadDoc(doc), SCENE);
    await expect(page.locator('.hierarchy .tree-row').first()).toBeVisible();
}

test('shows only the rows in view of the hierarchy, and marks a new selection in place', async () => {
    const page = editor.page();
    await loadLarge();
    const rows = page.locator('.hierarchy .tree-row');
    expect(await rows.count()).toBeLessThan(150);

    // An object far down the tree: its row is drawn, scrolled into view and marked.
    const last = SCENE.nodes[SCENE.nodes.length - 1].id;
    await page.evaluate((id) => window.__editor.store.select([id]), last);
    const row = page.locator(`.hierarchy .tree-row[data-id="${last}"]`);
    await expect(row).toHaveClass(/selected/);
    await expect(row).toBeInViewport();

    // Another selection in view, a move and a name change of another object do not draw the other rows again.
    const next = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('.hierarchy .tree-row'));
        rows.forEach((r) => ((r as any).__kept = true));
        return rows.map((r) => r.dataset.id!);
    });
    const other = next[next.length - 5];
    await page.evaluate((id) => {
        const store = window.__editor.store;
        store.select([id]);
        store.commit('Move', (d) => (store.node(id)!.position = [1, 2, 3]), { nodes: [id], transform: true });
    }, other);
    await expect(page.locator(`.hierarchy .tree-row[data-id="${other}"]`)).toHaveClass(/selected/);
    await expect(row).not.toHaveClass(/selected/);
    const kept = await page.evaluate(() => Array.from(document.querySelectorAll('.hierarchy .tree-row')).every((r) => (r as any).__kept));
    expect(kept).toBe(true);

    await page.evaluate((id) => window.__editor.rename(id, 'Renamed Object'), other);
    await expect(page.locator(`.hierarchy .tree-row[data-id="${other}"] .tree-name`)).toHaveText('Renamed Object');
    await page.evaluate(() => window.__editor.store.undo());
    await expect(page.locator(`.hierarchy .tree-row[data-id="${other}"] .tree-name`)).not.toHaveText('Renamed Object');

    // The arrow keys move through every row, also those not drawn.
    await page.evaluate(() => document.querySelector<HTMLElement>('.hierarchy .tree')!.focus());
    await page.keyboard.press('ArrowDown');
    const after = await page.evaluate(() => window.__editor.store.primary?.id);
    expect(after).not.toBe(other);
    await expect(page.locator(`.hierarchy .tree-row[data-id="${after}"]`)).toHaveClass(/selected/);
});

test('drags objects of a large scene with little work besides moving them', async () => {
    const page = editor.page();
    await loadLarge();
    const result = await page.evaluate(async () => {
        const ed = window.__editor;
        const store = ed.store;
        const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        const ids = store.doc.nodes.filter((n) => n.mesh).slice(0, 3).map((n) => n.id);
        store.select(ids);
        await frame();
        await frame();
        const perf = (window as any).__perf;
        perf.reset();
        // A drag as the gizmo makes it: one step, an update on every pointer move (here one a frame).
        const frames = 30;
        store.begin('Move');
        for (let f = 0; f < frames; f++) {
            store.update(() => {
                for (const id of ids) {
                    const n = store.node(id)!;
                    n.position = [n.position[0] + 0.01, n.position[1], n.position[2]];
                }
            }, { nodes: ids, transform: true });
            await frame();
        }
        store.end();
        // Every listener of the document's changes: the engine's, the model's and the views' (once a frame).
        const totals: { event: string; site: string; calls: number; ms: number }[] = perf.totals();
        const changes = totals.filter((t) => t.event === 'change' || t.event === 'change (once a frame)');
        return {
            perFrame: changes.reduce((a, t) => a + t.ms, 0) / frames,
            top: changes.sort((a, b) => b.ms - a.ms).slice(0, 6).map((t) => `${t.event} ${t.site}: ${(t.ms / frames).toFixed(3)} ms`),
            undo: store.undoLabel,
        };
    });
    console.log(`Listener work per drag frame: ${result.perFrame.toFixed(3)} ms\n  ${result.top.join('\n  ')}`);
    expect(result.undo).toBe('Move');
    // The budget is 1 ms (test/bench); the browser here shares the CPU with SwiftShader.
    expect(result.perFrame).toBeLessThan(3);
});

test('draws the viewport at 30 fps and low resolution by default, and captures at full resolution', async () => {
    const page = editor.page();
    const state = () =>
        page.evaluate(() => {
            const rt = window.__editor.runtime;
            const canvas = rt.canvas;
            return { fps: rt.engine.frameRate, limit: rt.fpsLimit, ratio: canvas.width / canvas.clientWidth, prefs: [window.__editor.store.prefs.viewportFps, window.__editor.store.prefs.viewportQuality] };
        });
    const first = await state();
    expect(first.prefs).toEqual([30, 'low']);
    expect(first.fps).toBe(30);
    const dpr = await page.evaluate(() => Math.min(window.devicePixelRatio || 1, 2));
    expect(first.ratio).toBeCloseTo(Math.max(0.75, dpr / 2), 1);
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

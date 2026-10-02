// The assistant in the simple view (the scene and the chat), with OpenRouter
// scripted: a project starts from one request, the tools change the scene,
// the settings limit them, the user stops a request, approves a stage from
// the chat, and sees what the work cost, with images at the quality chosen.

import { expect, test, type Route } from '@playwright/test';
import { scriptedAssistant, sharedEditor, toolResults, USAGE, type ScriptedCall } from './editor';

let assistant: Awaited<ReturnType<typeof scriptedAssistant>>;
const editor = sharedEditor(async (page) => {
    assistant = await scriptedAssistant(page);
}, { simple: true });

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

/** Clicks in the page: SwiftShader can stall the frames Playwright's actionability checks wait for. */
const click = (selector: string, text?: string) =>
    editor.page().evaluate(
        ([s, t]) => {
            const all = Array.from(document.querySelectorAll<HTMLElement>(s!)).filter((el) => !t || el.textContent?.trim() === t);
            all[all.length - 1]!.click();
        },
        [selector, text],
    );

/** Sends a request that the assistant answers with `turns` of tool calls; resolves with the tool results. */
async function ask(turns: ScriptedCall[][], text = 'Build it.'): Promise<unknown[]> {
    const before = assistant.sent.length;
    assistant.turns = [...turns, 'Done.'];
    await editor.page().evaluate((t) => window.__editor.askAI(t, true), text);
    await expect.poll(() => assistant.sent.length, { timeout: 60_000 }).toBe(before + turns.length + 1);
    return toolResults(assistant.sent.slice(before));
}

const node = (name: string) => editor.page().evaluate((n) => window.__editor.store.doc.nodes.find((x) => x.name === n), name);

test('shows only the scene and the chat, and the full editor in edit mode', async () => {
    const page = editor.page();
    await expect(page.locator('.ai-panel')).toBeVisible();
    await expect(page.locator('.hierarchy')).toBeHidden();
    await expect(page.locator('.pipeline-bar')).toBeHidden();
    await click('.mode-toggle');
    await expect(page.locator('.hierarchy')).toBeVisible();
    await expect(page.locator('.pipeline-bar')).toBeVisible();
    await click('.mode-toggle');
    await expect(page.locator('.hierarchy')).toBeHidden();
    expect(await page.evaluate(() => window.__editor.store.prefs.editMode)).toBe(false);
});

test('starts a project from one request: the brief, the assistant, the scene name and the steps', async () => {
    const page = editor.page();
    // The scene the page started with, as a project nobody started yet: the start screen asks again.
    await page.evaluate(() => {
        const ed = window.__editor;
        const doc = JSON.parse(JSON.stringify(ed.store.doc));
        doc.design.id = `p-fresh-${Math.random().toString(36).slice(2)}`;
        ed.loadDoc(doc);
    });
    await expect(page.locator('.start-screen')).toBeVisible();
    await expect(page.locator('.steps-bar')).toBeHidden();
    await page.locator('.start-input').fill('A cozy cabin by a lake at dusk');
    const before = assistant.sent.length;
    assistant.turns = [[{ name: 'update_design', args: { scene_name: 'Lakeside Cabin', layout: { summary: 'A cabin on a small lake shore, 30 x 30 m.' } } }], 'The plan is ready.'];
    await click('.start-go');
    await expect.poll(() => assistant.sent.length, { timeout: 60_000 }).toBe(before + 2);

    await expect(page.locator('.start-screen')).toBeHidden();
    const design = await page.evaluate(() => window.__editor.store.doc.design);
    expect(design.brief.text).toBe('A cozy cabin by a lake at dusk');
    // The chat shows the user's words; the model got them with the instructions to start.
    await expect(page.locator('.ai-panel .ai-msg.user').last()).toHaveText('A cozy cabin by a lake at dusk');
    const request = assistant.sent[before].messages.at(-1).content as string;
    expect(request).toContain('I want to make this: A cozy cabin by a lake at dusk');
    expect(request).toContain('update_design scene_name');
    // The assistant named the scene.
    await expect(page.locator('.scene-name')).toHaveText('Lakeside Cabin');
    await expect(page).toHaveTitle('Lakeside Cabin - Morglay');
    // The user sees three steps, and is asked whether they like it.
    await expect(page.locator('.steps-bar .step')).toHaveCount(3);
    await expect(page.locator('.steps-bar .step.current')).toContainText('Layout');
    await expect(page.locator('.ai-panel .ai-next')).toContainText('Like how it looks?');
});

test('creates and changes objects, the environment and particles with its tools', async () => {
    const results = await ask([
        [{
            name: 'create_objects',
            args: {
                objects: [
                    { type: 'capsule', name: 'Guard', position: [2, 0.9, 0], character: { step_height: 0.5, run_speed: 7 }, material: { color: 'red', roughness: 2, transmission: 0.5 } },
                    { type: 'spot_light', name: 'Lamp', position: [0, 4, 0], light: { outer_angle: 45, cast_shadow: true } },
                    { type: 'box', name: 'Crate', position: [0, 2, 0], body: { mass: 5, bounce: 0.2, shape: 'hull' } },
                ],
            },
        }],
        [
            { name: 'set_environment', args: { bloom: { enable: true, intensity: 1.5 }, fog: { color: '#223344' }, gi: { counts: [40, 2, 40] } } },
            { name: 'add_particles', args: { preset: 'fire', name: 'Fire', position: [0, 0.2, 0], life: [2, 1] } },
        ],
        [{ name: 'update_objects', args: { updates: [{ id: 'Guard', player: { view: 'first' } }] } }],
    ]);
    expect(results.filter((r: any) => r?.error)).toEqual([]);

    const guard = (await node('Guard'))!;
    expect(guard.character).toMatchObject({ stepHeight: 0.5, runSpeed: 7 });
    expect(guard.player!.view).toBe('first');
    expect(guard.mesh!.material).toMatchObject({ color: '#ff0000', roughness: 1, transmission: 0.5 });
    expect((await node('Lamp'))!.light).toMatchObject({ type: 'spot', outerAngle: 45, castShadow: true });
    expect((await node('Crate'))!.body).toMatchObject({ type: 'dynamic', mass: 5, bounce: 0.2, shape: 'hull' });
    expect((await node('Fire'))!.particles!.life).toEqual([1, 2]);
    const env = await editor.page().evaluate(() => window.__editor.store.doc.environment);
    expect(env.bloom).toEqual({ enable: true, intensity: 1.5, threshold: 1, levels: 3, blur: 9 });
    expect(env.fog.color).toBe('#223344');
    expect(env.gi.counts.every((c) => c <= 16)).toBe(true);
});

test('grows a tree and a forest of trees with its tools, and bakes the forest into tree objects', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    const results = await ask([
        [{ name: 'create_objects', args: { objects: [{ type: 'tree', position: [6, 0, 2], tree: { species: 'spruce', autumn: 0.5, leaf_tint: '#ddeecc' } }] } }],
        [{
            name: 'scatter',
            args: { name: 'Wood', position: [0, 0, -20], size: [30, 30], count: 10, spacing: 5, sources: [{ tree: { species: 'birch', seed: 7 } }, { tree: { species: 'oak', height: 12 }, weight: 2, solid: 'none' }] },
        }],
        // Another species keeps the rest of the tree.
        [{ name: 'update_objects', args: { updates: [{ id: 'Spruce', tree: { species: 'oak', height: 9 } }] } }],
        [{ name: 'get_scene', args: {} }],
    ]);
    expect(results.filter((r: any) => r?.error)).toEqual([]);

    const tree = (await node('Spruce'))!;
    expect(tree.tree).toMatchObject({ species: 'oak', height: 9, autumn: 0.5, leafTint: '#ddeecc', solid: true });
    const wood = (await node('Wood'))!;
    // A new tree source is a species' usual tree, solid at its trunk unless told otherwise.
    expect(wood.scatter!.sources.map((s) => [s.model, s.tree?.species, s.tree?.height, s.solid])).toEqual([[null, 'birch', 15, 'trunk'], [null, 'oak', 12, 'none']]);
    expect(wood.scatter!.sources[0].tree!.seed).toBe(7);
    const placed = results[1] as { copies: number; sources: { tree: string; copies: number }[]; solid_copies: number };
    expect(placed.copies).toBeGreaterThan(3);
    expect(placed.sources.map((s) => s.tree)).toEqual(['birch', 'oak']);
    expect(placed.solid_copies).toBe(placed.sources[0].copies);
    const listed = (results[3] as { objects: { name: string; type: string; tree?: unknown; scatter?: { sources: unknown[] } }[] }).objects;
    expect(listed.find((o) => o.name === 'Spruce')).toMatchObject({ type: 'tree', tree: { species: 'oak', height: 9, autumn: 0.5 } });
    expect(listed.find((o) => o.name === 'Wood')!.scatter!.sources[0]).toMatchObject({ tree: { species: 'birch', seed: 7, height: 15 }, solid: 'trunk' });

    // Both are drawn; the tree's trunk and the birches' stop characters in Play.
    const drawn = await page.evaluate(([t, w]) => {
        const { sync } = window.__editor;
        return {
            levels: sync.treeView(t)?.levelTriangles() ?? [],
            wood: sync.treeView(w)?.report() ?? '',
            solids: Object.fromEntries(sync.scatterSolids().filter((x) => x.id === t || x.id === w).map((x) => [x.id === t ? 'tree' : 'wood', x.solids.length])),
        };
    }, [tree.id, wood.id]);
    expect(drawn.levels.length).toBe(3);
    expect(drawn.levels[0]).toBeGreaterThan(drawn.levels[1] * 3);
    expect(drawn.levels[1]).toBeGreaterThan(drawn.levels[2]);
    expect(drawn.wood).toMatch(new RegExp(`^${placed.copies} trees`));
    expect(drawn.solids).toEqual({ tree: 1, wood: placed.sources[0].copies });

    // Baked, each copy is a tree object growing the variant it grew as.
    const [baked] = (await ask([[{ name: 'scatter', args: { object: 'Wood', bake: true } }]])) as { group: string; objects: number }[];
    expect(baked.objects).toBe(placed.copies);
    const copies = await page.evaluate((g) => window.__editor.store.children(g).map((n) => n.tree!), baked.group);
    const birches = copies.filter((c) => c.species === 'birch');
    expect(birches.length).toBe(placed.sources[0].copies);
    for (const b of birches) expect([7, 7926, 15845, 23764]).toContain(b.seed);
    expect(copies.filter((c) => c.species === 'oak').every((c) => c.height === 12 && !c.solid)).toBe(true);
});

test('offers only the tools the AI settings allow and refuses the others', async () => {
    const [result] = await ask([[{ name: 'play', args: {} }]]);
    expect((result as { error: string }).error).toBe('Play is turned off in the AI settings.');
    const names = (assistant.sent[assistant.sent.length - 1].tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toContain('get_scene');
    for (const off of ['play', 'run_play_test', 'capture_viewport', 'generate_swatch', 'generate_concept']) expect(names).not.toContain(off);
});

test('stops the assistant from over the view', async () => {
    const page = editor.page();
    // The model's answer is held until the test lets it go.
    const held: Route[] = [];
    const hold = (route: Route) => void held.push(route);
    await page.route('**/api/v1/chat/completions', hold);
    try {
        await page.evaluate(() => window.__editor.askAI('Build a small park.', true));
        const status = page.locator('.viewport .ai-status');
        await expect(status).toBeVisible();
        await expect(status).toContainText('Thinking...');
        await expect(page.locator('.ai-panel .ai-send')).toHaveText('Stop');
        await click('.viewport .ai-status-stop');
        await expect(status).toBeHidden();
        await expect(page.locator('.ai-panel .ai-msg.note').last()).toHaveText('Stopped.');
        await expect(page.locator('.ai-panel .ai-send')).toHaveText('Send');
        await expect(page.locator('.ai-panel .ai-next')).toContainText('Keep going');
    } finally {
        await page.unroute('**/api/v1/chat/completions', hold);
        for (const r of held) await r.abort().catch(() => {});
    }
});

test('completes the stage the assistant proposes from the chat', async () => {
    const page = editor.page();
    await ask([[{ name: 'propose_stage_complete', args: { summary: 'The areas and the layout are in the plan.' } }]], 'Go on.');
    const card = page.locator('.ai-panel .ai-msg.approval').last();
    await expect(card).toContainText('Brief is done. Happy with it?');
    await expect(card).toContainText('The areas and the layout are in the plan.');
    // While the approval waits, the chat offers nothing else.
    await expect(page.locator('.ai-panel .ai-next')).toBeHidden();

    await click('.ai-panel .ai-msg.approval button', 'Looks good');
    // Checklist items are still open: the same question as in the Design tab.
    await expect(page.locator('.dialog')).toContainText('Complete Brief?');
    await click('.dialog button', 'Complete Anyway');
    await expect.poll(() => page.evaluate(() => window.__editor.store.doc.design.stage)).toBe('level');
    expect(await page.evaluate(() => window.__editor.store.doc.design.stages.brief.proposal)).toBeNull();
    await expect(card).toContainText('Brief is complete.');
    // Then the user says whether they like it, and the assistant keeps going.
    await expect(page.locator('.ai-panel .ai-next')).toContainText('Like how it looks?');
});

test('sends attached images at the quality chosen, and counts what each request spent', async () => {
    const page = editor.page();
    await page.evaluate(async () => {
        await window.__editor.usage.loading;
        window.__editor.usage.clear();
    });
    // A 1200 x 800 picture dropped on the chat.
    await page.evaluate(async () => {
        const c = new OffscreenCanvas(1200, 800);
        const g = c.getContext('2d')!;
        g.fillStyle = '#3080e0';
        g.fillRect(0, 0, 1200, 800);
        const file = new File([await c.convertToBlob({ type: 'image/png' })], 'Sketch.png', { type: 'image/png' });
        const data = new DataTransfer();
        data.items.add(file);
        document.querySelector('.ai-panel')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await expect(page.locator('.ai-attachments .ai-attachment')).toHaveCount(1);
    // Images the assistant sees: low.
    await click('.ai-quality');
    await click('.ai-quality-popover .seg[aria-label="Images the assistant sees"] .seg-btn', 'Low');
    await expect(page.locator('.ai-quality')).toHaveText('Low / Medium');
    await page.keyboard.press('Escape');

    const before = assistant.sent.length;
    assistant.turns = ['It is a blue sketch.'];
    await page.locator('.ai-input').fill('What is on it?');
    await click('.ai-send');
    await expect.poll(() => assistant.sent.length, { timeout: 60_000 }).toBe(before + 1);
    const image = (assistant.sent[before].messages.at(-1).content as any[]).find((p) => p.type === 'image_url').image_url;
    expect(image.detail).toBe('low');
    const size = await page.evaluate(async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        return [img.naturalWidth, img.naturalHeight];
    }, image.url);
    expect(size).toEqual([512, 341]);

    // The request is one piece of work in the project's usage, with what the model reported.
    await expect.poll(() => page.evaluate(() => window.__editor.usage.entries.filter((e) => !e.running).length)).toBe(1);
    const entry = await page.evaluate(() => window.__editor.usage.entries[0]);
    expect(entry).toMatchObject({ kind: 'request', label: 'What is on it?', model: 'test/model', calls: 1, prompt: USAGE.prompt_tokens, cached: 1000, completion: USAGE.completion_tokens, sent: 1, seeQuality: 'low' });
    await expect(page.locator('.ai-usage')).toHaveText('1.5k tok · 67% cached · $0.0020');
    await click('.ai-usage');
    await expect(page.locator('.usage-modal .usage-table').first()).toContainText('Assistant requests');
    await expect(page.locator('.usage-modal')).toContainText('1 sent (low)');
    await click('.usage-modal .dialog-footer button', 'Close');

    // Back to the default for the tests after this one.
    await click('.ai-quality');
    await click('.ai-quality-popover .seg[aria-label="Images the assistant sees"] .seg-btn', 'Medium');
    await page.keyboard.press('Escape');
});

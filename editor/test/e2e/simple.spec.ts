// The simple view: the scene and the chat. A project starts with one
// question, the assistant runs the pipeline and names the scene, the user
// sees three steps and can stop the assistant from over the view.

import { expect, test, type Route } from '@playwright/test';
import { scriptedAssistant, sharedEditor } from './editor';

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

/** Opens the scene the page started with as a project nobody started yet (the start screen asks again). */
const freshProject = () =>
    editor.page().evaluate(() => {
        const ed = window.__editor;
        const doc = JSON.parse(JSON.stringify(ed.store.doc));
        doc.design.id = `p-fresh-${Math.random().toString(36).slice(2)}`;
        ed.loadDoc(doc);
    });

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
    await freshProject();
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

test('renames the scene from the top bar', async () => {
    const page = editor.page();
    await click('.scene-name');
    const input = page.locator('.scene-name-input');
    await expect(input).toBeVisible();
    await input.fill('Harbor at Night');
    await input.press('Enter');
    await expect(page.locator('.scene-name')).toHaveText('Harbor at Night');
    expect(await page.evaluate(() => window.__editor.store.doc.name)).toBe('Harbor at Night');
    await page.evaluate(() => window.__editor.store.undo());
    await expect(page.locator('.scene-name')).toHaveText('Untitled Scene');
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

test('shows submenus opaque, in the text color, over a hovered item', async () => {
    const page = editor.page();
    await click('.menubar-item', 'Create');
    const item = page.locator('.menu.dropdown .menu-item.has-sub', { hasText: 'Particles' });
    await item.hover();
    const sub = item.locator('.submenu');
    await expect(sub).toBeVisible();
    const look = await sub.evaluate((el) => {
        const first = el.querySelector('.menu-item') as HTMLElement;
        const alpha = (c: string) => Number(/rgba?\([^)]*?,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+))?\)/.exec(c)?.[1] ?? '1');
        const bg = getComputedStyle(el).backgroundColor;
        return { text: getComputedStyle(first).color, parent: getComputedStyle(el.closest('.menu-item.has-sub')!).color, body: getComputedStyle(document.body).color, alpha: alpha(bg) };
    });
    // Not the dark text of the hovered item around it.
    expect(look.text).toBe(look.body);
    expect(look.text).not.toBe(look.parent);
    expect(look.alpha).toBeGreaterThan(0.9);
    await page.keyboard.press('Escape');
});

test('never locks placement: a change after the layout was done marks it for a recheck', async () => {
    const page = editor.page();
    // Through the Brief and Level stages as the assistant completes them: the Level stage records its layout.
    await page.evaluate(async () => {
        const ed = window.__editor;
        ed.store.commit('Test: Brief', (d) => (d.design.brief.text = 'A cabin by a lake'), { design: true });
        await ed.pipeline.complete(true);
        await ed.pipeline.complete(true);
    });
    expect(await page.evaluate(() => window.__editor.store.doc.design.stage)).toBe('light');
    await expect(page.locator('.steps-bar .step').first()).toHaveClass(/done/);
    await expect(page.locator('.steps-bar .step').first()).not.toHaveClass(/recheck/);
    // A light moves: the layout stays as it was.
    await page.evaluate(() => {
        const ed = window.__editor;
        const sun = ed.store.doc.nodes.find((n) => n.light)!;
        ed.store.commit('Test: Turn the Sun', (d) => (d.nodes.find((n) => n.id === sun.id)!.rotation = [30, 60, 0]), { nodes: [sun.id], transform: true });
    });
    await expect(page.locator('.steps-bar .step').first()).not.toHaveClass(/recheck/);
    // Deleting an object of the level in the Lighting stage goes through (it was refused before) and marks the layout.
    const gone = await page.evaluate(() => {
        const ed = window.__editor;
        const cube = ed.store.doc.nodes.find((n) => n.name === 'Cube')!;
        ed.store.select([cube.id]);
        ed.deleteSelection();
        return !ed.store.node(cube.id);
    });
    expect(gone).toBe(true);
    await expect(page.locator('.steps-bar .step').first()).toHaveClass(/recheck/);
    // Completing the stages saved versions of the scene.
    expect(await page.evaluate(() => window.__editor.store.doc.design.snapshots.map((s) => s.name))).toEqual(['Brief complete', 'Level complete']);
});

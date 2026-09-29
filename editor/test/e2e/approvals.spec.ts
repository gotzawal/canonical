// What the assistant proposes (completing a stage, concept images) is
// approved in the chat, as in the Design tab, and both show the same.

import { expect, test } from '@playwright/test';
import { scriptedAssistant, sharedEditor, type ScriptedCall } from './editor';

/** A 2 x 2 PNG the image model "draws". */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM4UWET1XOCQWNB1J0TAQArBgZBKL6xYAAAAABJRU5ErkJggg==';

let assistant: Awaited<ReturnType<typeof scriptedAssistant>>;
const editor = sharedEditor(async (page) => {
    assistant = await scriptedAssistant(page);
    // Image generation allowed, answered here.
    await page.addInitScript(() => {
        const s = JSON.parse(localStorage.getItem('canonical-editor/ai') || '{}');
        localStorage.setItem('canonical-editor/ai', JSON.stringify({ ...s, allowImages: true }));
    });
    await page.route('**/api/v1/images/models', (route) => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/images', (route) => route.fulfill({ json: { data: [{ b64_json: PNG }] } }));
});

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

async function ask(turns: ScriptedCall[][]) {
    const before = assistant.sent.length;
    assistant.turns = [...turns, 'Done.'];
    await editor.page().evaluate(() => window.__editor.askAI('Go on.', true));
    await expect.poll(() => assistant.sent.length, { timeout: 60_000 }).toBe(before + turns.length + 1);
}

/** Clicks a button by its text inside `scope` (Playwright's clicks wait on frames, which SwiftShader can stall). */
const click = (scope: string, text: string) =>
    editor.page().evaluate(
        ([scope, text]) => {
            const all = Array.from(document.querySelectorAll<HTMLButtonElement>(`${scope} button`)).filter((b) => b.textContent?.trim() === text);
            all[all.length - 1]!.click();
        },
        [scope, text],
    );

test('completes the stage the assistant proposes from the chat', async () => {
    const page = editor.page();
    await ask([[{ name: 'propose_stage_complete', args: { summary: 'The areas and the layout are in the plan.' } }]]);
    const card = page.locator('.ai-panel .ai-msg.approval').last();
    await expect(card).toContainText('The assistant proposes completing Brief');
    await expect(card).toContainText('The areas and the layout are in the plan.');

    await click('.ai-panel .ai-msg.approval', 'Complete Brief');
    // Checklist items are still open: the same question as in the Design tab.
    await expect(page.locator('.dialog')).toContainText('Complete Brief?');
    await click('.dialog', 'Complete Anyway');
    await expect.poll(() => page.evaluate(() => window.__editor.store.doc.design.stage)).toBe('level');
    expect(await page.evaluate(() => window.__editor.store.doc.design.stages.brief.proposal)).toBeNull();
    await expect(card).toContainText('Brief is complete.');
    await expect(card.getByRole('button', { name: 'Go on with Level' })).toBeVisible();
});

test('approves or rejects the concept images the assistant made, from the chat', async () => {
    const page = editor.page();
    await ask([[{ name: 'generate_concept', args: { view: 'overview', count: 2 } }]]);
    const card = page.locator('.ai-panel .ai-msg.approval').last();
    await expect(card).toContainText('Concept images to review');
    await expect(card.locator('.ai-approval-tile')).toHaveCount(2);
    const concepts = () => page.evaluate(() => window.__editor.store.doc.design.concepts.map((c) => c.review ?? 'given'));
    expect(await concepts()).toEqual(['proposed', 'proposed']);

    await click('.ai-panel .ai-msg.approval .ai-approval-tile:first-child', 'Approve');
    await expect.poll(concepts).toEqual(['approved', 'proposed']);
    await expect(card.locator('.ai-approval-tile').first()).toContainText('Approved');

    // Decided in the Design tab, the chat shows it too.
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.pipeline.reviewConcepts([ed.store.doc.design.concepts[1].asset], false);
    });
    await expect(card.locator('.ai-approval-tile').nth(1)).toContainText('Rejected');
    expect(await concepts()).toEqual(['approved']);
});

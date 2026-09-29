// Helpers for browser tests: the editor is window.__editor once it runs.
import { test, type Page } from '@playwright/test';
import type { Editor } from '../../src/editor';

declare global {
    interface Window {
        __editor: Editor;
    }
}

/**
 * One editor page for the tests of a file, run in order: SwiftShader takes
 * half a minute to compile the shaders of a page. Every test starts from the
 * new scene the page opened with (`reset`); `errors` collects page errors.
 * `setup` runs before the page loads (routes, init scripts). The page shows
 * the full editor (edit mode) unless `simple`, with the start screen closed.
 */
export function sharedEditor(setup?: (page: Page) => Promise<void>, opts: { simple?: boolean } = {}): { page: () => Page; errors: string[]; reset: () => Promise<void> } {
    let page: Page;
    let initial = '';
    const errors: string[] = [];
    test.describe.configure({ mode: 'serial' });
    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.addInitScript((edit) => {
            const prefs = JSON.parse(localStorage.getItem('canonical-editor/prefs') || '{}');
            // Texture compression runs only where a test asks for it: it is CPU work SwiftShader competes with.
            localStorage.setItem('canonical-editor/prefs', JSON.stringify({ backgroundCompression: false, ...prefs, editMode: edit }));
        }, !opts.simple);
        await setup?.(page);
        await page.goto('/');
        // SwiftShader can stop drawing for seconds after a load: poll by time, not by frames.
        await page.waitForFunction(
            () => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'),
            null,
            { polling: 100, timeout: 120_000 },
        );
        initial = await page.evaluate(() => {
            // "Not now": this project does not ask again, also after reset.
            document.querySelector<HTMLButtonElement>('.start-screen:not([hidden]) .start-close')?.click();
            return JSON.stringify(window.__editor.store.doc);
        });
    });
    test.afterAll(async () => {
        await page?.close();
    });
    const reset = async () => {
        await page.evaluate((doc) => {
            const ed = window.__editor;
            if (ed.player.state !== 'stopped') ed.stopPlay();
            ed.loadDoc(JSON.parse(doc));
        }, initial);
    };
    return { page: () => page, errors, reset };
}

/** Starts Play and waits until it has run `frames` frames. */
export async function playFrames(page: Page, frames: number) {
    await page.evaluate(() => window.__editor.play());
    await page.waitForFunction((n) => window.__editor.player.time.frame >= n, frames, { polling: 100, timeout: 120_000 });
}

/** A tool call of a scripted assistant turn. */
export interface ScriptedCall {
    name: string;
    args: Record<string, unknown>;
}

/**
 * Stands in for OpenRouter: every request of the assistant gets the next
 * turn of `turns` (tool calls, or a text that ends the request). `sent`
 * collects the request bodies (their tools and the tool results).
 */
export async function scriptedAssistant(page: Page): Promise<{ turns: (ScriptedCall[] | string)[]; sent: any[] }> {
    const state = { turns: [] as (ScriptedCall[] | string)[], sent: [] as any[] };
    await page.addInitScript(() => {
        localStorage.setItem('canonical-editor/openrouter-key', 'test-key');
        localStorage.setItem('canonical-editor/ai', JSON.stringify({ model: 'test/model', memo: false, screenshots: false, allowPlay: false, allowImages: false, limitTools: false }));
    });
    await page.route('**/api/v1/models', (route) =>
        route.fulfill({
            json: {
                data: [
                    { id: 'test/model', name: 'Test Model', context_length: 200000, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
                    { id: 'acme/fast', name: 'Acme Fast', context_length: 100000, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
                    { id: 'acme/plain', name: 'Acme Plain', context_length: 100000, supported_parameters: [], architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
                ],
            },
        }),
    );
    await page.route('**/api/v1/chat/completions', (route) => {
        const body = route.request().postDataJSON();
        state.sent.push(body);
        const turn = state.turns.shift() ?? 'Done.';
        const delta = typeof turn === 'string'
            ? { content: turn }
            : { tool_calls: turn.map((c, index) => ({ index, id: `call_${state.sent.length}_${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
        const chunk = { choices: [{ delta, finish_reason: typeof turn === 'string' ? 'stop' : 'tool_calls' }] };
        return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` });
    });
    return state;
}

/** The results of the tools the assistant called for the latest request, in order. */
export function toolResults(sent: any[]): unknown[] {
    const messages: any[] = sent[sent.length - 1]?.messages ?? [];
    const start = messages.map((m) => m.role).lastIndexOf('user');
    return messages.slice(start).filter((m) => m.role === 'tool').map((m) => JSON.parse(typeof m.content === 'string' ? m.content : m.content[0].text));
}

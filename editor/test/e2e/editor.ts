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
 */
export function sharedEditor(): { page: () => Page; errors: string[]; reset: () => Promise<void> } {
    let page: Page;
    let initial = '';
    const errors: string[] = [];
    test.describe.configure({ mode: 'serial' });
    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto('/');
        // SwiftShader can stop drawing for seconds after a load: poll by time, not by frames.
        await page.waitForFunction(
            () => !!window.__editor && !!document.querySelector('.viewport canvas.gpu') && !document.querySelector('.viewport-loading'),
            null,
            { polling: 100, timeout: 120_000 },
        );
        initial = await page.evaluate(() => {
            const skip = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Work without a brief');
            skip?.click();
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

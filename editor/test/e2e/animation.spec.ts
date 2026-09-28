import { expect, test, type Page } from '@playwright/test';
import { playFrames, sharedEditor } from './editor';
import { rigGltf } from './rig';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

/** Imports the two-bone rig (Idle, Walk and Run clips); resolves with its node id once it has loaded. */
async function importRig(page: Page): Promise<string> {
    const id = await page.evaluate(async (text) => {
        const ed = window.__editor;
        await ed.importFiles([new File([text], 'Rig.gltf', { type: 'model/gltf+json' })]);
        return ed.store.doc.nodes.find((n) => n.model)!.id;
    }, rigGltf());
    await page.waitForFunction((id) => window.__editor.sync.modelState(id)?.status === 'ready', id, { polling: 100, timeout: 60_000 });
    return id;
}

/** The clip the engine's animator of a model plays. */
const playing = (page: Page, id: string) => page.evaluate((id) => (window.__editor.sync.modelInfo(id)!.animator as any)._currentSkeletonClip?.clip.clipName, id);

test('lists the clips of a model and previews the chosen one', async () => {
    const page = editor.page();
    const id = await importRig(page);
    expect(await page.evaluate((id) => window.__editor.sync.modelInfo(id)!.clips, id)).toEqual(['Idle', 'Walk', 'Run']);
    expect(await playing(page, id)).toBe('Idle');

    await page.evaluate((id) => window.__editor.store.select([id]), id);
    const section = page.locator('.side.right section', { hasText: 'Animation' });
    await expect(section).toBeVisible();
    // The Clip select offers the file's clips; choosing one plays it in the view.
    await section.locator('select').first().selectOption('Run');
    expect(await page.evaluate((id) => window.__editor.store.node(id)!.animation?.clip, id)).toBe('Run');
    expect(await playing(page, id)).toBe('Run');
});

test("plays a character's clip for its mode, and clips scripts ask for", async () => {
    const page = editor.page();
    const id = await importRig(page);
    await page.evaluate((id) => {
        const ed = window.__editor;
        ed.store.commit('Walker', (d) => {
            d.nodes.find((n) => n.id === id)!.character = { speed: 1.5, runSpeed: 6, jump: 4.5, gravity: 14, height: 1.8, radius: 0.35, eyeHeight: 1.65, stepHeight: 0.3, collide: true };
        });
        ed.createScript({
            name: 'Stroll',
            code: [
                'export default class Stroll extends Script {',
                '    start() { this.log("clips " + this.animator.clips.join(",")); }',
                '    update() { if (this.time.elapsed < 3) this.character.move(1, 0); else this.animator.play("Run", 0); }',
                '}',
            ].join('\n'),
            attachTo: [id],
            open: false,
        });
    }, id);
    await playFrames(page, 3);
    await expect.poll(() => page.evaluate((id) => window.__editor.player.animator(id)?.clip, id), { timeout: 60_000 }).toBe('Walk');
    await expect.poll(() => playing(page, id), { timeout: 60_000 }).toBe('Run');
    expect(await page.evaluate(() => window.__editor.player.logs.map((l) => l.text))).toContain('[Stroll.js on Rig] clips Idle,Walk,Run');
    await page.evaluate(() => window.__editor.stopPlay());
});

// Compressed copies of textures (derive/): made in a worker, shown in the
// view in place of the file, made again for other options, and shipped
// with built games, which play them.
import { expect, test } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { png } from './fixtures';
import { card, shown, view, buildZip, playGame, quarters, differing } from './copies';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

test('shows the compressed copy of a texture in place, the same way up and in the same colors', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    const asset = await card(page);
    await measure(page, 2);
    const before = await shown(page, asset);
    expect(before).toMatchObject({ format: 'rgba8unorm-srgb', bound: true });
    const original = await view(page);
    // The card fills the middle: every quarter shows.
    for (const share of quarters(original)) expect(share).toBeGreaterThan(0.1);

    // Made now (as a build would), then swapped into the same texture.
    const copy = await page.evaluate(async (asset) => {
        const ed = window.__editor;
        const meta = ed.store.doc.assets.find((a) => a.id === asset)!;
        const rec = await ed.derived.ensure(meta, 'color');
        return rec && { bytes: rec.bytes, width: rec.width, height: rec.height, codec: rec.opts.codec, status: ed.derived.statusOf(meta, 'color').state };
    }, asset);
    expect(copy).toMatchObject({ width: 256, height: 256, codec: 'etc1s', status: 'ready' });
    await measure(page, 2);
    const after = await shown(page, asset);
    expect(after.bound).toBe(true);
    expect(after.format).toMatch(/^(etc2|bc[17]|astc).*-srgb$/);
    // 256 x 256 with mips: 349,524 bytes as RGBA8, an eighth as ETC2 or BC1.
    expect(before.images - after.images).toBeGreaterThan(250_000);
    const compressed = await view(page);
    const off = differing(original, compressed);
    console.log(`Copy: ${copy!.bytes} bytes; ${(off * 100).toFixed(2)}% of the view differs from the file; quarters ${quarters(compressed).map((q) => q.toFixed(2))}`);
    expect(off).toBeLessThan(0.03);
});

test('keeps a texture two slots of a material show bound while its data changes in place', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    const problems: string[] = [];
    const onConsole = (m: import('@playwright/test').ConsoleMessage) => {
        if (m.type() === 'error') problems.push(m.text());
    };
    page.on('console', onConsole);
    try {
        const asset = await card(page, 'Orm.png');
        // Lit, with the texture as its metal-roughness and occlusion map (one ORM map: the same data texture in two slots).
        await page.evaluate((asset) => {
            window.__editor.store.commit('ORM', (d) => {
                const m = d.nodes[0].mesh!.material;
                m.type = 'lit';
                m.map = null;
                m.metalRoughMap = asset;
                m.aoMap = asset;
            });
        }, asset);
        await measure(page, 2);
        // One slot let go of it; the other still shows it.
        await page.evaluate(() => window.__editor.store.commit('No AO', (d) => void delete d.nodes[0].mesh!.material.aoMap));
        await measure(page, 2);
        // Its copy is made: the texture takes the new data in place, and the material rebinds it.
        const format = await page.evaluate(async (asset) => {
            const ed = window.__editor;
            await ed.derived.ensure(ed.store.doc.assets.find((a) => a.id === asset)!, 'data');
            await ed.sync.whenLoaded();
            return ((await ed.sync.loadTexture(asset, 'data')) as any).format as string;
        }, asset);
        await measure(page, 3);
        expect(format).not.toMatch(/^rgba8/);
        expect(problems).toEqual([]);
    } finally {
        page.off('console', onConsole);
    }
});

test('makes copies in the background, again for new options, and keeps them out of the document', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    await page.evaluate(() => window.__editor.store.setPrefs({ backgroundCompression: true }));
    try {
        const asset = await card(page, 'Background.png');
        // Shown once, so queued once: the view swaps it in when it is made.
        await expect.poll(() => page.evaluate((asset) => {
            const ed = window.__editor;
            return ed.derived.statusOf(ed.store.doc.assets.find((a) => a.id === asset)!, 'color').state;
        }, asset), { timeout: 120_000 }).toBe('ready');
        await expect.poll(async () => (await shown(page, asset)).format, { timeout: 60_000 }).toMatch(/-srgb$/);
        expect((await shown(page, asset)).format).not.toBe('rgba8unorm-srgb');

        // Off: the file again. Undo: the copy made before, without encoding again.
        await page.evaluate((asset) => window.__editor.setTextureCompression(asset, { mode: 'off' }), asset);
        expect(await shown(page, asset)).toMatchObject({ format: 'rgba8unorm-srgb', bound: true });
        await page.evaluate(() => window.__editor.store.undo());
        expect((await shown(page, asset)).format).not.toBe('rgba8unorm-srgb');
        expect(await page.evaluate(() => window.__editor.derived.pending)).toBe(0);

        // Only the options are in the document.
        const saved = await page.evaluate((asset) => JSON.stringify(window.__editor.store.doc.assets.find((a) => a.id === asset)), asset);
        expect(saved).not.toContain('ktx2');
        expect(JSON.parse(saved)).toMatchObject({ kind: 'texture', hash: expect.any(String) });
    } finally {
        await page.evaluate(() => window.__editor.store.setPrefs({ backgroundCompression: false }));
    }
});

test('builds a game with the compressed copies and only the decoders it needs, which plays them', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = editor.page();
    const asset = await card(page, 'Shipped.png');
    const zip = await buildZip(page);

    const game = JSON.parse(new TextDecoder().decode(zip.get('game.json')!));
    const copyPath = game.derived?.[`${asset}|color`];
    expect(copyPath).toMatch(new RegExp(`^media/${asset}-Shipped\\.color\\.ktx2$`));
    expect(Array.from(zip.get(copyPath)!.subarray(0, 4))).toEqual([0xab, 0x4b, 0x54, 0x58]);
    // Every role has a copy, so the file itself stays home.
    expect(game.files[asset]).toBeUndefined();
    const names = Array.from(zip.keys());
    expect(names.some((n) => /_KTX2Assets-.*\.js$/.test(n))).toBe(true);
    expect(names.some((n) => /basis_transcoder-.*\.wasm$/.test(n))).toBe(true);
    expect(names.some((n) => /_DracoAssets|draco_decoder|meshopt_decoder/.test(n))).toBe(false);

    // The game, served as a static site, plays the copy.
    const format = await playGame(browser, zip, (player) =>
        player.evaluate(async (asset) => {
            const p = (window as any).__player;
            await p.sync.whenLoaded();
            return (await p.sync.loadTexture(asset, 'color')).format;
        }, asset),
    );
    expect(format).toMatch(/^(etc2|bc[17]|astc).*-srgb$/);
});

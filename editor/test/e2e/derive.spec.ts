// Compressed copies of textures (derive/): made in a worker, shown in the
// view in place of the file, made again for other options, and shipped
// with built games, which play them.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { unzip } from './fixtures';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

/**
 * A 4 x 4 m card seen from above, unlit, with a 256-pixel texture of four
 * colored quarters (which shows a flipped or turned copy); resolves with
 * the texture's asset id.
 */
async function card(page: Page, name = 'Quarters.png'): Promise<string> {
    return page.evaluate(async (name) => {
        const ed = window.__editor;
        ed.store.commit('Card', (d) => {
            d.nodes = d.nodes.filter((n) => n.name === 'Ground');
            const g = d.nodes[0];
            g.mesh!.geometry = { type: 'plane', width: 4, height: 4 };
            g.mesh!.material.type = 'unlit';
            g.mesh!.material.color = '#ffffff';
            d.environment.sky = 'color';
            d.environment.skyColor = '#000000';
        });
        ed.store.select([ed.store.doc.nodes[0].id]);
        ed.store.setCamera({ ...ed.store.camera, target: [0, 0, 0], yaw: 0, pitch: 89, distance: 5 });
        const c = new OffscreenCanvas(256, 256);
        const g = c.getContext('2d')!;
        const quarters = ['#e02020', '#20c020', '#2040e0', '#e0d020'];
        quarters.forEach((color, i) => {
            g.fillStyle = color;
            g.fillRect((i % 2) * 128, Math.floor(i / 2) * 128, 128, 128);
        });
        const blob = await c.convertToBlob({ type: 'image/png' });
        await ed.importFiles([new File([blob], name, { type: 'image/png' })]);
        return ed.store.doc.assets.find((a) => a.name === name)!.id;
    }, name);
}

/** The card's texture as SceneSync shows it: format, and whether the material still binds that same object. */
function shown(page: Page, asset: string) {
    return page.evaluate(async (asset) => {
        const ed = window.__editor;
        await ed.sync.whenLoaded();
        const tex = (await ed.sync.loadTexture(asset, 'color')) as any;
        const mat = ed.sync.renderersOf(ed.store.doc.nodes[0].id)[0].materials[0] as any;
        return { format: tex.format as string, bound: mat.shader.getTexture('baseMap') === tex, images: ed.runtime.stats!.snapshot().memory.textures.image.bytes as number };
    }, asset);
}

/** The middle of the view as RGB rows. */
function view(page: Page): Promise<{ w: number; h: number; data: number[] }> {
    return page.evaluate(async () => {
        const rt = window.__editor.runtime;
        const [w, h] = rt.cssSize;
        const blob = await rt.captureFrame({ type: 'image/png', frames: 3, maxWidth: 160, crop: { x: w / 2 - 120, y: h / 2 - 120, w: 240, h: 240 } });
        const bmp = await createImageBitmap(blob);
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const data: number[] = [];
        for (let i = 0; i < d.length; i += 4) data.push(d[i], d[i + 1], d[i + 2]);
        return { w: bmp.width, h: bmp.height, data };
    });
}

/** Share of pixels close to each color of the card's quarters (red, green, blue, yellow). */
function quarters(img: { data: number[] }): number[] {
    const colors = [[224, 32, 32], [32, 192, 32], [32, 64, 224], [224, 208, 32]];
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < img.data.length; i += 3) {
        colors.forEach((c, k) => {
            if (Math.max(Math.abs(img.data[i] - c[0]), Math.abs(img.data[i + 1] - c[1]), Math.abs(img.data[i + 2] - c[2])) < 48) counts[k]++;
        });
    }
    return counts.map((n) => n / (img.data.length / 3));
}

/** Share of pixels that differ by more than `tolerance` in a channel. */
function differing(a: { data: number[] }, b: { data: number[] }, tolerance = 40): number {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 3) {
        if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > tolerance) n++;
    }
    return n / (a.data.length / 3);
}

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
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+b');
    const dialog = page.locator('.build-dialog');
    await expect(dialog).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 240_000 });
    await dialog.getByRole('button', { name: 'Download .zip' }).click();
    const zip = unzip(readFileSync(await (await download).path()));
    await page.keyboard.press('Escape');

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
    const context = await browser.newContext();
    try {
        await context.route('https://game.test/**', (route) => {
            const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1)) || 'index.html';
            const body = zip.get(path);
            if (!body) return route.fulfill({ status: 404, body: 'missing' });
            const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml' }[path.split('.').pop()!] ?? 'application/octet-stream';
            return route.fulfill({ status: 200, body: Buffer.from(body), contentType: type });
        });
        const player = await context.newPage();
        const problems: string[] = [];
        player.on('pageerror', (e) => problems.push(e.message));
        player.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
        await player.goto('https://game.test/index.html');
        await player.waitForFunction(() => !!(window as any).__player, null, { polling: 200, timeout: 150_000 });
        const format = await player.evaluate(async (asset) => {
            const p = (window as any).__player;
            await p.sync.whenLoaded();
            return (await p.sync.loadTexture(asset, 'color')).format;
        }, asset);
        expect(format).toMatch(/^(etc2|bc[17]|astc).*-srgb$/);
        expect(problems).toEqual([]);
    } finally {
        await context.close();
    }
});

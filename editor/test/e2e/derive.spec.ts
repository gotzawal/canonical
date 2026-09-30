// Compressed copies (derive/): textures made in a worker, shown in the
// view in place of the file, made again for other options, and shipped
// with built games, which play them; models packed with KTX2 textures and
// meshopt geometry for games.
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { base64, png, pngGlb, solid, unzip } from './fixtures';

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

/** The middle of the view (of the editor, or of a game's player) as RGB rows. */
function view(page: Page, of: 'editor' | 'player' = 'editor'): Promise<{ w: number; h: number; data: number[] }> {
    return page.evaluate(async (of) => {
        const rt = of === 'editor' ? window.__editor.runtime : (window as any).__player.runtime;
        const [w, h] = rt.cssSize;
        const blob = await rt.captureFrame({ type: 'image/png', frames: 3, maxWidth: 160, crop: { x: w / 2 - 120, y: h / 2 - 120, w: 240, h: 240 } });
        const bmp = await createImageBitmap(blob);
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const data: number[] = [];
        for (let i = 0; i < d.length; i += 4) data.push(d[i], d[i + 1], d[i + 2]);
        return { w: bmp.width, h: bmp.height, data };
    }, of);
}

/** RGBA pixels of the card's four quarters (red, green, blue, yellow). */
function quarterPixels(size: number): Uint8Array {
    const colors = [[224, 32, 32], [32, 192, 32], [32, 64, 224], [224, 208, 32]];
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) data.set([...colors[(x < size / 2 ? 0 : 1) + (y < size / 2 ? 0 : 2)], 255], (y * size + x) * 4);
    }
    return data;
}

/** Builds the scene with the Build & Deploy dialog's download; resolves with the files of the .zip. */
async function buildZip(page: Page): Promise<Map<string, Uint8Array>> {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+b');
    const dialog = page.locator('.build-dialog');
    await expect(dialog).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 240_000 });
    await dialog.getByRole('button', { name: 'Download .zip' }).click();
    const zip = unzip(readFileSync(await (await download).path()));
    await page.keyboard.press('Escape');
    return zip;
}

/** Plays a built game served as a static site: `check` runs once its player started, and nothing may fail. */
async function playGame<T>(browser: Browser, zip: Map<string, Uint8Array>, check: (player: Page) => Promise<T>): Promise<T> {
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
        const out = await check(player);
        expect(problems).toEqual([]);
        return out;
    } finally {
        await context.close();
    }
}

/** The JSON of a GLB file. */
function glbJson(bytes: Uint8Array): any {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
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

/** Share of pixels of each quarter's hue (red, green, blue, yellow), however lit. */
function hues(img: { data: number[] }): number[] {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < img.data.length; i += 3) {
        const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if (r > 2 * g && r > 2 * b) counts[0]++;
        else if (g > 2 * r && g > 2 * b) counts[1]++;
        else if (b > 2 * r && b > 1.5 * g) counts[2]++;
        else if (r > 2 * b && g > 2 * b) counts[3]++;
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

test('packs models for games: their textures in KTX2 and their geometry with meshopt, which the game plays', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = editor.page();
    // A standing 2 x 2 m two-sided quad whose PNG base color has the card's four quarters, lit evenly by a white sky.
    const { asset, node } = await page.evaluate(async (b64) => {
        const ed = window.__editor;
        ed.store.commit('Empty', (d) => {
            d.nodes = [];
            d.environment.sky = 'color';
            d.environment.skyColor = '#ffffff';
        });
        await ed.importFiles([new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Sign.glb', { type: 'model/gltf-binary' })]);
        const n = ed.store.doc.nodes.find((x) => x.model)!;
        return { asset: n.model!.asset, node: n.id };
    }, base64(pngGlb(png(128, 128, quarterPixels(128)))));
    await page.waitForFunction((id) => window.__editor.sync.modelState(id)?.status === 'ready', node, { polling: 100, timeout: 120_000 });
    // Face on (the game plays from this view: the scene has no camera).
    await page.evaluate((id) => {
        const ed = window.__editor;
        ed.store.select([]);
        ed.store.setCamera({ ...ed.store.camera, yaw: 0, pitch: 0 });
        ed.viewport.frameNodes([id]);
    }, node);
    // The editor's view shows the file (once SwiftShader compiled the model's shaders).
    await measure(page, 2);
    const inEditor = hues(await view(page));
    console.log(`Editor: quarters ${inEditor.map((q) => q.toFixed(2))}`);
    for (const share of inEditor) expect(share).toBeGreaterThan(0.1);

    // Made now, as a build makes it: the texture in KTX2, fingerprinted against the file.
    const copy = await page.evaluate(async (asset) => {
        const ed = window.__editor;
        const meta = ed.store.doc.assets.find((a) => a.id === asset)!;
        const rec = await ed.derived.ensure(meta, 'model');
        return rec && { textures: rec.textures, bytes: rec.bytes, file: meta.size, hash: meta.hash, state: ed.derived.statusOf(meta, 'model').state };
    }, asset);
    console.log(`Model copy: ${copy?.bytes} bytes (the file is ${copy?.file})`);
    expect(copy).toMatchObject({ textures: 1, state: 'ready', hash: expect.any(String) });

    const zip = await buildZip(page);
    const game = JSON.parse(new TextDecoder().decode(zip.get('game.json')!));
    const path = game.derived?.[`${asset}|model`];
    expect(path).toMatch(new RegExp(`^media/${asset}-Sign\\.game\\.glb$`));
    // The copy ships in place of the file.
    expect(game.files[asset]).toBeUndefined();
    const json = glbJson(zip.get(path)!);
    // Normals quantized by default (meshopt's octahedral filter).
    expect(json.extensionsRequired).toEqual(expect.arrayContaining(['KHR_texture_basisu', 'EXT_meshopt_compression', 'KHR_mesh_quantization']));
    expect(json.images.map((i: any) => i.mimeType)).toEqual(['image/ktx2']);
    expect(json.nodes.map((n: any) => n.name)).toEqual(['Part']);
    const names = Array.from(zip.keys());
    expect(names.some((n) => /meshopt_decoder-.*\.js$/.test(n))).toBe(true);
    expect(names.some((n) => /basis_transcoder-.*\.wasm$/.test(n))).toBe(true);
    expect(names.some((n) => /_DracoAssets|draco_decoder/.test(n))).toBe(false);

    const shown = await playGame(browser, zip, async (player) => {
        const loaded = await player.evaluate(async (node) => {
            const p = (window as any).__player;
            await p.sync.whenLoaded();
            const info = p.sync.modelInfo(node);
            const tex = info?.slots[0]?.material.shader.getTexture('baseMap');
            // Frames drawn, by time: SwiftShader may stall a while after a load.
            for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => { const off = p.runtime.onFrame(() => (off(), resolve())); });
            return {
                status: p.sync.modelState(node)?.status,
                triangles: info?.parts.reduce((n: number, part: any) => n + part.triangles, 0),
                format: tex?.format as string,
                kind: tex?.constructor.name as string,
            };
        }, node);
        return { ...loaded, view: await view(player, 'player') };
    });
    const inGame = hues(shown.view);
    console.log(`Game: ${shown.kind} ${shown.format}; quarters ${inGame.map((q) => q.toFixed(2))}`);
    expect(shown).toMatchObject({ status: 'ready', triangles: 2, kind: 'CompressedTexture2D' });
    expect(shown.format).toMatch(/^(etc2|bc[17]|astc).*-srgb$/);
    // The same picture as in the editor: every quarter in its hue, about as large.
    inGame.forEach((share, i) => expect(Math.abs(share - inEditor[i])).toBeLessThan(0.05));

    // Run in New Tab: the preview plays the copy this browser made.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+b');
    const popup = page.waitForEvent('popup');
    await page.locator('.build-dialog').getByRole('button', { name: 'Run in New Tab' }).click();
    const preview = await popup;
    try {
        await preview.waitForFunction(() => !!(window as any).__player, null, { polling: 200, timeout: 150_000 });
        const previewed = await preview.evaluate(async (node) => {
            const p = (window as any).__player;
            await p.sync.whenLoaded();
            return p.sync.modelInfo(node)?.slots[0]?.material.shader.getTexture('baseMap')?.constructor.name as string;
        }, node);
        expect(previewed).toBe('CompressedTexture2D');
    } finally {
        await preview.close();
    }
    await page.keyboard.press('Escape');

    // The Model section offers the options: turned off, games get the file.
    await page.evaluate((id) => window.__editor.store.select([id]), node);
    await page.locator('.inspector section.section', { hasText: 'Sign.glb' }).first().getByRole('button', { name: 'Compression for games' }).click();
    const popover = page.locator('.texture-options-popover');
    await expect(popover).toContainText('Sign.glb for games');
    await expect(popover).toContainText('with 1 texture in KTX2');
    await popover.locator('select').first().selectOption('off');
    await expect(popover).toContainText('Games get the file itself.');
    await page.keyboard.press('Escape');
    const off = await page.evaluate(async (asset) => {
        const ed = window.__editor;
        const meta = ed.store.doc.assets.find((a) => a.id === asset)!;
        return { mode: meta.compress?.mode, state: ed.derived.statusOf(meta, 'model').state, copy: await ed.derived.ensure(meta, 'model') };
    }, asset);
    expect(off).toEqual({ mode: 'off', state: 'off', copy: null });
});

test('compresses imported files and keeps only the compressed ones, which the editor and games use', async ({ browser }) => {
    test.setTimeout(300_000);
    const page = editor.page();
    await page.evaluate(() => window.__editor.store.setPrefs({ compressImports: true }));
    try {
        const texture = await card(page, 'Imported.png');
        const model = await page.evaluate(async (b64) => {
            const ed = window.__editor;
            await ed.importFiles([new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Crate.glb', { type: 'model/gltf-binary' })]);
            return ed.store.doc.nodes.find((n) => n.model)!.model!.asset;
        }, base64(pngGlb(png(128, 128, quarterPixels(128)))));
        // Both files are replaced by their compressed forms.
        const packed = (id: string) =>
            page.evaluate((id) => {
                const a = window.__editor.store.doc.assets.find((x) => x.id === id)!;
                return { name: a.name, mime: a.mime, packed: a.packed?.from ?? null };
            }, id);
        await expect.poll(() => packed(texture), { timeout: 150_000 }).toEqual({ name: 'Imported.ktx2', mime: 'image/ktx2', packed: 'Imported.png' });
        await expect.poll(() => packed(model), { timeout: 150_000 }).toMatchObject({ name: 'Crate.glb', packed: 'Crate.glb' });

        // The stored files are the compressed ones, and the editor shows them.
        const shownNow = await page.evaluate(async ({ texture, model }) => {
            const ed = window.__editor;
            await ed.sync.whenLoaded();
            const tex = (await ed.sync.loadTexture(texture, 'color')) as any;
            const node = ed.store.doc.nodes.find((n) => n.model?.asset === model)!;
            const info = ed.sync.modelInfo(node.id);
            const mat = info?.slots[0]?.material as any;
            return {
                texture: tex.format as string,
                model: ed.sync.modelState(node.id)?.status,
                modelTexture: mat?.shader.getTexture('baseMap')?.constructor.name as string,
                status: ed.derived.statusOf(ed.store.doc.assets.find((a) => a.id === texture)!, 'color').state,
            };
        }, { texture, model });
        expect(shownNow).toMatchObject({ model: 'ready', modelTexture: 'CompressedTexture2D', status: 'off' });
        expect(shownNow.texture).toMatch(/^(etc2|bc[17]|astc).*-srgb$/);

        // Games ship the files as they are: no copies, the meshopt and KTX2 decoders.
        const zip = await buildZip(page);
        const game = JSON.parse(new TextDecoder().decode(zip.get('game.json')!));
        expect(game.derived).toBeUndefined();
        expect(game.files[texture]).toMatch(/\.ktx2$/);
        expect(Array.from(zip.get(game.files[texture])!.subarray(0, 4))).toEqual([0xab, 0x4b, 0x54, 0x58]);
        expect(glbJson(zip.get(game.files[model])!).extensionsRequired).toEqual(expect.arrayContaining(['KHR_texture_basisu', 'EXT_meshopt_compression']));
        const names = Array.from(zip.keys());
        expect(names.some((n) => /meshopt_decoder-.*\.js$/.test(n))).toBe(true);
        expect(names.some((n) => /basis_transcoder-.*\.wasm$/.test(n))).toBe(true);
    } finally {
        await page.evaluate(() => window.__editor.store.setPrefs({ compressImports: false }));
    }
});

test('turns textures of one color into values, in materials and in models', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    await page.evaluate(() => window.__editor.store.setPrefs({ compressImports: true }));
    try {
        // A flat orange texture on the card, and a model whose base color is flat orange.
        const orange: [number, number, number, number] = [224, 128, 32, 255];
        const texture = await page.evaluate(async (b64) => {
            const ed = window.__editor;
            ed.store.commit('Card', (d) => {
                d.nodes = d.nodes.filter((n) => n.name === 'Ground');
                d.nodes[0].mesh!.material.color = '#ffffff';
            });
            ed.store.select([ed.store.doc.nodes[0].id]);
            await ed.importFiles([new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Orange.png', { type: 'image/png' })]);
            return ed.store.doc.assets.find((a) => a.name === 'Orange.png')!.id;
        }, base64(png(16, 16, solid(16, 16, orange))));
        await expect.poll(() => page.evaluate(() => window.__editor.store.doc.nodes[0].mesh!.material.map), { timeout: 120_000 }).toBeNull();
        expect(await page.evaluate(() => window.__editor.store.doc.nodes[0].mesh!.material.color)).toBe('#e08020');
        await expect.poll(() => page.evaluate((id) => window.__editor.store.doc.assets.find((a) => a.id === id)?.packed?.from, texture), { timeout: 120_000 }).toBe('Orange.png');

        const model = await page.evaluate(async (b64) => {
            const ed = window.__editor;
            await ed.importFiles([new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'Orange.glb', { type: 'model/gltf-binary' })]);
            return ed.store.doc.nodes.find((n) => n.model)!.id;
        }, base64(pngGlb(png(16, 16, solid(16, 16, orange)))));
        const asset = await page.evaluate((id) => window.__editor.store.node(id)!.model!.asset, model);
        await expect.poll(() => page.evaluate((id) => !!window.__editor.store.doc.assets.find((a) => a.id === id)?.packed, asset), { timeout: 150_000 }).toBe(true);
        await page.waitForFunction((id) => window.__editor.sync.modelState(id)?.status === 'ready', model, { polling: 100, timeout: 120_000 });
        // The packed model has no texture: its base color factor holds the orange (in linear).
        const shown = await page.evaluate(async (id) => {
            const ed = window.__editor;
            await ed.sync.whenLoaded();
            const mat = ed.sync.modelInfo(id)?.slots[0]?.material as any;
            const tex = mat?.shader.getTexture('baseMap');
            const c = mat?.baseColor;
            return { texture: tex?.name ?? null, color: c ? [c.r, c.g, c.b].map((v: number) => Math.round(v * 1000) / 1000) : null };
        }, model);
        console.log(`Flat model: ${JSON.stringify(shown)}`);
        expect(shown.texture).not.toBe('PngColor');
        const lin = (v: number) => Math.pow((v / 255 + 0.055) / 1.055, 2.4);
        shown.color!.forEach((v, i) => expect(Math.abs(v - lin(orange[i]))).toBeLessThan(0.01));
    } finally {
        await page.evaluate(() => window.__editor.store.setPrefs({ compressImports: false }));
    }
});

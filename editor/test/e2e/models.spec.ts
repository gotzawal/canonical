// Packed models and compressed imports (derive/): models packed with KTX2
// textures and meshopt geometry for games, files compressed on import in
// place of their originals, and flat-color textures turned into values.
import { expect, test } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { base64, png, pngGlb, solid } from './fixtures';
import { card, shown, view, quarterPixels, buildZip, playGame, glbJson, quarters, hues } from './copies';

const editor = sharedEditor();

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

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

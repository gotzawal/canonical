// Imported models and textures: compressed and quantized models through the
// engine's glTF loader (KHR_mesh_quantization, EXT_meshopt_compression,
// Draco from the decoder that ships with the engine, KTX2 textures
// transcoded for the device), animation clips, imports compressed in
// place, which the editor shows and a built game plays, and scatters of an
// imported model whose copies are all made again.
import { expect, test, type Page } from '@playwright/test';
import { playFrames, sharedEditor } from './editor';
import { measure } from './measure';
import { buildZip, card, glbJson, playGame, quarterPixels } from './copies';
import { base64, basisuGlb, dracoGlb, gridGlb, ktx2, meshoptGlb, png, pngGlb, quantizedGltf, solid } from './fixtures';
import { rigGltf } from './rig';

const problems: string[] = [];
const editor = sharedEditor(async (page) => {
    // WebGPU validation errors and failed loads show in the console only.
    page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
    });
    // Nothing may come from the decoder CDN the engine used before.
    await page.route('**/cdn.orillusion.com/**', (route) => route.abort());
});

test.beforeEach(async () => {
    await editor.reset();
    problems.length = 0;
});
test.afterEach(() => {
    expect(editor.errors).toEqual([]);
    expect(problems).toEqual([]);
});

/** Imports a model file; resolves with its node id once it loaded or failed. */
async function importModel(page: Page, name: string, data: string | Uint8Array): Promise<string> {
    const id = await page.evaluate(async ({ name, text, b64 }) => {
        const ed = window.__editor;
        const body = text ?? Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0));
        const before = new Set(ed.store.doc.nodes.map((n) => n.id));
        await ed.importFiles([new File([body], name, { type: name.endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary' })]);
        return ed.store.doc.nodes.find((n) => n.model && !before.has(n.id))!.id;
    }, typeof data === 'string' ? { name, text: data, b64: null } : { name, text: null, b64: base64(data) });
    await page.waitForFunction((id) => ['ready', 'error'].includes(window.__editor.sync.modelState(id)?.status ?? ''), id, { polling: 100, timeout: 120_000 });
    return id;
}

interface Loaded {
    status: string;
    error?: string;
    size: number[] | null;
    triangles: number;
    texture: { name: string; format: string; kind: string; width: number } | null;
    srgbAlbedo: boolean;
}

/** What a model node loaded: its size in the scene, triangles and base color texture. */
function loaded(page: Page, id: string): Promise<Loaded> {
    return page.evaluate((id) => {
        const ed = window.__editor;
        const state = ed.sync.modelState(id)!;
        const info = ed.sync.modelInfo(id);
        const box = ed.picker.bounds(id);
        const mat = info?.slots[0]?.material as any;
        const tex = mat?.shader.getTexture('baseMap');
        return {
            status: state.status,
            error: (state as any).error,
            size: box ? box.max.map((v: number, i: number) => Math.round((v - box.min[i]) * 1000) / 1000) : null,
            triangles: info?.parts.reduce((n, p) => n + p.triangles, 0) ?? 0,
            texture: tex ? { name: tex.name, format: tex.format, kind: tex.constructor.name, width: tex.width } : null,
            srgbAlbedo: !!mat?.shader.getDefaultColorShader().defineValue?.USE_SRGB_ALBEDO,
        };
    }, id);
}

test('loads quantized positions, normals and UVs (KHR_mesh_quantization)', async () => {
    const page = editor.page();
    const id = await importModel(page, 'Quantized.gltf', quantizedGltf());
    // SHORT positions of ±100, ±50, ±25 scaled by the node's 0.01.
    expect(await loaded(page, id)).toMatchObject({ status: 'ready', size: [2, 1, 0.5], triangles: 12 });
});

test('unpacks meshopt data and never reads the fallback buffer (EXT_meshopt_compression)', async () => {
    const page = editor.page();
    const id = await importModel(page, 'Packed.glb', await meshoptGlb());
    expect(await loaded(page, id)).toMatchObject({ status: 'ready', size: [4, 2, 1], triangles: 12 });
});

test('decodes Draco with the decoder that ships with the engine', async () => {
    const page = editor.page();
    const id = await importModel(page, 'Draco.glb', await dracoGlb());
    expect(await loaded(page, id)).toMatchObject({ status: 'ready', size: [3, 3, 3], triangles: 12 });
    // A second Draco model reuses the worker.
    const again = await importModel(page, 'Draco Again.glb', await dracoGlb());
    expect(await loaded(page, again)).toMatchObject({ status: 'ready', triangles: 12 });
});

test('transcodes KTX2 base colors for the device, or falls back to their PNG (KHR_texture_basisu)', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    const support = await page.evaluate(() => (window.__editor.runtime.engine as any).context3D.compressedTextureSupport);
    const compressed = support.bc || support.etc2 || support.astc;
    const color = solid(64, 64, [200, 40, 40, 255]);

    // ETC1S, required: transcoded to a compressed sRGB format when the device has one.
    const etc1s = await importModel(page, 'Basis.glb', basisuGlb(await ktx2(64, 64, color)));
    const a = await loaded(page, etc1s);
    expect(a).toMatchObject({ status: 'ready', texture: { name: 'BasisColor', kind: 'CompressedTexture2D', width: 64 }, srgbAlbedo: true });
    expect(a.texture!.format).toMatch(compressed ? /^(bc[17]|etc2|astc).*-srgb$/ : /^rgba8unorm-srgb$/);

    // UASTC with a PNG fallback: the KTX2 image wins.
    const uastc = await importModel(page, 'Basis UASTC.glb', basisuGlb(await ktx2(64, 64, color, { uastc: true }), png(64, 64, color)));
    const b = await loaded(page, uastc);
    expect(b).toMatchObject({ status: 'ready', texture: { name: 'BasisColor', kind: 'CompressedTexture2D' }, srgbAlbedo: true });
    expect(b.texture!.format).toMatch(compressed ? /^(bc7|etc2|astc).*-srgb$/ : /^rgba8unorm-srgb$/);

    // A size that is not whole 4x4 blocks transcodes to RGBA8.
    const odd = await importModel(page, 'Basis Odd.glb', basisuGlb(await ktx2(18, 18, solid(18, 18, [0, 0, 255, 255]), { mips: false })));
    expect(await loaded(page, odd)).toMatchObject({ status: 'ready', texture: { kind: 'CompressedTexture2D', format: 'rgba8unorm-srgb', width: 18 } });

    // A broken KTX2 image with a PNG fallback: the PNG loads and the model still does.
    const broken = new Uint8Array(await ktx2(64, 64, color));
    broken.fill(0, 80, 200);
    const fallback = await importModel(page, 'Basis Broken.glb', basisuGlb(broken, png(64, 64, color)));
    expect(await loaded(page, fallback)).toMatchObject({ status: 'ready', texture: { name: 'PngColor', kind: 'BitmapTexture2D' } });
    // The failed transcode is only a warning when a fallback exists.
    expect(problems).toEqual([]);

    // Frames draw with every one of them in view, and nothing fails validation.
    await page.evaluate(() => window.__editor.viewport.frameNodes(window.__editor.store.doc.nodes.filter((n) => n.model).map((n) => n.id)));
    expect((await measure(page, 3)).draws).toBeGreaterThan(0);
});

test('lists the clips of a model and previews the chosen one', async () => {
    const page = editor.page();
    const id = await importModel(page, 'Rig.gltf', rigGltf());
    /** The clip the engine's animator of the model plays. */
    const playing = () => page.evaluate((id) => (window.__editor.sync.modelInfo(id)!.animator as any)._currentSkeletonClip?.clip.clipName, id);
    expect(await page.evaluate((id) => window.__editor.sync.modelInfo(id)!.clips, id)).toEqual(['Idle', 'Walk', 'Run']);
    expect(await playing()).toBe('Idle');

    await page.evaluate((id) => window.__editor.store.select([id]), id);
    const section = page.locator('.side.right section', { hasText: 'Animation' });
    await expect(section).toBeVisible();
    // The Clip select offers the file's clips; choosing one plays it in the view.
    await section.locator('select').first().selectOption('Run');
    expect(await page.evaluate((id) => window.__editor.store.node(id)!.animation?.clip, id)).toBe('Run');
    expect(await playing()).toBe('Run');
});

test('compresses imported files in place, which the editor shows and a built game plays', async ({ browser }) => {
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
        const shown = await page.evaluate(async ({ texture, model }) => {
            const ed = window.__editor;
            await ed.sync.whenLoaded();
            const tex = (await ed.sync.loadTexture(texture, 'color')) as any;
            const node = ed.store.doc.nodes.find((n) => n.model?.asset === model)!;
            const mat = ed.sync.modelInfo(node.id)?.slots[0]?.material as any;
            return {
                texture: tex.format as string,
                model: ed.sync.modelState(node.id)?.status,
                modelTexture: mat?.shader.getTexture('baseMap')?.constructor.name as string,
                status: ed.derived.statusOf(ed.store.doc.assets.find((a) => a.id === texture)!, 'color').state,
            };
        }, { texture, model });
        expect(shown).toMatchObject({ model: 'ready', modelTexture: 'CompressedTexture2D', status: 'off' });
        expect(shown.texture).toMatch(/^(etc2|bc[17]|astc).*-srgb$/);

        // Games ship the files as they are, with only the decoders they need.
        const zip = await buildZip(page);
        const game = JSON.parse(new TextDecoder().decode(zip.get('game.json')!));
        expect(game.derived).toBeUndefined();
        expect(game.files[texture]).toMatch(/\.ktx2$/);
        expect(Array.from(zip.get(game.files[texture])!.subarray(0, 4))).toEqual([0xab, 0x4b, 0x54, 0x58]);
        expect(glbJson(zip.get(game.files[model])!).extensionsRequired).toEqual(expect.arrayContaining(['KHR_texture_basisu', 'EXT_meshopt_compression']));
        const names = Array.from(zip.keys());
        expect(names.some((n) => /meshopt_decoder-.*\.js$/.test(n))).toBe(true);
        expect(names.some((n) => /basis_transcoder-.*\.wasm$/.test(n))).toBe(true);
        expect(names.some((n) => /_DracoAssets|draco_decoder/.test(n))).toBe(false);

        // The game, served as a static site, plays them.
        const played = await playGame(browser, zip, async (player) => {
            await player.waitForFunction(() => {
                const p = (window as any).__player;
                return ['ready', 'error'].includes(p.sync.modelState(p.store.doc.nodes.find((n: any) => n.model).id)?.status);
            }, null, { polling: 200, timeout: 120_000 });
            return player.evaluate(async (texture) => {
                const p = (window as any).__player;
                await p.sync.whenLoaded();
                const node = p.store.doc.nodes.find((n: any) => n.model);
                return { texture: (await p.sync.loadTexture(texture, 'color')).format as string, model: p.sync.modelState(node.id)?.status as string };
            }, texture);
        });
        expect(played.model).toBe('ready');
        expect(played.texture).toMatch(/^(etc2|bc[17]|astc).*-srgb$/);
    } finally {
        await page.evaluate(() => window.__editor.store.setPrefs({ compressImports: false }));
    }
});

/** The shape of a model object's first part and its levels of detail; null before it loaded. */
function modelShape(page: Page, id: string): Promise<{ alive: boolean; levels: number } | null> {
    return page.evaluate((id) => {
        const shapes: any[] = [];
        const walk = (o: any) => {
            for (const c of o.components.values()) if (c.geometry) shapes.push(c.geometry);
            for (const child of o.entityChildren) walk(child);
        };
        const obj = window.__editor.sync.modelState(id)?.obj;
        if (obj) walk(obj);
        const g = shapes[0];
        return g ? { alive: !!g.subGeometries, levels: g.subGeometries?.[0]?.lodLevels.length ?? 0 } : null;
    }, id);
}

test('keeps the simpler levels of a model drawing when Play stops', async () => {
    const page = editor.page();
    const model = await importModel(page, 'Grid.glb', gridGlb());
    // Far away it draws simpler levels, made once it loaded.
    await expect.poll(() => modelShape(page, model), { timeout: 60_000 }).toEqual({ alive: true, levels: 3 });
    // Stop builds the scene again: the object goes with its renderers (the last to draw the simpler shape), and a new
    // one draws the shape again.
    await playFrames(page, 3);
    await page.evaluate(() => window.__editor.stopPlay());
    await expect.poll(() => modelShape(page, model), { timeout: 30_000 }).toEqual({ alive: true, levels: 3 });
});

test('keeps a scatter of a model drawing after all its copies went, and when Play stops', async () => {
    test.setTimeout(300_000);
    const page = editor.page();
    const model = await importModel(page, 'Grid.glb', gridGlb());
    // A scatter of the model around the view, and the model object deleted: its copies are all that draw it, as a
    // scatter of a model from the Library.
    const scatter = await page.evaluate((id) => {
        const ed = window.__editor;
        ed.store.select([id]);
        const scatter = ed.newScatter();
        ed.store.select([id]);
        ed.deleteSelection();
        return scatter;
    }, model);
    const placed = () => page.waitForFunction((id) => (window.__editor.sync.scatterView(id)?.count ?? 0) > 0, scatter, { polling: 100, timeout: 120_000 });
    await placed();
    // The shape its copies draw, with its simpler levels.
    const shape = () => page.evaluate((id) => {
        const ed = window.__editor;
        const g = ed.sync.scatterModelOf(ed.store.node(id)!.scatter!.sources[0].model!)!.pieces[0].parts[0].geometry;
        return { alive: !!g.subGeometries, levels: g.subGeometries?.[0]?.lodLevels.length ?? 0 };
    }, scatter);
    expect(await shape()).toEqual({ alive: true, levels: 3 });

    // Every copy goes, and its renderers are destroyed once the GPU is done with them (Play's Stop builds them all
    // again the same way): the shape stays, and copies placed again draw it.
    const count = (n: number) => page.evaluate(([id, n]) => window.__editor.store.commit('Count', (d) => {
        d.nodes.find((x) => x.id === id)!.scatter!.count = n;
    }), [scatter, n] as const);
    await count(0);
    await page.waitForFunction((id) => window.__editor.sync.scatterView(id)?.count === 0, scatter, { polling: 100, timeout: 60_000 });
    const without = (await measure(page, 3)).triangles;
    expect(await shape()).toEqual({ alive: true, levels: 3 });
    // 200 copies of 512 triangles, the far ones simpler.
    await count(200);
    await placed();
    expect((await measure(page, 3)).triangles).toBeGreaterThan(without + 5000);

    // A level a shape does not have (one that could not be simplified) draws its own triangles.
    await page.evaluate((id) => {
        for (const cell of (window.__editor.sync.scatterView(id) as any).cells) for (const r of cell.renderers) r.lodLevel = 7;
    }, scatter);
    expect((await measure(page, 3)).triangles).toBeGreaterThan(without + 5000);

    await playFrames(page, 3);
    await page.evaluate(() => window.__editor.stopPlay());
    await placed();
    expect((await measure(page, 3)).triangles).toBeGreaterThan(without + 5000);
});

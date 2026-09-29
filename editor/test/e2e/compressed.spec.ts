// Compressed and quantized models and textures through the engine's glTF
// loader: KHR_mesh_quantization, EXT_meshopt_compression, Draco from the
// decoder that ships with the engine, images in bufferView 0, and KTX2
// (Basis Universal) textures transcoded for the device.
import { expect, test, type Page } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';
import { base64, basisuGlb, bufferViewZeroGltf, dracoGlb, ktx2, meshoptGlb, png, quantizedGltf, solid } from './fixtures';

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

test('finds an image stored in the first bufferView of an embedded .gltf', async () => {
    const page = editor.page();
    const id = await importModel(page, 'Green.gltf', bufferViewZeroGltf(png(32, 32, solid(32, 32, [0, 255, 0, 255]))));
    // Base color decodes as sRGB on the GPU, so the shader skips its own decode.
    expect(await loaded(page, id)).toMatchObject({ status: 'ready', texture: { name: 'Green', format: 'rgba8unorm-srgb' }, srgbAlbedo: true });
});

test('transcodes KTX2 base colors for the device, or falls back to their PNG (KHR_texture_basisu)', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    const support = await page.evaluate(() => (window.__editor.runtime.engine as any).context3D.compressedTextureSupport);
    console.log(`Compressed textures on this device: ${JSON.stringify(support)}`);
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
    const m = await measure(page, 3);
    expect(m.draws).toBeGreaterThan(0);
});

/** Mean color of the middle of the view, after the scene settled. */
async function middleColor(page: Page): Promise<number[]> {
    await measure(page, 2);
    return page.evaluate(async () => {
        const rt = window.__editor.runtime;
        const [w, h] = rt.cssSize;
        const blob = await rt.captureFrame({ type: 'image/png', frames: 2, crop: { x: w / 2 - 10, y: h / 2 - 10, w: 20, h: 20 } });
        const bmp = await createImageBitmap(blob);
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const sum = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
        return sum.map((v) => Math.round(v / (d.length / 4)));
    });
}

test('draws a KTX2 base color as the same image in PNG', async () => {
    test.setTimeout(240_000);
    const page = editor.page();
    const color = solid(64, 64, [200, 40, 40, 255]);
    // Only the quad in view, lit evenly on both sides by a white sky.
    await page.evaluate(() => {
        window.__editor.store.commit('Empty', (d) => {
            d.nodes = [];
            d.environment.sky = 'color';
            d.environment.skyColor = '#ffffff';
        });
    });
    const show = async (name: string, data: Uint8Array) => {
        const id = await importModel(page, name, data);
        await page.evaluate((id) => {
            const ed = window.__editor;
            ed.store.setCamera({ ...ed.store.camera, yaw: 0, pitch: 0 });
            ed.viewport.frameNodes([id]);
        }, id);
        const rgb = await middleColor(page);
        await page.evaluate((id) => window.__editor.store.commit('Remove', (d) => (d.nodes = d.nodes.filter((n) => n.id !== id))), id);
        return rgb;
    };
    const broken = new Uint8Array(await ktx2(64, 64, color));
    broken.fill(0, 80, 200);
    const fromPng = await show('Png.glb', basisuGlb(broken, png(64, 64, color)));
    const fromEtc1s = await show('Etc1s.glb', basisuGlb(await ktx2(64, 64, color)));
    const fromUastc = await show('Uastc.glb', basisuGlb(await ktx2(64, 64, color, { uastc: true })));
    console.log(`Middle of the view: PNG ${fromPng}, ETC1S ${fromEtc1s}, UASTC ${fromUastc}`);
    // Red, not the sky: the quad fills the middle.
    expect(fromPng[0]).toBeGreaterThan(fromPng[1] * 2);
    for (const rgb of [fromEtc1s, fromUastc]) {
        for (let k = 0; k < 3; k++) expect(Math.abs(rgb[k] - fromPng[k])).toBeLessThanOrEqual(6);
    }
    // The failed image fell back with a warning, not an error.
    expect(problems).toEqual([]);
});

test('names the extension a model requires and the engine does not read', async () => {
    const page = editor.page();
    const gltf = JSON.parse(quantizedGltf());
    gltf.extensionsRequired.push('KHR_materials_pbrSpecularGlossiness');
    const id = await importModel(page, 'Unsupported.gltf', JSON.stringify(gltf));
    expect(await loaded(page, id)).toMatchObject({ status: 'error' });
    expect((await loaded(page, id)).error).toContain('KHR_materials_pbrSpecularGlossiness');
    // The editor tells the user; that toast is not a page problem.
    problems.length = 0;
});

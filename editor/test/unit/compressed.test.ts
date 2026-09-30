// The device-free parts of the engine's compressed asset path: texture
// formats, the KTX2 container and transcode targets, dequantization, meshopt
// decoding and required glTF extensions.
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { describe, expect, it } from 'vitest';
import { formatBlockInfo, isCompressedFormat, isSrgbFormat, levelBytes, levelsToSkip, toLinearFormat, toSrgbFormat } from '../../../src/gfx/graphics/webGpu/core/texture/TextureFormatUtil';
import { assertSupportedGltfExtensions, preferredImages, textureSources, unsupportedGltfExtensions } from '../../../src/loader/parser/gltf/GLTFExtensions';
import { dequantizeNormalized, fitIndices, toFloat32 } from '../../../src/loader/parser/gltf/GLTFQuantization';
import { EXT_meshopt_compression } from '../../../src/loader/parser/gltf/extends/EXT_meshopt_compression';
import { isKTX2, isKTX2Image, KTX2_MAGIC, readKTX2Header } from '../../../src/textures/ktx2/KTX2Container';
import { chooseTarget, rankTargets } from '../../../src/textures/ktx2/KTX2TranscodeTarget';
import { formatInfo } from '../../src/engine/gpuStats';

describe('texture formats', () => {
    it('tell sRGB and compressed formats apart', () => {
        expect(isSrgbFormat('rgba8unorm-srgb')).toBe(true);
        expect(isSrgbFormat('bc7-rgba-unorm-srgb')).toBe(true);
        expect(isSrgbFormat('rgba8unorm')).toBe(false);
        expect(isSrgbFormat(undefined)).toBe(false);
        expect(isCompressedFormat('bc1-rgba-unorm')).toBe(true);
        expect(isCompressedFormat('etc2-rgb8unorm')).toBe(true);
        expect(isCompressedFormat('eac-r11unorm')).toBe(true);
        expect(isCompressedFormat('astc-4x4-unorm-srgb')).toBe(true);
        expect(isCompressedFormat('rgba8unorm')).toBe(false);
    });

    it('switch between the sRGB and linear twins, where there is one', () => {
        for (const f of ['rgba8unorm', 'bgra8unorm', 'bc1-rgba-unorm', 'bc3-rgba-unorm', 'bc7-rgba-unorm', 'etc2-rgb8unorm', 'etc2-rgba8unorm', 'astc-4x4-unorm']) {
            expect(toSrgbFormat(f)).toBe(f + '-srgb');
            expect(toSrgbFormat(f + '-srgb')).toBe(f + '-srgb');
            expect(toLinearFormat(f + '-srgb')).toBe(f);
        }
        // No sRGB twin: unchanged.
        expect(toSrgbFormat('bc4-r-unorm')).toBe('bc4-r-unorm');
        expect(toSrgbFormat('rgba16float')).toBe('rgba16float');
    });

    it('size blocks as the GPU memory counter does', () => {
        for (const f of ['bc1-rgba-unorm', 'bc4-r-unorm', 'bc7-rgba-unorm-srgb', 'etc2-rgb8unorm', 'etc2-rgba8unorm', 'eac-rg11unorm', 'astc-4x4-unorm', 'astc-8x6-unorm', 'rgba8unorm', 'rgba16float', 'r8unorm', 'depth24plus', 'depth32float-stencil8']) {
            const b = formatBlockInfo(f);
            expect([b.bytes, b.w, b.h]).toEqual(formatInfo(f));
        }
        // A 2x2 level still takes a whole 4x4 block.
        expect(levelBytes('bc7-rgba-unorm', 2, 2)).toBe(16);
        expect(levelBytes('bc1-rgba-unorm', 1024, 1024)).toBe(1024 * 1024 / 2);
        expect(levelBytes('rgba8unorm', 3, 5)).toBe(60);
    });
});

/** A KTX2 header (80 bytes: identifier, 9 numbers, the index) for a texture. */
function ktx2Header(fields: { vkFormat?: number; width: number; height: number; levels?: number; supercompression?: number }): Uint8Array {
    const bytes = new Uint8Array(80);
    bytes.set(KTX2_MAGIC);
    const v = new DataView(bytes.buffer);
    const u32 = [fields.vkFormat ?? 0, 1, fields.width, fields.height, 0, 0, 1, fields.levels ?? 1, fields.supercompression ?? 0];
    u32.forEach((n, i) => v.setUint32(12 + i * 4, n, true));
    return bytes;
}

describe('textures on a quality tier', () => {
    const chain = (w: number, h: number) => {
        const out: { width: number; height: number }[] = [];
        for (;;) {
            out.push({ width: w, height: h });
            if (w === 1 && h === 1) return out;
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }
    };

    it('start from the first level that fits the tier', () => {
        expect(levelsToSkip('bc7-rgba-unorm', chain(2048, 2048), 1024)).toBe(1);
        expect(levelsToSkip('etc2-rgb8unorm', chain(4096, 1024), 1024)).toBe(2);
        expect(levelsToSkip('bc7-rgba-unorm', chain(1024, 1024), 1024)).toBe(0);
        expect(levelsToSkip('rgba8unorm', chain(2048, 2048), Infinity)).toBe(0);
        // Only whole blocks may be the base of a compressed texture.
        expect(levelsToSkip('bc1-rgba-unorm', chain(1000, 600), 256)).toBe(1);
        expect(levelsToSkip('rgba8unorm', chain(1000, 600), 256)).toBe(2);
        // A single level stays.
        expect(levelsToSkip('bc7-rgba-unorm', [{ width: 2048, height: 2048 }], 512)).toBe(0);
    });
});

describe('KTX2 files', () => {
    it('are told by their identifier and read by their header', () => {
        const header = ktx2Header({ width: 512, height: 256, levels: 10, supercompression: 1 });
        expect(isKTX2(header)).toBe(true);
        expect(isKTX2(header.buffer as ArrayBuffer)).toBe(true);
        expect(isKTX2(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(false);
        expect(isKTX2(new Uint8Array(4))).toBe(false);
        expect(readKTX2Header(header)).toEqual({ vkFormat: 0, width: 512, height: 256, depth: 0, layers: 0, faces: 1, levels: 10, supercompression: 1 });
        // A view into a larger buffer reads from its own start.
        const shifted = new Uint8Array(100);
        shifted.set(header, 20);
        expect(readKTX2Header(shifted.subarray(20)).width).toBe(512);
        expect(() => readKTX2Header(new Uint8Array(80))).toThrow('not a KTX2 file');
    });

    it('are known by their mime type or name, also after a blob URL', () => {
        expect(isKTX2Image({ mimeType: 'image/ktx2' })).toBe(true);
        expect(isKTX2Image({ uri: 'textures/wall.ktx2' })).toBe(true);
        expect(isKTX2Image({ uri: 'data:image/ktx2;base64,q0tUWCAyMLsNChoK' })).toBe(true);
        expect(isKTX2Image('blob:http://localhost/1234#wall%20color.ktx2')).toBe(true);
        expect(isKTX2Image('textures/wall.KTX2?v=2')).toBe(true);
        expect(isKTX2Image({ uri: 'wall.png', mimeType: 'image/png' })).toBe(false);
        expect(isKTX2Image('ktx2/wall.png')).toBe(false);
        expect(isKTX2Image(undefined)).toBe(false);
    });

    it('transcode to the best format the device samples', () => {
        const pick = (support: object, encoding: 'etc1s' | 'uastc', alpha: boolean, w = 1024, h = 1024) => chooseTarget(rankTargets(support), encoding, alpha, w, h).format;
        const all = { bc: true, etc2: true, astc: true };
        expect(pick(all, 'uastc', false)).toBe('astc-4x4-unorm');
        expect(pick(all, 'etc1s', false)).toBe('etc2-rgb8unorm');
        expect(pick(all, 'etc1s', true)).toBe('etc2-rgba8unorm');
        // Desktop: BC only.
        expect(pick({ bc: true }, 'uastc', false)).toBe('bc7-rgba-unorm');
        expect(pick({ bc: true }, 'uastc', true)).toBe('bc7-rgba-unorm');
        expect(pick({ bc: true }, 'etc1s', false)).toBe('bc1-rgba-unorm');
        expect(pick({ bc: true }, 'etc1s', true)).toBe('bc7-rgba-unorm');
        // Phones: ETC2 and ASTC.
        expect(pick({ etc2: true }, 'uastc', true)).toBe('etc2-rgba8unorm');
        expect(pick({ astc: true }, 'etc1s', false)).toBe('astc-4x4-unorm');
        // Nothing compressed, or a size that is not whole blocks: RGBA8.
        expect(pick({}, 'uastc', false)).toBe('rgba8unorm');
        expect(pick(null as unknown as object, 'etc1s', true)).toBe('rgba8unorm');
        expect(pick(all, 'uastc', false, 1022, 1024)).toBe('rgba8unorm');
        expect(pick(all, 'etc1s', true, 1024, 18)).toBe('rgba8unorm');
        // Every list ends with RGBA8, and names the transcoder's formats.
        for (const enc of ['etc1s', 'uastc'] as const) {
            for (const kind of ['opaque', 'alpha'] as const) {
                const list = rankTargets(all)[enc][kind];
                expect(list[list.length - 1]).toMatchObject({ name: 'cTFRGBA32', format: 'rgba8unorm', compressed: false });
                for (const t of list) expect(t.name).toMatch(/^cTF/);
            }
        }
    });
});

describe('quantized glTF data', () => {
    it('turns normalized integers into the floats they stand for', () => {
        expect(Array.from(dequantizeNormalized(new Int8Array([127, -127, -128, 0])))).toEqual([1, -1, -1, 0]);
        expect(Array.from(dequantizeNormalized(new Uint8Array([255, 0, 51])))).toEqual([1, 0, Math.fround(0.2)]);
        expect(Array.from(dequantizeNormalized(new Int16Array([32767, -32768])))).toEqual([1, -1]);
        expect(dequantizeNormalized(new Uint16Array([65535]))[0]).toBe(1);
        const floats = new Float32Array([0.5]);
        expect(dequantizeNormalized(floats)).toBe(floats);
        expect(Array.from(toFloat32(new Int16Array([-3, 7])))).toEqual([-3, 7]);
    });

    it('picks the index width from the largest index, not the count', () => {
        expect(fitIndices([0, 1, 2])).toBeInstanceOf(Uint16Array);
        expect(fitIndices(new Uint32Array([0, 70000, 2]))).toBeInstanceOf(Uint32Array);
        expect(Array.from(fitIndices(new Uint32Array([0, 70000, 2])))).toEqual([0, 70000, 2]);
        expect(fitIndices(new Uint8Array(70000))).toBeInstanceOf(Uint32Array);
        const small = new Uint16Array([1, 2, 3]);
        expect(fitIndices(small)).toBe(small);
    });
});

describe('meshopt compression', () => {
    it('unpacks what meshoptimizer packs, for every mode and filter', async () => {
        await MeshoptEncoder.ready;
        await EXT_meshopt_compression.ready();
        const cases: { mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES'; stride: number; count: number; data: Uint8Array; filter?: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION'; version?: number }[] = [];
        const positions = new Uint16Array(4 * 64);
        for (let i = 0; i < positions.length; i++) positions[i] = (i * 2654435761) % 65535;
        cases.push({ mode: 'ATTRIBUTES', stride: 8, count: 64, data: new Uint8Array(positions.buffer) });
        cases.push({ mode: 'ATTRIBUTES', stride: 8, count: 64, data: new Uint8Array(positions.buffer), version: 1 });
        const tris = new Uint16Array([0, 1, 2, 2, 1, 3, 3, 1, 4, 4, 1, 5]);
        cases.push({ mode: 'TRIANGLES', stride: 2, count: tris.length, data: new Uint8Array(tris.buffer) });
        const list = new Uint32Array([5, 9, 2, 70000, 1, 3]);
        cases.push({ mode: 'INDICES', stride: 4, count: list.length, data: new Uint8Array(list.buffer) });
        // Normals and rotations through the filters that pack them.
        const normals = new Float32Array(32 * 4);
        for (let i = 0; i < 32; i++) normals.set([Math.cos(i), Math.sin(i), 0, 0], i * 4);
        cases.push({ mode: 'ATTRIBUTES', stride: 4, count: 32, data: MeshoptEncoder.encodeFilterOct(normals, 32, 4, 8), filter: 'OCTAHEDRAL' });
        const quats = new Float32Array(16 * 4);
        for (let i = 0; i < 16; i++) quats.set([0, Math.sin(i / 4), 0, Math.cos(i / 4)], i * 4);
        cases.push({ mode: 'ATTRIBUTES', stride: 8, count: 16, data: MeshoptEncoder.encodeFilterQuat(quats, 16, 8, 12), filter: 'QUATERNION' });

        for (const c of cases) {
            const packed = MeshoptEncoder.encodeGltfBuffer(c.data, c.count, c.stride, c.mode, c.version);
            // The packed bytes sit inside a larger buffer, after other data.
            const source = new Uint8Array(packed.length + 16);
            source.set(packed, 16);
            const out = new Uint8Array(EXT_meshopt_compression.decode({ buffer: 0, byteOffset: 16, byteLength: packed.length, byteStride: c.stride, count: c.count, mode: c.mode, filter: c.filter }, source.buffer));
            if (c.filter === 'OCTAHEDRAL') {
                // Unfiltered into normalized bytes, close to the normals packed.
                const n = dequantizeNormalized(new Int8Array(out.buffer));
                for (let i = 0; i < 32; i++) for (let k = 0; k < 3; k++) expect(Math.abs(n[i * 4 + k] - normals[i * 4 + k])).toBeLessThan(0.02);
            } else if (c.filter === 'QUATERNION') {
                // Unfiltered into normalized shorts; q and -q are the same rotation.
                const q = dequantizeNormalized(new Int16Array(out.buffer));
                for (let i = 0; i < 16; i++) {
                    let dot = 0;
                    for (let k = 0; k < 4; k++) dot += q[i * 4 + k] * quats[i * 4 + k];
                    expect(Math.abs(dot)).toBeGreaterThan(0.999);
                }
            } else if (c.mode === 'TRIANGLES') {
                // Triangles may come back rotated, but they are the same triangles.
                const tri = (a: ArrayLike<number>, i: number) => [a[i], a[i + 1], a[i + 2]].sort().join();
                const got = new Uint16Array(out.buffer);
                for (let i = 0; i < tris.length; i += 3) expect(tri(got, i)).toBe(tri(tris, i));
            } else {
                expect(Array.from(out)).toEqual(Array.from(c.data));
            }
        }
    });

    it('reads the extension of a bufferView and its fallback buffers', () => {
        const ext = { buffer: 0, byteLength: 10, byteStride: 4, count: 3, mode: 'ATTRIBUTES' as const };
        expect(EXT_meshopt_compression.extOf({ extensions: { EXT_meshopt_compression: ext } })).toBe(ext);
        expect(EXT_meshopt_compression.extOf({ extensions: { KHR_meshopt_compression: ext } })).toBe(ext);
        expect(EXT_meshopt_compression.extOf({})).toBeUndefined();
        expect(EXT_meshopt_compression.isUsed({ bufferViews: [{}, { extensions: { EXT_meshopt_compression: ext } }] })).toBe(true);
        expect(EXT_meshopt_compression.isUsed({ bufferViews: [{}] })).toBe(false);
        expect(EXT_meshopt_compression.isFallback({ extensions: { EXT_meshopt_compression: { fallback: true } } })).toBe(true);
        expect(EXT_meshopt_compression.isFallback({})).toBe(false);
    });
});

describe('glTF texture sources', () => {
    it('are tried KTX2 first, then WebP and AVIF, then the plain image', () => {
        expect(textureSources({ source: 0, extensions: { KHR_texture_basisu: { source: 2 }, EXT_texture_webp: { source: 1 } } })).toEqual([2, 1, 0]);
        expect(textureSources({ extensions: { KHR_texture_basisu: { source: 3 } } })).toEqual([3]);
        expect(textureSources({ source: 1, extensions: { EXT_texture_avif: { source: 1 } } })).toEqual([1]);
        expect(textureSources(undefined)).toEqual([]);
        // Only the first choices load up front.
        expect([...preferredImages({ textures: [{ source: 0, extensions: { KHR_texture_basisu: { source: 1 } } }, { source: 2 }, {}] })].sort()).toEqual([1, 2]);
    });
});

describe('required glTF extensions', () => {
    it('load when the engine reads them and fail by name otherwise', () => {
        expect(() => assertSupportedGltfExtensions({})).not.toThrow();
        expect(() => assertSupportedGltfExtensions({ extensionsRequired: ['KHR_texture_basisu', 'EXT_meshopt_compression', 'KHR_mesh_quantization', 'KHR_draco_mesh_compression'] })).not.toThrow();
        expect(unsupportedGltfExtensions({ extensionsRequired: ['KHR_materials_pbrSpecularGlossiness', 'KHR_texture_transform', 'EXT_mesh_gpu_instancing'] })).toEqual(['KHR_materials_pbrSpecularGlossiness', 'EXT_mesh_gpu_instancing']);
        expect(() => assertSupportedGltfExtensions({ extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'] })).toThrow('glTF requires unsupported extension: KHR_materials_pbrSpecularGlossiness');
    });
});

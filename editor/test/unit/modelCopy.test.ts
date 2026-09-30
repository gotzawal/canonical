import { Document, WebIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { describe, expect, it } from 'vitest';
import type { TextureRole } from '../../src/core/types';
import { packModel } from '../../src/derive/model';
import { sameColor } from '../../src/derive/encode';

const KTX2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.123456789, 0.5, -0.25]);

/** Image bytes a fake encoder tells apart (the packer never decodes them itself). */
const image = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);

/** A model with a color, a normal and a data map, a texture no material uses, and a WebP image. */
function sampleDoc(buffers = 1): Document {
    const doc = new Document();
    const buffer = doc.createBuffer('main');
    const position = doc.createAccessor('position').setType('VEC3').setArray(POSITIONS.slice()).setBuffer(buffer);
    const indices = doc.createAccessor('indices').setType('SCALAR').setArray(new Uint16Array([0, 1, 2, 1, 3, 2])).setBuffer(buffers > 1 ? doc.createBuffer('second') : buffer);
    doc.createExtension(EXTTextureWebP);
    const base = doc.createTexture('base').setImage(image(1)).setMimeType('image/webp');
    const normal = doc.createTexture('normal').setImage(image(2)).setMimeType('image/png');
    const orm = doc.createTexture('orm').setImage(image(3)).setMimeType('image/jpeg');
    doc.createTexture('unused').setImage(image(4)).setMimeType('image/png');
    const skin = doc.createMaterial('Skin').setBaseColorTexture(base).setNormalTexture(normal).setMetallicRoughnessTexture(orm).setOcclusionTexture(orm);
    const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices).setMaterial(skin);
    const node = doc.createNode('Body').setMesh(doc.createMesh('Body').addPrimitive(prim)).setTranslation([1, 2, 3]);
    doc.createScene('Scene').addChild(doc.createNode('Root').addChild(node));
    return doc;
}

/** A fake KTX2 encoder that records the role of each image (by its last byte). */
function fakeEncoder(fail: TextureRole[] = []) {
    const roles: Record<number, TextureRole> = {};
    const encode = async (blob: Blob, role: TextureRole) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        roles[bytes[bytes.length - 1]] = role;
        if (fail.includes(role)) throw new Error('the encoder refused the image');
        return KTX2;
    };
    return { roles, encode };
}

/** Triangles of an index list, each from its smallest index (keeping the winding). */
function triangles(indices: ArrayLike<number>): string[] {
    const out: string[] = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
        const t = [indices[i], indices[i + 1], indices[i + 2]];
        const k = t.indexOf(Math.min(...t));
        out.push([t[k], t[(k + 1) % 3], t[(k + 2) % 3]].join(','));
    }
    return out.sort();
}

function glbJson(data: ArrayBuffer): any {
    const view = new DataView(data);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, view.getUint32(12, true))));
}

async function reread(data: ArrayBuffer): Promise<Document> {
    await MeshoptDecoder.ready;
    const io = new WebIO().registerExtensions([EXTMeshoptCompression, KHRTextureBasisu, EXTTextureWebP, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    return io.readBinary(new Uint8Array(data));
}

describe('model copies', () => {
    it('encode the textures of a model to KTX2 for the slots using them and pack its geometry without loss', async () => {
        const glb = new Blob([await new WebIO().registerExtensions([EXTTextureWebP]).writeBinary(sampleDoc())]);
        const { roles, encode } = fakeEncoder();
        const out = await packModel(glb, encode);
        expect(out.textures).toBe(3);
        // By slot: base color, normal map, and the map roughness and occlusion share.
        expect(roles).toEqual({ 1: 'color', 2: 'normal', 3: 'data' });

        const json = glbJson(out.data);
        expect(json.extensionsRequired.sort()).toEqual(['EXT_meshopt_compression', 'KHR_texture_basisu']);
        // No texture is WebP any more, and the one no material used is gone.
        expect(json.extensionsUsed).not.toContain('EXT_texture_webp');
        expect(json.textures).toHaveLength(3);
        for (const t of json.textures) {
            expect(t.source).toBeUndefined();
            expect(json.images[t.extensions.KHR_texture_basisu.source].mimeType).toBe('image/ktx2');
        }
        expect(json.bufferViews.some((v: any) => v.extensions?.EXT_meshopt_compression)).toBe(true);

        // Every vertex and transform as it was: the editor's part overrides still match.
        const doc = await reread(out.data);
        const root = doc.getRoot();
        expect(Array.from(root.listAccessors().find((a) => a.getType() === 'VEC3')!.getArray()!)).toEqual(Array.from(POSITIONS));
        // The same triangles with the same winding (the index codec may start a triangle at another corner).
        expect(triangles(root.listAccessors().find((a) => a.getType() === 'SCALAR')!.getArray()!)).toEqual(triangles([0, 1, 2, 1, 3, 2]));
        expect(root.listNodes().map((n) => n.getName())).toEqual(['Body', 'Root']);
        expect(root.listNodes()[0].getTranslation()).toEqual([1, 2, 3]);
        expect(root.listMaterials()[0].getBaseColorTexture()?.getMimeType()).toBe('image/ktx2');
    });

    it('keep the image of a texture the encoder refused, and pack a .gltf with its data embedded', async () => {
        const io = new WebIO().registerExtensions([EXTTextureWebP]);
        const { json, resources } = await io.writeJSON(sampleDoc(2));
        // Embedded, as the editor stores a .gltf: data URIs in place of the files.
        const dataUri = (bytes: Uint8Array, type: string) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
        for (const b of json.buffers!) b.uri = dataUri(resources[b.uri!], 'application/octet-stream');
        for (const i of json.images!) {
            i.uri = dataUri(resources[i.uri!], i.mimeType!);
            delete i.mimeType;
        }
        expect(json.buffers).toHaveLength(2);
        const { encode } = fakeEncoder(['data']);
        const out = await packModel(new Blob([JSON.stringify(json)]), encode);
        expect(out.textures).toBe(2);
        const packed = glbJson(out.data);
        // The refused map stays a JPEG; one buffer holds the data, as GLB wants.
        const orm = packed.textures.find((t: any) => t.source !== undefined);
        expect(packed.images[orm.source].mimeType).toBe('image/jpeg');
        expect(packed.buffers.filter((b: any) => !b.extensions?.EXT_meshopt_compression?.fallback)).toHaveLength(1);
        const doc = await reread(out.data);
        expect(Array.from(doc.getRoot().listAccessors().find((a) => a.getType() === 'VEC3')!.getArray()!)).toEqual(Array.from(POSITIONS));
    });

    it('leave Draco models and extensions the packer does not know to their files', async () => {
        const glbOf = (json: object) => {
            const text = new TextEncoder().encode(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, ' '));
            const header = new DataView(new ArrayBuffer(20));
            header.setUint32(0, 0x46546c67, true);
            header.setUint32(4, 2, true);
            header.setUint32(8, 20 + text.length, true);
            header.setUint32(12, text.length, true);
            header.setUint32(16, 0x4e4f534a, true);
            return new Blob([header.buffer, text]);
        };
        const { encode } = fakeEncoder();
        await expect(packModel(glbOf({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }), encode)).rejects.toThrow('Draco');
        await expect(packModel(glbOf({ asset: { version: '2.0' }, extensionsUsed: ['VENDOR_magic'] }), encode)).rejects.toThrow('VENDOR_magic');
    });

    it('turn textures of one color into material factors, and keep a slot without a factor textured', async () => {
        const glb = new Blob([await new WebIO().registerExtensions([EXTTextureWebP]).writeBinary(sampleDoc())]);
        const { encode } = fakeEncoder();
        // The base color is flat red, the normal map flat (straight up), the ORM map flat too: roughness 0.5, metal 1, occlusion 0.5.
        const flat = async (blob: Blob) => {
            const n = new Uint8Array(await blob.arrayBuffer()).at(-1);
            return n === 1 ? [255, 0, 0, 255] : n === 2 ? [128, 128, 255, 255] : n === 3 ? [128, 128, 255, 255] : null;
        };
        const out = await packModel(glb, encode, flat as any, { quantize: false, flat: true });
        // The ORM map stays: occlusion of 0.5 has no factor to go to (roughness and metalness still moved to theirs).
        expect(out).toMatchObject({ flattened: 2, textures: 1 });
        const m = (await reread(out.data)).getRoot().listMaterials()[0];
        expect(m.getBaseColorTexture()).toBeNull();
        expect(m.getBaseColorFactor()).toEqual([1, 0, 0, 1]);
        expect(m.getNormalTexture()).toBeNull();
        expect(m.getMetallicRoughnessTexture()).toBeNull();
        expect(m.getRoughnessFactor()).toBeCloseTo(0.5, 2);
        expect(m.getMetallicFactor()).toBeCloseTo(1, 2);
        expect(m.getOcclusionTexture()?.getMimeType()).toBe('image/ktx2');
        expect(sameColor(new Uint8Array([1, 2, 3, 4, 2, 3, 4, 5]))).toEqual([1, 2, 3, 4]);
        expect(sameColor(new Uint8Array([1, 2, 3, 4, 9, 2, 3, 4]))).toBeNull();
    });

    it('quantize normals with meshopt filters, keeping positions and node transforms exact', async () => {
        const doc = sampleDoc();
        const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
        const normals = new Float32Array([0, 0, 1, 0, 0.6, 0.8, 1, 0, 0, 0.577, 0.577, 0.577]);
        prim.setAttribute('NORMAL', doc.createAccessor('normal').setType('VEC3').setArray(normals).setBuffer(doc.getRoot().listBuffers()[0]));
        const glb = new Blob([await new WebIO().registerExtensions([EXTTextureWebP]).writeBinary(doc)]);
        const plain = await packModel(glb, fakeEncoder().encode);
        const out = await packModel(glb, fakeEncoder().encode, null, { quantize: true, flat: false });
        expect(glbJson(out.data).extensionsRequired).toEqual(expect.arrayContaining(['KHR_mesh_quantization', 'EXT_meshopt_compression']));
        expect(out.data.byteLength).toBeLessThan(plain.data.byteLength);
        const root = (await reread(out.data)).getRoot();
        const p = root.listMeshes()[0].listPrimitives()[0];
        expect(Array.from(p.getAttribute('POSITION')!.getArray()!)).toEqual(Array.from(POSITIONS));
        const n = p.getAttribute('NORMAL')!;
        for (let i = 0; i < 4; i++) {
            const v = n.getElement(i, []);
            for (let k = 0; k < 3; k++) expect(Math.abs(v[k] - normals[i * 3 + k])).toBeLessThan(0.03);
        }
        expect(root.listNodes()[0].getTranslation()).toEqual([1, 2, 3]);
    });
});

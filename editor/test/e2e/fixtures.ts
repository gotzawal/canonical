// Small compressed and quantized assets for browser tests, made in Node when
// a test runs: PNG, KTX2 (Basis Universal), and glTF files that use
// KHR_mesh_quantization, EXT_meshopt_compression, KHR_draco_mesh_compression
// and KHR_texture_basisu.
import { createRequire } from 'node:module';
import { crc32, deflateSync, inflateRawSync } from 'node:zlib';
import { encodeToKTX2 } from 'ktx2-encoder';
import { MeshoptEncoder } from 'meshoptimizer/encoder';

const require = createRequire(import.meta.url);

/** RGBA pixels of one color. */
export function solid(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    return data;
}

/** A PNG of RGBA pixels. */
export function png(width: number, height: number, rgba: Uint8Array): Uint8Array {
    const chunk = (type: string, body: Uint8Array) => {
        const out = Buffer.alloc(12 + body.length);
        out.writeUInt32BE(body.length, 0);
        out.write(type, 4, 'latin1');
        Buffer.from(body).copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(rows, y * (width * 4 + 1) + 1);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]);
}

/** A KTX2 file of RGBA pixels: ETC1S or UASTC, sRGB or linear, with mips. */
export async function ktx2(width: number, height: number, rgba: Uint8Array, opts: { uastc?: boolean; srgb?: boolean; mips?: boolean } = {}): Promise<Uint8Array> {
    const srgb = opts.srgb ?? true;
    // The encoder prints its statistics; keep them out of the test output.
    const { log } = console;
    const write = process.stdout.write;
    console.log = () => {};
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
        return await encodeToKTX2(new Uint8Array(0), {
            isUASTC: !!opts.uastc,
            qualityLevel: 128,
            compressionLevel: 1,
            needSupercompression: !!opts.uastc,
            generateMipmap: opts.mips ?? true,
            isPerceptual: srgb,
            isSetKTX2SRGBTransferFunc: srgb,
            imageDecoder: async () => ({ width, height, data: rgba }),
        });
    } finally {
        console.log = log;
        process.stdout.write = write;
    }
}

/** Base64 of bytes, to hand them to a page. */
export const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A GLB of a glTF JSON and its binary chunk. */
export function glb(json: object, bin: Uint8Array): Uint8Array {
    const text = Buffer.from(JSON.stringify(json));
    const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const binChunk = Buffer.concat([Buffer.from(bin), Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
    const head = (length: number, type: number) => {
        const b = Buffer.alloc(8);
        b.writeUInt32LE(length, 0);
        b.writeUInt32LE(type, 4);
        return b;
    };
    return Buffer.concat([header, head(jsonChunk.length, 0x4e4f534a), jsonChunk, head(binChunk.length, 0x004e4942), binChunk]);
}

/** Byte parts laid out 4-byte aligned in one buffer; `at[i]` is where part i starts. */
function pack(parts: Uint8Array[]): { bytes: Uint8Array; at: number[] } {
    const at: number[] = [];
    let size = 0;
    for (const p of parts) {
        at.push(size);
        size += Math.ceil(p.byteLength / 4) * 4;
    }
    const bytes = new Uint8Array(size);
    parts.forEach((p, i) => bytes.set(p, at[i]));
    return { bytes, at };
}

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** The 8 corners of a box of size `size` around the origin, and its 12 triangles. */
function box(size: [number, number, number]) {
    const [x, y, z] = size.map((s) => s / 2);
    const corners = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
    const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    return { corners, indices };
}

const asset = { version: '2.0', generator: 'morglay tests' };
const oneNode = (extra: object = {}) => ({ scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Part', mesh: 0, ...extra }] });

/**
 * A 2 x 1 x 0.5 m box in KHR_mesh_quantization: SHORT positions scaled by
 * the node, BYTE normalized normals and USHORT normalized UVs, as an
 * embedded .gltf.
 */
export function quantizedGltf(): string {
    const { corners, indices } = box([200, 100, 50]);
    // Positions: SHORT, 6 bytes padded to a stride of 8.
    const positions = new Int16Array(corners.length * 4);
    corners.forEach((c, i) => positions.set(c, i * 4));
    // Normals: BYTE normalized, 3 bytes padded to a stride of 4.
    const normals = new Int8Array(corners.length * 4);
    corners.forEach((c, i) => normals.set(c.map((v) => Math.round((Math.sign(v) * 127) / Math.sqrt(3))), i * 4));
    const uvs = new Uint16Array(corners.flatMap((c) => [c[0] > 0 ? 65535 : 0, c[1] > 0 ? 65535 : 0]));
    const idx = new Uint16Array(indices);
    const { bytes, at } = pack([bytesOf(positions), bytesOf(normals), bytesOf(uvs), bytesOf(idx)]);
    const gltf = {
        asset,
        extensionsUsed: ['KHR_mesh_quantization'],
        extensionsRequired: ['KHR_mesh_quantization'],
        ...oneNode({ scale: [0.01, 0.01, 0.01] }),
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }],
        accessors: [
            { bufferView: 0, componentType: 5122, count: 8, type: 'VEC3', min: [-100, -50, -25], max: [100, 50, 25] },
            { bufferView: 1, componentType: 5120, normalized: true, count: 8, type: 'VEC3' },
            { bufferView: 2, componentType: 5123, normalized: true, count: 8, type: 'VEC2' },
            { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: at[0], byteLength: positions.byteLength, byteStride: 8, target: 34962 },
            { buffer: 0, byteOffset: at[1], byteLength: normals.byteLength, byteStride: 4, target: 34962 },
            { buffer: 0, byteOffset: at[2], byteLength: uvs.byteLength, target: 34962 },
            { buffer: 0, byteOffset: at[3], byteLength: idx.byteLength, target: 34963 },
        ],
        buffers: [{ byteLength: bytes.byteLength, uri: 'data:application/octet-stream;base64,' + base64(bytes) }],
    };
    return JSON.stringify(gltf);
}

/**
 * A 4 x 2 x 1 m box packed with EXT_meshopt_compression, as gltfpack
 * writes it: the packed data in the GLB chunk (buffers[0]) and a fallback
 * buffer without any bytes (buffers[1]).
 */
export async function meshoptGlb(): Promise<Uint8Array> {
    await MeshoptEncoder.ready;
    const { corners, indices } = box([4, 2, 1]);
    const positions = new Float32Array(corners.flat());
    const idx = new Uint16Array(indices);
    const packedPositions = MeshoptEncoder.encodeGltfBuffer(bytesOf(positions), 8, 12, 'ATTRIBUTES');
    const packedIndices = MeshoptEncoder.encodeGltfBuffer(bytesOf(idx), idx.length, 2, 'TRIANGLES');
    const { bytes, at } = pack([packedPositions, packedIndices]);
    const gltf = {
        asset,
        extensionsUsed: ['EXT_meshopt_compression'],
        extensionsRequired: ['EXT_meshopt_compression'],
        ...oneNode(),
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-2, -1, -0.5], max: [2, 1, 0.5] },
            { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
        ],
        bufferViews: [
            {
                buffer: 1, byteOffset: 0, byteLength: positions.byteLength, byteStride: 12, target: 34962,
                extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at[0], byteLength: packedPositions.byteLength, byteStride: 12, count: 8, mode: 'ATTRIBUTES' } },
            },
            {
                buffer: 1, byteOffset: 96, byteLength: idx.byteLength, target: 34963,
                extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: at[1], byteLength: packedIndices.byteLength, byteStride: 2, count: idx.length, mode: 'TRIANGLES' } },
            },
        ],
        buffers: [{ byteLength: bytes.byteLength }, { byteLength: 96 + idx.byteLength, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    };
    return glb(gltf, bytes);
}

/** A 3 x 3 x 3 m box packed with Draco, as a GLB. */
export async function dracoGlb(): Promise<Uint8Array> {
    const draco = await require('draco3d').createEncoderModule({});
    const { corners, indices } = box([3, 3, 3]);
    const builder = new draco.MeshBuilder();
    const mesh = new draco.Mesh();
    const encoder = new draco.Encoder();
    const out = new draco.DracoInt8Array();
    try {
        builder.AddFacesToMesh(mesh, indices.length / 3, new Uint32Array(indices));
        const position = builder.AddFloatAttributeToMesh(mesh, draco.POSITION, 8, 3, new Float32Array(corners.flat()));
        encoder.SetEncodingMethod(draco.MESH_SEQUENTIAL_ENCODING);
        encoder.SetAttributeQuantization(draco.POSITION, 14);
        const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
        if (!length) throw new Error('Draco encoding failed');
        const data = new Uint8Array(length);
        for (let i = 0; i < length; i++) data[i] = out.GetValue(i) & 0xff;
        const gltf = {
            asset,
            extensionsUsed: ['KHR_draco_mesh_compression'],
            extensionsRequired: ['KHR_draco_mesh_compression'],
            ...oneNode(),
            meshes: [{
                primitives: [{
                    attributes: { POSITION: 0 },
                    indices: 1,
                    extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: position } } },
                }],
            }],
            accessors: [
                { componentType: 5126, count: 8, type: 'VEC3', min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5] },
                { componentType: 5123, count: indices.length, type: 'SCALAR' },
            ],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: data.byteLength }],
            buffers: [{ byteLength: data.byteLength }],
        };
        return glb(gltf, data);
    } finally {
        draco.destroy(out);
        draco.destroy(encoder);
        draco.destroy(mesh);
        draco.destroy(builder);
    }
}

/** A 2 x 2 m textured quad standing up, facing +z: positions, normals, UVs and indices. */
function quad() {
    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    return { positions, normals, uvs, indices };
}

/** An unlit two-sided material showing texture 0, so the drawn color is the texture's. */
const flatMaterial = { name: 'Surface', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } };

/**
 * A quad whose base color is a KTX2 image (KHR_texture_basisu) named
 * `BasisColor`, as a GLB; with `fallback`, a PNG named `PngColor` for
 * viewers without Basis, else the extension is required.
 */
export function basisuGlb(ktx: Uint8Array, fallback?: Uint8Array): Uint8Array {
    const { positions, normals, uvs, indices } = quad();
    const parts = [bytesOf(positions), bytesOf(normals), bytesOf(uvs), bytesOf(indices), ktx, ...(fallback ? [fallback] : [])];
    const { bytes, at } = pack(parts);
    const images: object[] = [{ bufferView: 4, mimeType: 'image/ktx2', name: 'BasisColor' }];
    if (fallback) images.push({ bufferView: 5, mimeType: 'image/png', name: 'PngColor' });
    const gltf = {
        asset,
        extensionsUsed: ['KHR_texture_basisu', 'KHR_materials_unlit'],
        ...(fallback ? {} : { extensionsRequired: ['KHR_texture_basisu'] }),
        ...oneNode(),
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
        materials: [flatMaterial],
        textures: [{ ...(fallback ? { source: 1 } : {}), extensions: { KHR_texture_basisu: { source: 0 } } }],
        images,
        accessors: [
            { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
        ],
        bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: at[i], byteLength: p.byteLength })),
        buffers: [{ byteLength: bytes.byteLength }],
    };
    return glb(gltf, bytes);
}

/** An embedded .gltf quad whose base color image `Green` is the first bufferView. */
export function bufferViewZeroGltf(image: Uint8Array): string {
    const { positions, normals, uvs, indices } = quad();
    const parts = [image, bytesOf(positions), bytesOf(normals), bytesOf(uvs), bytesOf(indices)];
    const { bytes, at } = pack(parts);
    const gltf = {
        asset,
        extensionsUsed: ['KHR_materials_unlit'],
        ...oneNode(),
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
        materials: [flatMaterial],
        textures: [{ source: 0 }],
        images: [{ bufferView: 0, mimeType: 'image/png', name: 'Green' }],
        accessors: [
            { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
            { bufferView: 2, componentType: 5126, count: 4, type: 'VEC3' },
            { bufferView: 3, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: 4, componentType: 5123, count: 6, type: 'SCALAR' },
        ],
        bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: at[i], byteLength: p.byteLength })),
        buffers: [{ byteLength: bytes.byteLength, uri: 'data:application/octet-stream;base64,' + base64(bytes) }],
    };
    return JSON.stringify(gltf);
}

/** The files of a .zip (stored or deflated, no ZIP64), by path. */
export function unzip(zip: Uint8Array): Map<string, Uint8Array> {
    const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
    let end = buf.length - 22;
    while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0) throw new Error('not a zip file');
    const count = buf.readUInt16LE(end + 10);
    let at = buf.readUInt32LE(end + 16);
    const out = new Map<string, Uint8Array>();
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory');
        const method = buf.readUInt16LE(at + 10);
        const size = buf.readUInt32LE(at + 20);
        const nameLength = buf.readUInt16LE(at + 28);
        const extraLength = buf.readUInt16LE(at + 30);
        const commentLength = buf.readUInt16LE(at + 32);
        const local = buf.readUInt32LE(at + 42);
        const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + size);
        out.set(name, method === 8 ? inflateRawSync(data) : new Uint8Array(data));
        at += 46 + nameLength + extraLength + commentLength;
    }
    return out;
}

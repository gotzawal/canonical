// Packs a model (glTF) for games: textures of one flat color become the
// material's factors, the others are encoded to KTX2 for the slots that use
// them, and geometry and animations are compressed with meshopt. With
// `quantize`, normals and tangents are stored as 8-bit octahedral vectors
// and animation rotations, translations and scales with meshopt's filters;
// positions and UVs stay floats and node transforms stay as they are, so
// the parts the editor overrides still match. The encoder worker
// (derive.worker.ts) loads this with the first model.

import { Logger, Material, PropertyType, WebIO, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import type { TextureRole } from '../core/types';
import { slotRole } from './encode';

/** Encodes one image of the model to KTX2 for a role. */
export type EncodeImage = (image: Blob, role: TextureRole) => Promise<Uint8Array>;

/** The RGBA color (0-255) every pixel of an image has, or null when it has more than one. */
export type FlatColor = (image: Blob) => Promise<[number, number, number, number] | null>;

export interface PackOptions {
    /** Store normals, tangents and animations with meshopt's lossy filters (smaller; positions stay exact). */
    quantize: boolean;
    /** Replace textures of one color by the material's factors. */
    flat: boolean;
}

export interface PackedModel {
    /** The GLB file. */
    data: ArrayBuffer;
    /** Textures encoded to KTX2. */
    textures: number;
    /** Textures of one color replaced by factors. */
    flattened: number;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Moves a flat color into the factor of a material slot, and clears the
 * slot; false when the slot has no factor to hold it (it keeps the texture).
 * Colors are sRGB in the texture and linear in the factors.
 */
export function flattenSlot(material: Material, slot: string, rgba: [number, number, number, number]): boolean {
    const [r, g, b, a] = rgba.map((v) => v / 255);
    const lin = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
    switch (slot) {
        case 'baseColorTexture': {
            const f = material.getBaseColorFactor();
            material.setBaseColorFactor([f[0] * lin[0], f[1] * lin[1], f[2] * lin[2], f[3] * a]);
            material.setBaseColorTexture(null);
            return true;
        }
        case 'emissiveTexture': {
            const f = material.getEmissiveFactor();
            material.setEmissiveFactor([f[0] * lin[0], f[1] * lin[1], f[2] * lin[2]]);
            material.setEmissiveTexture(null);
            return true;
        }
        case 'metallicRoughnessTexture':
            // Roughness in G, metalness in B, both linear.
            material.setRoughnessFactor(material.getRoughnessFactor() * g);
            material.setMetallicFactor(material.getMetallicFactor() * b);
            material.setMetallicRoughnessTexture(null);
            return true;
        case 'normalTexture':
            // Only a flat normal map (straight up in tangent space) says nothing.
            if (Math.abs(rgba[0] - 128) > 3 || Math.abs(rgba[1] - 128) > 3 || rgba[2] < 250) return false;
            material.setNormalTexture(null);
            return true;
        case 'occlusionTexture':
            // Only no occlusion at all has no factor to go to.
            if (r < 0.98) return false;
            material.setOcclusionTexture(null);
            return true;
        default:
            return false;
    }
}

/** Extensions the packer reads and writes back; it would drop any other. */
const KEPT = new Set<string>(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));

/** Image extensions that only allow their MIME type, dropped when no texture has it any more. */
const IMAGE_EXTENSIONS: Record<string, string> = { EXT_texture_webp: 'image/webp', EXT_texture_avif: 'image/avif' };

let io: Promise<WebIO> | null = null;

function reader(): Promise<WebIO> {
    io ??= Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]).then(() =>
        new WebIO()
            .setLogger(new Logger(Logger.Verbosity.WARN))
            .registerExtensions(ALL_EXTENSIONS)
            .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder }),
    );
    io.catch(() => (io = null));
    return io;
}

function isGLB(bytes: Uint8Array): boolean {
    return bytes.byteLength >= 12 && new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(0, true) === 0x46546c67;
}

/** Packs a .glb or .gltf (with its data embedded) into a GLB file for games. */
export async function packModel(file: Blob, encodeImage: EncodeImage, flatColor: FlatColor | null = null, opts: PackOptions = { quantize: false, flat: false }): Promise<PackedModel> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const io = await reader();
    const json = isGLB(bytes) ? await io.binaryToJSON(bytes) : { json: JSON.parse(new TextDecoder().decode(bytes)), resources: {} };
    const used: string[] = [...(json.json.extensionsUsed ?? []), ...(json.json.extensionsRequired ?? [])];
    // Draco models are small already, and the packer would have to decode them.
    if (used.includes('KHR_draco_mesh_compression')) throw new Error('it is Draco compressed');
    const unknown = Array.from(new Set(used.filter((name) => !KEPT.has(name))));
    if (unknown.length) throw new Error(`it uses ${unknown.join(', ')}, which packing would drop`);
    const doc = await io.readJSON(json);
    const root = doc.getRoot();
    const graph = doc.getGraph();

    let flattened = 0;
    if (opts.flat && flatColor) {
        for (const texture of root.listTextures()) {
            const image = texture.getImage();
            if (!image || texture.getMimeType() === 'image/ktx2') continue;
            const color = await flatColor(new Blob([image as Uint8Array<ArrayBuffer>], { type: texture.getMimeType() })).catch(() => null);
            if (!color) continue;
            if (flattenTexture(graph, texture, color)) flattened++;
        }
    }

    let textures = 0;
    for (const texture of root.listTextures()) {
        const slots = graph
            .listParentEdges(texture)
            .filter((edge) => edge.getParent().propertyType !== PropertyType.ROOT)
            .map((edge) => ({ name: edge.getName(), color: !!edge.getAttributes().isColor }));
        // No material shows it: games would only download it.
        if (!slots.length) {
            texture.dispose();
            continue;
        }
        const image = texture.getImage();
        const mime = texture.getMimeType();
        if (!image || mime === 'image/ktx2') continue;
        try {
            const ktx2 = await encodeImage(new Blob([image as Uint8Array<ArrayBuffer>], { type: mime }), slotRole(slots));
            texture.setImage(ktx2).setMimeType('image/ktx2');
            textures++;
        } catch (e) {
            // That texture keeps its image.
            console.warn(`[editor] a texture of the model could not be compressed (${texture.getName() || texture.getURI() || 'unnamed'})`, e);
        }
    }
    if (textures) doc.createExtension(KHRTextureBasisu).setRequired(true);
    const mimes = new Set(root.listTextures().map((t) => t.getMimeType()));
    for (const ext of root.listExtensionsUsed()) {
        const mime = IMAGE_EXTENSIONS[ext.extensionName];
        if (mime && !mimes.has(mime)) ext.dispose();
    }

    // A GLB holds one buffer (a .gltf may have several).
    const buffers = root.listBuffers();
    if (buffers.length > 1) {
        for (const accessor of root.listAccessors()) accessor.setBuffer(buffers[0]);
        for (const buffer of buffers.slice(1)) buffer.dispose();
    }
    if (root.listAccessors().length) {
        // FILTER: normals, tangents and animation channels through meshopt's
        // filters (stored as normalized integers where KHR_mesh_quantization
        // allows them). QUANTIZE without quantizing first leaves every value
        // as it is.
        const method = opts.quantize ? EXTMeshoptCompression.EncoderMethod.FILTER : EXTMeshoptCompression.EncoderMethod.QUANTIZE;
        doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method });
        if (opts.quantize) doc.createExtension(KHRMeshQuantization).setRequired(true);
    }
    const out = await io.writeBinary(doc);
    return { data: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, textures, flattened };
}

/** Moves a texture of one color into the factors of the material slots using it; true when no slot needs it any more (it is removed). */
function flattenTexture(graph: ReturnType<import('@gltf-transform/core').Document['getGraph']>, texture: Texture, color: [number, number, number, number]): boolean {
    const edges = graph.listParentEdges(texture).filter((e) => e.getParent().propertyType !== PropertyType.ROOT);
    if (!edges.length) return false;
    let kept = false;
    for (const edge of edges) {
        const parent = edge.getParent();
        if (!(parent instanceof Material) || !flattenSlot(parent, edge.getName(), color)) kept = true;
    }
    if (kept) return false;
    texture.dispose();
    return true;
}

// Packs a model (glTF) for games: its textures encoded to KTX2 for the
// slots that use them, and its geometry and animations compressed with
// meshopt, without loss: nothing is quantized, so every vertex and node
// transform stays as it is and the parts the editor overrides still match.
// The encoder worker (derive.worker.ts) loads this with the first model.

import { Logger, PropertyType, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import type { TextureRole } from '../core/types';
import { slotRole } from './encode';

/** Encodes one image of the model to KTX2 for a role. */
export type EncodeImage = (image: Blob, role: TextureRole) => Promise<Uint8Array>;

export interface PackedModel {
    /** The GLB file. */
    data: ArrayBuffer;
    /** Textures encoded to KTX2. */
    textures: number;
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
export async function packModel(file: Blob, encodeImage: EncodeImage): Promise<PackedModel> {
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
    // Lossless: QUANTIZE without quantizing first leaves every value as it is.
    if (root.listAccessors().length) {
        doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    }
    const out = await io.writeBinary(doc);
    return { data: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, textures };
}

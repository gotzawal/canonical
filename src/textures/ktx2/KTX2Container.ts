/**
 * The KTX2 container: recognising it and reading its header, without
 * decoding any texture data. Free of GPU and DOM globals.
 *
 * @group Texture
 */

/** The 12 bytes every KTX2 file starts with («KTX 20»\r\n\x1A\n). */
export const KTX2_MAGIC: readonly number[] = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** What the header of a KTX2 file says about its texture. */
export interface KTX2Header {
    /** Vulkan format of the data; 0 for Basis Universal (ETC1S or UASTC). */
    vkFormat: number;
    width: number;
    height: number;
    depth: number;
    layers: number;
    faces: number;
    levels: number;
    /** 0 none, 1 BasisLZ (ETC1S), 2 Zstandard, 3 zlib. */
    supercompression: number;
}

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    return data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
}

/** True when the data starts like a KTX2 file. */
export function isKTX2(data: ArrayBuffer | ArrayBufferView): boolean {
    const bytes = bytesOf(data);
    if (bytes.length < KTX2_MAGIC.length) return false;
    for (let i = 0; i < KTX2_MAGIC.length; i++) if (bytes[i] !== KTX2_MAGIC[i]) return false;
    return true;
}

/** The header of a KTX2 file; throws when the data is not one. */
export function readKTX2Header(data: ArrayBuffer | ArrayBufferView): KTX2Header {
    const bytes = bytesOf(data);
    if (!isKTX2(bytes) || bytes.length < 48) throw new Error('not a KTX2 file');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (at: number) => view.getUint32(at, true);
    return {
        vkFormat: u32(12),
        width: u32(20),
        height: u32(24),
        depth: u32(28),
        layers: u32(32),
        faces: u32(36),
        levels: u32(40),
        supercompression: u32(44),
    };
}

/** True for a glTF image, or a URL, that holds KTX2 data. */
export function isKTX2Image(image: { mimeType?: string; uri?: string } | string | undefined | null): boolean {
    if (!image) return false;
    const uri = typeof image === 'string' ? image : image.uri ?? '';
    if (typeof image !== 'string' && image.mimeType === 'image/ktx2') return true;
    return /^data:image\/ktx2[;,]/i.test(uri) || /\.ktx2(?:[?#]|$)/i.test(uri);
}

/**
 * Facts about GPU texture formats that do not need a device: whether a
 * format decodes sRGB on sample, whether it is block compressed, and how
 * large its blocks are. Kept free of WebGPU globals so it runs anywhere.
 *
 * @group GFX
 */

/** Size of a format's block: `bytes` for a `w` x `h` block of texels. */
export interface TextureFormatBlock {
    bytes: number;
    w: number;
    h: number;
}

/** Formats that have an `-srgb` twin (the twin decodes sRGB to linear on sample). */
const SRGB_TWINS = /^(rgba8unorm|bgra8unorm|bc[1237]-rgba-unorm|etc2-rgb8unorm|etc2-rgb8a1unorm|etc2-rgba8unorm|astc-\d+x\d+-unorm)(-srgb)?$/;

/** True for formats the sampler decodes from sRGB to linear. */
export function isSrgbFormat(format: GPUTextureFormat | string | undefined | null): boolean {
    return typeof format === 'string' && format.endsWith('-srgb');
}

/** True for block-compressed formats (BC, ETC2, EAC and ASTC). */
export function isCompressedFormat(format: GPUTextureFormat | string | undefined | null): boolean {
    return typeof format === 'string' && /^(bc\d|etc2|eac|astc)/.test(format);
}

/** The `-srgb` twin of a format, or the format itself when it has none. */
export function toSrgbFormat<T extends string>(format: T): T {
    const m = SRGB_TWINS.exec(format);
    return (m ? m[1] + '-srgb' : format) as T;
}

/** The linear twin of an `-srgb` format, or the format itself. */
export function toLinearFormat<T extends string>(format: T): T {
    const m = SRGB_TWINS.exec(format);
    return (m ? m[1] : format) as T;
}

/** Bytes per block and block size of a format; unknown formats count 4 bytes a texel. */
export function formatBlockInfo(format: GPUTextureFormat | string): TextureFormatBlock {
    const f = format || '';
    const bc = /^bc(\d)/.exec(f);
    if (bc) return { bytes: bc[1] === '1' || bc[1] === '4' ? 8 : 16, w: 4, h: 4 };
    if (f.startsWith('etc2') || f.startsWith('eac')) return { bytes: /rgba8|rg11/.test(f) ? 16 : 8, w: 4, h: 4 };
    const astc = /^astc-(\d+)x(\d+)/.exec(f);
    if (astc) return { bytes: 16, w: Number(astc[1]), h: Number(astc[2]) };
    switch (f) {
        case 'stencil8':
            return { bytes: 1, w: 1, h: 1 };
        case 'depth16unorm':
            return { bytes: 2, w: 1, h: 1 };
        case 'depth32float-stencil8':
            return { bytes: 8, w: 1, h: 1 };
        case 'depth24plus':
        case 'depth24plus-stencil8':
        case 'depth32float':
        case 'rgb10a2unorm':
        case 'rgb10a2uint':
        case 'rg11b10ufloat':
        case 'rgb9e5ufloat':
            return { bytes: 4, w: 1, h: 1 };
    }
    const m = /^(r|rg|rgba|bgra)(8|16|32)/.exec(f);
    if (m) return { bytes: (m[1] === 'bgra' ? 4 : m[1].length) * (Number(m[2]) / 8), w: 1, h: 1 };
    return { bytes: 4, w: 1, h: 1 };
}

/** Bytes of one mip level of a 2D texture, rounded up to whole blocks. */
export function levelBytes(format: GPUTextureFormat | string, width: number, height: number): number {
    const b = formatBlockInfo(format);
    return Math.ceil(Math.max(1, width) / b.w) * Math.ceil(Math.max(1, height) / b.h) * b.bytes;
}

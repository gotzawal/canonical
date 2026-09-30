// How a texture is encoded to KTX2 (Basis Universal) for a role: its size
// and the encoder's settings. No worker or DOM here, so it is testable; the
// worker (derive.worker.ts) applies it.

import type { DerivedOptions } from '../core/derived';
import type { TextureRole } from '../core/types';

/** The encoder refuses larger sources (Basis Universal 2.5 in 32-bit WebAssembly). */
export const MAX_SOURCE_TEXELS = 12 * 1024 * 1024;

/**
 * The size a texture is encoded at: no side over `maxSize` (keeping the
 * aspect), under the encoder's limit, and whole 4x4 blocks, which GPU block
 * compression needs.
 */
export function encodedSize(width: number, height: number, maxSize: number): { width: number; height: number } {
    let k = Math.min(1, maxSize / Math.max(width, height, 1));
    if (width * height * k * k > MAX_SOURCE_TEXELS) k = Math.sqrt(MAX_SOURCE_TEXELS / (width * height));
    const block = (v: number) => Math.max(4, Math.round((v * k) / 4) * 4);
    let w = block(width);
    let h = block(height);
    // Rounding up may still cross the limit.
    while (w * h > MAX_SOURCE_TEXELS) {
        if (w >= h) w -= 4;
        else h -= 4;
    }
    return { width: w, height: h };
}

/** Settings of the Basis encoder for one texture. */
export interface EncoderSettings {
    uastc: boolean;
    /** Colors: measure errors as the eye sees them, mark the file sRGB and filter mips in sRGB. */
    srgb: boolean;
    /** Tune for normal maps and renormalize their mips. */
    normalMap: boolean;
    /** ETC1S quality (1-255) and effort (0-6). */
    quality: number;
    effort: number;
    /** UASTC effort (0-4) and Zstandard supercompression. */
    uastcLevel: number;
    zstd: boolean;
}

export function encoderSettings(role: TextureRole, opts: DerivedOptions): EncoderSettings {
    const color = role === 'color';
    return {
        uastc: opts.codec === 'uastc',
        srgb: color,
        normalMap: role === 'normal',
        quality: 128,
        effort: 2,
        uastcLevel: 1,
        zstd: true,
    };
}

/** Slots of glTF materials that hold normal maps. */
const NORMAL_SLOTS = ['normalTexture', 'clearcoatNormalTexture'];

/**
 * The role of a model's texture from the material slots that use it (the
 * name of each, and whether it samples the texture as color): a normal map
 * wherever one uses it as such, else a color where one samples colors,
 * else data (roughness, metalness, occlusion).
 */
export function slotRole(slots: { name: string; color: boolean }[]): TextureRole {
    if (slots.some((s) => NORMAL_SLOTS.includes(s.name))) return 'normal';
    if (slots.some((s) => s.color)) return 'color';
    return 'data';
}

/**
 * The role a texture file's name suggests, for a file no material uses yet:
 * normal maps and data maps (roughness, metalness, occlusion, masks) by
 * their usual suffixes, else colors.
 */
export function roleFromName(name: string): TextureRole {
    const stem = name.toLowerCase().replace(/\.[a-z0-9]+$/, '');
    if (/(^|[^a-z])(normal|nrm|nor|norm|n)$|normal/.test(stem)) return 'normal';
    if (/rough|metal|orm|arm|occlusion|(^|[^a-z])ao($|[^a-z])|mask|spec|gloss|height|disp|bump/.test(stem)) return 'data';
    return 'color';
}

/** How a texture of a model is encoded: its colors with the model's codec, its normal and data maps in UASTC. */
export function modelTextureOptions(role: TextureRole, model: DerivedOptions): DerivedOptions {
    return { codec: role === 'color' ? model.codec : 'uastc', maxSize: model.maxSize };
}

/**
 * GPU memory of a texture with its mip chain: `blockBytes` per 4x4 block
 * (16 for BC7, ASTC and ETC2 with alpha, 8 for BC1 and ETC2 without), or
 * RGBA8 when 0.
 */
export function textureMemory(width: number, height: number, blockBytes = 0): number {
    let bytes = 0;
    for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
        bytes += blockBytes ? Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes : w * h * 4;
        if (w === 1 && h === 1) break;
    }
    return bytes;
}

/** Bytes per 4x4 block a copy takes on the GPU: ETC1S without alpha goes to 8-byte formats, the rest to 16-byte ones. */
export function copyBlockBytes(codec: 'etc1s' | 'uastc', alpha: boolean): number {
    return codec === 'etc1s' && !alpha ? 8 : 16;
}

/** The color every RGBA pixel has, within `tolerance` a channel (the first pixel's), or null when they differ. */
export function sameColor(pixels: Uint8Array, tolerance = 2): [number, number, number, number] | null {
    if (pixels.length < 4) return null;
    const first = [pixels[0], pixels[1], pixels[2], pixels[3]] as [number, number, number, number];
    for (let i = 4; i < pixels.length; i += 4) {
        for (let k = 0; k < 4; k++) if (Math.abs(pixels[i + k] - first[k]) > tolerance) return null;
    }
    return first;
}

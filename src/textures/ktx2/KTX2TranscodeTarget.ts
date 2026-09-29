/**
 * Which GPU format a Basis Universal texture is transcoded to on this
 * device. Free of GPU globals so the choice can be tested anywhere.
 *
 * @group Texture
 */

/** The block-compression families a device can sample. */
export interface CompressedTextureSupport {
    bc: boolean;
    etc2: boolean;
    astc: boolean;
}

/** The two Basis Universal encodings: small ETC1S, or high-quality UASTC. */
export type BasisEncoding = 'etc1s' | 'uastc';

/** One way to transcode: the transcoder's format name and the GPU format it fills. */
export interface TranscodeTarget {
    /** Name in the Basis transcoder's `transcoder_texture_format` enum. */
    name: string;
    format: GPUTextureFormat;
    /** Block compressed, so the base level must be a multiple of 4 on each side. */
    compressed: boolean;
}

/** Ranked targets for each encoding, for opaque and for transparent textures. */
export type TranscodeTable = Record<BasisEncoding, { opaque: TranscodeTarget[]; alpha: TranscodeTarget[] }>;

const RGBA32: TranscodeTarget = { name: 'cTFRGBA32', format: 'rgba8unorm', compressed: false };
const ASTC: TranscodeTarget = { name: 'cTFASTC_4x4_RGBA', format: 'astc-4x4-unorm', compressed: true };
const BC7: TranscodeTarget = { name: 'cTFBC7_RGBA', format: 'bc7-rgba-unorm', compressed: true };
const BC1: TranscodeTarget = { name: 'cTFBC1_RGB', format: 'bc1-rgba-unorm', compressed: true };
// ETC1 is a subset of ETC2's RGB8, and what ETC1S transcodes to without loss.
const ETC2_RGB: TranscodeTarget = { name: 'cTFETC1_RGB', format: 'etc2-rgb8unorm', compressed: true };
const ETC2_RGBA: TranscodeTarget = { name: 'cTFETC2_RGBA', format: 'etc2-rgba8unorm', compressed: true };

/**
 * The transcode targets this device can sample, best first:
 * - UASTC keeps its quality in ASTC or BC7, then falls to ETC2.
 * - ETC1S is ETC1 inside, so ETC2 takes it as it is; on BC devices an
 *   opaque texture goes to BC1, half the memory of BC7.
 * - Uncompressed RGBA8 always works, at four to eight times the memory.
 */
export function rankTargets(support: Partial<CompressedTextureSupport> | null | undefined): TranscodeTable {
    const s = { bc: !!support?.bc, etc2: !!support?.etc2, astc: !!support?.astc };
    const pick = (...list: [boolean, TranscodeTarget][]) => [...list.filter(([ok]) => ok).map(([, t]) => t), RGBA32];
    return {
        uastc: {
            opaque: pick([s.astc, ASTC], [s.bc, BC7], [s.etc2, ETC2_RGB]),
            alpha: pick([s.astc, ASTC], [s.bc, BC7], [s.etc2, ETC2_RGBA]),
        },
        etc1s: {
            opaque: pick([s.etc2, ETC2_RGB], [s.bc, BC1], [s.astc, ASTC]),
            alpha: pick([s.etc2, ETC2_RGBA], [s.bc, BC7], [s.astc, ASTC]),
        },
    };
}

/** The best target for a texture, given its encoding, alpha and base size. */
export function chooseTarget(table: TranscodeTable, encoding: BasisEncoding, alpha: boolean, width: number, height: number): TranscodeTarget {
    const aligned = width % 4 === 0 && height % 4 === 0;
    const list = table[encoding][alpha ? 'alpha' : 'opaque'];
    return list.find((t) => aligned || !t.compressed) ?? RGBA32;
}

// How sharp the images are that go to the models and come from them, chosen
// per use to spend fewer tokens: the chat's image button sets them for the
// assistant, and the image dialogs choose one per generation. A model reads
// an image as tokens by its pixels, so a smaller image costs less; image
// models charge by the size and quality they draw at.

import type { ParamValue } from '../core/types';
import { modelParams, type ImageModel } from './images';

export type ImageQuality = 'low' | 'medium' | 'high';
export const IMAGE_QUALITIES: readonly ImageQuality[] = ['low', 'medium', 'high'];
export const isImageQuality = (v: unknown): v is ImageQuality => IMAGE_QUALITIES.includes(v as ImageQuality);

/** Longest side, in pixels, of the images the assistant looks at (captures, attachments, images it views). */
export const SEE_PIXELS: Record<ImageQuality, number> = { low: 512, medium: 1024, high: 1568 };
/**
 * OpenAI's detail hint per quality: low reads any image as a few tokens, high
 * in tiles of the whole image; other providers go by the pixels alone.
 */
export const SEE_DETAIL: Record<ImageQuality, 'low' | 'high' | undefined> = { low: 'low', medium: undefined, high: 'high' };
/** Longest side, in pixels, of the reference images (captures, concepts) sent to the image model. */
export const REFERENCE_PIXELS: Record<ImageQuality, number> = { low: 768, medium: 1024, high: 1536 };
/** Longest side of the images the image model draws, as each quality aims at it. */
const DRAW_PIXELS: Record<ImageQuality, number> = { low: 512, medium: 1024, high: 2048 };

export const QUALITY_NAMES: Record<ImageQuality, string> = { low: 'Low', medium: 'Medium', high: 'High' };
/** What each quality means for the images the assistant sees. */
export const SEE_HINTS: Record<ImageQuality, string> = {
    low: 'up to 512 px: the fewest tokens, enough to judge layout and color',
    medium: 'up to 1024 px',
    high: 'up to 1568 px: fine detail, the most tokens',
};
/** What each quality means for the images an image model draws. */
export const DRAW_HINTS: Record<ImageQuality, string> = {
    low: 'the smallest size and lowest quality the model offers, the fewest credits',
    medium: 'about 1K',
    high: 'about 2K and the model\'s high quality, the most credits',
};

/**
 * The image model's options for a quality: its `quality` setting where it
 * lists the value, and the `resolution` it lists closest to the size the
 * quality aims at. Options the model does not list are left out.
 */
export function drawParams(model: ImageModel | undefined, quality: ImageQuality): Record<string, ParamValue> {
    const specs = modelParams(model);
    const out: Record<string, ParamValue> = {};
    const q = specs.quality;
    if (q?.type === 'enum') {
        const hit = q.values.find((v) => String(v).toLowerCase() === quality);
        if (hit !== undefined) out.quality = hit;
    }
    const r = specs.resolution;
    if (r?.type === 'enum') {
        let best: { v: string | number; err: number } | null = null;
        for (const v of r.values) {
            const px = resolutionPixels(String(v));
            if (!px) continue;
            const err = Math.abs(Math.log(px / DRAW_PIXELS[quality]));
            if (!best || err < best.err) best = { v, err };
        }
        if (best) out.resolution = best.v;
    }
    return out;
}

/** The longer side a resolution value names ("0.5K" 512, "2K" 2048, "1536x1024" 1536); 0 when it names none. */
export function resolutionPixels(v: string): number {
    const s = v.trim();
    const k = /^(\d+(?:\.\d+)?)\s*k$/i.exec(s);
    if (k) return Number(k[1]) * 1024;
    const wh = /^(\d+)\s*[x*]\s*(\d+)$/i.exec(s);
    if (wh) return Math.max(Number(wh[1]), Number(wh[2]));
    return 0;
}

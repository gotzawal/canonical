// The swatch library: tileable albedo textures shared by every project in
// this browser (IndexedDB store 'swatches', outside any scene), with tags
// and where each one came from. Search it before generating: a swatch a
// material slot uses is copied into the project as a texture asset, so the
// scene and its built game carry it.
//
// Every swatch goes through the same processing: a square crop, large-scale
// shading evened out (swatches must be flat albedo without baked light),
// the edges blended so it tiles (unless it already does), brightness kept
// within about sRGB 30..240, and WebP encoding.

import { putAsset } from '../core/assets';
import { tx } from '../core/db';
import { uid } from '../core/ids';
import { assetImageDataUrl, canvas, canvasBlob } from '../core/images';
import type { AssetMeta, MaterialSlotDoc, ParamValue } from '../core/types';
import type { Editor } from '../editor';
import { checkParams, closestAspect, generateImages, listImageModels, modelParams, takesImages, type ImageModel } from '../ai/images';
import { aiSettings } from '../ai/settings';

export interface SwatchRecord {
    id: string;
    name: string;
    tags: string[];
    /** Square WebP (or PNG where WebP cannot be written). */
    blob: Blob;
    /** Pixels per side. */
    size: number;
    /** Mean color, #rrggbb. */
    color: string;
    /** Suggested size of one tile in meters. */
    tile: number;
    roughness?: number;
    metallic?: number;
    source: 'generated' | 'upload';
    model?: string;
    prompt?: string;
    seed?: number | null;
    cost?: number | null;
    created: string;
}

/** Library records without their image data, for lists. */
export type SwatchInfo = Omit<SwatchRecord, 'blob'>;

// ---------------------------------------------------------------- storage

const memory = new Map<string, SwatchRecord>();

export async function listSwatches(): Promise<SwatchRecord[]> {
    try {
        const all = (await tx('swatches', 'readonly', (s) => s.getAll())) as SwatchRecord[];
        for (const r of all) memory.set(r.id, r);
    } catch { /* memory only */ }
    return [...memory.values()].sort((a, b) => b.created.localeCompare(a.created));
}

export async function getSwatch(id: string): Promise<SwatchRecord | null> {
    const cached = memory.get(id);
    if (cached) return cached;
    try {
        const r = (await tx('swatches', 'readonly', (s) => s.get(id))) as SwatchRecord | undefined;
        if (r) memory.set(id, r);
        return r ?? null;
    } catch {
        return null;
    }
}

export async function putSwatch(rec: SwatchRecord): Promise<void> {
    memory.set(rec.id, rec);
    try {
        await tx('swatches', 'readwrite', (s) => s.put(rec));
    } catch (e) {
        console.warn('[editor] swatch kept in memory only', e);
    }
}

export async function updateSwatch(id: string, patch: Partial<Pick<SwatchRecord, 'name' | 'tags' | 'tile' | 'roughness' | 'metallic'>>): Promise<SwatchRecord | null> {
    const rec = await getSwatch(id);
    if (!rec) return null;
    const next = { ...rec, ...patch, tags: patch.tags ? normalizeTags(patch.tags) : rec.tags };
    await putSwatch(next);
    return next;
}

export async function deleteSwatch(id: string): Promise<void> {
    memory.delete(id);
    try {
        await tx('swatches', 'readwrite', (s) => s.delete(id));
    } catch { /* ignore */ }
}

const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'into', 'onto', 'over', 'under', 'very', 'some', 'like', 'made', 'surface', 'material', 'texture']);

/** Lower case words of a text worth tagging. */
export function tagsFrom(text: string): string[] {
    const words = text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
    return normalizeTags(words).slice(0, 12);
}

function normalizeTags(tags: string[]): string[] {
    return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 24);
}

/** Library swatches matching a query (words against names and tags), best first. */
export async function searchSwatches(query: string, limit = 24): Promise<{ swatch: SwatchRecord; score: number }[]> {
    const all = await listSwatches();
    const words = tagsFrom(query);
    if (!words.length) return all.slice(0, limit).map((swatch) => ({ swatch, score: 0 }));
    const out: { swatch: SwatchRecord; score: number }[] = [];
    for (const s of all) {
        const name = s.name.toLowerCase();
        const nameWords = tagsFrom(s.name);
        let score = 0;
        for (const w of words) {
            if (s.tags.includes(w)) score += 3;
            else if (nameWords.includes(w)) score += 3;
            else if (s.tags.some((t) => t.startsWith(w) || w.startsWith(t))) score += 1.5;
            else if (name.includes(w)) score += 1;
        }
        if (score > 0) out.push({ swatch: s, score: score / words.length });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ------------------------------------------------------------- processing

export interface ProcessOptions {
    /** Pixels per side of the result (default 1024). */
    size?: number;
    /** Even out large-scale shading (default on). */
    flatten?: boolean;
    /** Blend the edges so the texture tiles (default on; skipped when it already tiles). */
    seamless?: boolean;
}

export interface ProcessedSwatch {
    blob: Blob;
    size: number;
    color: string;
    /** What was changed, in words. */
    notes: string[];
}

const TO_LINEAR = new Float32Array(256).map((_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function toSrgb8(v: number): number {
    const c = Math.min(1, Math.max(0, v));
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
}

/** Crops, flattens, makes seamless, levels and encodes an image as a swatch. */
export async function processSwatch(src: Blob, opts: ProcessOptions = {}): Promise<ProcessedSwatch> {
    const size = Math.max(64, Math.min(2048, Math.round(opts.size ?? 1024)));
    const bmp = await createImageBitmap(src);
    const c = canvas(size, size);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingQuality = 'high';
    try {
        const side = Math.min(bmp.width, bmp.height);
        g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    } finally {
        bmp.close();
    }
    let img = g.getImageData(0, 0, size, size);
    const notes: string[] = [];
    if (opts.flatten !== false) flatten(img, size, notes);
    if (opts.seamless !== false) img = seamless(img, size, notes);
    levels(img, 30, 240, notes);
    g.putImageData(img, 0, 0);
    let blob = await canvasBlob(c, 'image/webp', 0.9).catch(() => null);
    if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(c, 'image/png');
    return { blob, size, color: meanColor(img), notes };
}

/** Evens out shading larger than about an eighth of the image (baked light and shadow). */
function flatten(img: ImageData, size: number, notes: string[]) {
    const d = img.data;
    const n = size * size;
    // Low frequency lightness: the image scaled down to 8 x 8 and smoothly back up.
    const small = canvas(8, 8);
    const sg = small.getContext('2d', { willReadFrequently: true })!;
    const full = canvas(size, size);
    full.getContext('2d')!.putImageData(img, 0, 0);
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(full, 0, 0, 8, 8);
    const big = canvas(size, size);
    const bg = big.getContext('2d', { willReadFrequently: true })!;
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(small, 0, 0, size, size);
    const low = bg.getImageData(0, 0, size, size).data;
    const lum = (a: Uint8ClampedArray, i: number) => 0.2126 * TO_LINEAR[a[i]] + 0.7152 * TO_LINEAR[a[i + 1]] + 0.0722 * TO_LINEAR[a[i + 2]];
    let mean = 0, lo = Infinity, hi = 0;
    for (let i = 0; i < n; i++) {
        const l = lum(low, i * 4);
        mean += l;
        if (l < lo) lo = l;
        if (l > hi) hi = l;
    }
    mean /= n;
    if (mean <= 1e-4 || (hi - lo) / mean < 0.15) return;
    for (let i = 0; i < n; i++) {
        const l = Math.max(1e-4, lum(low, i * 4));
        const k = Math.min(2, Math.max(0.5, (mean / l) ** 0.8));
        const o = i * 4;
        d[o] = toSrgb8(TO_LINEAR[d[o]] * k);
        d[o + 1] = toSrgb8(TO_LINEAR[d[o + 1]] * k);
        d[o + 2] = toSrgb8(TO_LINEAR[d[o + 2]] * k);
    }
    notes.push(`evened out baked shading (${Math.round(((hi - lo) / mean) * 100)}% variation)`);
}

/**
 * Blends the image with a copy shifted by half its size, weighting each by
 * its distance from its own seams, so the edges meet when tiled. Images
 * whose edges already meet are left alone.
 */
function seamless(img: ImageData, size: number, notes: string[]): ImageData {
    const d = img.data;
    const luma = (x: number, y: number) => {
        const o = (y * size + x) * 4;
        return 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
    };
    // Jump across the edges compared with the jump between neighbors inside.
    let edge = 0, inner = 0;
    for (let i = 0; i < size; i++) {
        edge += Math.abs(luma(0, i) - luma(size - 1, i)) + Math.abs(luma(i, 0) - luma(i, size - 1));
        const m = size >> 1;
        inner += Math.abs(luma(m, i) - luma(m + 1, i)) + Math.abs(luma(i, m) - luma(i, m + 1));
    }
    if (edge <= inner * 1.6) return img;
    const out = new ImageData(size, size);
    const o = out.data;
    const half = size >> 1;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const da = Math.min(x, size - 1 - x, y, size - 1 - y);
            const db = Math.min(Math.abs(x - half), Math.abs(y - half));
            const wa = da * da, wb = db * db;
            const t = wa + wb > 0 ? wa / (wa + wb) : 0.5;
            const i = (y * size + x) * 4;
            const j = (((y + half) % size) * size + ((x + half) % size)) * 4;
            for (let c = 0; c < 3; c++) o[i + c] = d[i + c] * t + d[j + c] * (1 - t);
            o[i + 3] = 255;
        }
    }
    notes.push('blended the edges so it tiles');
    return out;
}

/** Stretches or squeezes brightness into lo..hi (sRGB) when the image leaves that range. */
function levels(img: ImageData, lo: number, hi: number, notes: string[]) {
    const d = img.data;
    const hist = new Uint32Array(256);
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) hist[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    const pct = (p: number) => {
        let acc = 0;
        for (let v = 0; v < 256; v++) {
            acc += hist[v];
            if (acc >= n * p) return v;
        }
        return 255;
    };
    const p1 = pct(0.01), p99 = pct(0.99);
    if (p1 >= lo && p99 <= hi) return;
    const a = Math.max(lo, p1), b = Math.min(hi, p99);
    const span = Math.max(1, p99 - p1);
    for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) d[i + c] = a + ((d[i + c] - p1) * (b - a)) / span;
    }
    notes.push(`brightness moved into ${lo}-${hi} (was ${p1}-${p99})`);
}

function meanColor(img: ImageData): string {
    const d = img.data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
        r += TO_LINEAR[d[i]];
        g += TO_LINEAR[d[i + 1]];
        b += TO_LINEAR[d[i + 2]];
    }
    const hx = (v: number) => toSrgb8(v / n).toString(16).padStart(2, '0');
    return `#${hx(r)}${hx(g)}${hx(b)}`;
}

// ------------------------------------------------------------- add / use

/** Processes image files and adds them to the library. */
export async function importSwatches(files: File[], meta: { tags?: string[]; tile?: number } = {}, opts: ProcessOptions = {}): Promise<SwatchRecord[]> {
    const out: SwatchRecord[] = [];
    for (const f of files) {
        const p = await processSwatch(f, opts);
        const name = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Swatch';
        const rec: SwatchRecord = {
            id: uid('sw'),
            name,
            tags: normalizeTags([...(meta.tags ?? []), ...tagsFrom(name)]),
            blob: p.blob,
            size: p.size,
            color: p.color,
            tile: meta.tile ?? 2,
            source: 'upload',
            created: new Date().toISOString(),
        };
        await putSwatch(rec);
        out.push(rec);
    }
    return out;
}

/** The instruction for a swatch of a slot. */
export function swatchPrompt(slot: Pick<MaterialSlotDoc, 'name' | 'description' | 'tile'>, withRefs: boolean): string {
    const what = [slot.name, slot.description].filter((s) => s && s.trim()).join(': ');
    return [
        `A seamless, tileable texture of ${what || 'the material'}, about ${slot.tile} meters across.`,
        'Flat albedo only: lit evenly from the front, no shadows, no highlights or reflections, no perspective or vanishing lines. Viewed straight on and filling the whole square frame, no borders, objects or text.',
        withRefs ? 'Match the look and colors of this material in the reference images.' : '',
    ].filter(Boolean).join('\n');
}

export interface SwatchGeneration {
    prompt: string;
    /** Scene image assets (concepts, paintovers) sent as references. */
    refs: string[];
    count: number;
    model: string;
    params: Record<string, ParamValue>;
    seed: number | null;
    name: string;
    tags: string[];
    tile: number;
    roughness?: number;
    metallic?: number;
}

/** Generates swatches with the image model, processes them and adds them to the library. */
export async function generateSwatches(gen: SwatchGeneration, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<{ swatches: SwatchRecord[]; cost: number | null; errors: string[]; dropped: string[] }> {
    const key = aiSettings.apiKey;
    if (!key) throw new Error('Add an OpenRouter key in the AI settings first.');
    const models = await listImageModels().catch(() => [] as ImageModel[]);
    const model = models.find((m) => m.id === gen.model);
    if (models.length && !model) throw new Error(`"${gen.model}" is not an image model on OpenRouter.`);
    const refs = model && !takesImages(model) ? [] : gen.refs;
    const references: string[] = [];
    for (const id of refs) {
        const url = await assetImageDataUrl(id, 1024);
        if (url) references.push(url);
    }
    const specs = modelParams(model);
    const params: Record<string, ParamValue> = { ...gen.params };
    // Square output where the model has a choice.
    if (specs.aspect_ratio?.type === 'enum' && params.aspect_ratio === undefined) {
        const v = closestAspect(specs.aspect_ratio.values, 1);
        if (v) params.aspect_ratio = v;
    } else if (specs.size?.type === 'enum' && params.size === undefined) {
        const v = closestAspect(specs.size.values, 1);
        if (v) params.size = v;
    }
    const checked = checkParams(model, params);
    const res = await generateImages(key, model, { model: gen.model, prompt: gen.prompt, references, count: gen.count, seed: gen.seed, params: checked.params }, { signal: opts.signal, onProgress: opts.onProgress });
    const swatches: SwatchRecord[] = [];
    const created = new Date().toISOString();
    for (const img of res.images) {
        const p = await processSwatch(img.blob);
        const rec: SwatchRecord = {
            id: uid('sw'),
            name: gen.name,
            tags: normalizeTags([...gen.tags, ...tagsFrom(gen.name)]),
            blob: p.blob,
            size: p.size,
            color: p.color,
            tile: gen.tile,
            ...(gen.roughness !== undefined ? { roughness: gen.roughness } : {}),
            ...(gen.metallic !== undefined ? { metallic: gen.metallic } : {}),
            source: 'generated',
            model: gen.model,
            prompt: gen.prompt,
            seed: img.seed,
            cost: img.cost,
            created,
        };
        await putSwatch(rec);
        swatches.push(rec);
    }
    return { swatches, cost: res.cost, errors: res.errors, dropped: [...checked.dropped, ...(refs.length < gen.refs.length ? ['references (the model takes no images)'] : [])] };
}

/** File name of a swatch copied into a project; the same swatch is copied once. */
function assetName(rec: SwatchRecord): string {
    const stem = rec.name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'swatch';
    return `${stem}.${rec.id}.${rec.blob.type === 'image/png' ? 'png' : 'webp'}`;
}

/** The project's texture asset of a library swatch, copied in (inside no commit; the caller commits the meta) when missing. */
export async function swatchAsset(editor: Editor, rec: SwatchRecord): Promise<{ meta: AssetMeta; added: boolean }> {
    const name = assetName(rec);
    const existing = editor.store.doc.assets.find((a) => a.kind === 'texture' && a.name === name);
    if (existing) return { meta: existing, added: false };
    const meta = await putAsset(rec.blob, name, 'texture', undefined, { width: rec.size, height: rec.size });
    return { meta, added: true };
}

/** The library swatch a project texture was copied from, if any. */
export function swatchIdOf(meta: AssetMeta | undefined): string | null {
    const m = meta ? /\.(sw_[a-z0-9]+)\.(webp|png)$/i.exec(meta.name) : null;
    return m ? m[1] : null;
}

// OpenRouter Image API client (POST /api/v1/images): generation from a
// prompt and reference images, the image model list with the parameters
// each model accepts (option UIs are built from it; a parameter a model does
// not list is not supported), and partial images for models that stream.
// Failed or cancelled generations are not charged.

import type { ParamValue } from '../core/types';
import { errorText, headers, OPENROUTER_URL, OpenRouterError } from './openrouter';

export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview';
/** Most images one generation may ask for. */
export const MAX_IMAGES = 10;

export type ParamSpec =
    | { type: 'enum'; values: (string | number)[] }
    | { type: 'range'; min: number; max: number }
    | { type: 'boolean' };

export interface ImageModel {
    id: string;
    name: string;
    description?: string;
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
    supported_parameters?: Record<string, ParamSpec>;
    supports_streaming?: boolean;
}

/** Parameters with their own fields in the request (not generic options). */
export const OWN_PARAMS = new Set(['model', 'prompt', 'n', 'seed', 'input_references', 'stream']);

let cache: { at: number; list: ImageModel[] } | null = null;

/** The image models on OpenRouter (public endpoint, cached for 10 minutes). */
export async function listImageModels(force = false): Promise<ImageModel[]> {
    if (!force && cache && Date.now() - cache.at < 600_000) return cache.list;
    const res = await fetch(`${OPENROUTER_URL}/images/models`);
    if (!res.ok) throw new OpenRouterError(errorText(await res.text(), res.status), res.status);
    const json = await res.json();
    const list: ImageModel[] = (Array.isArray(json?.data) ? json.data : []).filter((m: any) => m && typeof m.id === 'string');
    cache = { at: Date.now(), list };
    return list;
}

/** True when the model takes reference images (image to image). */
export function takesImages(m: ImageModel | undefined): boolean {
    return !!m?.architecture?.input_modalities?.includes('image');
}

/** The parameters a model lists, cleaned up; anything else is not supported. */
export function modelParams(m: ImageModel | undefined): Record<string, ParamSpec> {
    const out: Record<string, ParamSpec> = {};
    for (const [k, v] of Object.entries(m?.supported_parameters ?? {})) {
        const spec = v as any;
        if (!spec || typeof spec !== 'object') continue;
        if (spec.type === 'enum' && Array.isArray(spec.values)) {
            const values = spec.values.filter((x: unknown) => typeof x === 'string' || typeof x === 'number');
            if (values.length) out[k] = { type: 'enum', values };
        } else if (spec.type === 'range' && Number.isFinite(spec.min) && Number.isFinite(spec.max)) {
            out[k] = { type: 'range', min: Number(spec.min), max: Number(spec.max) };
        } else if (spec.type === 'boolean') out[k] = { type: 'boolean' };
    }
    return out;
}

/** Readable form of a parameter spec: "1K | 2K | 4K", "0-100", "on / off". */
export function describeSpec(spec: ParamSpec): string {
    if (spec.type === 'enum') return spec.values.join(' | ');
    if (spec.type === 'range') return `${spec.min}-${spec.max}`;
    return 'on / off';
}

/**
 * Keeps the options a model supports, with values it accepts (ranges are
 * clamped). `dropped` says what was left out and why.
 */
export function checkParams(model: ImageModel | undefined, params: Record<string, unknown>): { params: Record<string, ParamValue>; dropped: string[] } {
    const specs = modelParams(model);
    const out: Record<string, ParamValue> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        if (OWN_PARAMS.has(k)) continue;
        const spec = specs[k];
        if (!spec) {
            dropped.push(`${k} (not supported by ${model?.id ?? 'this model'})`);
            continue;
        }
        if (spec.type === 'enum') {
            const hit = spec.values.find((x) => String(x) === String(v));
            if (hit === undefined) dropped.push(`${k}: ${String(v)} (use ${describeSpec(spec)})`);
            else out[k] = hit;
        } else if (spec.type === 'range') {
            const n = Number(v);
            if (!Number.isFinite(n)) {
                dropped.push(`${k}: not a number`);
                continue;
            }
            const whole = Number.isInteger(spec.min) && Number.isInteger(spec.max);
            const c = Math.min(spec.max, Math.max(spec.min, n));
            out[k] = whole ? Math.round(c) : c;
        } else out[k] = v === true || v === 'true' || v === 1;
    }
    return { params: out, dropped };
}

/** The "w:h" value of an enum closest to `aspect` (exact within 2%), else a matching-input value, else null. */
export function closestAspect(values: (string | number)[], aspect: number): string | null {
    let best: { v: string; err: number } | null = null;
    for (const raw of values) {
        const v = String(raw);
        const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(v);
        if (!m) continue;
        const a = Number(m[1]) / Number(m[2]);
        const err = Math.abs(Math.log(a / aspect));
        if (!best || err < best.err) best = { v, err };
    }
    if (best && best.err < 0.02) return best.v;
    const match = values.map(String).find((v) => /match|input/i.test(v));
    if (match) return match;
    return best?.v ?? null;
}

// ---------------------------------------------------------------- generate

export interface ImageRequest {
    model: string;
    prompt: string;
    /** Reference images as data: or https: URLs, in order. */
    references?: string[];
    /** Images wanted, 1 to 10. */
    count?: number;
    seed?: number | null;
    /** Options from the model's supported parameters (see checkParams). */
    params?: Record<string, ParamValue>;
    /** Ask for partial images while generating (models that stream). */
    stream?: boolean;
}

export interface GeneratedImage {
    blob: Blob;
    /** Seed of the request that made it, when one was sent. */
    seed: number | null;
    /** Credits of the request divided over its images, when reported. */
    cost: number | null;
}

export interface ImageResult {
    images: GeneratedImage[];
    /** Credits spent in total, when reported. */
    cost: number | null;
    /** Requests that failed while others worked. */
    errors: string[];
}

export interface GenerateOptions {
    signal?: AbortSignal;
    /** A partial image while a streamed image is being made (index of the image in this generation). */
    onPartial?: (index: number, dataUrl: string) => void;
    /** Images finished so far, of the total asked. */
    onProgress?: (done: number, total: number) => void;
}

/**
 * Generates images. Models that list `n` get several images per request
 * (unless streamed); others get one request per image, with seeds counting
 * up from the seed, at most four requests at a time.
 */
export async function generateImages(key: string, model: ImageModel | undefined, req: ImageRequest, opts: GenerateOptions = {}): Promise<ImageResult> {
    const count = Math.max(1, Math.min(MAX_IMAGES, Math.round(req.count ?? 1)));
    const specs = modelParams(model);
    const nSpec = specs.n;
    const stream = !!req.stream && !!model?.supports_streaming;
    // A streamed request carries one image: its events name no image index.
    const perRequest = nSpec && nSpec.type === 'range' && !stream ? Math.max(1, Math.min(MAX_IMAGES, nSpec.max)) : 1;
    const seedSupported = !model || !!specs.seed;
    const batches: { n: number; seed: number | null; first: number }[] = [];
    for (let first = 0, i = 0; first < count; first += perRequest, i++) {
        const seed = req.seed != null && seedSupported ? (perRequest === 1 ? req.seed + i : req.seed + i * 1000) : null;
        batches.push({ n: Math.min(perRequest, count - first), seed, first });
    }
    const images: (GeneratedImage | undefined)[] = new Array(count);
    const errors: string[] = [];
    let cost: number | null = null;
    let done = 0;
    const run = async (b: (typeof batches)[number]) => {
        const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, ...(req.params ?? {}) };
        if (req.references?.length) body.input_references = req.references.map((url) => ({ type: 'image_url', image_url: { url } }));
        if (b.n > 1) body.n = b.n;
        if (b.seed != null) body.seed = b.seed;
        if (stream) body.stream = true;
        try {
            const res = await postImages(key, body, opts.signal, (i, url) => opts.onPartial?.(b.first + i, url));
            if (res.cost != null) cost = (cost ?? 0) + res.cost;
            const share = res.cost != null && res.blobs.length ? res.cost / res.blobs.length : null;
            res.blobs.slice(0, b.n).forEach((blob, i) => {
                images[b.first + i] = { blob, seed: b.seed, cost: share };
            });
            done += Math.min(b.n, res.blobs.length);
            opts.onProgress?.(done, count);
            if (!res.blobs.length) errors.push('The model returned no image.');
        } catch (e: any) {
            if (e?.name === 'AbortError') throw e;
            errors.push(e?.message || String(e));
        }
    };
    const queue = [...batches];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let b = queue.shift(); b; b = queue.shift()) await run(b);
    });
    await Promise.all(workers);
    const list = images.filter((x): x is GeneratedImage => !!x);
    if (!list.length) throw new OpenRouterError(errors[0] || 'The model returned no image.');
    return { images: list, cost, errors };
}

/** One request; the images as blobs, in order. */
async function postImages(key: string, body: Record<string, unknown>, signal: AbortSignal | undefined, onPartial: (index: number, url: string) => void): Promise<{ blobs: Blob[]; cost: number | null }> {
    const res = await fetch(`${OPENROUTER_URL}/images`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal });
    if (!res.ok) throw new OpenRouterError(errorText(await res.text(), res.status), res.status);
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream') && res.body) return readStream(res.body, onPartial);
    const json = await res.json();
    if (json?.error) throw new OpenRouterError(json.error.message || 'The image request failed.', json.error.code || 0);
    const found: ImageData64[] = [];
    collectImages(json, found);
    const blobs = await Promise.all(found.map(toBlob));
    return { blobs, cost: costOf(json) };
}

interface ImageData64 {
    b64?: string;
    url?: string;
    type?: string;
}

/** Image payloads anywhere in a response or stream event: b64_json fields, or url / image_url fields. */
function collectImages(v: any, out: ImageData64[], depth = 0) {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) {
        for (const x of v) collectImages(x, out, depth + 1);
        return;
    }
    const type = typeof v.media_type === 'string' ? v.media_type : typeof v.mime_type === 'string' ? v.mime_type : undefined;
    if (typeof v.b64_json === 'string' && v.b64_json) {
        out.push({ b64: v.b64_json, type });
        return;
    }
    if (typeof v.url === 'string' && /^(data:image\/|https:)/.test(v.url) && depth > 0) {
        out.push({ url: v.url, type });
        return;
    }
    if (v.image_url && typeof v.image_url === 'object' && typeof v.image_url.url === 'string') {
        out.push({ url: v.image_url.url, type });
        return;
    }
    for (const [k, x] of Object.entries(v)) {
        // Usage, errors and echoed request fields hold no results.
        if (k === 'usage' || k === 'error' || k === 'input_references' || k === 'request') continue;
        if (x && typeof x === 'object') collectImages(x, out, depth + 1);
    }
}

function costOf(json: any): number | null {
    const c = json?.usage?.cost ?? json?.response?.usage?.cost;
    return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/**
 * Reads a streamed generation: partial images go to `onPartial`, finished
 * ones are returned. Event shapes differ between providers, so any event
 * with image data counts; events named "partial" (or with a partial image
 * index) are progress. If only partial images came, the last one of each
 * image is the result.
 */
async function readStream(body: ReadableStream<Uint8Array>, onPartial: (index: number, url: string) => void): Promise<{ blobs: Blob[]; cost: number | null }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data = '';
    const finals: ImageData64[] = [];
    const partials = new Map<number, ImageData64>();
    let cost: number | null = null;
    const event = (json: any) => {
        if (json?.error) throw new OpenRouterError(json.error.message || 'The image request failed.', json.error.code || 0);
        // Usage is cumulative: the last report counts.
        const c = costOf(json);
        if (c != null) cost = c;
        const found: ImageData64[] = [];
        collectImages(json, found);
        if (!found.length) return;
        const type = String(json.type ?? json.event ?? '');
        if (/partial/i.test(type) || typeof json.partial_image_index === 'number') {
            const index = typeof json.index === 'number' ? json.index : typeof json.image_index === 'number' ? json.image_index : 0;
            const img = found[found.length - 1];
            partials.set(index, img);
            try {
                onPartial(index, img.url ?? `data:${img.type || sniff(img.b64!)};base64,${stripPrefix(img.b64!)}`);
            } catch { /* display only */ }
        } else finals.push(...found);
    };
    /** Handles one event's data; false when it is not complete JSON yet. */
    const tryEvent = (raw: string): boolean => {
        if (raw === '[DONE]') return true;
        let json: any;
        try {
            json = JSON.parse(raw);
        } catch {
            return false;
        }
        event(json);
        return true;
    };
    const line = (text: string) => {
        if (text.startsWith(':')) return;
        if (!text.trim()) {
            // A blank line ends an event.
            if (data) tryEvent(data);
            data = '';
            return;
        }
        if (!text.startsWith('data:')) return;
        const payload = text.slice(5).trimStart();
        // Events are usually one line; data split over lines is joined.
        if (data) data += '\n' + payload;
        else if (!tryEvent(payload)) data = payload;
        if (data && tryEvent(data)) data = '';
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const text = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            line(text);
        }
    }
    if (buffer) line(buffer);
    if (data) tryEvent(data);
    const list = finals.length ? finals : [...partials.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    return { blobs: await Promise.all(list.map(toBlob)), cost };
}

function stripPrefix(b64: string): string {
    const comma = b64.startsWith('data:') ? b64.indexOf(',') : -1;
    return comma >= 0 ? b64.slice(comma + 1) : b64;
}

/** Media type from the first bytes of base64 data. */
function sniff(b64: string): string {
    const s = stripPrefix(b64);
    if (s.startsWith('iVBOR')) return 'image/png';
    if (s.startsWith('/9j/')) return 'image/jpeg';
    if (s.startsWith('UklGR')) return 'image/webp';
    if (s.startsWith('R0lGOD')) return 'image/gif';
    if (s.startsWith('PHN2Zy') || s.startsWith('PD94bW')) return 'image/svg+xml';
    return 'image/png';
}

async function toBlob(img: ImageData64): Promise<Blob> {
    if (img.url) {
        const res = await fetch(img.url);
        if (!res.ok) throw new OpenRouterError(`Could not download the image (${res.status}).`);
        return res.blob();
    }
    const b64 = img.b64!;
    const type = (b64.startsWith('data:') ? b64.slice(5, b64.indexOf(';')) : '') || img.type || sniff(b64);
    const bin = atob(stripPrefix(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
}

/// <reference lib="webworker" />
// The inference worker: runs the decision model (Laya) and the embedding
// model with ONNX Runtime Web, on a WebGPU device of its own (WASM when
// WebGPU is missing or fails). ONNX Runtime is imported only when a model is
// loaded, so pages without agents never fetch its 27 MB of WebAssembly.
//
// Jobs run one at a time in priority order (answers first, then query
// embeddings, then memory embeddings) and are kept short: embeddings go in
// chunks. While the GPU runs a batch, the next batch is tokenized (prepare).
// When the device is lost, every model stops and the page falls back to the
// schema defaults.

import { Tokenizer } from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-web';
import { buildSequence, calibrate, QTYPE_INDEX, type LayaConfig, type LayaQuestion, type SpecialIds } from './laya';
import type { ModelKind, ModelSource } from './models';

declare const self: DedicatedWorkerGlobalScope;

export type WorkerIn =
    | { type: 'init'; wasm: string; backend: 'auto' | 'webgpu' | 'wasm' }
    | { type: 'check'; id: number; source: ModelSource }
    | { type: 'load'; id: number; source: ModelSource; download: boolean }
    | { type: 'ask'; id: number; items: { state: string; questions: LayaQuestion[] }[] }
    | { type: 'embed'; id: number; texts: string[]; kind: 'query' | 'passage' }
    | { type: 'prepare'; items: { state: string; questions: LayaQuestion[] }[] }
    | { type: 'forget'; id: number; source: ModelSource };

export type WorkerOut =
    | { type: 'progress'; kind: ModelKind; loaded: number; total: number; file: string }
    | { type: 'done'; id: number; result: any; ms: number }
    | { type: 'failed'; id: number; message: string; code?: 'not-cached' | 'lost' }
    | { type: 'lost'; message: string };

const CACHE = 'canonical-models-v1';
const EMBED_CHUNK = 16;

let ort: typeof Ort | null = null;
let wasmUrl = '';
let wantBackend: 'auto' | 'webgpu' | 'wasm' = 'auto';
let device: GPUDevice | null = null;
let deviceTried = false;
let lost = false;

interface Loaded {
    source: ModelSource;
    session: Ort.InferenceSession;
    tokenizer: Tokenizer;
    backend: 'webgpu' | 'wasm';
}

let decision: (Loaded & { config: LayaConfig; ids: SpecialIds }) | null = null;
let embedder: Loaded | null = null;
const loading = new Map<ModelKind, Promise<void>>();

const post = (msg: WorkerOut, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

// ------------------------------------------------------------------ files

class NotCached extends Error {}

/** A file from Cache Storage, or downloaded into it (when allowed). */
async function file(url: string, download: boolean, onBytes: (n: number) => void, sha256?: string): Promise<ArrayBuffer> {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
        const buf = await hit.arrayBuffer();
        onBytes(buf.byteLength);
        return buf;
    }
    if (!download) throw new NotCached(url);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`${url} could not be downloaded (${res.status} ${res.statusText}).`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        onBytes(value.byteLength);
    }
    const blob = new Blob(chunks as BlobPart[]);
    const buf = await blob.arrayBuffer();
    if (sha256) {
        const hex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (b) => b.toString(16).padStart(2, '0')).join('');
        if (hex !== sha256) throw new Error(`${url} is damaged (checksum mismatch); try again.`);
    }
    await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }));
    return buf;
}

async function json(url: string, download: boolean, onBytes: (n: number) => void): Promise<any> {
    return JSON.parse(new TextDecoder().decode(await file(url, download, onBytes)));
}

const at = (src: ModelSource, name: string) => new URL(name, src.base).href;

/** Every file of a model, joined into the model bytes. */
async function fetchModel(src: ModelSource, download: boolean): Promise<{ bytes: Uint8Array; config: any; tokenizer: any; tokenizerConfig: any }> {
    let loaded = 0;
    let total = src.size;
    let last = 0;
    const onBytes = (n: number, name: string) => {
        loaded += n;
        const now = performance.now();
        if (now - last > 120) {
            last = now;
            post({ type: 'progress', kind: src.kind, loaded, total: Math.max(total, loaded), file: name });
        }
    };
    const small = (name: string) => json(at(src, name), download, (n) => onBytes(n, name));
    const config = src.config ? await small(src.config) : null;
    const tokenizer = await small(src.tokenizer);
    const tokenizerConfig = src.tokenizerConfig ? await small(src.tokenizerConfig).catch(() => ({})) : {};
    let bytes: Uint8Array;
    if ('manifest' in src.model) {
        const manifest = await small(src.model.manifest);
        const parts: { file: string; bytes: number; sha256?: string }[] = manifest.parts ?? [];
        total = loaded + (manifest.total_bytes ?? parts.reduce((s, p) => s + p.bytes, 0));
        bytes = new Uint8Array(parts.reduce((s, p) => s + p.bytes, 0));
        let offset = 0;
        for (const p of parts) {
            const buf = new Uint8Array(await file(at(src, p.file), download, (n) => onBytes(n, p.file), p.sha256));
            bytes.set(buf, offset);
            offset += buf.byteLength;
        }
    } else {
        bytes = new Uint8Array(await file(at(src, src.model.file), download, (n) => onBytes(n, (src.model as { file: string }).file)));
    }
    post({ type: 'progress', kind: src.kind, loaded: total, total, file: '' });
    return { bytes, config, tokenizer, tokenizerConfig };
}

async function isCached(src: ModelSource): Promise<boolean> {
    const cache = await caches.open(CACHE);
    const files = [src.tokenizer, ...(src.config ? [src.config] : [])];
    if ('manifest' in src.model) {
        const m = await cache.match(at(src, src.model.manifest));
        if (!m) return false;
        const manifest = await m.json();
        files.push(...(manifest.parts ?? []).map((p: any) => p.file));
    } else files.push(src.model.file);
    for (const f of files) if (!(await cache.match(at(src, f)))) return false;
    return true;
}

async function forget(src: ModelSource) {
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) if (req.url.startsWith(src.base)) await cache.delete(req);
}

// ---------------------------------------------------------------- runtime

async function runtime(): Promise<typeof Ort> {
    if (ort) return ort;
    const mod = await import('onnxruntime-web/webgpu');
    ort = ((mod as any).default?.InferenceSession ? (mod as any).default : mod) as typeof Ort;
    ort.env.wasm.wasmPaths = { wasm: wasmUrl };
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    return ort;
}

/** This worker's own WebGPU device, with the adapter's limits (large models need big buffers). */
async function ownDevice(): Promise<GPUDevice | null> {
    if (deviceTried) return device;
    deviceTried = true;
    if (wantBackend === 'wasm' || !('gpu' in navigator)) return null;
    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return null;
        const names = [
            'maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
            'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY', 'maxComputeWorkgroupSizeZ', 'maxComputeWorkgroupsPerDimension',
            'maxStorageBuffersPerShaderStage',
        ] as const;
        const requiredLimits: Record<string, number> = {};
        for (const n of names) requiredLimits[n] = adapter.limits[n];
        const requiredFeatures = (['shader-f16', 'subgroups', 'timestamp-query'] as GPUFeatureName[]).filter((f) => adapter.features.has(f));
        device = await adapter.requestDevice({ requiredLimits, requiredFeatures });
        void device.lost.then((info) => {
            if (info.reason === 'destroyed') return;
            lost = true;
            decision = null;
            embedder = null;
            post({ type: 'lost', message: info.message || 'The GPU device was lost.' });
        });
        return device;
    } catch (e) {
        console.warn('[ai] no WebGPU device for the models, using WASM', e);
        device = null;
        return null;
    }
}

async function session(bytes: Uint8Array): Promise<{ session: Ort.InferenceSession; backend: 'webgpu' | 'wasm' }> {
    const o = await runtime();
    const gpu = await ownDevice();
    if (gpu && !lost) {
        try {
            o.env.webgpu.device = gpu as any;
            return { session: await o.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' }), backend: 'webgpu' };
        } catch (e) {
            console.warn('[ai] the model does not run on WebGPU here, using WASM', e);
        }
    }
    return { session: await o.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), backend: 'wasm' };
}

function specialIds(config: any, tok: Tokenizer): SpecialIds {
    const id = (name: string, fallback?: number) => {
        const v = typeof fallback === 'number' ? fallback : tok.token_to_id(name);
        if (v === undefined) throw new Error(`The tokenizer has no ${name} token.`);
        return v;
    };
    return {
        cls: id('[CLS]', config?.cls),
        sep: id('[SEP]', config?.sep),
        pad: id('[PAD]', config?.pad),
        mask: id('[MASK]', config?.mask),
        maskToken: config?.mask_token ?? '[MASK]',
    };
}

async function load(src: ModelSource, download: boolean): Promise<{ backend: string }> {
    const cur = src.kind === 'decision' ? decision : embedder;
    if (cur && cur.source.id === src.id) return { backend: cur.backend };
    const pending = loading.get(src.kind);
    if (pending) await pending.catch(() => {});
    const run = (async () => {
        const files = await fetchModel(src, download);
        const tokenizer = new Tokenizer(files.tokenizer, files.tokenizerConfig ?? {});
        const s = await session(files.bytes);
        if (src.kind === 'decision') {
            const c = files.config ?? {};
            const config: LayaConfig = {
                max_len: c.max_len ?? 512,
                head_max_len: c.head_max_len ?? 192,
                temperature: c.temperature ?? [1, 1, 1],
                temperature_by_options: c.temperature_by_options ?? {},
            };
            decision = { source: src, tokenizer, config, ids: specialIds(c, tokenizer), ...s };
        } else {
            embedder = { source: src, tokenizer, ...s };
        }
    })();
    loading.set(src.kind, run);
    try {
        await run;
    } finally {
        loading.delete(src.kind);
    }
    const now = src.kind === 'decision' ? decision : embedder;
    return { backend: now?.backend ?? 'none' };
}

// ----------------------------------------------------------- tokenizing

const tokenCache = new Map<string, number[]>();

function encoder(tok: Tokenizer): (text: string) => number[] {
    return (text) => {
        let ids = tokenCache.get(text);
        if (!ids) {
            ids = tok.encode(text, { add_special_tokens: false }).ids;
            tokenCache.set(text, ids);
            if (tokenCache.size > 2048) tokenCache.delete(tokenCache.keys().next().value!);
        } else {
            // Most recently used last.
            tokenCache.delete(text);
            tokenCache.set(text, ids);
        }
        return ids;
    };
}

function sequences(items: { state: string; questions: LayaQuestion[] }[]) {
    const d = decision!;
    const encode = encoder(d.tokenizer);
    const rows: { ids: number[]; markers: number[]; q: LayaQuestion }[] = [];
    for (const it of items) {
        for (const q of it.questions) {
            const seq = buildSequence(encode, d.ids, q, it.state, d.config.max_len, d.config.head_max_len);
            rows.push({ ...seq, q });
        }
    }
    return rows;
}

// ---------------------------------------------------------------- running

async function ask(items: { state: string; questions: LayaQuestion[] }[]): Promise<number[][][]> {
    const d = decision;
    if (!d || lost) throw new Error(lost ? 'The GPU device was lost.' : 'The decision model is not loaded.');
    const o = await runtime();
    const rows = sequences(items);
    const n = rows.length;
    const L = Math.max(...rows.map((r) => r.ids.length));
    const K = Math.max(2, ...rows.map((r) => r.markers.length));
    const inputIds = new BigInt64Array(n * L).fill(BigInt(d.ids.pad));
    const attention = new BigInt64Array(n * L);
    const markerPos = new BigInt64Array(n * K);
    const markerMask = new Uint8Array(n * K);
    const qtype = new BigInt64Array(n);
    rows.forEach((r, i) => {
        r.ids.forEach((v, j) => {
            inputIds[i * L + j] = BigInt(v);
            attention[i * L + j] = 1n;
        });
        r.markers.forEach((m, j) => {
            markerPos[i * K + j] = BigInt(m);
            markerMask[i * K + j] = 1;
        });
        qtype[i] = BigInt(QTYPE_INDEX[r.q.type]);
    });
    const feeds: Record<string, Ort.Tensor> = {
        input_ids: new o.Tensor('int64', inputIds, [n, L]),
        attention_mask: new o.Tensor('int64', attention, [n, L]),
        marker_pos: new o.Tensor('int64', markerPos, [n, K]),
        marker_mask: new o.Tensor('bool', markerMask, [n, K]),
        qtype: new o.Tensor('int64', qtype, [n]),
    };
    const out = await d.session.run(feeds, ['logits']);
    const data = out.logits.data as Float32Array;
    const probs: number[][] = rows.map((r, i) => calibrate(Array.from(data.subarray(i * K, i * K + r.markers.length)), r.q.type, d.config));
    for (const t of Object.values(out)) t.dispose?.();
    // Back to one list per item.
    const res: number[][][] = [];
    let k = 0;
    for (const it of items) res.push(it.questions.map(() => probs[k++]));
    return res;
}

async function embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const e = embedder;
    if (!e || lost) throw new Error(lost ? 'The GPU device was lost.' : 'The embedding model is not loaded.');
    const o = await runtime();
    const src = e.source;
    const prefix = (kind === 'query' ? src.queryPrefix : src.passagePrefix) ?? '';
    const max = src.maxLength ?? 512;
    const encoded = texts.map((t) => e.tokenizer.encode(prefix + t).ids.slice(0, max));
    const pad = e.tokenizer.token_to_id('<pad>') ?? e.tokenizer.token_to_id('[PAD]') ?? 0;
    const n = encoded.length;
    const L = Math.max(1, ...encoded.map((x) => x.length));
    const ids = new BigInt64Array(n * L).fill(BigInt(pad));
    const mask = new BigInt64Array(n * L);
    encoded.forEach((x, i) => x.forEach((v, j) => {
        ids[i * L + j] = BigInt(v);
        mask[i * L + j] = 1n;
    }));
    const feeds: Record<string, Ort.Tensor> = { input_ids: new o.Tensor('int64', ids, [n, L]), attention_mask: new o.Tensor('int64', mask, [n, L]) };
    if (e.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new o.Tensor('int64', new BigInt64Array(n * L), [n, L]);
    const out = await e.session.run(feeds);
    const name = src.pooling === 'output' && out.sentence_embedding ? 'sentence_embedding' : out.last_hidden_state ? 'last_hidden_state' : e.session.outputNames[0];
    const t = out[name];
    const data = t.data as Float32Array;
    const vectors: Float32Array[] = [];
    if (t.dims.length === 2) {
        const H = t.dims[1];
        for (let i = 0; i < n; i++) vectors.push(data.slice(i * H, (i + 1) * H));
    } else {
        const H = t.dims[2];
        for (let i = 0; i < n; i++) {
            const v = new Float32Array(H);
            if (src.pooling === 'cls') v.set(data.subarray(i * L * H, i * L * H + H));
            else {
                let count = 0;
                for (let j = 0; j < L; j++) {
                    if (!mask[i * L + j]) continue;
                    count++;
                    const off = (i * L + j) * H;
                    for (let k = 0; k < H; k++) v[k] += data[off + k];
                }
                for (let k = 0; k < H; k++) v[k] /= Math.max(1, count);
            }
            vectors.push(v);
        }
    }
    for (const x of Object.values(out)) x.dispose?.();
    return vectors.map((v) => {
        const cut = src.dims && src.dims < v.length ? v.slice(0, src.dims) : v;
        let s = 0;
        for (let k = 0; k < cut.length; k++) s += cut[k] * cut[k];
        const norm = Math.sqrt(s) || 1;
        for (let k = 0; k < cut.length; k++) cut[k] /= norm;
        return cut;
    });
}

// ------------------------------------------------------------------ queue

interface Job {
    id: number;
    priority: number;
    run: () => Promise<{ result: any; transfer?: Transferable[] }>;
}

const queue: Job[] = [];
let busy = false;

function enqueue(job: Job) {
    queue.push(job);
    queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    void pump();
}

async function pump() {
    if (busy) return;
    busy = true;
    try {
        while (queue.length) {
            const job = queue.shift()!;
            const t0 = performance.now();
            try {
                const { result, transfer } = await job.run();
                post({ type: 'done', id: job.id, result, ms: performance.now() - t0 }, transfer ?? []);
            } catch (e: any) {
                post({ type: 'failed', id: job.id, message: e?.message || String(e), code: e instanceof NotCached ? 'not-cached' : lost ? 'lost' : undefined });
            }
        }
    } finally {
        busy = false;
    }
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
    const m = ev.data;
    switch (m.type) {
        case 'init':
            wasmUrl = m.wasm;
            wantBackend = m.backend;
            return;
        case 'check':
            void isCached(m.source).then(
                (cached) => post({ type: 'done', id: m.id, result: cached, ms: 0 }),
                (e) => post({ type: 'failed', id: m.id, message: e?.message || String(e) }),
            );
            return;
        case 'forget':
            if (decision?.source.base === m.source.base) decision = null;
            if (embedder?.source.base === m.source.base) embedder = null;
            void forget(m.source).then(() => post({ type: 'done', id: m.id, result: true, ms: 0 }));
            return;
        case 'load':
            // Loading is not queued behind answers: it runs next to them.
            void (async () => {
                const t0 = performance.now();
                try {
                    const r = await load(m.source, m.download);
                    post({ type: 'done', id: m.id, result: r, ms: performance.now() - t0 });
                } catch (e: any) {
                    post({ type: 'failed', id: m.id, message: e?.message || String(e), code: e instanceof NotCached ? 'not-cached' : undefined });
                }
            })();
            return;
        case 'prepare':
            if (decision) {
                try {
                    sequences(m.items);
                } catch { /* tokenized again when asked */ }
            }
            return;
        case 'ask':
            enqueue({ id: m.id, priority: 0, run: async () => ({ result: await ask(m.items) }) });
            return;
        case 'embed': {
            // Short jobs: a long list is embedded in chunks, queries before memory items.
            const priority = m.kind === 'query' ? 1 : 2;
            enqueue({
                id: m.id,
                priority,
                run: async () => {
                    const out: Float32Array[] = [];
                    for (let i = 0; i < m.texts.length; i += EMBED_CHUNK) {
                        out.push(...(await embed(m.texts.slice(i, i + EMBED_CHUNK), m.kind)));
                        // Let answers waiting in the queue go between chunks.
                        if (queue.some((j) => j.priority === 0) && i + EMBED_CHUNK < m.texts.length) await runWaiting(0);
                    }
                    return { result: out, transfer: out.map((v) => v.buffer) };
                },
            });
            return;
        }
    }
};

/** Runs the queued jobs of a priority now (called between the chunks of a long job). */
async function runWaiting(priority: number) {
    const jobs = queue.filter((j) => j.priority <= priority);
    for (const job of jobs) {
        queue.splice(queue.indexOf(job), 1);
        const t0 = performance.now();
        try {
            const { result, transfer } = await job.run();
            post({ type: 'done', id: job.id, result, ms: performance.now() - t0 }, transfer ?? []);
        } catch (e: any) {
            post({ type: 'failed', id: job.id, message: e?.message || String(e), code: lost ? 'lost' : undefined });
        }
    }
}

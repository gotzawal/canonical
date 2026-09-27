/// <reference lib="webworker" />
// The inference worker: runs the scene's models with ONNX Runtime Web, on a
// WebGPU device of its own (WASM when WebGPU is missing or fails). ONNX
// Runtime is imported only when a model is loaded, so pages without agents
// never fetch its 27 MB of WebAssembly.
//
// A model is any folder with tokenizer.json (config.json and
// tokenizer_config.json when it has them) and an ONNX file, or a
// manifest.json of parts joined in order. It runs with the adapter of its
// kind (adapters.ts). Jobs run one at a time in priority order (the
// scheduler's batches, then query embeddings, then memory embeddings, which
// the page sends in small chunks); while the GPU runs a batch, the next one
// is tokenized (prepare). When the device is lost, every model stops and the
// page falls back to the schema defaults.

import { Tokenizer } from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-web';
import { modelFingerprint } from '../../core/behavior/models';
import type { AiModelDoc } from '../../core/types';
import { ADAPTERS, type Adapter } from './adapters';

declare const self: DedicatedWorkerGlobalScope;

export type WorkerIn =
    | { type: 'init'; wasm: string; backend: 'auto' | 'webgpu' | 'wasm' }
    | { type: 'check'; id: number; model: AiModelDoc }
    | { type: 'load'; id: number; model: AiModelDoc; download: boolean; size?: number }
    | { type: 'run'; id: number; model: string; inputs: unknown[]; priority: number }
    | { type: 'prepare'; model: string; inputs: unknown[] }
    | { type: 'forget'; id: number; model: AiModelDoc };

export type WorkerOut =
    | { type: 'progress'; model: string; loaded: number; total: number; file: string }
    | { type: 'done'; id: number; result: any; ms: number }
    | { type: 'failed'; id: number; message: string; code?: 'not-cached' | 'lost' }
    | { type: 'lost'; message: string };

const CACHE = 'canonical-models-v1';
/** Files a model folder may have; an empty {} is stored when it has not (so the cache knows). */
const OPTIONAL = ['config.json', 'tokenizer_config.json'];

let ort: typeof Ort | null = null;
let wasmUrl = '';
let wantBackend: 'auto' | 'webgpu' | 'wasm' = 'auto';
let device: GPUDevice | null = null;
let deviceTried = false;
let lost = false;

interface Loaded {
    fingerprint: string;
    session: Ort.InferenceSession;
    adapter: Adapter;
    backend: 'webgpu' | 'wasm';
}

const models = new Map<string, Loaded>();
const loading = new Map<string, Promise<unknown>>();

const post = (msg: WorkerOut, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

// ------------------------------------------------------------------ files

class NotCached extends Error {}
class Missing extends Error {}

/** A file from Cache Storage, or downloaded into it (when allowed). */
async function file(url: string, download: boolean, onBytes: (n: number, total?: number) => void, sha256?: string): Promise<ArrayBuffer> {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
        const buf = await hit.arrayBuffer();
        onBytes(buf.byteLength, buf.byteLength);
        return buf;
    }
    if (!download) throw new NotCached(url);
    const res = await fetch(url);
    if (res.status === 404) throw new Missing(url);
    if (!res.ok || !res.body) throw new Error(`${url} could not be downloaded (${res.status} ${res.statusText}).`);
    const length = Number(res.headers.get('content-length')) || undefined;
    onBytes(0, length);
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

const at = (m: AiModelDoc, name: string) => new URL(name, m.url).href;
const isManifest = (m: AiModelDoc) => /\.json$/i.test(m.file);

/** Every file of a model: the tokenizer, the configs ({} when missing) and the model bytes (parts joined). */
async function fetchModel(m: AiModelDoc, download: boolean, size = 0) {
    let loaded = 0;
    let total = size;
    let last = 0;
    /** Progress of one file; `sized`: its length adds to the total (not for parts, the manifest has their sum). */
    const onBytes = (name: string, sized = true) => (n: number, length?: number) => {
        if (length !== undefined && sized && !size) total += length;
        loaded += n;
        const now = performance.now();
        if (now - last > 120) {
            last = now;
            post({ type: 'progress', model: m.id, loaded, total: Math.max(total, loaded), file: name });
        }
    };
    const json = async (name: string, optional = false) => {
        try {
            return JSON.parse(new TextDecoder().decode(await file(at(m, name), download, onBytes(name))));
        } catch (e) {
            if (!(optional && e instanceof Missing)) throw e;
            await (await caches.open(CACHE)).put(at(m, name), new Response('{}'));
            return {};
        }
    };
    const tokenizer = await json('tokenizer.json');
    const [config, tokenizerConfig] = [await json(OPTIONAL[0], true), await json(OPTIONAL[1], true)];
    let bytes: Uint8Array;
    if (isManifest(m)) {
        // Parts listed in order: { total_bytes, parts: [{ file, bytes, sha256 }] } (hosts that take files up to 100 MB).
        const manifest = await json(m.file);
        const parts: { file: string; bytes: number; sha256?: string }[] = manifest.parts ?? [];
        const sum = parts.reduce((s, p) => s + p.bytes, 0);
        total = Math.max(total, loaded + (manifest.total_bytes ?? sum));
        bytes = new Uint8Array(sum);
        let offset = 0;
        for (const p of parts) {
            const buf = new Uint8Array(await file(new URL(p.file, at(m, m.file)).href, download, onBytes(p.file, false), p.sha256));
            bytes.set(buf, offset);
            offset += buf.byteLength;
        }
    } else bytes = new Uint8Array(await file(at(m, m.file), download, onBytes(m.file)));
    post({ type: 'progress', model: m.id, loaded, total: loaded, file: '' });
    return { bytes, tokenizer, config, tokenizerConfig };
}

/** The URLs of a model's files (a manifest's parts when it is cached). */
async function modelFiles(m: AiModelDoc): Promise<string[] | null> {
    const cache = await caches.open(CACHE);
    const urls = ['tokenizer.json', ...OPTIONAL, m.file].map((f) => at(m, f));
    if (isManifest(m)) {
        const hit = await cache.match(at(m, m.file));
        if (!hit) return null;
        const manifest = await hit.json();
        urls.push(...(manifest.parts ?? []).map((p: { file: string }) => new URL(p.file, at(m, m.file)).href));
    }
    return urls;
}

async function isCached(m: AiModelDoc): Promise<boolean> {
    const cache = await caches.open(CACHE);
    const urls = await modelFiles(m);
    if (!urls) return false;
    for (const u of urls) if (!(await cache.match(u))) return false;
    return true;
}

async function forget(m: AiModelDoc) {
    const cache = await caches.open(CACHE);
    for (const u of (await modelFiles(m)) ?? []) await cache.delete(u);
    if (models.get(m.id)?.fingerprint === modelFingerprint(m)) models.delete(m.id);
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
            for (const [id, l] of models) if (l.backend === 'webgpu') models.delete(id);
            post({ type: 'lost', message: info.message || 'The GPU device was lost.' });
        });
        return device;
    } catch (e) {
        console.warn('[ai] no WebGPU device for the models, using WASM', e);
        device = null;
        return null;
    }
}

/** Sessions are made one at a time: ONNX Runtime stalls when two are created at once. */
let sessionLock: Promise<unknown> = Promise.resolve();

/**
 * A session on the worker's WebGPU device, else on WebAssembly. Some models
 * only fail once they run (fp16 parts on a device without shader-f16), so a
 * WebGPU session must pass `warm` (one small run, which also compiles the
 * shaders before the first real request) or WASM is used.
 */
function session(bytes: Uint8Array, warm: (s: Ort.InferenceSession) => Promise<unknown>): Promise<{ session: Ort.InferenceSession; backend: 'webgpu' | 'wasm' }> {
    const next = sessionLock.then(() => makeSession(bytes, warm));
    sessionLock = next.catch(() => {});
    return next;
}

async function makeSession(bytes: Uint8Array, warm: (s: Ort.InferenceSession) => Promise<unknown>): Promise<{ session: Ort.InferenceSession; backend: 'webgpu' | 'wasm' }> {
    const o = await runtime();
    const gpu = await ownDevice();
    if (gpu && !lost) {
        let s: Ort.InferenceSession | null = null;
        try {
            o.env.webgpu.device = gpu as any;
            s = await o.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
            await warm(s);
            return { session: s, backend: 'webgpu' };
        } catch (e) {
            console.warn('[ai] the model does not run on WebGPU here, using WASM', e);
            await s?.release().catch(() => {});
        }
    }
    const s = await o.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    await warm(s);
    return { session: s, backend: 'wasm' };
}

async function load(m: AiModelDoc, download: boolean, size?: number): Promise<{ backend: string; info?: Record<string, unknown> }> {
    const fingerprint = modelFingerprint(m);
    const key = `${m.id}|${fingerprint}`;
    const cur = models.get(m.id);
    if (cur?.fingerprint === fingerprint) return { backend: cur.backend, info: cur.adapter.info };
    const pending = loading.get(key);
    if (pending) {
        await pending;
        const now = models.get(m.id);
        if (now) return { backend: now.backend, info: now.adapter.info };
    }
    const make = ADAPTERS[m.kind];
    if (!make) throw new Error(`No adapter for models of kind "${m.kind}".`);
    const run = (async () => {
        const files = await fetchModel(m, download, size);
        const o = await runtime();
        const adapter = make({ model: m, config: files.config, tokenizerConfig: files.tokenizerConfig, tokenizer: new Tokenizer(files.tokenizer, files.tokenizerConfig), ort: o });
        const s = await session(files.bytes, (sess) => adapter.warm(sess));
        const old = models.get(m.id);
        models.set(m.id, { fingerprint, adapter, ...s });
        if (old && old.session !== s.session) void old.session.release().catch(() => {});
    })();
    loading.set(key, run);
    try {
        await run;
    } finally {
        loading.delete(key);
    }
    const now = models.get(m.id)!;
    return { backend: now.backend, info: now.adapter.info };
}

async function runModel(id: string, inputs: unknown[]): Promise<unknown[]> {
    const l = models.get(id);
    if (!l || lost && l.backend === 'webgpu') throw new Error(lost ? 'The GPU device was lost.' : `The model "${id}" is not loaded.`);
    return l.adapter.run(l.session, inputs);
}

// ------------------------------------------------------------------ queue

interface Job {
    id: number;
    priority: number;
    run: () => Promise<unknown>;
}

const queue: Job[] = [];
let busy = false;

function enqueue(job: Job) {
    queue.push(job);
    queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    void pump();
}

/** Float32Array results go back without a copy. */
function transfers(result: unknown): Transferable[] {
    return Array.isArray(result) ? result.filter((r): r is Float32Array => r instanceof Float32Array).map((r) => r.buffer) : [];
}

async function pump() {
    if (busy) return;
    busy = true;
    try {
        while (queue.length) {
            const job = queue.shift()!;
            const t0 = performance.now();
            try {
                const result = await job.run();
                post({ type: 'done', id: job.id, result, ms: performance.now() - t0 }, transfers(result));
            } catch (e: any) {
                post({ type: 'failed', id: job.id, message: e?.message || String(e), code: lost ? 'lost' : undefined });
            }
        }
    } finally {
        busy = false;
    }
}

function reply(id: number, work: Promise<unknown>) {
    const t0 = performance.now();
    work.then(
        (result) => post({ type: 'done', id, result, ms: performance.now() - t0 }),
        (e: any) => post({ type: 'failed', id, message: e?.message || String(e), code: e instanceof NotCached ? 'not-cached' : undefined }),
    );
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
    const m = ev.data;
    switch (m.type) {
        case 'init':
            wasmUrl = m.wasm;
            wantBackend = m.backend;
            return;
        case 'check':
            reply(m.id, isCached(m.model));
            return;
        case 'forget':
            reply(m.id, forget(m.model).then(() => true));
            return;
        case 'load':
            // Loading is not queued behind the jobs: it runs next to them.
            reply(m.id, load(m.model, m.download, m.size));
            return;
        case 'prepare': {
            const l = models.get(m.model);
            try {
                l?.adapter.prepare?.(m.inputs);
            } catch { /* done again when it runs */ }
            return;
        }
        case 'run':
            enqueue({ id: m.id, priority: m.priority, run: () => runModel(m.model, m.inputs) });
            return;
    }
};

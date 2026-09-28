// The page side of the inference worker: starts it when a model is first
// needed, loads models (from Cache Storage, or downloaded when allowed),
// keeps each model's state by id and forwards jobs.

import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { modelFingerprint, modelRevision } from '../../core/behavior/models';
import { Emitter } from '../../core/events';
import type { AiModelDoc } from '../../core/types';
import type { WorkerIn, WorkerOut } from './inference.worker';

export type ModelState = 'unknown' | 'checking' | 'missing' | 'downloading' | 'loading' | 'ready' | 'error' | 'lost';

export interface ModelStatus {
    state: ModelState;
    backend?: 'webgpu' | 'wasm';
    /** Download progress, bytes. */
    loaded?: number;
    total?: number;
    message?: string;
    /** What the model reported when it loaded, e.g. a classifier's labels. */
    info?: Record<string, unknown>;
}

/** Order of jobs in the worker: the scheduler's batches, then query embeddings, then memory embeddings. */
export const PRIORITY = { batch: 0, query: 1, passage: 2 } as const;
/** Long embedding lists go in chunks, so a batch can run between them. */
const CHUNK = 16;

interface Entry extends ModelStatus {
    fingerprint: string;
    revision: string;
    model: AiModelDoc;
}

interface Pending {
    resolve: (v: { result: any; ms: number }) => void;
    reject: (e: Error & { code?: string }) => void;
}

export class InferenceClient extends Emitter<{ status: string }> {
    private entries = new Map<string, Entry>();
    private worker: Worker | null = null;
    private pending = new Map<number, Pending>();
    private serial = 0;

    constructor(private backend: 'auto' | 'webgpu' | 'wasm' = 'auto') {
        super();
    }

    /**
     * A model's state. A model whose files changed (another URL or file)
     * starts over; one with other options keeps running with them.
     */
    status(m: AiModelDoc): ModelStatus {
        return this.entry(m);
    }

    private entry(m: AiModelDoc): Entry {
        const fingerprint = modelFingerprint(m);
        const revision = modelRevision(m);
        let e = this.entries.get(m.id);
        if (!e || e.fingerprint !== fingerprint) {
            e = { state: 'unknown', fingerprint, revision, model: m };
            this.entries.set(m.id, e);
        } else if (e.revision !== revision) {
            e.revision = revision;
            e.model = m;
            if (e.state === 'ready') {
                void this.call({ type: 'options', id: ++this.serial, model: this.resolved(m) }).then(
                    (r) => this.set(m.id, { info: r.result }),
                    () => {},
                );
            }
        }
        return e;
    }

    ready(id: string): boolean {
        return this.entries.get(id)?.state === 'ready';
    }

    backendOf(id: string): 'webgpu' | 'wasm' | undefined {
        return this.entries.get(id)?.backend;
    }

    /** Some model stopped while running (its GPU device was lost). */
    get anyLost(): boolean {
        for (const e of this.entries.values()) if (e.state === 'lost') return true;
        return false;
    }

    get computeBackend(): 'auto' | 'webgpu' | 'wasm' {
        return this.backend;
    }

    /** Runs the models on another backend: the worker starts again and loaded models load again (from the cache). */
    setBackend(backend: 'auto' | 'webgpu' | 'wasm') {
        if (backend === this.backend) return;
        this.backend = backend;
        const reload = Array.from(this.entries.values()).filter((e) => e.state === 'ready').map((e) => e.model);
        this.stop('The inference worker was restarted.', 'restart');
        for (const e of this.entries.values()) this.set(e.model.id, { state: 'unknown', backend: undefined, loaded: undefined, total: undefined, message: undefined });
        for (const m of reload) void this.load(m, false);
    }

    /** Ends the worker (the next call starts a new one); the calls waiting for it fail. */
    private stop(message: string, code: string) {
        this.worker?.terminate();
        this.worker = null;
        for (const p of this.pending.values()) p.reject(Object.assign(new Error(message), { code }));
        this.pending.clear();
    }

    private set(id: string, s: Partial<ModelStatus>) {
        const e = this.entries.get(id);
        if (!e) return;
        Object.assign(e, s);
        this.emit('status', id);
    }

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        const w = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module', name: 'morglay-inference' });
        w.onmessage = (ev: MessageEvent<WorkerOut>) => this.onMessage(ev.data);
        w.onerror = (ev) => {
            // A late error of a worker that was ended already does not end the new one.
            if (w !== this.worker) return;
            const message = ev.message || 'The inference worker failed.';
            console.error('[ai] the inference worker failed', message);
            // Its models go with it; a new worker loads them when they are needed again.
            for (const e of this.entries.values()) if (e.state === 'ready') this.set(e.model.id, { state: 'error', message });
            this.stop(message, 'failed');
        };
        this.post(w, { type: 'init', wasm: new URL(wasmUrl, location.href).href, backend: this.backend });
        this.worker = w;
        return w;
    }

    private post(w: Worker, msg: WorkerIn) {
        w.postMessage(msg);
    }

    private call(msg: WorkerIn & { id: number }): Promise<{ result: any; ms: number }> {
        const w = this.ensureWorker();
        return new Promise((resolve, reject) => {
            this.pending.set(msg.id, { resolve, reject });
            this.post(w, msg);
        });
    }

    private onMessage(m: WorkerOut) {
        if (m.type === 'progress') {
            const e = this.entries.get(m.model);
            if (e && (e.state === 'downloading' || e.state === 'loading')) this.set(m.model, { state: m.loaded < m.total ? 'downloading' : 'loading', loaded: m.loaded, total: m.total });
            return;
        }
        if (m.type === 'lost') {
            // Models on the CPU go on; the ones on the lost device stop.
            for (const e of this.entries.values()) if (e.state === 'ready' && e.backend === 'webgpu') this.set(e.model.id, { state: 'lost', message: m.message });
            return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'done') p.resolve({ result: m.result, ms: m.ms });
        else p.reject(Object.assign(new Error(m.message), { code: m.code }));
    }

    /** The model as the worker gets it: its folder as an absolute URL. */
    private resolved(m: AiModelDoc): AiModelDoc {
        return { ...m, url: new URL(m.url, location.href).href };
    }

    /** True when every file of the model is in this browser's cache. */
    async cached(m: AiModelDoc): Promise<boolean> {
        try {
            return !!(await this.call({ type: 'check', id: ++this.serial, model: this.resolved(m) })).result;
        } catch {
            return false;
        }
    }

    /**
     * Loads a model. Without `download` only a cached copy is used; the
     * state becomes 'missing' when there is none. `size`: the download size
     * when it is known ahead (built-in models), for the progress.
     */
    async load(m: AiModelDoc, download: boolean, size?: number): Promise<boolean> {
        const e = this.entry(m);
        if (e.state === 'ready') return true;
        if (e.state === 'downloading' || e.state === 'loading' || e.state === 'checking') return false;
        this.set(m.id, { state: download ? 'downloading' : 'checking', loaded: 0, total: size, message: undefined });
        try {
            if (!download) {
                if (!(await this.call({ type: 'check', id: ++this.serial, model: this.resolved(m) })).result) {
                    this.set(m.id, { state: 'missing' });
                    return false;
                }
                this.set(m.id, { state: 'loading' });
            }
            const { result } = await this.call({ type: 'load', id: ++this.serial, model: this.resolved(m), download, size });
            // The model may have been changed while it loaded: the result belongs to the old files.
            if (this.entries.get(m.id) !== e) return false;
            this.set(m.id, { state: 'ready', backend: result.backend, info: result.info });
            return true;
        } catch (err: any) {
            // A restart (another backend) set the state already.
            if (err?.code === 'restart' || this.entries.get(m.id) !== e) return false;
            this.set(m.id, { state: err?.code === 'not-cached' ? 'missing' : 'error', message: err?.message || String(err) });
            return false;
        }
    }

    /** Removes a model from this browser's cache. */
    async forget(m: AiModelDoc) {
        await this.call({ type: 'forget', id: ++this.serial, model: this.resolved(m) }).catch(() => {});
        this.entry(m);
        this.set(m.id, { state: 'missing', backend: undefined, info: undefined });
    }

    /** Runs a loaded model on some inputs (their format depends on the model's kind, see adapters.ts). */
    run(id: string, inputs: unknown[], priority: number = PRIORITY.batch): Promise<{ outputs: unknown[]; ms: number }> {
        return this.call({ type: 'run', id: ++this.serial, model: id, inputs, priority }).then(
            (r) => ({ outputs: r.result as unknown[], ms: r.ms }),
            (err) => {
                if (err.code === 'lost') this.set(id, { state: 'lost', message: err.message });
                throw err;
            },
        );
    }

    /** Embeds texts with an embed model (in chunks, so batches can run between them). */
    async embed(id: string, texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
        const chunks: Promise<{ outputs: unknown[] }>[] = [];
        for (let i = 0; i < texts.length; i += CHUNK) chunks.push(this.run(id, texts.slice(i, i + CHUNK).map((text) => ({ text, kind })), PRIORITY[kind]));
        return (await Promise.all(chunks)).flatMap((c) => c.outputs as Float32Array[]);
    }

    /** Tokenizes the inputs of a coming run ahead (while the GPU runs the batch before). */
    prepare(id: string, inputs: unknown[]) {
        if (this.worker && this.ready(id)) this.post(this.worker, { type: 'prepare', model: id, inputs });
    }
}

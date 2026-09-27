// The page side of the inference worker: starts it when a model is first
// needed, loads models (from Cache Storage, or downloaded when allowed) and
// reports their state, and forwards answer and embedding jobs.

import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { Emitter } from '../../core/events';
import type { LayaQuestion } from './laya';
import type { ModelKind, ModelSource } from './models';
import type { WorkerIn, WorkerOut } from './inference.worker';

export type ModelState = 'unknown' | 'checking' | 'missing' | 'downloading' | 'loading' | 'ready' | 'error' | 'lost';

export interface ModelStatus {
    state: ModelState;
    source: ModelSource;
    backend?: 'webgpu' | 'wasm';
    /** Download progress, bytes. */
    loaded?: number;
    total?: number;
    message?: string;
}

interface Pending {
    resolve: (v: { result: any; ms: number }) => void;
    reject: (e: Error & { code?: string }) => void;
}

export class InferenceClient extends Emitter<{ status: ModelKind }> {
    readonly status: Record<ModelKind, ModelStatus>;
    private worker: Worker | null = null;
    private pending = new Map<number, Pending>();
    private serial = 0;

    constructor(decision: ModelSource, embedder: ModelSource, private backend: 'auto' | 'webgpu' | 'wasm' = 'auto') {
        super();
        this.status = { decision: { state: 'unknown', source: decision }, embedder: { state: 'unknown', source: embedder } };
    }

    ready(kind: ModelKind): boolean {
        return this.status[kind].state === 'ready';
    }

    /** Switches a kind to another model (it has to be loaded again). */
    setSource(kind: ModelKind, source: ModelSource) {
        if (this.status[kind].source.id === source.id) return;
        this.set(kind, { state: 'unknown', source });
    }

    private set(kind: ModelKind, s: Partial<ModelStatus>) {
        this.status[kind] = { ...this.status[kind], ...s };
        this.emit('status', kind);
    }

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        const w = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module', name: 'canonical-inference' });
        w.onmessage = (ev: MessageEvent<WorkerOut>) => this.onMessage(ev.data);
        w.onerror = (ev) => {
            console.error('[ai] the inference worker failed', ev.message);
            for (const kind of ['decision', 'embedder'] as ModelKind[]) {
                if (this.status[kind].state === 'loading' || this.status[kind].state === 'downloading') this.set(kind, { state: 'error', message: ev.message || 'The inference worker failed.' });
            }
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
            const s = this.status[m.kind];
            if (s.state === 'downloading' || s.state === 'loading') this.set(m.kind, { state: m.loaded < m.total ? 'downloading' : 'loading', loaded: m.loaded, total: m.total });
            return;
        }
        if (m.type === 'lost') {
            for (const kind of ['decision', 'embedder'] as ModelKind[]) if (this.status[kind].state === 'ready') this.set(kind, { state: 'lost', message: m.message });
            return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'done') p.resolve({ result: m.result, ms: m.ms });
        else p.reject(Object.assign(new Error(m.message), { code: m.code }));
    }

    /** True when every file of the model is in this browser's cache. */
    async cached(kind: ModelKind): Promise<boolean> {
        try {
            return !!(await this.call({ type: 'check', id: ++this.serial, source: this.status[kind].source })).result;
        } catch {
            return false;
        }
    }

    /**
     * Loads a model. Without `download` only a cached copy is used; the
     * status becomes 'missing' when there is none.
     */
    async load(kind: ModelKind, download: boolean): Promise<boolean> {
        const s = this.status[kind];
        if (s.state === 'ready') return true;
        if (s.state === 'downloading' || s.state === 'loading' || s.state === 'checking') return false;
        this.set(kind, { state: download ? 'downloading' : 'checking', loaded: 0, total: s.source.size, message: undefined });
        if (!download) {
            const cached = await this.cached(kind);
            if (!cached) {
                this.set(kind, { state: 'missing' });
                return false;
            }
            this.set(kind, { state: 'loading' });
        }
        try {
            const { result } = await this.call({ type: 'load', id: ++this.serial, source: s.source, download });
            this.set(kind, { state: 'ready', backend: result.backend });
            return true;
        } catch (e: any) {
            this.set(kind, { state: e?.code === 'not-cached' ? 'missing' : 'error', message: e?.message || String(e) });
            return false;
        }
    }

    /** Removes a model from this browser's cache. */
    async forget(kind: ModelKind) {
        await this.call({ type: 'forget', id: ++this.serial, source: this.status[kind].source }).catch(() => {});
        this.set(kind, { state: 'missing', backend: undefined });
    }

    ask(items: { state: string; questions: LayaQuestion[] }[]): Promise<{ probabilities: number[][][]; ms: number }> {
        return this.call({ type: 'ask', id: ++this.serial, items }).then(
            (r) => ({ probabilities: r.result, ms: r.ms }),
            (e) => {
                if (e.code === 'lost') this.set('decision', { state: 'lost', message: e.message });
                throw e;
            },
        );
    }

    embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
        return this.call({ type: 'embed', id: ++this.serial, texts, kind }).then((r) => r.result as Float32Array[]);
    }

    prepare(items: { state: string; questions: LayaQuestion[] }[]) {
        if (this.worker && this.ready('decision')) this.post(this.worker, { type: 'prepare', items });
    }
}

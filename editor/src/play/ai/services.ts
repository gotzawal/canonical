// The models behind the agents, shared by every Play session of a page: the
// inference worker (every model the scene uses: built-in ones and the
// scene's own, core/behavior/models.ts), the request scheduler that runs
// right after the engine drew each frame, and the rule for downloading. The
// editor asks before the first download; a built game downloads what its
// scene needs.

import { findModel, type BuiltinModel } from '../../core/behavior/models';
import { Emitter } from '../../core/events';
import type { AiModelDoc } from '../../core/types';
import type { Runtime } from '../../engine/runtime';
import type { AIServices } from './agents';
import { InferenceClient, PRIORITY, type ModelStatus } from './inference';
import { Scheduler, type ModelProvider } from './scheduler';
import type { SpeechQueue } from './speech';

export type DownloadPolicy = 'auto' | 'ask';

/** Where the models run: 'auto' tries WebGPU (a device of the worker's own) and falls back to WebAssembly. */
export type ComputeBackend = 'auto' | 'webgpu' | 'wasm';

const BACKEND_KEY = 'canonical-editor/ai-backend';

/** The backend chosen in this browser (the Behavior tab's model menu). */
export function savedBackend(): ComputeBackend {
    try {
        const v = localStorage.getItem(BACKEND_KEY);
        if (v === 'webgpu' || v === 'wasm') return v;
    } catch { /* ignore */ }
    return 'auto';
}

export class ModelServices extends Emitter<{ status: string; needed: string }> implements AIServices {
    readonly client: InferenceClient;
    readonly scheduler: Scheduler;
    /** 'auto' downloads what a scene needs; 'ask' only loads cached models until download() is called. */
    policy: DownloadPolicy;
    /** Models a Play session needed but could not load (the editor shows a download prompt). */
    readonly needed = new Set<string>();

    /** `sceneModels`: the models of the scene that plays (the built-in ones are always there). */
    constructor(runtime: Runtime, speech: SpeechQueue, private sceneModels: () => readonly AiModelDoc[], opts: { policy: DownloadPolicy; backend?: ComputeBackend }) {
        super();
        this.policy = opts.policy;
        const client = (this.client = new InferenceClient(opts.backend ?? 'auto'));
        const provider: ModelProvider = {
            ready: (id) => client.ready(id),
            name: (id) => `${this.model(id)?.kind ?? id}/${client.backendOf(id) ?? 'none'}`,
            gpu: (id) => client.backendOf(id) !== 'wasm',
            run: (id, inputs) => client.run(id, inputs, PRIORITY.batch),
            prepare: (id, inputs) => client.prepare(id, inputs),
        };
        this.scheduler = new Scheduler(provider, () => runtime.fps);
        this.scheduler.speechPending = () => speech.pending > 0;
        // The scheduler sends its batches right after the engine drew a frame.
        runtime.onFrame(() => this.scheduler.frame());
        client.on('status', (id) => {
            if (client.ready(id)) this.needed.delete(id);
            this.emit('status', id);
        });
    }

    /** A model by id: the scene's, then the built-in ones. */
    model(id: string): AiModelDoc | BuiltinModel | undefined {
        return findModel(id, this.sceneModels());
    }

    status(id: string): ModelStatus {
        const m = this.model(id);
        return m ? this.client.status(m) : { state: 'error', message: `No model "${id}".` };
    }

    ready(id: string): boolean {
        return this.client.ready(id);
    }

    /** A model stopped while running (its GPU device was lost). */
    get lost(): boolean {
        return this.client.anyLost;
    }

    embed(model: string, texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[] | null> {
        if (!this.ready(model)) return Promise.resolve(null);
        return this.client.embed(model, texts, kind).catch((e) => {
            console.warn('[ai] embedding failed', e);
            return null;
        });
    }

    /** A Play session starts with agents that use these models. */
    prepare(ids: string[]) {
        for (const id of ids) {
            const m = this.model(id);
            if (!m) {
                console.warn(`[ai] unknown model "${id}": its nodes keep their keys at the defaults`);
                continue;
            }
            const s = this.client.status(m).state;
            if (s === 'ready' || s === 'downloading' || s === 'loading' || s === 'checking') continue;
            void this.client.load(m, this.policy === 'auto', sizeOf(m)).then((ok) => {
                if (!ok && this.client.status(m).state === 'missing') {
                    this.needed.add(id);
                    this.emit('needed', id);
                }
            });
        }
    }

    /** Downloads (or loads from the cache) a model now. */
    download(id: string): Promise<boolean> {
        const m = this.model(id);
        return m ? this.client.load(m, true, sizeOf(m)) : Promise.resolve(false);
    }

    /** True when every file of the model is in this browser's cache. */
    cached(id: string): Promise<boolean> {
        const m = this.model(id);
        return m ? this.client.cached(m) : Promise.resolve(false);
    }

    /** Removes a model from this browser's cache. */
    async forget(id: string) {
        const m = this.model(id);
        if (m) await this.client.forget(m);
    }

    get backend(): ComputeBackend {
        return this.client.computeBackend;
    }

    /** Runs the models on another backend from now on, and remembers it in this browser. */
    setBackend(backend: ComputeBackend) {
        try {
            if (backend === 'auto') localStorage.removeItem(BACKEND_KEY);
            else localStorage.setItem(BACKEND_KEY, backend);
        } catch { /* ignore */ }
        this.client.setBackend(backend);
    }
}

/** The download size of a built-in model, for the progress (others report theirs as they come). */
function sizeOf(m: AiModelDoc | BuiltinModel): number | undefined {
    return 'size' in m ? m.size : undefined;
}

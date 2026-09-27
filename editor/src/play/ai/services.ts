// The models behind the agents, shared by every Play session of a page: the
// inference worker (decision model and embedding model), the request
// scheduler that runs right after the engine drew each frame, and the rule
// for downloading. The editor asks before the first download; a built game
// downloads what its scene needs.

import { Emitter } from '../../core/events';
import type { Runtime } from '../../engine/runtime';
import type { AIServices } from './agents';
import { InferenceClient, type ModelStatus } from './inference';
import { DEFAULT_DECISION_MODEL, modelSource, type ModelKind, type ModelSource } from './models';
import { Scheduler, type DecisionProvider } from './scheduler';
import type { SpeechQueue } from './speech';
import { DEFAULT_EMBEDDER } from '../../core/behavior/format';

export type DownloadPolicy = 'auto' | 'ask';

export class ModelServices extends Emitter<{ status: ModelKind; needed: ModelKind }> implements AIServices {
    readonly client: InferenceClient;
    readonly scheduler: Scheduler;
    /** 'auto' downloads what a scene needs; 'ask' only loads cached models until download() is called. */
    policy: DownloadPolicy;
    /** Kinds a Play session needed but could not load (the editor shows a download prompt). */
    readonly needed = new Set<ModelKind>();

    constructor(runtime: Runtime, speech: SpeechQueue, opts: { policy: DownloadPolicy; decision?: string; embedder?: string; backend?: 'auto' | 'webgpu' | 'wasm' }) {
        super();
        this.policy = opts.policy;
        const decision = modelSource(opts.decision ?? DEFAULT_DECISION_MODEL, 'decision') ?? modelSource(DEFAULT_DECISION_MODEL, 'decision')!;
        const embedder = modelSource(opts.embedder ?? DEFAULT_EMBEDDER, 'embedder') ?? modelSource(DEFAULT_EMBEDDER, 'embedder')!;
        this.client = new InferenceClient(decision, embedder, opts.backend ?? 'auto');
        const client = this.client;
        const provider: DecisionProvider = {
            get ready() {
                return client.ready('decision');
            },
            get name() {
                return `laya/${client.status.decision.backend ?? 'none'}`;
            },
            get model() {
                return `${client.status.decision.source.id} (calibrated with its config.json temperatures)`;
            },
            run: (items) => client.ask(items),
            prepare: (items) => client.prepare(items),
        };
        this.scheduler = new Scheduler(provider, () => runtime.fps);
        this.scheduler.speechPending = () => speech.pending > 0;
        // The scheduler sends its batches right after the engine drew a frame.
        runtime.onFrame(() => this.scheduler.frame());
        client.on('status', (kind) => {
            if (client.ready(kind)) this.needed.delete(kind);
            this.emit('status', kind);
        });
    }

    status(kind: ModelKind): ModelStatus {
        return this.client.status[kind];
    }

    get embedderReady(): boolean {
        return this.client.ready('embedder');
    }

    embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[] | null> {
        if (!this.embedderReady) return Promise.resolve(null);
        return this.client.embed(texts, kind).catch((e) => {
            console.warn('[ai] embedding failed', e);
            return null;
        });
    }

    /** Uses another model for a kind (a scene's memory embedder, a custom decision model URL). */
    use(kind: ModelKind, id: string): ModelSource | null {
        const src = modelSource(id, kind);
        if (src) this.client.setSource(kind, src);
        return src ?? null;
    }

    /** A Play session starts with agents that need these models. */
    prepare(needs: { decision: boolean; embedder: boolean }) {
        for (const kind of ['decision', 'embedder'] as ModelKind[]) {
            if (!needs[kind]) continue;
            const s = this.client.status[kind].state;
            if (s === 'ready' || s === 'downloading' || s === 'loading' || s === 'checking') continue;
            void this.client.load(kind, this.policy === 'auto').then((ok) => {
                if (!ok && this.client.status[kind].state === 'missing') {
                    this.needed.add(kind);
                    this.emit('needed', kind);
                }
            });
        }
    }

    /** Downloads (or loads from the cache) a model now. */
    download(kind: ModelKind): Promise<boolean> {
        return this.client.load(kind, true);
    }
}

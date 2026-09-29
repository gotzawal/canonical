// Runs texture encodes in a few workers (derive.worker.ts): one job per
// copy, the most urgent first, none while paused (Play), and workers that
// sit idle are stopped, since the encoder's memory never shrinks.

import { Emitter } from '../core/events';
import type { DerivedOptions } from '../core/derived';
import type { TextureRole } from '../core/types';
import type { DeriveIn, DeriveOut } from './derive.worker';

/** How urgent a job is: a build waits on it, the view shows it, or it is for later. */
export const PRIORITY = { build: 2, view: 1, background: 0 } as const;

export interface EncodeInput {
    blob: Blob;
    role: TextureRole;
    opts: DerivedOptions;
}

export interface Encoded {
    data: ArrayBuffer;
    width: number;
    height: number;
    levels: number;
    alpha: boolean;
}

/** The part of a Worker the queue uses (tests give a fake one). */
export interface WorkerLike {
    postMessage(msg: DeriveIn, transfer?: Transferable[]): void;
    onmessage: ((e: MessageEvent<DeriveOut>) => void) | null;
    onerror: ((e: ErrorEvent) => void) | null;
    terminate(): void;
}

interface Job {
    key: string;
    input: EncodeInput;
    priority: number;
    order: number;
    promise: Promise<Encoded>;
    resolve(v: Encoded): void;
    reject(e: Error): void;
    worker: Slot | null;
    id: number;
    /** Callers still waiting (cancelled callers leave). */
    waiting: number;
}

interface Slot {
    worker: WorkerLike;
    job: Job | null;
}

export interface QueueOptions {
    /** Workers at most (default 1). */
    workers?: number;
    /** Stop workers idle this long, ms (default 30 s). */
    idleMs?: number;
}

export class DeriveQueue extends Emitter<{ change: void }> {
    private jobs = new Map<string, Job>();
    private slots: Slot[] = [];
    private paused = false;
    private order = 0;
    private nextId = 1;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly max: number;
    private readonly idleMs: number;

    constructor(private makeWorker: () => WorkerLike, private wasmUrl: string, opts: QueueOptions = {}) {
        super();
        this.max = Math.max(1, opts.workers ?? 1);
        this.idleMs = opts.idleMs ?? 30_000;
    }

    /** Jobs queued or running. */
    get size(): number {
        return this.jobs.size;
    }

    /** True while a job for this key is queued or running. */
    has(key: string): boolean {
        return this.jobs.has(key);
    }

    /** True while this key's job is being encoded (not only queued). */
    running(key: string): boolean {
        return !!this.jobs.get(key)?.worker;
    }

    /**
     * Encodes one copy. The same key while it is pending shares the job
     * (raising its priority); aborting only leaves it, the job stops when
     * no caller waits any more.
     */
    run(key: string, input: EncodeInput, priority: number = PRIORITY.background, signal?: AbortSignal): Promise<Encoded> {
        if (signal?.aborted) return Promise.reject(abortError());
        let job = this.jobs.get(key);
        if (job) {
            job.priority = Math.max(job.priority, priority);
            job.waiting++;
        } else {
            let resolve!: (v: Encoded) => void;
            let reject!: (e: Error) => void;
            const promise = new Promise<Encoded>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            job = { key, input, priority, order: this.order++, promise, resolve, reject, worker: null, id: 0, waiting: 1 };
            this.jobs.set(key, job);
            this.emit('change', undefined);
        }
        const own = job;
        this.pump();
        if (!signal) return own.promise;
        return new Promise<Encoded>((resolve, reject) => {
            const onAbort = () => {
                own.waiting--;
                if (own.waiting <= 0) this.cancel(own);
                reject(abortError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            own.promise.then(
                (v) => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(v);
                },
                (e) => {
                    signal.removeEventListener('abort', onAbort);
                    reject(e);
                },
            );
        });
    }

    /** No new jobs start while paused; running ones finish. */
    pause(paused: boolean) {
        if (this.paused === paused) return;
        this.paused = paused;
        if (!paused) this.pump();
    }

    /** Stops every worker and fails every job. */
    dispose() {
        for (const job of Array.from(this.jobs.values())) this.cancel(job);
        for (const s of this.slots) s.worker.terminate();
        this.slots = [];
        if (this.idleTimer) clearTimeout(this.idleTimer);
    }

    private pump() {
        if (this.paused) return;
        for (;;) {
            const next = Array.from(this.jobs.values())
                .filter((j) => !j.worker)
                .sort((a, b) => b.priority - a.priority || a.order - b.order)[0];
            if (!next) break;
            const slot = this.slots.find((s) => !s.job) ?? (this.slots.length < this.max ? this.startWorker() : null);
            if (!slot) break;
            slot.job = next;
            next.worker = slot;
            next.id = this.nextId++;
            slot.worker.postMessage({ type: 'texture', id: next.id, blob: next.input.blob, role: next.input.role, opts: next.input.opts });
        }
        this.scheduleIdle();
    }

    private startWorker(): Slot {
        const slot: Slot = { worker: this.makeWorker(), job: null };
        slot.worker.onmessage = (e) => this.answer(slot, e.data);
        slot.worker.onerror = (e) => {
            e.preventDefault?.();
            // A crash (out of memory, say): the job fails, the next job gets a new worker.
            slot.worker.terminate();
            this.slots = this.slots.filter((s) => s !== slot);
            const job = slot.job;
            slot.job = null;
            if (job) this.finish(job, null, new Error(`The texture encoder stopped: ${e.message || 'worker error'}`));
            this.pump();
        };
        slot.worker.postMessage({ type: 'init', wasmUrl: this.wasmUrl });
        this.slots.push(slot);
        return slot;
    }

    private answer(slot: Slot, msg: DeriveOut) {
        const job = slot.job;
        if (!job || job.id !== msg.id) return;
        slot.job = null;
        if (msg.type === 'done') this.finish(job, { data: msg.data, width: msg.width, height: msg.height, levels: msg.levels, alpha: msg.alpha }, null);
        else this.finish(job, null, new Error(msg.message));
        this.pump();
    }

    private finish(job: Job, value: Encoded | null, error: Error | null) {
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        job.worker = null;
        if (value) job.resolve(value);
        else job.reject(error ?? new Error('Encoding failed.'));
        this.emit('change', undefined);
    }

    private cancel(job: Job) {
        if (this.jobs.get(job.key) !== job) return;
        const slot = job.worker;
        if (slot) {
            // Encoding cannot be interrupted: stop that worker.
            slot.worker.terminate();
            this.slots = this.slots.filter((s) => s !== slot);
        }
        // Nobody waits for it: settle it quietly.
        job.promise.catch(() => {});
        this.finish(job, null, abortError());
        this.pump();
    }

    private scheduleIdle() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.jobs.size || !this.slots.length) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.jobs.size) return;
            for (const s of this.slots) s.worker.terminate();
            this.slots = [];
        }, this.idleMs);
    }
}

function abortError(): Error {
    const e = new Error('Cancelled.');
    e.name = 'AbortError';
    return e;
}

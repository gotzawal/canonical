// The request scheduler for every model job of the agents (Ask questions,
// Model tasks). It runs on the main thread, right after the engine drew a
// frame (Runtime.onFrame):
//
// 1. exact cache: the same model and input give the stored result;
// 2. semantic cache: the same input without the context, with a context
//    vector at least 0.97 similar;
// 3. an identical job already queued or running is joined;
// 4. jobs are ranked by the agent's distance to the player (and the Ask's
//    priority); a batch takes jobs of the first job's model;
// 5. GPU time is budgeted: 150 ms per second to start, adjusted between 50
//    and 400 ms by the frame time (a token bucket: a batch goes out when
//    the time it is expected to take has accrued, and pays what it took).
//    A model on the CPU (WebAssembly) takes no GPU time and is not budgeted;
// 6. a batch is filled: while the queue is short and its oldest job has
//    waited less than 50 ms, up to 2 more frames are collected;
// 7. at most 10 units go out at a time (questions, texts; a generation is a
//    batch by itself), and only one batch is in flight;
// 8. a job that waited more than 1.5 s ends without an answer (the key
//    keeps its value). Time behind the running batch does not count (on a
//    slow CPU a batch takes seconds); a batch that has not answered after
//    30 s is given up.

import { cosine } from './memory';

export interface ModelJob {
    /** The model that runs it (a scene or built-in model id). */
    model: string;
    /** A newer job of the same group replaces a queued older one (agent/node). */
    group: string;
    /** Exact cache key (it includes the model); empty: never cached or joined (sampled text). */
    key: string;
    /** The input without the context, for the semantic cache. */
    semanticKey?: string;
    contextVector?: Float32Array | null;
    /** What the model's adapter gets (adapters.ts). */
    input: unknown;
    /** Batch units: the questions of an Ask, 1 per text; a generation takes a whole batch. */
    size: number;
    /** Lower runs first. */
    priority(): number;
}

export interface JobResult {
    /** What the model gave (adapters.ts), or null without an answer. */
    output: unknown;
    outcome?: 'timeout' | 'unavailable' | 'superseded';
    cache: 'none' | 'exact' | 'semantic' | 'joined';
    /** e.g. "laya/webgpu". */
    provider: string;
    model: string;
    /** Milliseconds from the request to the answer. */
    latency: number;
}

/** Runs batches of a model (the inference worker). */
export interface ModelProvider {
    ready(model: string): boolean;
    /** Changes with the model's files or options: answers of another revision are not reused. */
    revision(model: string): string;
    /** Kind and backend, e.g. "laya/webgpu". */
    name(model: string): string;
    run(model: string, inputs: unknown[]): Promise<{ outputs: unknown[]; ms: number }>;
    /** Tokenizes a job ahead, while the GPU runs the batch before it. */
    prepare?(model: string, inputs: unknown[]): void;
    /**
     * False when the model runs on the CPU (WebAssembly in the worker): it
     * does not take GPU time from the frames, so the GPU budget does not
     * apply (one batch at a time still does).
     */
    gpu(model: string): boolean;
}

interface Waiter {
    group: string;
    since: number;
    priority: () => number;
    resolve: (r: JobResult) => void;
    joined: boolean;
}

interface Pending {
    job: ModelJob;
    waiters: Waiter[];
    queuedAt: number;
    /** Milliseconds waited while no batch was running (what the queue timeout counts). */
    waited: number;
}

export const QUEUE_TIMEOUT = 1500;
/** A batch that has not answered after this long is given up (the model stopped answering). */
export const BATCH_WATCHDOG = 30000;
export const MAX_BATCH = 10;
const SPEECH_BATCH = 4;
const FILL_WAIT = 50;
const FILL_FRAMES = 2;
const BUDGET_START = 150;
const BUDGET_MIN = 50;
const BUDGET_MAX = 400;
const SEMANTIC_MIN = 0.97;
const EXACT_CACHE = 4000;
/** First guess of a model's milliseconds per unit, until it has run. */
const COST_START = 80;

export interface SchedulerStats {
    queued: number;
    units: number;
    inFlight: number;
    budget: number;
    used: number;
    tokens: number;
    batches: number;
    cacheHits: number;
    /** Milliseconds per unit, the average over the models that ran. */
    msPerUnit: number;
}

export class Scheduler {
    /** GPU milliseconds per second the models may use. */
    budget = BUDGET_START;
    /** A voice line is waiting: batches get smaller (set by the speech queue). */
    speechPending: () => boolean = () => false;

    private queue: Pending[] = [];
    private inFlight: Pending[] | null = null;
    private exact = new Map<string, unknown>();
    private semantic = new Map<string, { vector: Float32Array; output: unknown }[]>();
    private fillFrames = 0;
    /** GPU milliseconds available now (accrue at `budget` per second; the bucket starts full). */
    private tokens = Number.POSITIVE_INFINITY;
    private lastRefill = -1;
    /** GPU milliseconds of the batches that ended in the last second (for the stats). */
    private spent: { at: number; ms: number }[] = [];
    /** Milliseconds per unit, by model (moving averages). */
    private cost = new Map<string, number>();
    private msPerBatch = 20;
    private lastAdapt = 0;
    private batches = 0;
    private hits = 0;
    private lastFrame = -1;
    /** A batch was running when the last frame ended (the time until this frame is not counted as waiting). */
    private busy = false;
    private inFlightSince = 0;
    /** Raised per batch: an answer that comes after the watchdog gave up on its batch is dropped. */
    private batchSerial = 0;

    /** `fps`: frames per second now; `target`: what the view aims at (its limit, else 60). */
    constructor(private provider: ModelProvider, private fps: () => number, private target: () => number = () => 60) {}

    ready(model: string): boolean {
        return this.provider.ready(model);
    }

    providerName(model: string): string {
        return this.provider.name(model);
    }

    private result(model: string, output: unknown, since: number, cache: JobResult['cache'], outcome?: JobResult['outcome']): JobResult {
        return { output, outcome, cache, provider: this.provider.name(model), model, latency: performance.now() - since };
    }

    submit(job: ModelJob): Promise<JobResult> {
        // The caches and joins go by the model's revision too.
        const rev = this.provider.revision(job.model);
        job = { ...job, key: job.key && `${rev}\u0000${job.key}`, semanticKey: job.semanticKey && `${rev}\u0000${job.semanticKey}` };
        return new Promise((resolve) => {
            const since = performance.now();
            if (!this.provider.ready(job.model)) {
                resolve(this.result(job.model, null, since, 'none', 'unavailable'));
                return;
            }
            // A newer request of the same node replaces the one still waiting.
            this.supersede(job.group);
            if (job.key && this.exact.has(job.key)) {
                const hit = this.exact.get(job.key);
                this.hits++;
                // Refresh the entry's place in the cache order.
                this.exact.delete(job.key);
                this.exact.set(job.key, hit);
                resolve(this.result(job.model, hit, since, 'exact'));
                return;
            }
            if (job.key && job.contextVector && job.semanticKey) {
                for (const e of this.semantic.get(job.semanticKey) ?? []) {
                    if (cosine(e.vector, job.contextVector) >= SEMANTIC_MIN) {
                        this.hits++;
                        resolve(this.result(job.model, e.output, since, 'semantic'));
                        return;
                    }
                }
            }
            const waiter: Waiter = { group: job.group, since, priority: job.priority, resolve, joined: false };
            const same = job.key ? this.queue.find((p) => p.job.key === job.key) ?? this.inFlight?.find((p) => p.job.key === job.key) : undefined;
            if (same) {
                waiter.joined = true;
                same.waiters.push(waiter);
                return;
            }
            this.queue.push({ job, waiters: [waiter], queuedAt: since, waited: 0 });
            this.provider.prepare?.(job.model, [job.input]);
        });
    }

    private supersede(group: string) {
        for (const p of this.queue.slice()) {
            const gone = p.waiters.filter((w) => w.group === group);
            if (!gone.length) continue;
            p.waiters = p.waiters.filter((w) => w.group !== group);
            for (const w of gone) w.resolve(this.result(p.job.model, null, w.since, 'none', 'superseded'));
            if (!p.waiters.length) this.queue.splice(this.queue.indexOf(p), 1);
        }
    }

    /** Ends every waiting request (Play stopped). */
    clear() {
        for (const p of this.queue) for (const w of p.waiters) w.resolve(this.result(p.job.model, null, w.since, 'none', 'superseded'));
        this.queue = [];
        this.fillFrames = 0;
    }

    /** Called right after the engine drew a frame. */
    frame(now = performance.now()) {
        // A gap between frames (a background tab, a paused engine) is not waiting: at most 250 ms count per frame.
        const dt = this.lastFrame >= 0 ? Math.min(250, Math.max(0, now - this.lastFrame)) : 0;
        this.lastFrame = now;
        // Waiting while the one batch at a time runs does not make a request
        // stale (the newest request of a node wins anyway); waiting for the
        // GPU budget or behind nearer agents does.
        if (!this.busy) for (const p of this.queue) p.waited += dt;
        if (this.inFlight && now - this.inFlightSince > BATCH_WATCHDOG) {
            // The model stopped answering: give up on the batch (a late answer is dropped).
            const batch = this.inFlight;
            this.inFlight = null;
            this.batchSerial++;
            for (const p of batch) for (const w of p.waiters) w.resolve(this.result(p.job.model, null, w.since, 'none', 'timeout'));
        }
        this.step(now);
        this.busy = !!this.inFlight;
    }

    private step(now: number) {
        // Waited too long, or the model is gone: finish without an answer.
        for (const p of this.queue.slice()) {
            const ready = this.provider.ready(p.job.model);
            if (ready && p.waited <= QUEUE_TIMEOUT) continue;
            this.queue.splice(this.queue.indexOf(p), 1);
            for (const w of p.waiters) w.resolve(this.result(p.job.model, null, w.since, 'none', ready ? 'timeout' : 'unavailable'));
        }
        this.spent = this.spent.filter((s) => now - s.at < 1000);
        if (now - this.lastAdapt >= 1000) {
            this.lastAdapt = now;
            // Below three quarters of the frame rate aimed at, the models get less; close to it (55 of 60), more.
            const fps = this.fps();
            const target = this.target();
            if (fps > 0 && fps < target * 0.75) this.budget = Math.max(BUDGET_MIN, this.budget - 50);
            else if (fps >= (target * 11) / 12) this.budget = Math.min(BUDGET_MAX, this.budget + 25);
        }
        // The bucket holds at least one full batch, so a batch longer than a second's budget still goes out.
        const cap = Math.max(this.budget, this.msPerBatch + Math.max(COST_START, ...this.cost.values()) * MAX_BATCH);
        if (this.lastRefill >= 0) this.tokens = Math.min(cap, this.tokens + (this.budget * Math.max(0, now - this.lastRefill)) / 1000);
        this.lastRefill = now;
        if (this.inFlight || !this.queue.length) return;

        const max = this.speechPending() ? SPEECH_BATCH : MAX_BATCH;
        const count = this.queue.reduce((n, p) => n + p.job.size, 0);
        const oldest = Math.min(...this.queue.map((p) => p.queuedAt));
        if (count < max && now - oldest < FILL_WAIT && this.fillFrames < FILL_FRAMES) {
            this.fillFrames++;
            return;
        }
        this.fillFrames = 0;

        // Nearest (and most important) first; older first between equals. The batch runs the first job's model.
        const rank = (p: Pending) => Math.min(...p.waiters.map((w) => w.priority()));
        const ordered = this.queue.slice().sort((a, b) => rank(a) - rank(b) || a.queuedAt - b.queuedAt);
        const model = ordered[0].job.model;
        const batch: Pending[] = [];
        let units = 0;
        for (const p of ordered) {
            if (p.job.model !== model) continue;
            const n = p.job.size;
            if (batch.length && units + n > max) continue;
            batch.push(p);
            units += n;
            if (units >= max) break;
        }
        const estimate = this.msPerBatch + (this.cost.get(model) ?? COST_START) * units;
        if (this.provider.gpu(model) && this.tokens < estimate && this.tokens < cap) return;
        this.dispatch(batch, model, units);
    }

    private dispatch(batch: Pending[], model: string, units: number) {
        this.queue = this.queue.filter((p) => !batch.includes(p));
        this.inFlight = batch;
        this.inFlightSince = performance.now();
        this.batches++;
        const serial = ++this.batchSerial;
        const done = (outputs: unknown[] | null, ms: number) => {
            if (serial !== this.batchSerial) return;
            this.inFlight = null;
            const end = performance.now();
            if (ms > 0) {
                // CPU inference does not use the frames' GPU time.
                if (this.provider.gpu(model)) this.tokens -= ms;
                this.spent.push({ at: end, ms });
                // Moving average of the model's cost, for the next estimate.
                const per = Math.max(1, (ms - this.msPerBatch) / Math.max(1, units));
                this.cost.set(model, (this.cost.get(model) ?? COST_START) * 0.7 + per * 0.3);
            }
            batch.forEach((p, i) => {
                const out = outputs?.[i] ?? null;
                if (out !== null) this.remember(p.job, out);
                for (const w of p.waiters) w.resolve(this.result(model, out, w.since, w.joined ? 'joined' : 'none', out === null ? 'unavailable' : undefined));
            });
        };
        this.provider.run(model, batch.map((p) => p.job.input)).then(
            (r) => done(r.outputs, r.ms),
            (e) => {
                console.warn(`[ai] a batch of ${model} failed`, e);
                done(null, 0);
            },
        );
    }

    private remember(job: ModelJob, output: unknown) {
        if (!job.key) return;
        this.exact.set(job.key, output);
        if (this.exact.size > EXACT_CACHE) this.exact.delete(this.exact.keys().next().value!);
        if (job.contextVector && job.semanticKey) {
            const list = this.semantic.get(job.semanticKey) ?? [];
            list.unshift({ vector: job.contextVector, output });
            if (list.length > 8) list.length = 8;
            this.semantic.set(job.semanticKey, list);
        }
    }

    stats(): SchedulerStats {
        return {
            queued: this.queue.length,
            units: this.queue.reduce((n, p) => n + p.job.size, 0),
            inFlight: this.inFlight?.length ?? 0,
            budget: this.budget,
            used: Math.round(this.spent.reduce((s, x) => s + x.ms, 0)),
            tokens: Math.round(this.tokens),
            batches: this.batches,
            cacheHits: this.hits,
            msPerUnit: Math.round(this.cost.size ? Array.from(this.cost.values()).reduce((a, b) => a + b, 0) / this.cost.size : COST_START),
        };
    }
}

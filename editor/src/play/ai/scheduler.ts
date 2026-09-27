// The request scheduler for the decision model. It runs on the main thread,
// right after the engine drew a frame (Runtime.onFrame):
//
// 1. exact cache: the same state and questions give the stored answers;
// 2. semantic cache: the same facts and questions, with a context vector at
//    least 0.97 similar;
// 3. an identical request already queued or running is joined;
// 4. requests are ranked by the agent's distance to the player (and the
//    Ask's priority);
// 5. GPU time is budgeted: 150 ms per second to start, adjusted between 50
//    and 400 ms by the frame time (a token bucket: a batch goes out when
//    the time it is expected to take has accrued, and pays what it took).
//    A model on the CPU (WebAssembly) takes no GPU time and is not budgeted;
// 6. a batch is filled: while the queue is short and its oldest request has
//    waited less than 50 ms, up to 2 more frames are collected;
// 7. at most 10 questions go out at a time, and only one batch is in flight;
// 8. a request that waited more than 1.5 s ends without an answer (the key
//    keeps its value).

import type { LayaQuestion } from './laya';
import { cosine } from './memory';

export interface AskJob {
    /** A newer job of the same group replaces a queued older one (agent/Ask node). */
    group: string;
    /** Exact cache key: state and questions. */
    key: string;
    /** Facts and questions without the context, for the semantic cache. */
    semanticKey: string;
    contextVector: Float32Array | null;
    /** The state as the model sees it (JSON text). */
    state: string;
    questions: LayaQuestion[];
    /** Lower runs first. */
    priority(): number;
}

export interface AskResult {
    /** Probabilities per question, or null without an answer. */
    probabilities: number[][] | null;
    outcome?: 'timeout' | 'unavailable' | 'superseded';
    cache: 'none' | 'exact' | 'semantic' | 'joined';
    provider: string;
    model: string;
    /** Milliseconds from the request to the answer. */
    latency: number;
}

/** Runs batches of questions (the inference worker). */
export interface DecisionProvider {
    readonly ready: boolean;
    /** e.g. "laya/webgpu". */
    readonly name: string;
    /** Model and calibration, e.g. "laya-en-q4 (temperatures of config.json)". */
    readonly model: string;
    run(items: { state: string; questions: LayaQuestion[] }[]): Promise<{ probabilities: number[][][]; ms: number }>;
    /** Tokenizes a request ahead, while the GPU runs the batch before it. */
    prepare?(items: { state: string; questions: LayaQuestion[] }[]): void;
    /**
     * False when the model runs on the CPU (WebAssembly in the worker): it
     * does not take GPU time from the frames, so the GPU budget does not
     * apply (one batch at a time still does).
     */
    readonly gpu?: boolean;
}

interface Waiter {
    group: string;
    since: number;
    priority: () => number;
    resolve: (r: AskResult) => void;
    joined: boolean;
}

interface Pending {
    job: AskJob;
    waiters: Waiter[];
    queuedAt: number;
}

export const QUEUE_TIMEOUT = 1500;
export const MAX_QUESTIONS = 10;
const SPEECH_QUESTIONS = 4;
const FILL_WAIT = 50;
const FILL_FRAMES = 2;
const BUDGET_START = 150;
const BUDGET_MIN = 50;
const BUDGET_MAX = 400;
const SEMANTIC_MIN = 0.97;
const EXACT_CACHE = 4000;

export interface SchedulerStats {
    queued: number;
    questions: number;
    inFlight: number;
    budget: number;
    used: number;
    tokens: number;
    msPerQuestion: number;
    batches: number;
    cacheHits: number;
}

export class Scheduler {
    /** GPU milliseconds per second the model may use. */
    budget = BUDGET_START;
    /** A voice line is waiting: batches get smaller (set by the speech queue). */
    speechPending: () => boolean = () => false;

    private queue: Pending[] = [];
    private inFlight: Pending[] | null = null;
    private exact = new Map<string, number[][]>();
    private semantic = new Map<string, { vector: Float32Array; probabilities: number[][] }[]>();
    private fillFrames = 0;
    /** GPU milliseconds available now (accrue at `budget` per second; the bucket starts full). */
    private tokens = Number.POSITIVE_INFINITY;
    private lastRefill = -1;
    /** GPU milliseconds of the batches that ended in the last second (for the stats). */
    private spent: { at: number; ms: number }[] = [];
    private msPerQuestion = 80;
    private msPerBatch = 20;
    private lastAdapt = 0;
    private batches = 0;
    private hits = 0;

    constructor(private provider: DecisionProvider, private fps: () => number) {}

    get ready(): boolean {
        return this.provider.ready;
    }

    get providerName(): string {
        return this.provider.name;
    }

    private result(probabilities: number[][] | null, since: number, cache: AskResult['cache'], outcome?: AskResult['outcome']): AskResult {
        return { probabilities, outcome, cache, provider: this.provider.name, model: this.provider.model, latency: performance.now() - since };
    }

    submit(job: AskJob): Promise<AskResult> {
        return new Promise((resolve) => {
            const since = performance.now();
            if (!this.provider.ready) {
                resolve(this.result(null, since, 'none', 'unavailable'));
                return;
            }
            // A newer request of the same Ask replaces the one still waiting.
            this.supersede(job.group);
            const hit = this.exact.get(job.key);
            if (hit) {
                this.hits++;
                // Refresh the entry's place in the cache order.
                this.exact.delete(job.key);
                this.exact.set(job.key, hit);
                resolve(this.result(hit, since, 'exact'));
                return;
            }
            if (job.contextVector) {
                for (const e of this.semantic.get(job.semanticKey) ?? []) {
                    if (cosine(e.vector, job.contextVector) >= SEMANTIC_MIN) {
                        this.hits++;
                        resolve(this.result(e.probabilities, since, 'semantic'));
                        return;
                    }
                }
            }
            const waiter: Waiter = { group: job.group, since, priority: job.priority, resolve, joined: false };
            const same = this.queue.find((p) => p.job.key === job.key) ?? this.inFlight?.find((p) => p.job.key === job.key);
            if (same) {
                waiter.joined = true;
                same.waiters.push(waiter);
                return;
            }
            this.queue.push({ job, waiters: [waiter], queuedAt: since });
            this.provider.prepare?.([{ state: job.state, questions: job.questions }]);
        });
    }

    private supersede(group: string) {
        for (const p of this.queue.slice()) {
            const gone = p.waiters.filter((w) => w.group === group);
            if (!gone.length) continue;
            p.waiters = p.waiters.filter((w) => w.group !== group);
            for (const w of gone) w.resolve(this.result(null, w.since, 'none', 'superseded'));
            if (!p.waiters.length) this.queue.splice(this.queue.indexOf(p), 1);
        }
    }

    /** Ends every waiting request (Play stopped). */
    clear() {
        for (const p of this.queue) for (const w of p.waiters) w.resolve(this.result(null, w.since, 'none', 'superseded'));
        this.queue = [];
        this.fillFrames = 0;
    }

    /** Called right after the engine drew a frame. */
    frame(now = performance.now()) {
        // Waited too long: finish without an answer.
        for (const p of this.queue.slice()) {
            if (now - p.queuedAt <= QUEUE_TIMEOUT) continue;
            this.queue.splice(this.queue.indexOf(p), 1);
            for (const w of p.waiters) w.resolve(this.result(null, w.since, 'none', 'timeout'));
        }
        this.spent = this.spent.filter((s) => now - s.at < 1000);
        if (now - this.lastAdapt >= 1000) {
            this.lastAdapt = now;
            const fps = this.fps();
            if (fps > 0 && fps < 45) this.budget = Math.max(BUDGET_MIN, this.budget - 50);
            else if (fps >= 55) this.budget = Math.min(BUDGET_MAX, this.budget + 25);
        }
        // The bucket holds at least one full batch, so a batch longer than a second's budget still goes out.
        const cap = Math.max(this.budget, this.estimate(MAX_QUESTIONS));
        if (this.lastRefill >= 0) this.tokens = Math.min(cap, this.tokens + (this.budget * Math.max(0, now - this.lastRefill)) / 1000);
        this.lastRefill = now;
        if (this.inFlight || !this.queue.length || !this.provider.ready) return;

        const max = this.speechPending() ? SPEECH_QUESTIONS : MAX_QUESTIONS;
        const count = this.queue.reduce((n, p) => n + p.job.questions.length, 0);
        const oldest = Math.min(...this.queue.map((p) => p.queuedAt));
        if (count < max && now - oldest < FILL_WAIT && this.fillFrames < FILL_FRAMES) {
            this.fillFrames++;
            return;
        }
        this.fillFrames = 0;

        // Nearest (and most important) first; older first between equals.
        const rank = (p: Pending) => Math.min(...p.waiters.map((w) => w.priority()));
        const ordered = this.queue.slice().sort((a, b) => rank(a) - rank(b) || a.queuedAt - b.queuedAt);
        const batch: Pending[] = [];
        let questions = 0;
        for (const p of ordered) {
            const n = p.job.questions.length;
            if (batch.length && questions + n > max) continue;
            batch.push(p);
            questions += n;
            if (questions >= max) break;
        }
        const estimate = this.estimate(questions);
        if (this.provider.gpu !== false && this.tokens < estimate && this.tokens < cap) return;
        this.dispatch(batch, questions);
    }

    private estimate(questions: number): number {
        return this.msPerBatch + this.msPerQuestion * questions;
    }

    private dispatch(batch: Pending[], questions: number) {
        this.queue = this.queue.filter((p) => !batch.includes(p));
        this.inFlight = batch;
        this.batches++;
        const done = (probabilities: number[][][] | null, ms: number) => {
            this.inFlight = null;
            const end = performance.now();
            if (ms > 0) {
                // CPU inference does not use the frames' GPU time.
                if (this.provider.gpu !== false) this.tokens -= ms;
                this.spent.push({ at: end, ms });
                // Moving averages of the batch cost, for the next estimate.
                const per = Math.max(1, (ms - this.msPerBatch) / Math.max(1, questions));
                this.msPerQuestion = this.msPerQuestion * 0.7 + per * 0.3;
            }
            batch.forEach((p, i) => {
                const probs = probabilities?.[i] ?? null;
                if (probs) this.remember(p.job, probs);
                for (const w of p.waiters) w.resolve(this.result(probs, w.since, w.joined ? 'joined' : 'none', probs ? undefined : 'unavailable'));
            });
        };
        this.provider.run(batch.map((p) => ({ state: p.job.state, questions: p.job.questions }))).then(
            (r) => done(r.probabilities, r.ms),
            (e) => {
                console.warn('[ai] decision batch failed', e);
                done(null, 0);
            },
        );
    }

    private remember(job: AskJob, probabilities: number[][]) {
        this.exact.set(job.key, probabilities);
        if (this.exact.size > EXACT_CACHE) this.exact.delete(this.exact.keys().next().value!);
        if (job.contextVector) {
            const list = this.semantic.get(job.semanticKey) ?? [];
            list.unshift({ vector: job.contextVector, probabilities });
            if (list.length > 8) list.length = 8;
            this.semantic.set(job.semanticKey, list);
        }
    }

    stats(): SchedulerStats {
        return {
            queued: this.queue.length,
            questions: this.queue.reduce((n, p) => n + p.job.questions.length, 0),
            inFlight: this.inFlight?.length ?? 0,
            budget: this.budget,
            used: Math.round(this.spent.reduce((s, x) => s + x.ms, 0)),
            tokens: Math.round(this.tokens),
            msPerQuestion: Math.round(this.msPerQuestion),
            batches: this.batches,
            cacheHits: this.hits,
        };
    }
}

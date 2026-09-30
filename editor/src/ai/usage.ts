// What the models cost, per piece of work: each request of the assistant,
// the summaries of long conversations, the scene memo, images made by hand
// and the language model calls of scripts in Play. The log is kept per
// project in this browser (IndexedDB), and the chat's token count opens it
// (ui/usageDialog.ts).

import { kvGet, kvSet } from '../core/db';
import { planStarted } from '../core/design';
import { Emitter } from '../core/events';
import { uid } from '../core/ids';
import type { Store } from '../core/store';
import type { StageId } from '../core/types';
import { cacheTokens, type Usage } from '../openrouter/client';
import type { ImageQuality } from '../openrouter/imageQuality';

export type UsageKind = 'request' | 'summary' | 'memo' | 'images' | 'script';

export const USAGE_KINDS: Record<UsageKind, string> = {
    request: 'Assistant requests',
    summary: 'Conversation summaries',
    memo: 'Scene memo',
    images: 'Images made by hand',
    script: 'Scripts (this.chat)',
};

export interface UsageEntry {
    id: string;
    kind: UsageKind;
    /** What the work was: the request's words, the shot painted... */
    label: string;
    /** When it started (ms since 1970) and how long it took (ms). */
    at: number;
    ms: number;
    /** The pipeline stage it was done in; null before a plan started. */
    stage: StageId | null;
    /** The language model and how often it was called. */
    model: string;
    calls: number;
    /** Prompt tokens, those of them read from and written to the provider's cache, and completion tokens. */
    prompt: number;
    cached: number;
    written: number;
    completion: number;
    /** Credits of the language model calls, where reported. */
    cost: number;
    /** Images sent to the language model, and how sharp. */
    sent: number;
    seeQuality?: ImageQuality;
    /** Images generated, by which model, their credits (where reported) and how sharp. */
    made: number;
    imageModel: string;
    imageCost: number;
    drawQuality?: ImageQuality;
    /** Tool calls of an assistant request. */
    tools: number;
    /** Still going on. */
    running?: boolean;
}

export interface UsageTotals {
    /** Pieces of work. */
    count: number;
    calls: number;
    prompt: number;
    cached: number;
    completion: number;
    /** Credits of the language models and the image models. */
    cost: number;
    sent: number;
    made: number;
    ms: number;
}

export const emptyTotals = (): UsageTotals => ({ count: 0, calls: 0, prompt: 0, cached: 0, completion: 0, cost: 0, sent: 0, made: 0, ms: 0 });

export function addTotals(t: UsageTotals, e: UsageEntry | UsageTotals): UsageTotals {
    const one = 'kind' in e;
    t.count += one ? 1 : e.count;
    t.calls += e.calls;
    t.prompt += e.prompt;
    t.cached += e.cached;
    t.completion += e.completion;
    t.cost += one ? e.cost + e.imageCost : e.cost;
    t.sent += e.sent;
    t.made += e.made;
    t.ms += e.ms;
    return t;
}

/** Totals of entries grouped by a key (entries whose key is null are left out), largest first by tokens, then credits. */
export function groupTotals(entries: readonly UsageEntry[], key: (e: UsageEntry) => string | null): [string, UsageTotals][] {
    const groups = new Map<string, UsageTotals>();
    for (const e of entries) {
        const k = key(e);
        if (k === null) continue;
        let t = groups.get(k);
        if (!t) groups.set(k, (t = emptyTotals()));
        addTotals(t, e);
    }
    return [...groups].sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]) || b[1].cost - a[1].cost);
}

/** Totals per model: the language model's calls under its name, generated images under the image model's. */
export function modelTotals(entries: readonly UsageEntry[]): [string, UsageTotals][] {
    const groups = new Map<string, UsageTotals>();
    const at = (model: string) => {
        let t = groups.get(model);
        if (!t) groups.set(model, (t = emptyTotals()));
        return t;
    };
    for (const e of entries) {
        if (e.calls && e.model) {
            const t = at(e.model);
            t.count++;
            t.calls += e.calls;
            t.prompt += e.prompt;
            t.cached += e.cached;
            t.completion += e.completion;
            t.cost += e.cost;
            t.sent += e.sent;
        }
        if (e.made && e.imageModel) {
            const t = at(e.imageModel);
            t.count++;
            t.made += e.made;
            t.cost += e.imageCost;
        }
    }
    return [...groups].sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]) || b[1].cost - a[1].cost);
}

export const tokensOf = (t: { prompt: number; completion: number }) => t.prompt + t.completion;

const CSV_HEAD = [
    'started', 'kind', 'work', 'stage', 'model', 'calls', 'prompt_tokens', 'cached_tokens', 'cache_write_tokens', 'completion_tokens', 'cost_usd',
    'images_sent', 'image_quality_sent', 'image_model', 'images_made', 'image_cost_usd', 'image_quality_made', 'tool_calls', 'seconds',
];

/** The entries as CSV, one row each, oldest first. */
export function usageCsv(entries: readonly UsageEntry[]): string {
    const cell = (v: unknown) => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [...entries].sort((a, b) => a.at - b.at).map((e) => [
        new Date(e.at).toISOString(), e.kind, e.label, e.stage ?? '', e.model, e.calls, e.prompt, e.cached, e.written, e.completion, round(e.cost),
        e.sent, e.seeQuality ?? '', e.imageModel, e.made, round(e.imageCost), e.drawQuality ?? '', e.tools, (e.ms / 1000).toFixed(1),
    ].map(cell).join(','));
    return [CSV_HEAD.join(','), ...rows].join('\n') + '\n';
}

const round = (v: number) => Number(v.toFixed(6));

interface Stored {
    version: 1;
    entries: UsageEntry[];
    /** What the entries dropped to keep the log small added up to. */
    older: UsageTotals | null;
}

/** Entries a project keeps; older ones only count in the totals. */
const MAX_ENTRIES = 1000;
const KEY_PREFIX = 'ai-usage:';
/** Calls of scripts within this long of the last one add to its entry. */
const SCRIPT_MERGE_MS = 10 * 60_000;

/**
 * Where the tokens and credits of one piece of work go while it runs; end()
 * closes it. Work that spent nothing leaves no entry.
 */
export class UsageTask {
    private start = performance.now();
    private ended = false;

    constructor(private log: UsageLog, readonly entry: UsageEntry, readonly key: string) {}

    /** A language model call's usage report. */
    chat(model: string, u: Usage | null | undefined) {
        const e = this.entry;
        const cache = cacheTokens(u);
        e.model ||= model;
        e.calls++;
        e.prompt += u?.prompt_tokens ?? 0;
        e.completion += u?.completion_tokens ?? 0;
        e.cached += cache.read;
        e.written += cache.written;
        e.cost += u?.cost ?? 0;
        this.log.touched(this);
    }

    /** Images sent to the language model. */
    sent(count: number, quality: ImageQuality) {
        if (!count) return;
        this.entry.sent += count;
        this.entry.seeQuality = quality;
        this.log.touched(this);
    }

    /** Images an image model made. */
    images(model: string, count: number, cost: number | null, quality?: ImageQuality) {
        const e = this.entry;
        e.imageModel ||= model;
        e.made += count;
        e.imageCost += cost ?? 0;
        if (quality) e.drawQuality = quality;
        this.log.touched(this);
    }

    tool() {
        this.entry.tools++;
    }

    end() {
        if (this.ended) return;
        this.ended = true;
        this.entry.ms += performance.now() - this.start;
        delete this.entry.running;
        this.log.finished(this);
    }
}

/** The usage log of the open project. */
export class UsageLog extends Emitter<{ change: void }> {
    entries: UsageEntry[] = [];
    older: UsageTotals | null = null;
    private key = '';
    private timer = 0;
    /** Resolves once the open project's log is read. */
    loading: Promise<void> = Promise.resolve();

    constructor(private store: Store) {
        super();
        this.loading = this.load();
        store.on('load', () => {
            if (this.keyOf() === this.key) return;
            this.flush();
            this.loading = this.load();
        });
    }

    private keyOf(): string {
        return KEY_PREFIX + this.store.doc.design.id;
    }

    private async load() {
        const key = this.keyOf();
        this.key = key;
        // Work that begins while the log is read joins what was stored.
        this.entries = [];
        this.older = null;
        this.emit('change', undefined);
        const data = await kvGet<Stored>(key).catch(() => undefined);
        if (this.key !== key || data?.version !== 1) return;
        const known = new Set(this.entries.map((e) => e.id));
        this.entries = [...(Array.isArray(data.entries) ? data.entries.filter((e) => e && !known.has(e.id)) : []), ...this.entries];
        // A reload in the middle of a piece of work leaves it running for good otherwise.
        for (const e of this.entries) if (e.running && !known.has(e.id)) delete e.running;
        this.older = data.older ?? null;
        this.emit('change', undefined);
    }

    /** Starts a piece of work of the open project. */
    begin(kind: UsageKind, label: string): UsageTask {
        const design = this.store.doc.design;
        const entry: UsageEntry = {
            id: uid('u'),
            kind,
            label: label.replace(/\s+/g, ' ').trim().slice(0, 200) || USAGE_KINDS[kind],
            at: Date.now(),
            ms: 0,
            stage: planStarted(design) ? design.stage : null,
            model: '',
            calls: 0,
            prompt: 0,
            cached: 0,
            written: 0,
            completion: 0,
            cost: 0,
            sent: 0,
            made: 0,
            imageModel: '',
            imageCost: 0,
            tools: 0,
            running: true,
        };
        this.entries.push(entry);
        this.emit('change', undefined);
        return new UsageTask(this, entry, this.key);
    }

    /**
     * A language model call of a script (this.chat): calls in a row, with
     * no other work between, add up in one entry.
     */
    script(model: string, u: Usage | null | undefined) {
        const last = this.entries[this.entries.length - 1];
        if (last?.kind === 'script' && Date.now() - (last.at + last.ms) < SCRIPT_MERGE_MS) {
            const task = new UsageTask(this, last, this.key);
            last.ms = Math.max(0, Date.now() - last.at);
            task.chat(model, u);
            return;
        }
        const task = this.begin('script', USAGE_KINDS.script);
        task.chat(model, u);
        task.end();
    }

    /** The totals of every piece of work of the project, including those no longer listed. */
    totals(): UsageTotals {
        const t = emptyTotals();
        if (this.older) addTotals(t, this.older);
        for (const e of this.entries) addTotals(t, e);
        return t;
    }

    /** Forgets the project's log. */
    clear() {
        this.entries = this.entries.filter((e) => e.running);
        this.older = null;
        this.save();
        this.emit('change', undefined);
    }

    /** A running piece of work spent something. */
    touched(task: UsageTask) {
        if (task.key !== this.key) return;
        this.emit('change', undefined);
        this.save();
    }

    /** A piece of work ended: kept when it spent anything, with the project it began in. */
    finished(task: UsageTask) {
        const e = task.entry;
        const empty = !e.calls && !e.made && !e.sent;
        if (task.key !== this.key) {
            void this.storeElsewhere(task.key, e, empty);
            return;
        }
        if (empty) this.entries = this.entries.filter((x) => x !== e);
        this.trim();
        this.emit('change', undefined);
        this.save();
    }

    /** Work of a project left while it ran goes to that project's log. */
    private async storeElsewhere(key: string, e: UsageEntry, empty: boolean) {
        const data = await kvGet<Stored>(key).catch(() => undefined);
        const stored: Stored = data?.version === 1 ? data : { version: 1, entries: [], older: null };
        stored.entries = stored.entries.filter((x) => x.id !== e.id);
        if (empty) return void kvSet(key, stored);
        stored.entries.push({ ...e });
        await kvSet(key, stored);
    }

    /** Keeps the latest MAX_ENTRIES; the totals of the older ones stay. */
    private trim() {
        const over = this.entries.length - MAX_ENTRIES;
        if (over <= 0) return;
        const gone = this.entries.filter((e) => !e.running).slice(0, over);
        const drop = new Set(gone);
        this.older ??= emptyTotals();
        for (const e of gone) addTotals(this.older, e);
        this.entries = this.entries.filter((e) => !drop.has(e));
    }

    private save() {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.flush(), 800);
    }

    /** Writes the open project's log now. */
    private flush() {
        clearTimeout(this.timer);
        this.timer = 0;
        if (!this.key) return;
        const data: Stored = { version: 1, entries: this.entries.map((e) => ({ ...e })), older: this.older };
        void kvSet(this.key, data);
    }
}

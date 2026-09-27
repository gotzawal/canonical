// Laya's input and output format: how a state and a typed question become
// one token sequence, and how the logits become calibrated probabilities.
// It follows the checkpoint's rl_common.build_sequence and rl_agent_api.py
// (convaiinnovations/laya, Apache-2.0), as ported to TypeScript by
// @receptron/laya (MIT):
//
//   [CLS] <type> question: <instructions> [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] <state> [SEP]
//
// The model scores each option at its [MASK] marker; a softmax over the
// options with a temperature per question type and option count gives the
// probabilities. Pure functions: the worker tokenizes with them and the main
// thread builds cache keys from the same state text.

export type LayaQuestionType = 'choice' | 'score' | 'noul';

export const QTYPE_INDEX: Record<LayaQuestionType, number> = { choice: 0, score: 1, noul: 2 };

export interface LayaQuestion {
    type: LayaQuestionType;
    instructions: string;
    /** choice: option -> description (or null); score: the ordered levels; noul: optional texts. */
    criteria?: Record<string, string | null> | string[] | { true?: string; false?: string };
}

/** laya_config.json / config.json of a build. */
export interface LayaConfig {
    max_len: number;
    head_max_len: number;
    /** Per question type: choice, score, noul. */
    temperature: [number, number, number];
    /** Per type and option count, e.g. "choice:3-5". */
    temperature_by_options: Record<string, number>;
    cls?: number;
    sep?: number;
    pad?: number;
    mask?: number;
    mask_token?: string;
}

export interface SpecialIds {
    cls: number;
    sep: number;
    pad: number;
    mask: number;
    maskToken: string;
}

/** Python's json.dumps(v, ensure_ascii=False): ", " and ": " separators, keys in insertion order. */
export function pyJson(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : JSON.stringify(v)) : 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
    if (typeof v === 'object') {
        return '{' + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ') + '}';
    }
    return JSON.stringify(String(v));
}

/** The option texts in label order. Noul is always [false, true], so p[1] is P(true). */
export function renderOptions(q: LayaQuestion): string[] {
    if (q.type === 'choice') {
        const crit = Array.isArray(q.criteria) ? Object.fromEntries(q.criteria.map((c) => [c, null])) : ((q.criteria ?? {}) as Record<string, string | null>);
        return Object.entries(crit).map(([k, v]) => (v ? `${k}: ${v}` : k));
    }
    if (q.type === 'score') return ((q.criteria as string[]) ?? []).map((c, i) => `level ${i}: ${c}`);
    const c = (q.criteria ?? {}) as { true?: string; false?: string };
    return [`false: ${c.false || 'no, the statement does not hold'}`, `true: ${c.true || 'yes, the statement holds'}`];
}

/** The option labels of a question (the values an answer picks between). */
export function optionLabels(q: LayaQuestion): string[] {
    if (q.type === 'choice') return Array.isArray(q.criteria) ? q.criteria.slice() : Object.keys((q.criteria ?? {}) as object);
    if (q.type === 'score') return ((q.criteria as string[]) ?? []).map((_, i) => String(i));
    return ['false', 'true'];
}

/** Token ids of one question about a state, and the position of each option's [MASK]. */
export function buildSequence(encode: (text: string) => number[], ids: SpecialIds, q: LayaQuestion, stateText: string, maxLen: number, headMaxLen: number): { ids: number[]; markers: number[] } {
    const scrub = (s: string) => s.split(ids.maskToken).join(' ');
    const opts = renderOptions(q);
    let head = encode(`${q.type} question: ${scrub(q.instructions)}`);
    let optIds = opts.map((o) => [ids.mask, ...encode(' ' + scrub(o)).slice(0, 48)]);
    const total = (xs: number[][]) => xs.reduce((s, o) => s + o.length, 0);
    let budget = headMaxLen - total(optIds);
    if (budget < 16) {
        // Too many or too long options: shorten every option text evenly.
        const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
        optIds = optIds.map((o) => o.slice(0, per));
        budget = headMaxLen - total(optIds);
    }
    head = head.slice(0, Math.max(8, budget));
    const seq = [ids.cls, ...head, ids.sep];
    const markers: number[] = [];
    for (const o of optIds) {
        markers.push(seq.length);
        seq.push(...o);
    }
    seq.push(ids.sep);
    const room = Math.max(0, maxLen - seq.length - 1);
    seq.push(...encode(scrub(stateText)).slice(0, room), ids.sep);
    return { ids: seq.slice(0, maxLen), markers: markers.filter((m) => m < maxLen) };
}

export function softmax(z: number[]): number[] {
    const max = Math.max(...z);
    const e = z.map((v) => Math.exp(v - max));
    const sum = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / sum);
}

function sizeBucket(k: number): string {
    if (k <= 2) return '2';
    if (k <= 5) return '3-5';
    if (k <= 10) return '6-10';
    return '11+';
}

/** Calibrated probabilities of one question from its option logits. */
export function calibrate(logits: number[], type: LayaQuestionType, config: LayaConfig): number[] {
    const q = QTYPE_INDEX[type];
    const temp = config.temperature_by_options[`${type}:${sizeBucket(logits.length)}`] ?? config.temperature[q] ?? 1;
    return softmax(logits.map((v) => v / temp));
}

/** 1 - normalized entropy (Jev's confidence of a distribution). */
export function entropyConfidence(p: number[]): number {
    if (p.length < 2) return 1;
    let h = 0;
    for (const x of p) h -= x * Math.log(Math.max(x, 1e-12));
    return 1 - h / Math.log(p.length);
}

/** A short stable hash of a string (FNV-1a, 53 bits), for cache keys. */
export function hashText(s: string): string {
    let h1 = 0x811c9dc5 ^ s.length;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    }
    return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).padEnd(8, '0');
}

// How each kind of model runs (core/behavior/models.ts lists the kinds and
// their settings). The inference worker loads a model's files and makes its
// ONNX Runtime session; the adapter of its kind turns inputs into tensors
// and the outputs into results. A new kind of model needs an entry in
// MODEL_KINDS and an adapter here.
//
// Inputs and results per task:
//   decide    { state, questions } (Laya's typed questions) -> probabilities per question
//   embed     { text, kind: 'query' | 'passage' }           -> Float32Array (normalized)
//   classify  { text }                                      -> { labels, probs }
//   generate  { prompt, maxTokens, temperature }            -> { text }

import type { Tokenizer } from '@huggingface/tokenizers';
import type * as Ort from 'onnxruntime-web';
import { modelOption } from '../../core/behavior/models';
import type { AiModelDoc } from '../../core/types';
import { buildSequence, calibrate, QTYPE_INDEX, softmax, type LayaConfig, type LayaQuestion, type SpecialIds } from './laya';

type Session = Ort.InferenceSession;

export interface AdapterContext {
    model: AiModelDoc;
    /** config.json, or {} when the folder has none. */
    config: any;
    tokenizerConfig: any;
    tokenizer: Tokenizer;
    ort: typeof Ort;
}

export interface Adapter {
    /** One small run on a new WebGPU session: it compiles the shaders, and fails where the model cannot run. */
    warm(s: Session): Promise<unknown>;
    run(s: Session, inputs: any[]): Promise<unknown[]>;
    /** Work ahead of a run (tokenizing), while the GPU runs the batch before it. */
    prepare?(inputs: any[]): void;
    /** What the page learns about the model, e.g. a classifier's labels. */
    info?: Record<string, unknown>;
}

export interface DecideInput {
    state: string;
    questions: LayaQuestion[];
}

// ------------------------------------------------------------------ helpers

const option = <T>(c: AdapterContext, name: string) => modelOption<T>(c.model, name);
const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

/** int64 tensors of token rows, padded to the longest (ids, attention mask, token types). */
function batch(c: AdapterContext, s: Session, rows: { ids: number[]; types?: number[] }[], pad: number): Record<string, Ort.Tensor> {
    const n = rows.length;
    const L = Math.max(1, ...rows.map((r) => r.ids.length));
    const ids = new BigInt64Array(n * L).fill(BigInt(pad));
    const mask = new BigInt64Array(n * L);
    const types = new BigInt64Array(n * L);
    rows.forEach((r, i) =>
        r.ids.forEach((v, j) => {
            ids[i * L + j] = BigInt(v);
            mask[i * L + j] = 1n;
            types[i * L + j] = BigInt(r.types?.[j] ?? 0);
        }),
    );
    const feeds: Record<string, Ort.Tensor> = { input_ids: new c.ort.Tensor('int64', ids, [n, L]), attention_mask: new c.ort.Tensor('int64', mask, [n, L]) };
    if (s.inputNames.includes('token_type_ids')) feeds.token_type_ids = new c.ort.Tensor('int64', types, [n, L]);
    return feeds;
}

function padId(c: AdapterContext): number {
    const t = c.tokenizer;
    const named = typeof c.tokenizerConfig?.pad_token === 'string' ? t.token_to_id(c.tokenizerConfig.pad_token) : undefined;
    return named ?? c.config?.pad_token_id ?? t.token_to_id('[PAD]') ?? t.token_to_id('<pad>') ?? 0;
}

/**
 * A text (and a second one) as token ids of at most `max`: the first text is
 * cut at its end, like truncation to the model's length in Transformers.
 */
function encodeFit(c: AdapterContext, text: string, pair: string | null, max: number): { ids: number[]; types?: number[] } {
    let t = text;
    for (let i = 0; i < 12; i++) {
        const e = c.tokenizer.encode(t, { text_pair: pair, return_token_type_ids: true });
        if (e.ids.length <= max) return { ids: e.ids, types: e.token_type_ids };
        if (!t) return { ids: e.ids.slice(0, max), types: e.token_type_ids?.slice(0, max) };
        t = t.slice(0, Math.floor((t.length * max) / e.ids.length * 0.9));
    }
    const e = c.tokenizer.encode(t, { text_pair: pair, return_token_type_ids: true });
    return { ids: e.ids.slice(0, max), types: e.token_type_ids?.slice(0, max) };
}

/** Labels in output order: the setting, else id2label of config.json. */
function labelsOf(c: AdapterContext): string[] {
    const set = String(option<string>(c, 'labels') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (set.length) return set;
    const map = c.config?.id2label ?? {};
    return Object.keys(map).sort((a, b) => Number(a) - Number(b)).map((k) => String(map[k]));
}

function logitsOf(s: Session, out: Ort.InferenceSession.ReturnType): Ort.Tensor {
    return (out.logits ?? out[s.outputNames[0]]) as Ort.Tensor;
}

/** Values `from`..`to` of a tensor as float32 (float16 outputs are converted). */
function floats(t: Ort.Tensor, from = 0, to = t.size): Float32Array {
    if (t.type !== 'float16') return (t.data as Float32Array).slice(from, to);
    const h = (t.data as Uint16Array).subarray(from, to);
    const out = new Float32Array(h.length);
    for (let i = 0; i < h.length; i++) {
        const e = (h[i] >> 10) & 0x1f;
        const f = h[i] & 0x3ff;
        const v = e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15);
        out[i] = h[i] & 0x8000 ? -v : v;
    }
    return out;
}

function dispose(out: Ort.InferenceSession.ReturnType) {
    for (const t of Object.values(out)) (t as Ort.Tensor).dispose?.();
}

/** A state of the Ask runner (JSON of facts and context) as plain sentences, for NLI premises. */
function premiseOf(state: string): string {
    try {
        const o = JSON.parse(state);
        return Object.entries(o).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}.`).join(' ');
    } catch {
        return state;
    }
}

// --------------------------------------------------------------- the kinds

/** Laya: typed questions scored at [MASK] markers in one encoder pass (see laya.ts). */
function laya(c: AdapterContext): Adapter {
    const cfg = c.config ?? {};
    const config: LayaConfig = {
        max_len: cfg.max_len ?? 512,
        head_max_len: cfg.head_max_len ?? 192,
        temperature: cfg.temperature ?? [1, 1, 1],
        temperature_by_options: cfg.temperature_by_options ?? {},
    };
    const id = (name: string, fallback?: number) => {
        const v = typeof fallback === 'number' ? fallback : c.tokenizer.token_to_id(name);
        if (v === undefined) throw new Error(`The tokenizer has no ${name} token.`);
        return v;
    };
    const ids: SpecialIds = { cls: id('[CLS]', cfg.cls), sep: id('[SEP]', cfg.sep), pad: id('[PAD]', cfg.pad), mask: id('[MASK]', cfg.mask), maskToken: cfg.mask_token ?? '[MASK]' };
    const cache = new Map<string, number[]>();
    const encode = (text: string) => {
        let t = cache.get(text);
        if (t) cache.delete(text);
        else t = c.tokenizer.encode(text, { add_special_tokens: false }).ids;
        cache.set(text, t);
        if (cache.size > 2048) cache.delete(cache.keys().next().value!);
        return t;
    };
    const rows = (items: DecideInput[]) => items.flatMap((it) => it.questions.map((q) => ({ ...buildSequence(encode, ids, q, it.state, config.max_len, config.head_max_len), q })));
    const run = async (s: Session, items: DecideInput[]) => {
        const r = rows(items);
        const n = r.length;
        const K = Math.max(2, ...r.map((x) => x.markers.length));
        const feeds = batch(c, s, r, ids.pad);
        const pos = new BigInt64Array(n * K);
        const mask = new Uint8Array(n * K);
        const qtype = new BigInt64Array(n);
        r.forEach((x, i) => {
            x.markers.forEach((m, j) => {
                pos[i * K + j] = BigInt(m);
                mask[i * K + j] = 1;
            });
            qtype[i] = BigInt(QTYPE_INDEX[x.q.type]);
        });
        feeds.marker_pos = new c.ort.Tensor('int64', pos, [n, K]);
        feeds.marker_mask = new c.ort.Tensor('bool', mask, [n, K]);
        feeds.qtype = new c.ort.Tensor('int64', qtype, [n]);
        const out = await s.run(feeds, ['logits']);
        const data = floats(out.logits);
        const probs = r.map((x, i) => calibrate(Array.from(data.subarray(i * K, i * K + x.markers.length)), x.q.type, config));
        dispose(out);
        let k = 0;
        return items.map((it) => it.questions.map(() => probs[k++]));
    };
    return {
        warm: (s) => run(s, [{ state: '{"ready": true}', questions: [{ type: 'noul', instructions: 'Is it ready?' }] }]),
        run,
        prepare: (items: DecideInput[]) => void rows(items),
    };
}

/**
 * Zero-shot NLI: the facts and context are the premise, each option a
 * hypothesis. Choice: a softmax over the options' entailment logits; yes /
 * no: entailment against contradiction of the question as a statement.
 */
function nli(c: AdapterContext): Adapter {
    const labels = labelsOf(c).map((l) => l.toLowerCase());
    const find = (name: string) => labels.findIndex((l) => l.startsWith(String(option<string>(c, name)).toLowerCase()));
    const entail = find('entailment');
    const contra = find('contradiction');
    if (entail < 0 || contra < 0) throw new Error(`config.json of an NLI model needs entailment and contradiction labels (found: ${labels.join(', ') || 'none'}).`);
    const max = option<number>(c, 'maxLength');
    const template = String(option<string>(c, 'hypothesis'));
    const pad = padId(c);
    const run = async (s: Session, items: DecideInput[]) => {
        const pairs: { premise: string; hypothesis: string }[] = [];
        const plan = items.map((it) => {
            const premise = premiseOf(it.state);
            return it.questions.map((q) => {
                const from = pairs.length;
                if (q.type === 'noul') pairs.push({ premise, hypothesis: q.instructions });
                else {
                    const crit = (Array.isArray(q.criteria) ? Object.fromEntries(q.criteria.map((x) => [x, null])) : q.criteria ?? {}) as Record<string, string | null>;
                    for (const [value, text] of Object.entries(crit)) pairs.push({ premise, hypothesis: template.replace('{question}', q.instructions).replace('{option}', text || value) });
                }
                return { q, from, to: pairs.length };
            });
        });
        const out = await s.run(batch(c, s, pairs.map((p) => encodeFit(c, p.premise, p.hypothesis, max)), pad));
        const t = logitsOf(s, out);
        const W = t.dims[1];
        const data = floats(t);
        const at = (row: number, col: number) => data[row * W + col];
        const res = plan.map((qs) =>
            qs.map(({ q, from, to }) => {
                if (q.type === 'noul') {
                    const [no, yes] = softmax([at(from, contra), at(from, entail)]);
                    return [no, yes];
                }
                const scores: number[] = [];
                for (let r = from; r < to; r++) scores.push(at(r, entail));
                return softmax(scores);
            }),
        );
        dispose(out);
        return res;
    };
    return { warm: (s) => run(s, [{ state: '{"sky": "blue"}', questions: [{ type: 'noul', instructions: 'The sky is blue.' }] }]), run, info: { labels } };
}

/** Sentence embeddings: pooled token states (or the model's own sentence_embedding), normalized. */
function embedding(c: AdapterContext): Adapter {
    const max = option<number>(c, 'maxLength');
    const pooling = option<string>(c, 'pooling');
    const dims = option<number>(c, 'dims');
    const pad = padId(c);
    const run = async (s: Session, inputs: { text: string; kind: 'query' | 'passage' }[]) => {
        const rows = inputs.map((x) => encodeFit(c, String(option<string>(c, x.kind === 'query' ? 'queryPrefix' : 'passagePrefix') ?? '') + x.text, null, max));
        const feeds = batch(c, s, rows, pad);
        const mask = feeds.attention_mask.data as BigInt64Array;
        const out = await s.run(feeds);
        const t = (pooling === 'output' && out.sentence_embedding ? out.sentence_embedding : out.last_hidden_state ?? out[s.outputNames[0]]) as Ort.Tensor;
        const data = floats(t);
        const n = rows.length;
        const vectors: Float32Array[] = [];
        if (t.dims.length === 2) for (let i = 0; i < n; i++) vectors.push(data.slice(i * t.dims[1], (i + 1) * t.dims[1]));
        else {
            const [, L, H] = t.dims;
            for (let i = 0; i < n; i++) {
                const v = new Float32Array(H);
                if (pooling === 'cls') v.set(data.subarray(i * L * H, i * L * H + H));
                else {
                    let count = 0;
                    for (let j = 0; j < L; j++) {
                        if (!mask[i * L + j]) continue;
                        count++;
                        for (let k = 0; k < H; k++) v[k] += data[(i * L + j) * H + k];
                    }
                    for (let k = 0; k < H; k++) v[k] /= Math.max(1, count);
                }
                vectors.push(v);
            }
        }
        dispose(out);
        return vectors.map((v) => {
            const cut = dims > 0 && dims < v.length ? v.slice(0, dims) : v;
            const norm = Math.hypot(...cut) || 1;
            for (let k = 0; k < cut.length; k++) cut[k] /= norm;
            return cut;
        });
    };
    return { warm: (s) => run(s, [{ text: 'warm up', kind: 'query' }]), run };
}

/** Sequence classification: the probability of each label (sigmoid for multi-label models). */
function classifier(c: AdapterContext): Adapter {
    const labels = labelsOf(c);
    const max = option<number>(c, 'maxLength');
    const multi = c.config?.problem_type === 'multi_label_classification';
    const pad = padId(c);
    const run = async (s: Session, inputs: { text: string }[]) => {
        const out = await s.run(batch(c, s, inputs.map((x) => encodeFit(c, x.text, null, max)), pad));
        const t = logitsOf(s, out);
        const W = t.dims[t.dims.length - 1];
        const data = floats(t);
        const res = inputs.map((_, i) => {
            const z = Array.from(data.subarray(i * W, (i + 1) * W));
            const probs = multi ? z.map((v) => 1 / (1 + Math.exp(-v))) : softmax(z);
            return { labels: z.map((_, j) => labels[j] ?? `LABEL_${j}`), probs };
        });
        dispose(out);
        return res;
    };
    return { warm: (s) => run(s, [{ text: 'warm up' }]), run, info: { labels } };
}

/**
 * Causal language model: the prompt runs once, then one token per step with
 * the model's key/value cache (past_key_values in, present out; an empty
 * cache first). Greedy at temperature 0, else sampled from the 40 likeliest.
 */
function causalLm(c: AdapterContext): Adapter {
    const cfg = c.config ?? {};
    const window = option<number>(c, 'maxLength');
    const prompt = unescape(String(option<string>(c, 'prompt') || '{input}'));
    const stops = unescape(String(option<string>(c, 'stop') ?? '')).split('|').filter(Boolean);
    const eos = new Set<number>([cfg.eos_token_id ?? []].flat().filter((x: unknown): x is number => typeof x === 'number'));
    const eosName = typeof c.tokenizerConfig?.eos_token === 'string' ? c.tokenizerConfig.eos_token : c.tokenizerConfig?.eos_token?.content;
    const named = eosName ? c.tokenizer.token_to_id(eosName) : undefined;
    if (named !== undefined) eos.add(named);

    /** Empty past_key_values inputs, shaped from the session's metadata (and config.json where it is symbolic). */
    const emptyPast = (s: Session) => {
        const feeds: Record<string, Ort.Tensor> = {};
        const heads = cfg.num_key_value_heads ?? cfg.num_attention_heads ?? cfg.n_head;
        const headDim = cfg.head_dim ?? (cfg.hidden_size ?? cfg.n_embd) / (cfg.num_attention_heads ?? cfg.n_head);
        for (const m of s.inputMetadata) {
            if (!m.isTensor || !/^past/.test(m.name)) continue;
            const dims = m.shape.map((d, i) => (typeof d === 'number' ? d : i === 0 ? 1 : i === 1 ? heads : i === m.shape.length - 1 ? headDim : 0));
            if (dims.some((d) => !Number.isInteger(d))) throw new Error(`Cannot shape ${m.name}: config.json needs num_attention_heads and hidden_size.`);
            feeds[m.name] = new c.ort.Tensor(m.type as any, m.type === 'float16' ? new Uint16Array(0) : new Float32Array(0), dims);
        }
        return feeds;
    };

    const pick = (logits: Float32Array, temperature: number) => {
        let best = 0;
        for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
        if (temperature <= 0) return best;
        const top = Array.from(logits.keys()).sort((a, b) => logits[b] - logits[a]).slice(0, 40);
        const p = softmax(top.map((i) => logits[i] / temperature));
        let r = Math.random();
        for (let i = 0; i < top.length; i++) if ((r -= p[i]) <= 0) return top[i];
        return best;
    };

    const generate = async (s: Session, x: { prompt: string; maxTokens: number; temperature: number }) => {
        const maxTokens = Math.max(1, Math.min(512, x.maxTokens | 0));
        let ids = c.tokenizer.encode(prompt.replace('{input}', x.prompt)).ids;
        // Keep the end of a long prompt (the newest lines of a dialogue).
        if (ids.length + maxTokens > window) ids = ids.slice(-Math.max(1, window - maxTokens));
        const names = s.inputNames;
        // Without cache inputs the whole sequence runs again at every step.
        const cached = names.some((n) => /^past/.test(n));
        let past = emptyPast(s);
        let step = ids;
        let pos = 0;
        const out: number[] = [];
        let text = '';
        for (let n = 0; n < maxTokens; n++) {
            const feeds: Record<string, Ort.Tensor> = {
                ...past,
                input_ids: new c.ort.Tensor('int64', BigInt64Array.from(step, BigInt), [1, step.length]),
                attention_mask: new c.ort.Tensor('int64', new BigInt64Array(pos + step.length).fill(1n), [1, pos + step.length]),
            };
            if (names.includes('position_ids')) feeds.position_ids = new c.ort.Tensor('int64', BigInt64Array.from(step, (_, i) => BigInt(pos + i)), [1, step.length]);
            if (names.includes('use_cache_branch')) feeds.use_cache_branch = new c.ort.Tensor('bool', new Uint8Array([n > 0 ? 1 : 0]), [1]);
            const res = await s.run(feeds);
            const logits = logitsOf(s, res);
            const V = logits.dims[logits.dims.length - 1];
            const last = floats(logits, (step.length - 1) * V, step.length * V);
            for (const t of Object.values(past)) t.dispose?.();
            past = {};
            for (const name of Object.keys(feeds)) if (/^past/.test(name)) past[name] = res[name.replace(/^past_key_values|^past/, 'present')] as Ort.Tensor;
            logits.dispose?.();
            const next = pick(last, x.temperature);
            if (eos.has(next)) break;
            out.push(next);
            text = c.tokenizer.decode(out, { skip_special_tokens: true });
            if (stops.some((st) => text.includes(st))) break;
            if (cached) {
                pos += step.length;
                step = [next];
            } else step = [...step, next];
            if (pos + step.length >= window) break;
        }
        for (const t of Object.values(past)) t.dispose?.();
        let cut = text.length;
        for (const st of stops) {
            const i = text.indexOf(st);
            if (i >= 0 && i < cut) cut = i;
        }
        return { text: text.slice(0, cut).trim() };
    };
    return {
        warm: (s) => generate(s, { prompt: 'Hello', maxTokens: 1, temperature: 0 }),
        run: async (s, inputs) => {
            const res: unknown[] = [];
            for (const x of inputs) res.push(await generate(s, x));
            return res;
        },
    };
}

export const ADAPTERS: Record<string, (c: AdapterContext) => Adapter> = {
    laya,
    nli,
    embedding,
    classifier,
    'causal-lm': causalLm,
};

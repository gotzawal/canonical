// Ask: turns an Ask task or service into a job for its decide model (Laya,
// or a zero-shot NLI model) and writes the answers back under the rules:
//
// - Probability keys are asked as Noul (P(true) is written), enum keys as a
//   Choice between their values (the value descriptions are the options),
//   string keys as a Choice between memory items (the item id is written).
// - Every request of an Ask gets a number; only the newest one's answers
//   are written (older ones are "superseded").
// - An answer less confident than the Ask's minimum keeps the previous
//   value; a value is not changed before its minimum hold time.
// - Without a model nothing is written: the keys keep the schema defaults.
//
// Answers arrive between ticks and are applied in the agent phase of a frame
// (AgentSystem.poster), never in the middle of a script or a tick.

import { DEFAULT_DECIDE_MODEL } from '../../core/behavior/models';
import { CONTEXT_PLACEHOLDER } from '../../core/behavior/validate';
import type {
    AskOutcome, AskServiceDoc, AskTaskDoc, BlackboardKeyDoc, BlackboardValue, DecisionLogEntry, DecisionQuestion,
} from '../../core/types';
import type { Agent, AgentSystem } from './agents';
import type { RuntimeValue } from './blackboard';
import { plainValue } from './blackboard';
import type { ContextPool } from './context';
import { hashText, pyJson, type LayaQuestion } from './laya';
import type { JobResult } from './scheduler';
import type { AskHandle } from './tree';

type AskDoc = AskTaskDoc | AskServiceDoc;

interface Plan {
    key: BlackboardKeyDoc;
    format: 'noul' | 'choice';
    text: string;
    options: { value: string; text: string }[] | null;
}

export const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Options in the order an object with their values as keys lists them
 * (integer-like values first, ascending): the order the model scores them
 * in, since a question passes its options as such an object. The answers
 * are mapped back in the same order.
 */
function keyOrder<T extends { value: string }>(options: T[]): T[] {
    return Object.keys(Object.fromEntries(options.map((o) => [o.value, 0]))).map((v) => options.find((o) => o.value === v)!);
}

/** Characters of the context pool an Ask shows its model (about 400 tokens, within Laya's 512). */
const CONTEXT_CHARS = 1500;

/** "{key}" replaced with the blackboard value (objects by name), "{context}" with the context pool, "{context:slot}" with one slot. */
export function fillTemplate(text: string, get: (key: string) => RuntimeValue | undefined, pool?: ContextPool | null): string {
    return text.replace(/\{([^{}]+)\}/g, (_m, raw: string) => {
        const name = raw.trim();
        const ctx = CONTEXT_PLACEHOLDER.exec(name);
        if (ctx) return pool?.text(ctx[1]) ?? '';
        const v = plainValue(get(name));
        return v === null ? '' : String(v);
    });
}

/** The start of a decision log entry (the questions and the model's details come later). */
export function logEntry(agent: Agent, node: string, seq: number, started: { time: number; frame: number; at: string }, facts: Record<string, BlackboardValue>, context: string[], result: JobResult): DecisionLogEntry {
    return {
        time: round4(started.time),
        frame: started.frame,
        at: started.at,
        agent: agent.id,
        agentName: agent.name,
        tree: agent.treeDoc.id,
        treeVersion: agent.treeDoc.version,
        node,
        seq,
        facts,
        context,
        questions: [],
        provider: result.provider,
        model: result.model,
        cache: result.cache,
        latency: Math.round(result.latency),
        label: null,
    };
}

export class AskRunner {
    constructor(private sys: AgentSystem) {}

    request(agent: Agent, doc: AskDoc, isTask: boolean): AskHandle {
        const handle: AskHandle = { done: false, ok: false };
        const seq = agent.nextSeq(doc.id);
        const started = { time: this.sys.time, frame: this.sys.frameNumber, at: new Date().toISOString() };
        const bb = agent.blackboard;
        const get = (k: string) => bb.get(k);
        const plans: Plan[] = [];
        for (const q of doc.questions) {
            const key = bb.key(q.key);
            if (!key || key.owner !== 'ai') {
                agent.warn(doc.id, `Ask "${doc.id}": "${q.key}" is not an AI key of the blackboard, so it is not asked.`);
                continue;
            }
            const text = fillTemplate(q.text, get, agent.context);
            if (key.type === 'probability') plans.push({ key, format: 'noul', text, options: null });
            else if (key.type === 'enum' && doc.choices !== 'memory') plans.push({ key, format: 'choice', text, options: keyOrder((key.values ?? []).map((v) => ({ value: v.value, text: v.description }))) });
            else if (key.type === 'string' && doc.choices === 'memory') plans.push({ key, format: 'choice', text, options: null });
            else agent.warn(doc.id, `Ask "${doc.id}": the ${key.type} key "${key.name}" cannot be asked${key.type === 'string' ? ' without memory choices' : ''}.`);
        }
        if (!plans.length) {
            handle.done = true;
            return handle;
        }
        const model = doc.model || DEFAULT_DECIDE_MODEL;
        const facts = bb.snapshot(doc.facts);
        const pool = doc.context ? agent.context : null;
        // The newest part of the pool: a long dialogue must not push its last lines out of the model's window.
        const context = { text: pool?.text(undefined, CONTEXT_CHARS) ?? '', sources: pool?.sources() ?? [], vector: pool?.vector() ?? null };
        // Results come back in a later frame; a result for an agent that is gone is dropped.
        const post = this.sys.poster();
        const finish = (result: JobResult) => {
            if (!agent.removed) this.apply(agent, doc, isTask, seq, plans, facts, context.sources, started, result, handle);
        };
        const scheduler = this.sys.scheduler;
        const none = (provider: string): JobResult => ({ output: null, outcome: 'unavailable', cache: 'none', provider, model, latency: 0 });
        if (!scheduler || !scheduler.ready(model)) {
            finish(none(scheduler?.providerName(model) ?? 'none'));
            return handle;
        }
        const submit = () => {
            if (plans.some((p) => p.format === 'choice' && (p.options?.length ?? 0) < 2)) {
                agent.warn(doc.id, `Ask "${doc.id}": fewer than two options to choose from, so it is not asked.`);
                finish(none(scheduler.providerName(model)));
                return;
            }
            const state: Record<string, unknown> = { ...facts };
            if (context.text) state.context = context.text;
            const stateText = pyJson(state);
            const questions: LayaQuestion[] = plans.map((p) =>
                p.format === 'noul'
                    ? { type: 'noul', instructions: p.text }
                    : { type: 'choice', instructions: p.text, criteria: Object.fromEntries(p.options!.map((o) => [o.value, o.text.trim() || null])) },
            );
            const qText = pyJson(questions);
            void scheduler
                .submit({
                    model,
                    group: `${agent.id}/${doc.id}`,
                    key: hashText(`${model}\u0000${stateText}\u0000${qText}`),
                    semanticKey: hashText(`${model}\u0000${pyJson(facts)}\u0000${qText}`),
                    contextVector: context.vector,
                    input: { state: stateText, questions },
                    size: questions.length,
                    priority: () => agent.priority(doc.priority),
                })
                .then((result) => post(() => finish(result)));
        };
        // Choices from memory get their options (the best matching items) first.
        const fromMemory = plans.filter((p) => p.format === 'choice' && !p.options);
        if (fromMemory.length) {
            void this.memoryOptions(agent, doc).then((options) => {
                post(() => {
                    if (agent.removed) return;
                    for (const p of fromMemory) p.options = keyOrder(options);
                    submit();
                });
            });
        } else submit();
        return handle;
    }

    /** Memory items offered as the options of a Choice from memory. */
    private async memoryOptions(agent: Agent, doc: AskDoc): Promise<{ value: string; text: string }[]> {
        const memory = this.sys.memory;
        if (!memory) return [];
        const text = fillTemplate(doc.memoryQuery || doc.questions[0]?.text || '', (k) => agent.blackboard.get(k), agent.context);
        const vector = memory.embedded ? await this.sys.embed(text, 'query') : null;
        return memory.search({ vector, text }, doc.memoryTags, doc.memoryCount).map((h) => ({ value: h.entry.id, text: h.entry.text }));
    }

    private apply(
        agent: Agent,
        doc: AskDoc,
        isTask: boolean,
        seq: number,
        plans: Plan[],
        facts: Record<string, BlackboardValue>,
        context: string[],
        started: { time: number; frame: number; at: string },
        result: JobResult,
        handle: AskHandle,
    ) {
        const bb = agent.blackboard;
        const now = this.sys.time;
        const newest = agent.latestSeq(doc.id);
        const source = `${result.provider}${result.cache !== 'none' ? ` (${result.cache} cache)` : ''}`;
        const all = Array.isArray(result.output) ? (result.output as number[][]) : null;
        const questions: DecisionQuestion[] = plans.map((p, i) => {
            const probs = all?.[i] ?? null;
            let value: BlackboardValue = null;
            let confidence: number | null = null;
            if (probs && probs.length) {
                if (p.format === 'noul') {
                    value = round4(probs[1] ?? 0);
                    confidence = round4(Math.max(probs[0] ?? 0, probs[1] ?? 0));
                } else {
                    let best = 0;
                    for (let j = 1; j < probs.length; j++) if (probs[j] > probs[best]) best = j;
                    value = p.options![best]?.value ?? null;
                    confidence = round4(probs[best]);
                }
            }
            let outcome: AskOutcome;
            if (!probs || value === null || confidence === null) outcome = result.outcome ?? 'unavailable';
            // The model stopped (device lost): its keys stay at their defaults for the rest of the session.
            else if (this.sys.modelLost) outcome = 'unavailable';
            else if (seq < newest) outcome = 'superseded';
            else if (confidence < doc.minConfidence) outcome = 'low_confidence';
            else {
                const meta = bb.answer(p.key.name);
                const current = bb.plain(p.key.name);
                // The hold counts from the last change of the value, not from the last answer.
                if (meta && doc.minHold > 0 && now - meta.since < doc.minHold && current !== value) outcome = 'held';
                else {
                    try {
                        bb.write(p.key.name, value, 'ai', { confidence, source, at: now, node: doc.id, seq });
                        outcome = 'written';
                    } catch (e: any) {
                        agent.warn(doc.id, e?.message || String(e));
                        outcome = 'unavailable';
                    }
                }
            }
            const q: DecisionQuestion = { key: p.key.name, format: p.format, text: p.text, probabilities: probs ? probs.map(round4) : null, value, confidence, outcome };
            if (p.options) q.options = p.options.map((o) => ({ value: o.value, text: o.text }));
            return q;
        });
        handle.done = true;
        handle.ok = questions.every((q) => q.outcome === 'written');
        const entry = logEntry(agent, doc.id, seq, started, facts, context, result);
        entry.questions = questions;
        this.sys.log.add(entry);
        if (isTask && !handle.ok && entry.questions.some((q) => q.outcome === 'unavailable')) {
            agent.warn(doc.id, `Ask task "${doc.id}" failed: the decide model "${result.model}" is not available, so its keys keep their defaults.`);
        }
    }
}

// Ask: turns an Ask task or service into a request for the decision model
// and writes the answers back under the rules:
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
// (AgentSystem.post), never in the middle of a script or a tick.

import type {
    AskOutcome, AskServiceDoc, AskTaskDoc, BlackboardKeyDoc, BlackboardValue, DecisionLogEntry, DecisionQuestion,
} from '../../core/types';
import type { Agent, AgentSystem } from './agents';
import type { RuntimeValue } from './blackboard';
import { plainValue } from './blackboard';
import { hashText, pyJson, type LayaQuestion } from './laya';
import type { RecallContext } from './memory';
import type { AskResult } from './scheduler';
import type { AskHandle } from './tree';

type AskDoc = AskTaskDoc | AskServiceDoc;

interface Plan {
    key: BlackboardKeyDoc;
    format: 'noul' | 'choice';
    text: string;
    options: { value: string; text: string }[] | null;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** "{key}" replaced with the blackboard value (objects by name). */
export function fillTemplate(text: string, get: (key: string) => RuntimeValue | undefined): string {
    return text.replace(/\{([^{}]+)\}/g, (_m, name: string) => {
        const v = plainValue(get(name.trim()));
        return v === null ? '' : String(v);
    });
}

export class AskRunner {
    constructor(private sys: AgentSystem) {}

    request(agent: Agent, doc: AskDoc, isTask: boolean): AskHandle {
        const handle: AskHandle = { done: false, ok: false };
        const seq = agent.nextSeq(doc.id);
        const started = { time: this.sys.time, frame: this.sys.frameNumber, at: new Date().toISOString() };
        const bb = agent.blackboard;
        const plans: Plan[] = [];
        for (const q of doc.questions) {
            const key = bb.key(q.key);
            if (!key || key.owner !== 'ai') {
                agent.warn(doc.id, `Ask "${doc.id}": "${q.key}" is not an AI key of the blackboard, so it is not asked.`);
                continue;
            }
            if (key.type === 'probability') plans.push({ key, format: 'noul', text: q.text, options: null });
            else if (key.type === 'enum' && doc.choices !== 'memory') plans.push({ key, format: 'choice', text: q.text, options: (key.values ?? []).map((v) => ({ value: v.value, text: v.description })) });
            else if (key.type === 'string' && doc.choices === 'memory') plans.push({ key, format: 'choice', text: q.text, options: null });
            else agent.warn(doc.id, `Ask "${doc.id}": the ${key.type} key "${key.name}" cannot be asked${key.type === 'string' ? ' without memory choices' : ''}.`);
        }
        if (!plans.length) {
            handle.done = true;
            return handle;
        }
        const facts = bb.snapshot(doc.facts);
        const context = doc.context ? agent.context : null;
        const finish = (result: AskResult) => this.apply(agent, doc, isTask, seq, plans, facts, context, started, result, handle);
        const scheduler = this.sys.scheduler;
        if (!scheduler || !scheduler.ready) {
            finish({ probabilities: null, outcome: 'unavailable', cache: 'none', provider: scheduler?.providerName ?? 'none', model: '', latency: 0 });
            return handle;
        }
        const submit = () => {
            if (plans.some((p) => p.format === 'choice' && (p.options?.length ?? 0) < 2)) {
                agent.warn(doc.id, `Ask "${doc.id}": fewer than two options to choose from, so it is not asked.`);
                finish({ probabilities: null, outcome: 'unavailable', cache: 'none', provider: scheduler.providerName, model: '', latency: 0 });
                return;
            }
            const state: Record<string, unknown> = { ...facts };
            if (context?.text) state.context = context.text;
            const stateText = pyJson(state);
            const questions: LayaQuestion[] = plans.map((p) =>
                p.format === 'noul'
                    ? { type: 'noul', instructions: p.text }
                    : { type: 'choice', instructions: p.text, criteria: Object.fromEntries(p.options!.map((o) => [o.value, o.text.trim() || null])) },
            );
            const qText = pyJson(questions);
            void scheduler
                .submit({
                    group: `${agent.id}/${doc.id}`,
                    key: hashText(`${stateText}\u0000${qText}`),
                    semanticKey: hashText(`${pyJson(facts)}\u0000${qText}`),
                    contextVector: context?.vector ?? null,
                    state: stateText,
                    questions,
                    priority: () => agent.priority(doc.priority),
                })
                .then((result) => this.sys.post(() => finish(result)));
        };
        if (plans.some((p) => !p.options)) {
            void this.memoryOptions(agent, doc).then((options) => {
                this.sys.post(() => {
                    for (const p of plans) if (!p.options) p.options = options;
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
        const text = fillTemplate(doc.memoryQuery || doc.questions[0]?.text || '', (k) => agent.blackboard.get(k));
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
        context: RecallContext | null,
        started: { time: number; frame: number; at: string },
        result: AskResult,
        handle: AskHandle,
    ) {
        const bb = agent.blackboard;
        const now = this.sys.time;
        const newest = agent.latestSeq(doc.id);
        const source = `${result.provider}${result.cache !== 'none' ? ` (${result.cache} cache)` : ''}`;
        const questions: DecisionQuestion[] = plans.map((p, i) => {
            const probs = result.probabilities?.[i] ?? null;
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
            else if (seq < newest) outcome = 'superseded';
            else if (confidence < doc.minConfidence) outcome = 'low_confidence';
            else {
                const meta = bb.answer(p.key.name);
                const current = bb.plain(p.key.name);
                if (meta && doc.minHold > 0 && now - meta.at < doc.minHold && current !== value) outcome = 'held';
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
        const entry: DecisionLogEntry = {
            time: round4(started.time),
            frame: started.frame,
            at: started.at,
            agent: agent.id,
            agentName: agent.name,
            tree: agent.treeDoc.id,
            treeVersion: agent.treeDoc.version,
            node: doc.id,
            seq,
            facts,
            context: context?.ids ?? [],
            questions,
            provider: result.provider,
            model: result.model,
            cache: result.cache,
            latency: Math.round(result.latency),
            label: null,
        };
        this.sys.log.add(entry);
        if (isTask && !handle.ok && entry.questions.some((q) => q.outcome === 'unavailable')) {
            agent.warn(doc.id, `Ask task "${doc.id}" failed: no decision model is available, so its keys keep their defaults.`);
        }
    }
}

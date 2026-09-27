// Model task: fills its input template (blackboard values and the context
// pool), runs a classify or generate model through the scheduler (like Ask
// questions: after the engine drew a frame, ranked by distance, within the
// GPU budget) and writes the result to its AI key under the same rules as
// Ask: only the newest request of the node writes, a result less confident
// than the minimum keeps the value, and without a model nothing is written.
// A written result can go on into the context pool as a line of dialogue
// (History) and be spoken.

import { modelTask } from '../../core/behavior/models';
import { CONTEXT_PLACEHOLDER } from '../../core/behavior/validate';
import type { AskOutcome, BlackboardKeyDoc, BlackboardValue, DecisionQuestion, InferTaskDoc } from '../../core/types';
import type { Agent, AgentSystem } from './agents';
import { fillTemplate, logEntry, round4 } from './ask';
import { hashText } from './laya';
import { MAX_BATCH, type JobResult } from './scheduler';

/** A pending Model task as the tree sees it. */
export interface InferHandle {
    done: boolean;
    ok: boolean;
    /** Play time after which the task fails (and a later result is not written). */
    deadline: number;
}

export class InferRunner {
    constructor(private sys: AgentSystem) {}

    request(agent: Agent, doc: InferTaskDoc): InferHandle {
        const handle: InferHandle = { done: false, ok: false, deadline: this.sys.time + doc.timeout };
        const seq = agent.nextSeq(doc.id);
        const started = { time: this.sys.time, frame: this.sys.frameNumber, at: new Date().toISOString() };
        const key = agent.blackboard.key(doc.output);
        const task = modelTask(this.sys.modelDoc(doc.model));
        const input = fillTemplate(doc.input, (k) => agent.blackboard.get(k), agent.context);
        // The slots the input reads ({context} reads them all), for the decision log.
        const slots = Array.from(doc.input.matchAll(/\{([^{}]+)\}/g), (m) => CONTEXT_PLACEHOLDER.exec(m[1].trim())).filter((m) => !!m);
        const sources = slots.length ? agent.context.sources(slots.some((m) => !m![1]) ? undefined : slots.map((m) => m![1])) : [];
        const post = this.sys.poster();
        const finish = (result: JobResult) => {
            if (!agent.removed) this.apply(agent, doc, seq, key!, task === 'generate' ? 'generate' : 'classify', input, sources, started, result, handle);
        };
        const scheduler = this.sys.scheduler;
        const none: JobResult = { output: null, outcome: 'unavailable', cache: 'none', provider: scheduler?.providerName(doc.model) ?? 'none', model: doc.model, latency: 0 };
        if (!key || key.owner !== 'ai') {
            agent.warn(doc.id, `Model task "${doc.id}": "${doc.output}" is not an AI key of the blackboard, so nothing is written.`);
            handle.done = true;
            return handle;
        }
        if (!scheduler || !scheduler.ready(doc.model) || (task !== 'classify' && task !== 'generate')) {
            finish(none);
            return handle;
        }
        const generate = task === 'generate';
        void scheduler
            .submit({
                model: doc.model,
                group: `${agent.id}/${doc.id}`,
                // Sampled text is not cached: the same line may come out differently.
                key: generate && doc.temperature > 0 ? '' : hashText(`${doc.model}\u0000${input}\u0000${generate ? doc.maxTokens : ''}`),
                input: generate ? { prompt: input, maxTokens: doc.maxTokens, temperature: doc.temperature } : { text: input },
                size: generate ? MAX_BATCH : 1,
                priority: () => agent.priority('normal'),
            })
            .then((result) => post(() => finish(result)));
        return handle;
    }

    private apply(
        agent: Agent,
        doc: InferTaskDoc,
        seq: number,
        key: BlackboardKeyDoc,
        format: 'classify' | 'generate',
        input: string,
        sources: string[],
        started: { time: number; frame: number; at: string },
        result: JobResult,
        handle: InferHandle,
    ) {
        const out = result.output as { text?: string; labels?: string[]; probs?: number[] } | null;
        let value: BlackboardValue = null;
        let confidence: number | null = null;
        let probabilities: number[] | null = null;
        let options: { value: string; text: string }[] | undefined;
        if (out && format === 'generate' && typeof out.text === 'string' && out.text) {
            value = out.text;
            confidence = 1;
        } else if (out && format === 'classify' && out.labels && out.probs) {
            probabilities = out.probs.map(round4);
            options = out.labels.map((l) => ({ value: l, text: l }));
            let best = 0;
            for (let j = 1; j < out.probs.length; j++) if (out.probs[j] > out.probs[best]) best = j;
            confidence = round4(out.probs[best]);
            const top = out.labels[best];
            if (key.type === 'probability') {
                const i = doc.label ? out.labels.findIndex((l) => l.toLowerCase() === doc.label.toLowerCase()) : best;
                value = i >= 0 ? round4(out.probs[i]) : null;
                if (i < 0) agent.warn(doc.id, `Model task "${doc.id}": the model has no label "${doc.label}" (labels: ${out.labels.join(', ')}).`);
            } else if (key.type === 'enum') {
                // An enum key takes the label when it names one of its values.
                value = key.values?.find((v) => v.value.toLowerCase() === top.toLowerCase())?.value ?? null;
                if (value === null) agent.warn(doc.id, `Model task "${doc.id}": the label "${top}" is not a value of "${key.name}" (${key.values?.map((v) => v.value).join(', ')}).`);
            } else value = top;
        }
        let outcome: AskOutcome;
        if (value === null) outcome = result.outcome ?? 'unavailable';
        else if (this.sys.modelLost) outcome = 'unavailable';
        else if (this.sys.time > handle.deadline) outcome = 'timeout';
        else if (seq < agent.latestSeq(doc.id)) outcome = 'superseded';
        else if (confidence !== null && confidence < doc.minConfidence) outcome = 'low_confidence';
        else {
            try {
                const source = `${result.provider}${result.cache !== 'none' ? ` (${result.cache} cache)` : ''}`;
                agent.blackboard.write(key.name, value, 'ai', { confidence: confidence ?? 1, source, at: this.sys.time, node: doc.id, seq });
                outcome = 'written';
            } catch (e: any) {
                agent.warn(doc.id, e?.message || String(e));
                outcome = 'unavailable';
            }
        }
        if (outcome === 'written' && typeof value === 'string') {
            if (doc.history) agent.context.add(doc.history, `${agent.name}: ${value}`, doc.id, this.sys.time);
            if (doc.speak) this.sys.host.speak?.(value, agent.obj);
        }
        handle.done = true;
        handle.ok = outcome === 'written';
        const q: DecisionQuestion = { key: key.name, format, text: input.slice(-1000), probabilities, value, confidence, outcome };
        if (options) q.options = options;
        const entry = logEntry(agent, doc.id, seq, started, {}, sources, result);
        entry.questions = [q];
        this.sys.log.add(entry);
    }
}

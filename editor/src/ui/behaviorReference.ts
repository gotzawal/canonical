import {
    COMPARE_OPS, DECORATOR_TYPES, KEY_OWNERS, KEY_TYPES, NODE_TYPES, SERVICE_TYPES, type FieldDef, type ItemTypeDef,
} from '../core/behavior/nodeTypes';
import { OP_DOCS } from '../core/behavior/ops';
import { h } from './dom';
import { dialog } from './overlays';

// Help > Behavior Tree Reference. Generated from the node type definitions
// (core/behavior/nodeTypes.ts), so it lists exactly what the editor, the
// validation and the runtime know.

function table(rows: [string, string][]): HTMLElement {
    return h(
        'table',
        { class: 'reference-table' },
        rows.map(([k, v]) => h('tr', null, h('td', null, h('code', { text: k })), h('td', { text: v }))),
    );
}

function fieldRow(f: FieldDef): [string, string] {
    const parts: string[] = [f.description];
    if (f.choices) parts.push(`One of: ${f.choices.map((c) => c.value).join(', ')}.`);
    if (f.keyOwners) parts.push(`${f.keyOwners.join(' or ')} keys only.`);
    if (f.min !== undefined || f.max !== undefined) parts.push(`Range ${f.min ?? '-'} to ${f.max ?? '-'}.`);
    if (f.whenText) parts.push(`Only when ${f.whenText}.`);
    const d = f.default;
    if (d !== undefined && d !== '' && d !== null && !(Array.isArray(d) && !d.length)) parts.push(`Default ${JSON.stringify(d)}.`);
    return [f.name, parts.join(' ')];
}

function typeSection(def: ItemTypeDef): HTMLElement[] {
    const out: HTMLElement[] = [
        h('h4', null, h('code', { text: def.type }), ` ${def.label}`),
        h('p', { text: `${def.summary} ${def.details}` }),
    ];
    if (def.attachTo) out.push(h('p', { class: 'muted', text: `Attaches to ${def.attachTo.join(' and ')} nodes${def.category === 'decorator' ? ' (not the root)' : ''}.` }));
    if (def.fields.length) out.push(table(def.fields.map(fieldRow)));
    return out;
}

const RULES: [string, string][] = [
    ['Ticks', 'Each agent ticks 10 times a second, spread over the frames. A tick runs between the scripts\' update() and lateUpdate(), after the timers, in play time (pause stops it).'],
    ['Conditions', 'Every tick checks the conditions again; running tasks are not started again. A running branch whose conditions fail is aborted; a higher branch of a Selector whose conditions start to pass aborts the lower one and runs (both are always on).'],
    ['Aborts', 'An aborted script task fires task.signal and calls the script\'s onTaskAbort(task).'],
    ['Services', 'Run only while the node they are attached to is active, every interval with a random jitter. Services of the root run as long as the tree does, also when it starts over.'],
    ['Ask', 'Every request of an Ask gets a number; only the newest request\'s answers are written. Below minConfidence the old value stays; within minHold a value does not change. Without a model nothing is written: the keys keep their defaults, and when the model stops in the middle of a session (its GPU device was lost) the AI keys go back to them. Answers arrive between ticks and are applied at the start of the agent phase.'],
    ['Confidence', 'The probability of the chosen answer; for Noul the likelier of true and false. Conditions can require a minimum.'],
    ['Scheduler', 'Exact cache, semantic cache (same facts, context at least 0.97 similar), joining identical requests, nearest agent first, a GPU budget of 150 ms per second (50 to 400 by the frame time), batches of up to 10 questions after the frame is drawn, one batch at a time, and no answer after 1.5 s in the queue.'],
    ['Recall', 'Memory items with one of the tags, the best k matches of the query, joined in id order within the token budget, become the agent\'s context.'],
    ['Play', 'Trees cannot be edited while playing; the Behavior tab shows the active path and the latest answers instead.'],
];

const SCRIPT_API: [string, string][] = [
    ['this.blackboard', 'The blackboard of this object\'s tree (null without an agent): get(key), set(key, value) for fact keys, version(key), answer(key) for an AI key\'s confidence, source and time, keys.'],
    ['this.getBlackboard(objOrName)', 'Another agent\'s blackboard.'],
    ['methodName(task)', 'A Script task calls it: return true or nothing (success), false (failure), \'running\' (finish later with task.succeed() / task.fail()) or a Promise. task.get(key), task.set(key, value) (tree keys), task.node, task.signal.'],
    ['onTaskAbort(task)', 'A running task of this script was aborted.'],
    ['this.say(text, options?)', 'Speaks a line one sentence at a time; resolves when done. Options: voice, lang, rate, pitch, volume, signal.'],
    ['this.chat(prompt, options?)', 'Asks the language model (OpenRouter, in the editor); resolves with the text.'],
    ['this.remember(text, tags?)', 'Adds a memory for Recall and memory choices for the rest of the session (saveMemories() puts it into a game save).'],
    ['this.memory(id)', 'A memory item by id: { id, text, tags }.'],
    ['this.saveMemories()', 'The memories remembered while playing, as JSON for a game save (with their embeddings).'],
    ['this.loadMemories(saved)', 'Puts saved memories back, replacing the ones remembered so far; returns how many.'],
    ['this.setPlayer(obj?)', 'Agents nearest to this object get answers first (the camera by default).'],
];

export function showBehaviorReference() {
    const body = h(
        'div',
        { class: 'reference' },
        h('p', {
            text: 'Objects run behavior trees in Play mode. A decision model (Laya) only writes blackboard values; the tree decides with the standard rules, so a scene plays with the schema defaults when there is no model. Trees, blackboard schemas, agents and memory change only through edit operations: the Behavior tab and the assistant use the same ones, a batch is applied whole or not at all and is one undo step.',
        }),
        h('h3', { text: 'Blackboard keys' }),
        table(KEY_TYPES.map((k) => [k.type, k.description])),
        h('h4', { text: 'Owners' }),
        table(KEY_OWNERS.map((o) => [o.owner, o.description])),
        h('h3', { text: 'Composites' }),
        ...NODE_TYPES.filter((t) => t.category === 'composite').flatMap(typeSection),
        h('h3', { text: 'Tasks' }),
        ...NODE_TYPES.filter((t) => t.category === 'task').flatMap(typeSection),
        h('h3', { text: 'Decorators' }),
        ...DECORATOR_TYPES.flatMap(typeSection),
        h('h4', { text: 'Condition tests' }),
        table(COMPARE_OPS.map((o) => [`${o.op} (${o.symbol})`, o.description])),
        h('h3', { text: 'Services' }),
        ...SERVICE_TYPES.flatMap(typeSection),
        h('h3', { text: 'How trees run' }),
        table(RULES),
        h('h3', { text: 'Scripts' }),
        table(SCRIPT_API),
        h('h3', { text: 'Edit operations' }),
        h('p', { text: 'The JSON view and the assistant use these; ids are the readable node ids, trees and schemas can be named by id or name.' }),
        table(OP_DOCS.map((o) => [`${o.op}(${o.fields})`, o.description])),
    );
    void dialog('Behavior Tree Reference', body);
}

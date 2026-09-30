import {
    COMPARE_OPS, DECORATOR_TYPES, KEY_OWNERS, KEY_TYPES, NODE_TYPES, SERVICE_TYPES, type FieldDef, type ItemTypeDef,
} from '../core/behavior/nodeTypes';
import { BUILTIN_MODELS, MODEL_KINDS, MODEL_TASKS } from '../core/behavior/models';
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
    ['Parallel', 'Its children run at the same time, so several tasks can run at once; when it ends, the children still running are aborted. With policy first, the other children start over when they finish, until the first one ends.'],
    ['Results', 'Invert and Force Result change the result a node ends with, also when its conditions keep it from running or abort it. A node aborted from above has no result. Repeat and Retry start the next run on the next tick; Time Limit fails a run that takes too long (a Retry then tries again).'],
    ['Senses', 'Sight and Hearing are services: every interval they look or listen once and write fact keys. Sight looks from the eyes within its range and field of view, walls blocking with Line of Sight; Hearing takes the sounds of the last second that carry to the agent (3D sounds, Play Sound, footsteps of walking and running characters, this.noise), halved by walls. Position keys get a marker object where the target was seen or heard.'],
    ['Walking', 'Move To, Wander and Flee walk the agent\'s character; with the level\'s navigation mesh (made when Play starts) on a path around walls, else straight. They fail when the character gets stuck.'],
    ['Services', 'Run only while the node they are attached to is active, every interval with a random jitter. Services of the root run as long as the tree does, also when it starts over.'],
    ['Ask', 'Every request of an Ask gets a number; only the newest request\'s answers are written. Below minConfidence the old value stays; within minHold a value does not change. Without a model nothing is written: the keys keep their defaults, and when the model stops in the middle of a session (its GPU device was lost) the AI keys go back to them. Answers arrive between ticks and are applied at the start of the agent phase.'],
    ['Confidence', 'The probability of the chosen answer; for a yes/no question (a probability key) the likelier of true and false. Conditions can require a minimum.'],
    ['Model tasks', 'Like Ask: only the newest request of the node writes, below minConfidence the old value stays, without a model nothing is written. A result after the task\'s timeout is not written. With History the written text is added to that context slot as "Name: text".'],
    ['Scheduler', 'Every model job of the agents (Ask questions, Model tasks) goes through it: exact cache, semantic cache (same facts, context at least 0.97 similar), joining identical jobs, nearest agent first, a GPU budget of 150 ms per second (50 to 400 by the frame time; models on the CPU are not budgeted), batches of one model of up to 10 units (questions, texts; a generation is a batch by itself) after the frame is drawn, one batch at a time, and no answer after 1.5 s in the queue.'],
    ['Context pool', 'Named slots of text per agent. Recall fills the slot named after the service, Model tasks with History and scripts add lines. An Ask with Use Context sees the whole pool; templates take {context} (every slot) or {context:slot}.'],
    ['Recall', 'Memory items with one of the tags, the best k matches of the query, joined in id order within the token budget, fill the Recall\'s context slot.'],
    ['Play', 'Trees cannot be edited while playing; the Behavior tab shows the active path and the latest answers instead.'],
];

const SCRIPT_API: [string, string][] = [
    ['this.blackboard', 'The blackboard of this object\'s tree (null without an agent): get(key), set(key, value) for fact keys, version(key), answer(key) for an AI key\'s confidence, source and time, keys.'],
    ['this.blackboard.context', 'The agent\'s context pool: add(slot, line) (e.g. add(\'dialogue\', \'Player: Hello\')), set(slot, text), clear(slot?), get(slot?), slots.'],
    ['this.getBlackboard(objOrName)', 'Another agent\'s blackboard.'],
    ['methodName(task)', 'A Script task calls it: return true or nothing (success), false (failure), \'running\' (finish later with task.succeed() / task.fail()) or a Promise. task.get(key), task.set(key, value) (tree keys), task.node, task.signal.'],
    ['onTaskAbort(task)', 'A running task of this script was aborted.'],
    ['this.noise(range, at?)', 'Tells agents with Hearing about a sound that carries range meters from this object (or at), without playing one.'],
    ['this.playSound(name, { at })', 'A sound played at a place is heard by agents with Hearing up to its far distance.'],
    ['this.nav', 'The navigation mesh in Play (null until it is made): path(from, to), randomPoint(center, radius), closest(point).'],
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
            text: 'Objects run behavior trees in Play mode. Models only write blackboard values; the tree decides with the standard rules, so a scene plays with the schema defaults when there is no model. Trees, blackboard schemas, agents, memory and models change only through edit operations: the Behavior tab and the assistant use the same ones, a batch is applied whole or not at all and is one undo step.',
        }),
        h('h3', { text: 'Models' }),
        h('p', { text: `Built in: ${BUILTIN_MODELS.map((m) => `${m.id} (${m.name})`).join(', ')}. A scene adds any small ONNX model of a kind below by the URL of its folder, which holds tokenizer.json, config.json and the ONNX file (or a manifest.json of parts). Files download once into the browser's cache and run in a worker, on a WebGPU device of its own or on the CPU.` }),
        table(MODEL_TASKS.map((t) => [t.task, t.usedBy])),
        table(MODEL_KINDS.map((k) => [k.kind, `${k.label} (${k.task}): ${k.description}${k.options.length ? ` Settings: ${k.options.map((o) => `${o.name} (${o.description})`).join(' ')}` : ''}`])),
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

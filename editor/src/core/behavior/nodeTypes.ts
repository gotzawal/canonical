// Node type definitions: the one place that says what every kind of
// behavior tree item has (fields, defaults, constraints, where it attaches).
// The inspector builds its inputs from these, validate.ts checks against
// them, the assistant's tool descriptions and prompt summary and the
// reference in Help are generated from them. A new kind of node only needs
// an entry here (plus its runtime in play/ai/tree.ts).

import type {
    AskTrigger, BlackboardKeyDoc, BlackboardKeyOwner, BlackboardKeyType, BlackboardValue, CompareOp, EnumValueDoc,
} from '../types';
import type { ModelTask } from './models';

export type FieldKind =
    | 'number'
    | 'integer'
    | 'seconds'
    /** A number in 0..1. */
    | 'unit'
    | 'text'
    /** Text in which {key} is replaced with the blackboard value. */
    | 'template'
    | 'bool'
    /** One of `choices`. */
    | 'choice'
    /** Any number of `choices`. */
    | 'flags'
    /** A key of the tree's schema, limited by keyTypes and keyOwners. */
    | 'key'
    /** A list of such keys. */
    | 'keys'
    /** A value of the type of the key named by the `keyField` field. */
    | 'value'
    | 'tags'
    /** A method name of a script on the agent's object. */
    | 'method'
    /** Ask questions: target key and question text. */
    | 'questions'
    /** A model id (scene or built-in), limited by modelTasks. */
    | 'model';

export interface FieldChoice {
    value: string;
    label: string;
    description?: string;
}

export interface FieldDef {
    name: string;
    kind: FieldKind;
    label: string;
    description: string;
    default: unknown;
    min?: number;
    max?: number;
    choices?: FieldChoice[];
    keyTypes?: BlackboardKeyType[];
    keyOwners?: BlackboardKeyOwner[];
    /** 'value' fields: the field that names the key. */
    keyField?: string;
    /** 'model' fields: what the model must do. */
    modelTasks?: ModelTask[];
    /** Must not be empty. */
    required?: boolean;
    /** The field applies only when this holds (it is hidden and not checked otherwise). */
    when?: (item: any) => boolean;
    /** Words for `when`, for the reference and the tool descriptions. */
    whenText?: string;
}

export type ItemCategory = 'composite' | 'task' | 'decorator' | 'service';

/** Looks up keys of the tree's schema (outline texts need their types). */
export type KeyLookup = (name: string) => BlackboardKeyDoc | undefined;

export interface ItemTypeDef {
    type: string;
    category: ItemCategory;
    label: string;
    icon: string;
    /** What it does, in one line (menus, prompt summary). */
    summary: string;
    /** More about it, for the reference. */
    details: string;
    fields: FieldDef[];
    /** Decorators and services: the kinds of nodes they can be attached to. */
    attachTo?: ('composite' | 'task')[];
    /** The key settings in a few words, for the outline and the outliner rows. */
    brief(item: any, keys: KeyLookup): string;
}

// ------------------------------------------------------------------- keys

export interface KeyTypeInfo {
    type: BlackboardKeyType;
    label: string;
    description: string;
    default: BlackboardValue;
    /** Comparisons a condition may use on keys of this type. */
    ops: CompareOp[];
}

export const KEY_TYPES: KeyTypeInfo[] = [
    { type: 'bool', label: 'Bool', description: 'true or false.', default: false, ops: ['eq', 'ne', 'set'] },
    { type: 'number', label: 'Number', description: 'Any number.', default: 0, ops: ['eq', 'ne', 'ge', 'le', 'set'] },
    { type: 'probability', label: 'Probability', description: 'A number in 0..1. Ask writes it as a Noul (yes / no) answer: P(true).', default: 0, ops: ['eq', 'ne', 'ge', 'le', 'set'] },
    { type: 'enum', label: 'Enum', description: 'One of the listed values. Each value has a short description, which Choice questions show the model as the option.', default: '', ops: ['eq', 'ne', 'set'] },
    { type: 'string', label: 'String', description: 'Text. Ask can write a memory item id into it (Choice from memory).', default: '', ops: ['eq', 'ne', 'set'] },
    { type: 'object', label: 'Object', description: 'A scene object: a node id in the document, the engine object while playing.', default: null, ops: ['eq', 'ne', 'set'] },
];

export function keyTypeInfo(type: BlackboardKeyType): KeyTypeInfo {
    return KEY_TYPES.find((k) => k.type === type) ?? KEY_TYPES[0];
}

export interface OwnerInfo {
    owner: BlackboardKeyOwner;
    label: string;
    description: string;
}

export const KEY_OWNERS: OwnerInfo[] = [
    { owner: 'fact', label: 'Fact (scripts)', description: 'Written by scripts only: what the agent perceives. Prefer categories (near / mid / far); Ask notices a change by the key\'s write version.' },
    { owner: 'ai', label: 'AI (one Ask or Model task)', description: 'Written by exactly one Ask or Model task of the tree, with a confidence, source and time. Until the model answers, the key has its default.' },
    { owner: 'tree', label: 'Tree (Set Key, script tasks)', description: 'Written by the tree: Set Key tasks and script tasks (task.set). Goals such as a move target, or the step of a sequence.' },
];

export const COMPARE_OPS: { op: CompareOp; symbol: string; label: string; description: string }[] = [
    { op: 'eq', symbol: '=', label: 'equals', description: 'The value equals the comparison value.' },
    { op: 'ne', symbol: '!=', label: 'is not', description: 'The value differs from the comparison value.' },
    { op: 'ge', symbol: '>=', label: 'at least', description: 'Numbers and probabilities: the value is at least the comparison value.' },
    { op: 'le', symbol: '<=', label: 'at most', description: 'Numbers and probabilities: the value is at most the comparison value.' },
    {
        op: 'set',
        symbol: 'is set',
        label: 'has a value',
        description: 'An AI key has been answered by the model; a string or object key is not empty; a bool key is true; number and enum keys always have a value.',
    },
];

export function opSymbol(op: CompareOp): string {
    return COMPARE_OPS.find((o) => o.op === op)?.symbol ?? op;
}

/** The default value of a key type, taking an enum's first value. */
export function typeDefault(type: BlackboardKeyType, values?: EnumValueDoc[]): BlackboardValue {
    if (type === 'enum') return values?.[0]?.value ?? '';
    return keyTypeInfo(type).default;
}

/** True when `v` is a valid value of a key. */
export function valueFits(key: Pick<BlackboardKeyDoc, 'type' | 'values'>, v: unknown): boolean {
    switch (key.type) {
        case 'bool':
            return typeof v === 'boolean';
        case 'number':
            return typeof v === 'number' && Number.isFinite(v);
        case 'probability':
            return typeof v === 'number' && v >= 0 && v <= 1;
        case 'enum':
            return typeof v === 'string' && !!key.values?.some((x) => x.value === v);
        case 'string':
            return typeof v === 'string';
        case 'object':
            return v === null || typeof v === 'string';
    }
}

/** A value as the outline and the logs show it. */
export function formatValue(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return /^[\p{L}\p{N}_-]+$/u.test(v) ? v : JSON.stringify(v);
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    return String(v);
}

// ----------------------------------------------------------------- fields

const idPattern = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

/** Readable ids of nodes, services, keys and memory items. */
export function isReadableId(s: unknown): s is string {
    return typeof s === 'string' && s.length > 0 && s.length <= 64 && idPattern.test(s);
}

const PRIORITIES: FieldChoice[] = [
    { value: 'low', label: 'Low' },
    { value: 'normal', label: 'Normal' },
    { value: 'high', label: 'High' },
];

const TRIGGERS: { value: AskTrigger; label: string; description: string }[] = [
    { value: 'activate', label: 'On activate', description: 'when the node it is attached to becomes active' },
    { value: 'facts', label: 'On fact change', description: 'when the write version of one of its facts changes (with Use Context, also when Recall brings other items)' },
    { value: 'interval', label: 'Every interval', description: 'every interval (with the jitter)' },
];

const memoryChoices = (item: any) => item?.choices === 'memory';

/** Fields of the Ask task and the Ask service. */
const ASK_FIELDS: FieldDef[] = [
    { name: 'model', kind: 'model', label: 'Model', description: 'The decide model that answers: Laya, or any zero-shot NLI model added in the Models view. Empty uses laya-en-q4.', default: '', modelTasks: ['decide'] },
    {
        name: 'questions',
        kind: 'questions',
        label: 'Questions',
        description: 'Target AI keys and the question for each. Probability keys are asked as Noul (P(true)), enum keys as Choice between their values, string keys as Choice between memory items (choices = memory).',
        default: [],
        required: true,
    },
    { name: 'facts', kind: 'keys', label: 'Facts', description: 'Fact keys the model sees. Questions that look at the same facts belong in one Ask.', default: [], keyOwners: ['fact'] },
    { name: 'context', kind: 'bool', label: 'Use Context', description: 'Also show the model the agent\'s context pool: what Recall services found, and what scripts and Model tasks added (dialogue lines).', default: false },
    { name: 'minConfidence', kind: 'unit', label: 'Min Confidence', description: 'Answers less confident than this keep the key\'s previous value.', default: 0 },
    { name: 'minHold', kind: 'seconds', label: 'Min Hold', description: 'Seconds a written value stays before another answer may change it.', default: 0, min: 0 },
    { name: 'priority', kind: 'choice', label: 'Priority', description: 'Rank in the request queue, after the distance to the player.', default: 'normal', choices: PRIORITIES },
    {
        name: 'choices',
        kind: 'choice',
        label: 'Choices From',
        description: 'Options of Choice questions: the enum values of the key, or memory items found by a search (for string keys; the chosen item id is written).',
        default: 'enum',
        choices: [
            { value: 'enum', label: 'Enum values' },
            { value: 'memory', label: 'Memory search' },
        ],
    },
    { name: 'memoryQuery', kind: 'template', label: 'Memory Query', description: 'Search text for the memory options; {key} is replaced with the blackboard value. Empty uses the question.', default: '', when: memoryChoices, whenText: 'choices = memory' },
    { name: 'memoryTags', kind: 'tags', label: 'Memory Tags', description: 'Only memory items with one of these tags (empty: all).', default: [], when: memoryChoices, whenText: 'choices = memory' },
    { name: 'memoryCount', kind: 'integer', label: 'Memory Options', description: 'How many memory items to offer as options.', default: 5, min: 2, max: 20, when: memoryChoices, whenText: 'choices = memory' },
];

const intervalField = (d: number): FieldDef => ({ name: 'interval', kind: 'seconds', label: 'Interval', description: 'Seconds between runs while the node it is attached to is active.', default: d, min: 0.1 });
const jitterField: FieldDef = { name: 'jitter', kind: 'unit', label: 'Jitter', description: 'Random deviation of the interval as a fraction (0.2 = plus or minus 20%), so agents do not run in step.', default: 0.2 };

// ------------------------------------------------------------ item types

function questionsBrief(item: any, keys: KeyLookup): string {
    const qs: any[] = Array.isArray(item.questions) ? item.questions : [];
    const parts = qs.map((q) => {
        const k = keys(q?.key);
        const fmt = !k ? '?' : k.type === 'probability' ? 'noul' : 'choice';
        return `${q?.key || '?'} (${fmt})`;
    });
    let s = `-> ${parts.join(', ') || 'no questions'}`;
    if (item.model) s += ` model=${item.model}`;
    if (Array.isArray(item.facts) && item.facts.length) s += ` facts=[${item.facts.join(', ')}]`;
    if (item.context) s += ' +context';
    if (item.choices === 'memory') s += ` from memory "${item.memoryQuery || '(question)'}"${item.memoryTags?.length ? ` tags=[${item.memoryTags.join(', ')}]` : ''} k=${item.memoryCount}`;
    if (item.minConfidence > 0) s += ` min conf ${formatValue(item.minConfidence)}`;
    if (item.minHold > 0) s += ` hold ${formatValue(item.minHold)}s`;
    if (item.priority && item.priority !== 'normal') s += ` ${item.priority} priority`;
    return s;
}

const every = (item: any) => `every ${formatValue(item.interval)}s${item.jitter ? ` ±${Math.round(item.jitter * 100)}%` : ''}`;

export const NODE_TYPES: ItemTypeDef[] = [
    {
        type: 'selector',
        category: 'composite',
        label: 'Selector',
        icon: 'btSelector',
        summary: 'Runs its children in order until one succeeds (priority: first child first). Fails when every child fails.',
        details: 'Use it to switch modes: put the branches in priority order, each with a condition, and a last branch without a condition as the default behavior. A branch higher up takes over as soon as its conditions pass.',
        fields: [],
        brief: () => '',
    },
    {
        type: 'sequence',
        category: 'composite',
        label: 'Sequence',
        icon: 'btSequence',
        summary: 'Runs its children in order until one fails. Succeeds when every child succeeds.',
        details: 'Use it for steps that follow each other. For steps that come back to later, keep the step in an enum key (a task sets it, branches check it with conditions).',
        fields: [],
        brief: () => '',
    },
    {
        type: 'parallel',
        category: 'composite',
        label: 'Parallel',
        icon: 'btParallel',
        summary: 'Runs its children at the same time; the policy says when it ends.',
        details:
            'all: succeeds when every child has succeeded, fails as soon as one fails. one: succeeds as soon as one succeeds, fails when every child has failed. first: the first child is the main one and the Parallel ends with its result; the other children run beside it (starting over when they finish), e.g. Move To while a sequence plays footsteps and looks around. When it ends, the children still running are aborted.',
        fields: [
            {
                name: 'policy',
                kind: 'choice',
                label: 'Policy',
                description: 'When the Parallel ends: all (every child succeeds, or one fails), one (one succeeds, or every child fails), first (with its first child; the others run beside it).',
                default: 'all',
                choices: [
                    { value: 'all', label: 'All succeed', description: 'Succeeds when every child succeeded; fails when one fails.' },
                    { value: 'one', label: 'One succeeds', description: 'Succeeds when one child succeeds; fails when every child failed.' },
                    { value: 'first', label: 'First child decides', description: 'Ends with the first child; the others run beside it, again when they finish.' },
                ],
            },
        ],
        brief: (n) => `policy ${n.policy}`,
    },
    {
        type: 'random',
        category: 'composite',
        label: 'Random Selector',
        icon: 'btRandom',
        summary: 'Tries its children in a random order until one succeeds; fails when every child fails.',
        details: 'For variety: idle actions, barks, patrol targets. The order is drawn anew every time it starts. There is no priority between its children, so a higher branch does not take over from a lower one as in a Selector.',
        fields: [],
        brief: () => '',
    },
    {
        type: 'script',
        category: 'task',
        label: 'Script Task',
        icon: 'script',
        summary: 'Calls a method of a script on the agent\'s object: true or nothing succeeds, false fails, a Promise runs until it settles.',
        details:
            'The method gets a task object: task.get(key), task.set(key, value) for tree keys, task.node, and task.signal, an AbortSignal fired when the task is aborted (the script\'s onTaskAbort(task) is called too). Continuous work (moving, looking, animating) belongs in the script\'s update(): the task only writes the goal. Without the script (or when scripts are paused) the task fails.',
        fields: [
            { name: 'method', kind: 'method', label: 'Method', description: 'Method name, e.g. "nextPatrolPoint".', default: '', required: true },
            { name: 'script', kind: 'text', label: 'Script', description: 'Script file or class name; empty takes the first script on the object that has the method.', default: '' },
        ],
        brief: (n) => `${n.script ? `${n.script}.` : ''}${n.method || '?'}()`,
    },
    {
        type: 'wait',
        category: 'task',
        label: 'Wait',
        icon: 'history',
        summary: 'Waits for some seconds, then succeeds.',
        details: 'The time is play time: it stops while the game is paused.',
        fields: [
            { name: 'seconds', kind: 'seconds', label: 'Seconds', description: 'How long to wait.', default: 1, min: 0 },
            { name: 'deviation', kind: 'seconds', label: 'Deviation', description: 'Random deviation, plus or minus seconds.', default: 0, min: 0 },
        ],
        brief: (n) => `${formatValue(n.seconds)}s${n.deviation ? ` ±${formatValue(n.deviation)}s` : ''}`,
    },
    {
        type: 'move_to',
        category: 'task',
        label: 'Move To',
        icon: 'walk',
        summary: 'Walks the agent\'s character to the object in a key: succeeds on arrival, fails when it gets stuck.',
        details:
            'The agent\'s object needs a Character (Add Component > Character). It walks straight at the target and follows it while it moves; walls make it slide along or stop, and after 2 seconds without getting closer the task fails (a Selector can then try another way). Aborting the task stops the walk. Scripts drive the character the same way with this.character.moveTo(target).',
        fields: [
            { name: 'target', kind: 'key', label: 'Target', description: 'An object key: where to walk.', default: '', keyTypes: ['object'], required: true },
            { name: 'radius', kind: 'number', label: 'Radius', description: 'Arrived this close to the target, meters.', default: 1, min: 0.05 },
            { name: 'run', kind: 'bool', label: 'Run', description: 'Run instead of walking.', default: false },
        ],
        brief: (n) => `${n.target || '?'}${n.run ? ', running' : ''}`,
    },
    {
        type: 'look_at',
        category: 'task',
        label: 'Look At',
        icon: 'eye',
        summary: 'Turns the agent to face the object in a key: succeeds when it faces it, fails without one.',
        details: 'A character turns at its turn rate (it keeps facing there until it walks); another agent\'s object turns at once.',
        fields: [{ name: 'target', kind: 'key', label: 'Target', description: 'An object key: what to face.', default: '', keyTypes: ['object'], required: true }],
        brief: (n) => n.target || '?',
    },
    {
        type: 'wander',
        category: 'task',
        label: 'Wander',
        icon: 'walk',
        summary: 'Walks the agent\'s character to a random point nearby: succeeds on arrival, fails when it gets stuck.',
        details: 'The point is within Radius of the object in Around, else of where the agent stood when Play started. With a navigation mesh it is a reachable point and the character follows a path to it; without one it walks straight.',
        fields: [
            { name: 'radius', kind: 'number', label: 'Radius', description: 'Meters around the center.', default: 6, min: 0.5 },
            { name: 'around', kind: 'key', label: 'Around', description: 'An object key: the center (empty: where the agent started).', default: '', keyTypes: ['object'] },
            { name: 'run', kind: 'bool', label: 'Run', description: 'Run instead of walking.', default: false },
        ],
        brief: (n) => `within ${formatValue(n.radius)} m${n.around ? ` of ${n.around}` : ''}${n.run ? ', running' : ''}`,
    },
    {
        type: 'flee',
        category: 'task',
        label: 'Flee',
        icon: 'walk',
        summary: 'Walks the agent\'s character away from the object in a key until it is Distance away: succeeds then, fails when it gets stuck.',
        details: 'It picks the way that leads farthest from the threat (on the navigation mesh when there is one) and runs or walks there.',
        fields: [
            { name: 'from', kind: 'key', label: 'From', description: 'An object key: what to get away from.', default: '', keyTypes: ['object'], required: true },
            { name: 'distance', kind: 'number', label: 'Distance', description: 'Safe at this many meters.', default: 10, min: 1 },
            { name: 'run', kind: 'bool', label: 'Run', description: 'Run instead of walking.', default: true },
        ],
        brief: (n) => `from ${n.from || '?'} to ${formatValue(n.distance)} m${n.run ? ', running' : ''}`,
    },
    {
        type: 'find',
        category: 'task',
        label: 'Find Nearest',
        icon: 'search',
        summary: 'Finds the nearest object with a name within a radius and writes it to a tree key: succeeds when one is found, fails otherwise.',
        details: 'A name ending in * matches every name that starts with it (Cover* finds Cover A and Cover B). With Visible, only objects the agent can see count (nothing of the level between them).',
        fields: [
            { name: 'name', kind: 'text', label: 'Name', description: 'Object name; a trailing * matches the start of names.', default: '', required: true },
            { name: 'radius', kind: 'number', label: 'Radius', description: 'Meters around the agent.', default: 20, min: 0.5 },
            { name: 'visible', kind: 'bool', label: 'Visible', description: 'Only objects in plain view.', default: false },
            { name: 'output', kind: 'key', label: 'Output', description: 'The tree key (object) the found object is written to.', default: '', keyTypes: ['object'], keyOwners: ['tree'], required: true },
        ],
        brief: (n) => `"${n.name}" within ${formatValue(n.radius)} m -> ${n.output || '?'}${n.visible ? ', visible' : ''}`,
    },
    {
        type: 'play_sound',
        category: 'task',
        label: 'Play Sound',
        icon: 'speaker',
        summary: 'Plays a sound asset at the agent (other agents may hear it): succeeds at once, or when it ends with Wait.',
        details: 'The sound is heard in 3D from the agent\'s place, at full volume within 2 m and fading out up to Range, which is also how far agents with hearing notice it. Fails when there is no such sound.',
        fields: [
            { name: 'clip', kind: 'text', label: 'Sound', description: 'A sound asset\'s name (with or without its extension) or id.', default: '', required: true },
            { name: 'volume', kind: 'number', label: 'Volume', description: '1 as recorded.', default: 1, min: 0, max: 2 },
            { name: 'range', kind: 'number', label: 'Range', description: 'Heard up to this many meters.', default: 20, min: 1 },
            { name: 'wait', kind: 'bool', label: 'Wait', description: 'Run until the sound ends.', default: false },
        ],
        brief: (n) => `"${n.clip || '?'}"${n.wait ? ', wait' : ''}`,
    },
    {
        type: 'play_animation',
        category: 'task',
        label: 'Play Animation',
        icon: 'play',
        summary: 'Plays an animation clip of the agent\'s model: succeeds after Seconds (at once with 0), fails for an unknown clip.',
        details: 'A character\'s model changes clip with its mode again when it starts or stops walking.',
        fields: [
            { name: 'clip', kind: 'text', label: 'Clip', description: 'The clip name (list_model_parts lists a model\'s clips).', default: '', required: true },
            { name: 'fade', kind: 'number', label: 'Fade', description: 'Crossfade seconds; -1 uses the model\'s.', default: -1, min: -1, max: 5 },
            { name: 'seconds', kind: 'seconds', label: 'Seconds', description: 'How long the task runs (0: it succeeds at once and the clip goes on).', default: 0, min: 0 },
        ],
        brief: (n) => `"${n.clip || '?'}"${n.seconds ? ` for ${formatValue(n.seconds)}s` : ''}`,
    },
    {
        type: 'set_key',
        category: 'task',
        label: 'Set Key',
        icon: 'key',
        summary: 'Writes a value to a tree key, then succeeds.',
        details: 'Only tree keys can be set: facts come from scripts and AI keys from their Ask.',
        fields: [
            { name: 'key', kind: 'key', label: 'Key', description: 'The tree key to write.', default: '', keyOwners: ['tree'], required: true },
            { name: 'value', kind: 'value', label: 'Value', description: 'The value, of the key\'s type.', default: null, keyField: 'key' },
        ],
        brief: (n) => `${n.key || '?'} = ${formatValue(n.value)}`,
    },
    {
        type: 'ask',
        category: 'task',
        label: 'Ask Task',
        icon: 'sparkle',
        summary: 'Asks the model and runs until the answer is written: succeeds when it is, fails when the answer is not confident enough, times out or there is no model.',
        details: 'Use it when the next step needs the answer (pick a topic, then say it). To keep an assessment current while a branch runs, attach an Ask service instead.',
        fields: ASK_FIELDS,
        brief: questionsBrief,
    },
    {
        type: 'infer',
        category: 'task',
        label: 'Model Task',
        icon: 'sparkle',
        summary: 'Runs a classify or generate model on a text made from blackboard values and the context pool, and writes the result to an AI key.',
        details:
            'The input is a template: {key} is replaced with a blackboard value, {context} with the agent\'s context pool (what Recall found, dialogue lines, what scripts added) and {context:slot} with one slot of it. A classifier writes its top label (string key, or enum key when the label names a value) or the probability of a label (probability key); a generator writes its text (string key). The task runs until the result is written, and fails when it is not (no model, less confident than the minimum, or too late). With History the written result is also added to that context slot as "Name: text", so a dialogue builds up turn by turn.',
        fields: [
            { name: 'model', kind: 'model', label: 'Model', description: 'A classify or generate model (Models view).', default: '', modelTasks: ['classify', 'generate'], required: true },
            { name: 'input', kind: 'template', label: 'Input', description: 'The text the model gets; {key}, {context} and {context:slot} are filled in.', default: '', required: true },
            { name: 'output', kind: 'key', label: 'Output', description: 'The AI key for the result: string (text or top label), enum (top label) or probability (P of the label).', default: '', keyOwners: ['ai'], keyTypes: ['string', 'enum', 'probability'], required: true },
            { name: 'label', kind: 'text', label: 'Label', description: 'Classifiers with a probability output: the label whose probability is written (empty: the top label\'s).', default: '' },
            { name: 'minConfidence', kind: 'unit', label: 'Min Confidence', description: 'Classifiers: results less confident than this keep the key\'s value.', default: 0 },
            { name: 'maxTokens', kind: 'integer', label: 'Max Tokens', description: 'Generators: most new tokens.', default: 32, min: 1, max: 512 },
            { name: 'temperature', kind: 'number', label: 'Temperature', description: 'Generators: 0 takes the likeliest token, higher values vary more.', default: 0.7, min: 0, max: 2 },
            { name: 'history', kind: 'text', label: 'History', description: 'A context slot the written result is added to as "Name: text" (a dialogue); empty for none.', default: '' },
            { name: 'speak', kind: 'bool', label: 'Speak', description: 'Speak the written text, one sentence at a time.', default: false },
            { name: 'timeout', kind: 'seconds', label: 'Timeout', description: 'Seconds to wait for the result before the task fails (a generator on the CPU takes seconds).', default: 20, min: 0.5 },
        ],
        brief: (n) => `${n.model || '?'} -> ${n.output || '?'}${n.history ? ` history=${n.history}` : ''}${n.speak ? ' speak' : ''} "${String(n.input ?? '').replace(/\s+/g, ' ').slice(0, 48)}"`,
    },
];

export const DECORATOR_TYPES: ItemTypeDef[] = [
    {
        type: 'condition',
        category: 'decorator',
        label: 'Condition',
        icon: 'filter',
        summary: 'The node runs only while a blackboard key passes a comparison.',
        details:
            'Conditions are checked again on every tick. When the condition of a running branch fails, the branch is aborted (self); when the condition of a higher branch of a Selector starts to pass, the running lower branch is aborted and the higher one runs (lower priority). Both are always on. With a minimum confidence, an AI key also needs an answer at least that confident.',
        fields: [
            { name: 'key', kind: 'key', label: 'Key', description: 'The key to test.', default: '', required: true },
            {
                name: 'op',
                kind: 'choice',
                label: 'Test',
                description: 'eq, ne, ge (at least), le (at most) or set (has a value). ge and le need a number or probability key.',
                default: 'eq',
                choices: COMPARE_OPS.map((o) => ({ value: o.op, label: `${o.symbol} (${o.label})`, description: o.description })),
            },
            { name: 'value', kind: 'value', label: 'Value', description: 'The comparison value, of the key\'s type (an enum value for enum keys).', default: null, keyField: 'key', when: (d) => d?.op !== 'set', whenText: 'op is not set' },
            { name: 'minConfidence', kind: 'unit', label: 'Min Confidence', description: 'AI keys: the answer\'s confidence must be at least this (0: any).', default: 0 },
        ],
        attachTo: ['composite', 'task'],
        brief: (d) => `${d.key || '?'} ${opSymbol(d.op)}${d.op === 'set' ? '' : ` ${formatValue(d.value)}`}${d.minConfidence > 0 ? `, conf >= ${formatValue(d.minConfidence)}` : ''}`,
    },
    {
        type: 'cooldown',
        category: 'decorator',
        label: 'Cooldown',
        icon: 'history',
        summary: 'After the node finishes (or is aborted) it cannot run again for some seconds.',
        details: 'A Selector skips the node while it cools down; when the time is up, a higher branch with a cooldown takes over from a lower one.',
        fields: [{ name: 'seconds', kind: 'seconds', label: 'Seconds', description: 'Cooldown time.', default: 5, min: 0 }],
        attachTo: ['composite', 'task'],
        brief: (d) => `cooldown ${formatValue(d.seconds)}s`,
    },
    {
        type: 'invert',
        category: 'decorator',
        label: 'Invert',
        icon: 'swap',
        summary: 'Success becomes failure and failure success.',
        details: 'It turns the node\'s result, also when its conditions keep it from running or abort it. Aborts from above end a node without a result, so nothing is turned then.',
        fields: [],
        attachTo: ['composite', 'task'],
        brief: () => 'invert',
    },
    {
        type: 'force',
        category: 'decorator',
        label: 'Force Result',
        icon: 'check',
        summary: 'The node always ends with this result: an optional step in a Sequence (success), or a branch a Selector always moves past (failure).',
        details: 'It applies to every way the node ends, also when its conditions keep it from running. It comes after Invert.',
        fields: [
            {
                name: 'result',
                kind: 'choice',
                label: 'Result',
                description: 'success or failure.',
                default: 'success',
                choices: [
                    { value: 'success', label: 'Success' },
                    { value: 'failure', label: 'Failure' },
                ],
            },
        ],
        attachTo: ['composite', 'task'],
        brief: (d) => `always ${d.result}`,
    },
    {
        type: 'repeat',
        category: 'decorator',
        label: 'Repeat',
        icon: 'refresh',
        summary: 'Runs the node again when it succeeds: Count runs in all (0: until it fails).',
        details: 'The next run starts on the next tick, so a node that finishes at once runs once per tick (ten times a second). It fails when a run fails, and succeeds after the last run.',
        fields: [{ name: 'count', kind: 'integer', label: 'Count', description: 'Runs in all; 0 repeats until a run fails.', default: 3, min: 0, max: 10000 }],
        attachTo: ['composite', 'task'],
        brief: (d) => (d.count ? `repeat x${d.count}` : 'repeat until failure'),
    },
    {
        type: 'retry',
        category: 'decorator',
        label: 'Retry',
        icon: 'rotate',
        summary: 'Runs the node again when it fails: Count tries in all (0: until it succeeds).',
        details: 'The next try starts on the next tick. With a Time Limit, each try gets its own time. A node aborted by its conditions is not tried again.',
        fields: [{ name: 'count', kind: 'integer', label: 'Count', description: 'Tries in all; 0 tries until one succeeds.', default: 3, min: 0, max: 10000 }],
        attachTo: ['composite', 'task'],
        brief: (d) => (d.count ? `retry x${d.count}` : 'retry until success'),
    },
    {
        type: 'time_limit',
        category: 'decorator',
        label: 'Time Limit',
        icon: 'history',
        summary: 'A run of the node that takes longer than Seconds is aborted and fails.',
        details: 'Gives up on a walk that takes too long or an answer that does not come. Each run (each try of a Retry) gets its own time.',
        fields: [{ name: 'seconds', kind: 'seconds', label: 'Seconds', description: 'Longest run.', default: 10, min: 0.1 }],
        attachTo: ['composite', 'task'],
        brief: (d) => `at most ${formatValue(d.seconds)}s`,
    },
];

const factOut = (name: string, label: string, description: string, keyTypes: BlackboardKeyType[]): FieldDef => ({ name, kind: 'key', label, description: `${description} Empty: not written.`, default: '', keyTypes, keyOwners: ['fact'] });

export const SERVICE_TYPES: ItemTypeDef[] = [
    {
        type: 'recall',
        category: 'service',
        label: 'Recall',
        icon: 'search',
        summary: 'Looks up the memory items that match a query and puts them into the agent\'s context pool.',
        details:
            'The query is embedded and compared with the memory items: items with one of the tags, the best matches by cosine, put in id order and joined within the token budget. They fill the context slot named after the service; Asks with Use Context and Model tasks with {context} show the pool to their model.',
        fields: [
            intervalField(2),
            jitterField,
            { name: 'query', kind: 'template', label: 'Query', description: 'Search text; {key} is replaced with the blackboard value.', default: '', required: true },
            { name: 'tags', kind: 'tags', label: 'Tags', description: 'Only items with one of these tags (empty: all).', default: [] },
            { name: 'count', kind: 'integer', label: 'Count', description: 'How many items to take.', default: 5, min: 1, max: 50 },
            { name: 'tokenBudget', kind: 'integer', label: 'Token Budget', description: 'Most tokens the context may take.', default: 200, min: 16, max: 480 },
        ],
        attachTo: ['composite', 'task'],
        brief: (s) => `recall ${every(s)} "${s.query}"${s.tags?.length ? ` tags=[${s.tags.join(', ')}]` : ''} k=${s.count} ${s.tokenBudget} tokens`,
    },
    {
        type: 'ask',
        category: 'service',
        label: 'Ask Service',
        icon: 'sparkle',
        summary: 'Asks the model while the node is active: when it becomes active, when a fact changes, or every interval.',
        details:
            'Every request gets a number and only the newest request\'s answer is written. An answer less confident than the minimum keeps the previous value, and a value is not changed before its hold time. Without a model the keys keep their defaults.',
        fields: [
            intervalField(5),
            jitterField,
            {
                name: 'triggers',
                kind: 'flags',
                label: 'Triggers',
                description: 'When to ask: ' + TRIGGERS.map((t) => `${t.value} (${t.description})`).join(', ') + '.',
                default: ['activate', 'facts'],
                choices: TRIGGERS.map((t) => ({ value: t.value, label: t.label, description: t.description })),
            },
            ...ASK_FIELDS,
        ],
        attachTo: ['composite', 'task'],
        brief: (s, keys) => `ask on ${(s.triggers ?? []).join(',') || 'nothing'}${(s.triggers ?? []).includes('interval') ? ` (${every(s)})` : ''} ${questionsBrief(s, keys)}`,
    },
    {
        type: 'sight',
        category: 'service',
        label: 'Sight',
        icon: 'eye',
        summary: 'Sees the player, other characters or named objects within a range and field of view, and writes what it sees to fact keys.',
        details:
            'Every interval it looks from the agent\'s eyes: targets within Range and the field of view around where the agent faces, with nothing of the level between (Line of Sight). The nearest one goes to Output; it stays there Memory seconds after it went out of sight, while Visible turns false at once. Position is a marker object at where the target was last seen, for Move To (go and look). The keys are fact keys, so Conditions and Asks read them like facts from scripts.',
        fields: [
            intervalField(0.2),
            jitterField,
            {
                name: 'targets',
                kind: 'choice',
                label: 'Targets',
                description: 'player (the player\'s character), characters (every other character) or named (objects with Name).',
                default: 'player',
                choices: [
                    { value: 'player', label: 'The player' },
                    { value: 'characters', label: 'Other characters' },
                    { value: 'named', label: 'Objects with a name' },
                ],
            },
            { name: 'name', kind: 'text', label: 'Name', description: 'Object name; a trailing * matches the start of names.', default: '', when: (s) => s?.targets === 'named', whenText: 'targets = named' },
            { name: 'range', kind: 'number', label: 'Range', description: 'Meters it sees.', default: 15, min: 0.5 },
            { name: 'fov', kind: 'number', label: 'Field of View', description: 'Degrees around where the agent faces (360: all around).', default: 120, min: 1, max: 360 },
            { name: 'lineOfSight', kind: 'bool', label: 'Line of Sight', description: 'Walls and other level objects block the view.', default: true },
            { name: 'memory', kind: 'seconds', label: 'Memory', description: 'Seconds the target stays in Output after it went out of sight.', default: 3, min: 0 },
            factOut('output', 'Output', 'Object key: the nearest target in sight (null when none, after Memory).', ['object']),
            factOut('visible', 'Visible', 'Bool key: a target is in sight now.', ['bool']),
            factOut('distance', 'Distance', 'Number key: meters to the target (while seen).', ['number']),
            factOut('position', 'Position', 'Object key: a marker where the target was last seen.', ['object']),
        ],
        attachTo: ['composite', 'task'],
        brief: (s) => `sees ${s.targets === 'named' ? `"${s.name}"` : s.targets} ${formatValue(s.range)} m ${formatValue(s.fov)} deg${s.lineOfSight ? '' : ' through walls'} -> ${[s.output, s.visible, s.distance, s.position].filter(Boolean).join(', ') || 'nothing'}`,
    },
    {
        type: 'hearing',
        category: 'service',
        label: 'Hearing',
        icon: 'speaker',
        summary: 'Notices sounds played in 3D (Audio components, Play Sound tasks, this.playSound with a place) and scripts\' noises (this.noise) that carry to the agent.',
        details:
            'A sound carries its range (Heard Up To of an Audio component, Range of a Play Sound task, far of this.playSound, the range of this.noise), times Sensitivity; with Walls, level objects between halve it. Heard is true for Memory seconds after the last sound; Source is the object that made it; Position is a marker where it was heard, for Move To (investigate).',
        fields: [
            intervalField(0.2),
            jitterField,
            { name: 'sensitivity', kind: 'number', label: 'Sensitivity', description: 'Multiplies how far sounds carry to this agent.', default: 1, min: 0, max: 5 },
            { name: 'walls', kind: 'bool', label: 'Walls', description: 'Level objects between halve how far a sound carries.', default: true },
            { name: 'memory', kind: 'seconds', label: 'Memory', description: 'Seconds Heard stays true after the last sound.', default: 3, min: 0 },
            factOut('heard', 'Heard', 'Bool key: it heard something within Memory seconds.', ['bool']),
            factOut('source', 'Source', 'Object key: what made the last sound (null when unknown).', ['object']),
            factOut('position', 'Position', 'Object key: a marker where the last sound was heard.', ['object']),
        ],
        attachTo: ['composite', 'task'],
        brief: (s) => `hears x${formatValue(s.sensitivity)}${s.walls ? '' : ' through walls'} -> ${[s.heard, s.source, s.position].filter(Boolean).join(', ') || 'nothing'}`,
    },
];

/** Fields every node and service has. */
export const COMMON_FIELDS: FieldDef[] = [
    { name: 'id', kind: 'text', label: 'Id', description: 'Readable name, fixed and unique in the tree (letters, digits, _ and -), e.g. threat_gate.', default: '', required: true },
    { name: 'note', kind: 'text', label: 'Note', description: 'Free text for people.', default: '' },
];

export function nodeType(type: string): ItemTypeDef | undefined {
    return NODE_TYPES.find((t) => t.type === type);
}

export function decoratorType(type: string): ItemTypeDef | undefined {
    return DECORATOR_TYPES.find((t) => t.type === type);
}

export function serviceType(type: string): ItemTypeDef | undefined {
    return SERVICE_TYPES.find((t) => t.type === type);
}

export function isComposite(type: string): boolean {
    return nodeType(type)?.category === 'composite';
}

/** Fields that apply to an item now (fields with `when` only when it holds). */
export function activeFields(def: ItemTypeDef, item: any): FieldDef[] {
    return def.fields.filter((f) => !f.when || f.when(item));
}

/** A deep copy of a field's default. */
export function fieldDefault(f: FieldDef): any {
    return Array.isArray(f.default) ? JSON.parse(JSON.stringify(f.default)) : f.default;
}

/** A new item of a type with every field at its default. */
export function newItem(def: ItemTypeDef, extra: Record<string, unknown> = {}): any {
    const out: Record<string, unknown> = { type: def.type };
    for (const f of def.fields) out[f.name] = fieldDefault(f);
    if (def.category === 'composite') out.children = [];
    return { ...out, ...extra };
}

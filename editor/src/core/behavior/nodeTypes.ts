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
];

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

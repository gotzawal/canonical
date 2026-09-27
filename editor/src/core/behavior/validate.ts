// Validation of behavior trees, blackboard schemas and agents. Errors point
// at a node id (and a field); the outliner marks them red, the edit layer
// refuses AI batches that add new ones, and the assistant's validate tool
// returns them. Warnings never block.

import type {
    AgentDoc, AiModelDoc, BehaviorTreeDoc, BlackboardKeyDoc, BlackboardSchemaDoc, BtDecoratorDoc, BtNodeDoc, BtServiceDoc, InferTaskDoc,
    MemoryDoc, SceneDoc,
} from '../types';
import { isCompositeDoc, memoryChoiceKeys, schemaOf, walkNodes } from './format';
import { BUILTIN_MODELS, findModel, MODEL_KINDS, MODEL_TASKS, modelKind, modelTask, type ModelTask } from './models';
import {
    activeFields, decoratorType, isReadableId, keyTypeInfo, nodeType, serviceType, valueFits, type FieldDef, type ItemTypeDef,
} from './nodeTypes';

export type Severity = 'error' | 'warning';

export interface Issue {
    severity: Severity;
    /** Short machine readable kind, e.g. "key-missing". */
    code: string;
    message: string;
    /** Tree id, or schema id for schema issues. */
    tree?: string;
    schema?: string;
    /** Node or service id. */
    node?: string;
    /** Decorator index on the node. */
    decorator?: number;
    /** Field path, e.g. "key" or "questions[1].key". */
    field?: string;
    /** Scene object (node id) for agent issues. */
    object?: string;
    /** Model id for model issues. */
    model?: string;
}

/** Placeholders a template may use besides {key}: the context pool, or one slot of it. */
export const CONTEXT_PLACEHOLDER = /^context(?::([\p{L}\p{N}_-]+))?$/u;

/** Ask questions: the format a key type is asked in, or why it cannot be. */
export function questionFormat(key: BlackboardKeyDoc, choices: string): { format: 'noul' | 'choice' } | { error: string } {
    if (key.type === 'probability') return { format: 'noul' };
    if (key.type === 'enum') {
        if (choices === 'memory') return { error: `"${key.name}" is an enum key: memory choices write an item id, which needs a string key.` };
        return { format: 'choice' };
    }
    if (key.type === 'string') {
        if (choices !== 'memory') return { error: `"${key.name}" is a string key: it can only be asked as a Choice between memory items (choices = memory).` };
        return { format: 'choice' };
    }
    return { error: `"${key.name}" is a ${key.type} key; Ask writes probability keys (Noul) and enum keys (Choice).` };
}

/** False when the node never fails (so later branches of a Selector are never reached). */
function canFail(n: BtNodeDoc): boolean {
    if (n.decorators?.length) return true;
    switch (n.type) {
        case 'wait':
        case 'set_key':
            return false;
        case 'script':
        case 'ask':
        case 'infer':
            return true;
        case 'selector':
            return n.children.length === 0 || n.children.every(canFail);
        case 'sequence':
            return n.children.some(canFail);
    }
}

interface Ctx {
    tree: BehaviorTreeDoc;
    schema: BlackboardSchemaDoc | undefined;
    memory: MemoryDoc | undefined;
    /** The scene's models (the built-in ones are always there). */
    models: readonly AiModelDoc[];
    out: Issue[];
}

const taskLabel = (t: ModelTask | undefined) => MODEL_TASKS.find((x) => x.task === t)?.label.toLowerCase() ?? 'unknown';

function push(ctx: Ctx, severity: Severity, code: string, message: string, at: Partial<Issue> = {}) {
    ctx.out.push({ severity, code, message, tree: ctx.tree.id, ...at });
}

function keyOf(ctx: Ctx, name: unknown): BlackboardKeyDoc | undefined {
    return typeof name === 'string' ? ctx.schema?.keys.find((k) => k.name === name) : undefined;
}

/** Checks one key reference against a field's limits. */
function checkKeyRef(ctx: Ctx, f: FieldDef, name: unknown, at: Partial<Issue>): BlackboardKeyDoc | undefined {
    if (typeof name !== 'string' || !name) return undefined;
    if (!ctx.schema) return undefined;
    const key = keyOf(ctx, name);
    if (!key) {
        push(ctx, 'error', 'key-missing', `Key "${name}" does not exist in schema "${ctx.schema.name}".`, at);
        return undefined;
    }
    if (f.keyTypes && !f.keyTypes.includes(key.type)) {
        push(ctx, 'error', 'key-type', `"${name}" is a ${key.type} key; ${f.label} needs ${f.keyTypes.join(' or ')}.`, at);
    }
    if (f.keyOwners && !f.keyOwners.includes(key.owner)) {
        const need = f.keyOwners.map((o) => (o === 'fact' ? 'a fact key' : o === 'ai' ? 'an AI key' : 'a tree key')).join(' or ');
        const is = key.owner === 'fact' ? 'a fact key (written by scripts)' : key.owner === 'ai' ? 'an AI key (written by its Ask)' : 'a tree key';
        push(ctx, 'error', 'key-owner', `"${name}" is ${is}; ${f.label} needs ${need}.`, at);
    }
    return key;
}

/** Checks an item's fields against its type definition. */
function checkFields(ctx: Ctx, def: ItemTypeDef, item: any, at: Partial<Issue>) {
    for (const f of activeFields(def, item)) {
        const v = item[f.name];
        const where = { ...at, field: f.name };
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
        if (f.required && empty) {
            push(ctx, 'error', 'required', `${f.label} is required.`, where);
            continue;
        }
        switch (f.kind) {
            case 'number':
            case 'integer':
            case 'seconds':
            case 'unit': {
                if (typeof v !== 'number' || !Number.isFinite(v)) {
                    push(ctx, 'error', 'field-type', `${f.label} must be a number.`, where);
                    break;
                }
                const min = f.kind === 'unit' ? 0 : f.min;
                const max = f.kind === 'unit' ? 1 : f.max;
                if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
                    push(ctx, 'error', 'range', `${f.label} must be ${min !== undefined && max !== undefined ? `between ${min} and ${max}` : min !== undefined ? `at least ${min}` : `at most ${max}`}.`, where);
                }
                break;
            }
            case 'choice':
                if (!f.choices?.some((c) => c.value === v)) push(ctx, 'error', 'choice', `${f.label} must be one of ${f.choices?.map((c) => c.value).join(', ')}.`, where);
                break;
            case 'flags':
                if (!Array.isArray(v) || !v.length) push(ctx, 'error', 'required', `${f.label}: choose at least one (${f.choices?.map((c) => c.value).join(', ')}).`, where);
                break;
            case 'method':
                if (typeof v === 'string' && v && !/^[A-Za-z_$][\w$]*$/.test(v)) push(ctx, 'error', 'method', `"${v}" is not a method name.`, where);
                break;
            case 'key':
                checkKeyRef(ctx, f, v, where);
                break;
            case 'keys': {
                const seen = new Set<string>();
                (Array.isArray(v) ? v : []).forEach((name: string, i: number) => {
                    if (seen.has(name)) push(ctx, 'warning', 'duplicate', `"${name}" is listed twice.`, { ...at, field: `${f.name}[${i}]` });
                    seen.add(name);
                    checkKeyRef(ctx, f, name, { ...at, field: `${f.name}[${i}]` });
                });
                break;
            }
            case 'value': {
                const key = keyOf(ctx, item[f.keyField ?? 'key']);
                if (!key) break;
                if (!valueFits(key, v)) {
                    const allowed = key.type === 'enum' ? `one of ${key.values?.map((x) => x.value).join(', ') || '(no values)'}` : key.type === 'probability' ? 'a number in 0..1' : key.type === 'object' ? 'an object id or null' : `a ${key.type}`;
                    push(ctx, 'error', key.type === 'enum' ? 'enum-value' : 'value-type', `${f.label} ${JSON.stringify(v)} does not fit "${key.name}": it must be ${allowed}.`, where);
                }
                break;
            }
            case 'template':
                checkTemplate(ctx, v, f.label, where);
                break;
            case 'questions':
                checkQuestions(ctx, item, at);
                break;
            case 'model': {
                if (typeof v !== 'string' || !v) break;
                const m = findModel(v, ctx.models);
                const task = modelTask(m);
                if (!m) push(ctx, 'error', 'model-missing', `No model "${v}". Models: ${[...ctx.models, ...BUILTIN_MODELS].map((x) => x.id).join(', ')}.`, where);
                else if (f.modelTasks && (!task || !f.modelTasks.includes(task))) {
                    push(ctx, 'error', 'model-task', `"${v}" is a ${taskLabel(task)} model; ${f.label} needs a ${f.modelTasks.map(taskLabel).join(' or ')} model.`, where);
                }
                break;
            }
        }
    }
}

/** Placeholders of a text: {key} names a key of the schema; {context} and {context:slot} the context pool. */
function checkTemplate(ctx: Ctx, v: unknown, label: string, where: Partial<Issue>) {
    if (typeof v !== 'string' || !ctx.schema) return;
    for (const m of v.matchAll(/\{([^{}]+)\}/g)) {
        const name = m[1].trim();
        if (CONTEXT_PLACEHOLDER.test(name)) continue;
        if (!keyOf(ctx, name)) push(ctx, 'error', 'key-missing', `{${m[1]}} in ${label}: no key "${name}" in schema "${ctx.schema.name}" ({context} and {context:slot} name the context pool).`, where);
    }
}

function checkQuestions(ctx: Ctx, item: any, at: Partial<Issue>) {
    const seen = new Set<string>();
    (Array.isArray(item.questions) ? item.questions : []).forEach((q: any, i: number) => {
        const where = { ...at, field: `questions[${i}].key` };
        if (!q?.key) {
            push(ctx, 'error', 'required', `Question ${i + 1} has no key.`, where);
            return;
        }
        if (seen.has(q.key)) push(ctx, 'error', 'duplicate', `"${q.key}" is asked twice in this Ask.`, where);
        seen.add(q.key);
        if (!String(q.text ?? '').trim()) push(ctx, 'error', 'required', `The question for "${q.key}" has no text.`, { ...at, field: `questions[${i}].text` });
        // Question texts are templates too ({key} is filled in when asking).
        checkTemplate(ctx, q.text, `the question for "${q.key}"`, { ...at, field: `questions[${i}].text` });
        const key = checkKeyRef(ctx, { name: 'questions', kind: 'key', label: 'A question', description: '', default: '', keyOwners: ['ai'] }, q.key, where);
        if (!key || key.owner !== 'ai') return;
        const fmt = questionFormat(key, item.choices);
        if ('error' in fmt) push(ctx, 'error', 'question-format', fmt.error, where);
        else if (key.type === 'enum') {
            const n = key.values?.length ?? 0;
            if (n < 2) push(ctx, 'error', 'enum-empty', `"${key.name}" needs at least two values to be asked as a Choice.`, where);
            else if (n > 20) push(ctx, 'warning', 'too-many-options', `"${key.name}" has ${n} values; the model is best with 20 options or fewer.`, where);
        }
    });
    if (item.choices === 'memory' && ctx.memory) {
        const tags: string[] = item.memoryTags ?? [];
        const count = ctx.memory.items.filter((m) => !tags.length || m.tags.some((t) => tags.includes(t))).length;
        if (count < 2) push(ctx, 'warning', 'memory-empty', `Memory has ${count} item${count === 1 ? '' : 's'}${tags.length ? ` tagged ${tags.join(', ')}` : ''}; a Choice needs at least two.`, { ...at, field: 'memoryTags' });
    }
}

function checkDecorator(ctx: Ctx, node: BtNodeDoc, d: BtDecoratorDoc, index: number, isRoot: boolean) {
    const at = { node: node.id, decorator: index };
    const def = decoratorType(d.type);
    if (!def) {
        push(ctx, 'error', 'unknown-type', `Unknown decorator type "${d.type}".`, at);
        return;
    }
    const cat = nodeType(node.type)?.category as 'composite' | 'task' | undefined;
    if (isRoot) push(ctx, 'error', 'attach', `The root cannot have decorators; wrap it in a Selector or Sequence and decorate that.`, at);
    else if (cat && def.attachTo && !def.attachTo.includes(cat)) push(ctx, 'error', 'attach', `A ${def.label} cannot be attached to a ${cat}.`, at);
    checkFields(ctx, def, d, at);
    if (d.type === 'condition') {
        const key = keyOf(ctx, d.key);
        if (key && !keyTypeInfo(key.type).ops.includes(d.op)) push(ctx, 'error', 'op-type', `"${d.op}" cannot compare a ${key.type} key; use ${keyTypeInfo(key.type).ops.join(', ')}.`, { ...at, field: 'op' });
        if (key && d.minConfidence > 0 && key.owner !== 'ai') push(ctx, 'warning', 'confidence', `Min confidence only applies to AI keys; "${key.name}" is a ${key.owner} key.`, { ...at, field: 'minConfidence' });
    }
}

function checkService(ctx: Ctx, node: BtNodeDoc, s: BtServiceDoc) {
    const at = { node: s.id };
    const def = serviceType(s.type);
    if (!def) {
        push(ctx, 'error', 'unknown-type', `Unknown service type "${s.type}".`, at);
        return;
    }
    const cat = nodeType(node.type)?.category as 'composite' | 'task' | undefined;
    if (cat && def.attachTo && !def.attachTo.includes(cat)) push(ctx, 'error', 'attach', `A ${def.label} cannot be attached to a ${cat}.`, at);
    checkFields(ctx, def, s, at);
}

/** A Model task's output key must take what its model gives. */
function checkInfer(ctx: Ctx, n: InferTaskDoc) {
    if (n.history && !isReadableId(n.history)) push(ctx, 'error', 'bad-id', `"${n.history}" is not a context slot name: use letters, digits, _ and -.`, { node: n.id, field: 'history' });
    const key = keyOf(ctx, n.output);
    const task = modelTask(findModel(n.model, ctx.models));
    if (!key || !task) return;
    if (task === 'generate' && key.type !== 'string') push(ctx, 'error', 'output-type', `A text generator writes text: "${key.name}" is a ${key.type} key; use a string key.`, { node: n.id, field: 'output' });
    if (n.label && (task !== 'classify' || key.type !== 'probability')) push(ctx, 'warning', 'label-unused', 'Label only applies to a classifier with a probability output.', { node: n.id, field: 'label' });
}

/** Every problem of one tree. */
export function validateTree(tree: BehaviorTreeDoc, schemas: BlackboardSchemaDoc[], memory?: MemoryDoc, models: readonly AiModelDoc[] = []): Issue[] {
    const ctx: Ctx = { tree, schema: schemaOf(schemas, tree), memory, models, out: [] };
    if (!ctx.schema) push(ctx, 'error', 'schema-missing', tree.schema ? `Schema "${tree.schema}" does not exist.` : 'The tree has no blackboard schema.', { field: 'schema' });

    const ids = new Map<string, number>();
    const asks: { id: string; keys: string[]; facts: string[] }[] = [];
    /** Who writes which AI key, in tree order: Ask questions and Model task outputs. */
    const writes: { id: string; key: string; field: string }[] = [];
    const addAsk = (id: string, a: { questions: { key: string }[]; facts: string[] }) => {
        asks.push({ id, keys: a.questions.map((q) => q.key), facts: a.facts });
        for (const k of new Set(a.questions.map((q) => q.key))) if (k) writes.push({ id, key: k, field: 'questions' });
    };
    let recall = false;
    walkNodes(tree.root, (node, parent) => {
        const isRoot = parent === null;
        const def = nodeType(node.type);
        for (const id of [node.id, ...(node.services ?? []).map((s) => s.id)]) ids.set(id, (ids.get(id) ?? 0) + 1);
        if (!isReadableId(node.id)) push(ctx, 'error', 'bad-id', `"${node.id}" is not a valid id: use letters, digits, _ and -.`, { node: node.id, field: 'id' });
        if (!def) {
            push(ctx, 'error', 'unknown-type', `Unknown node type "${node.type}".`, { node: node.id });
            return;
        }
        checkFields(ctx, def, node, { node: node.id });
        (node.decorators ?? []).forEach((d, i) => checkDecorator(ctx, node, d, i, isRoot));
        for (const s of node.services ?? []) {
            if (!isReadableId(s.id)) push(ctx, 'error', 'bad-id', `"${s.id}" is not a valid id: use letters, digits, _ and -.`, { node: s.id, field: 'id' });
            checkService(ctx, node, s);
            if (s.type === 'recall') recall = true;
            if (s.type === 'ask') addAsk(s.id, s);
        }
        if (node.type === 'ask') addAsk(node.id, node);
        if (node.type === 'infer') {
            if (node.output) writes.push({ id: node.id, key: node.output, field: 'output' });
            checkInfer(ctx, node);
        }
        if (isCompositeDoc(node)) {
            if (!node.children.length) push(ctx, 'warning', 'empty', `This ${def.label} has no children; it always ${node.type === 'selector' ? 'fails' : 'succeeds'}.`, { node: node.id });
            if (node.type === 'selector') {
                const stop = node.children.findIndex((c) => !c.decorators?.length && !canFail(c));
                if (stop >= 0) {
                    for (const c of node.children.slice(stop + 1)) {
                        push(ctx, 'warning', 'unreachable', `Never reached: the earlier branch "${node.children[stop].id}" has no condition and never fails.`, { node: c.id });
                    }
                }
                const last = node.children[node.children.length - 1];
                if (last && last.decorators?.length) push(ctx, 'warning', 'no-default', `No default branch: the last child "${last.id}" has a condition, so the Selector fails when nothing matches. End it with a branch without conditions.`, { node: node.id });
            }
        }
    });
    for (const [id, n] of ids) if (n > 1) push(ctx, 'error', 'duplicate-id', `The id "${id}" is used ${n} times; ids are unique in the tree.`, { node: id, field: 'id' });

    // Ownership: every AI key has exactly one writer, an Ask or a Model task.
    const writers = new Map<string, { id: string; field: string }[]>();
    for (const w of writes) writers.set(w.key, [...(writers.get(w.key) ?? []), w]);
    for (const [key, list] of writers) {
        for (const w of list.slice(1)) push(ctx, 'error', 'owner-conflict', `"${key}" is also written by "${list[0].id}"; an AI key is written by exactly one Ask or Model task.`, { node: w.id, field: w.field });
    }
    if (ctx.schema) {
        const read = new Set<string>();
        walkNodes(tree.root, (n) => {
            for (const d of n.decorators ?? []) if (d.type === 'condition') read.add(d.key);
        });
        for (const k of ctx.schema.keys) {
            if (k.owner === 'ai' && read.has(k.name) && !writers.has(k.name)) push(ctx, 'warning', 'ai-unwritten', `The AI key "${k.name}" is tested but no Ask or Model task of this tree writes it; it keeps its default.`, { field: 'schema' });
        }
    }
    // Questions about the same facts belong in one Ask.
    for (let i = 0; i < asks.length; i++) {
        for (let j = i + 1; j < asks.length; j++) {
            const a = asks[i], b = asks[j];
            if (a.facts.length && a.facts.length === b.facts.length && a.facts.every((f) => b.facts.includes(f))) {
                push(ctx, 'warning', 'same-facts', `"${b.id}" looks at the same facts as "${a.id}"; put their questions in one Ask.`, { node: b.id, field: 'facts' });
            }
        }
    }
    const usesContext = asks.some((a) => {
        let ctxOn = false;
        walkNodes(tree.root, (n) => {
            if (n.id === a.id && n.type === 'ask' && n.context) ctxOn = true;
            for (const s of n.services ?? []) if (s.id === a.id && s.type === 'ask' && s.context) ctxOn = true;
        });
        return ctxOn;
    });
    if (usesContext && !recall) push(ctx, 'warning', 'no-recall', 'An Ask uses the context, but the tree has no Recall service to fill it.', { node: tree.root.id });
    // Keys an Ask chooses from memory hold item ids: a condition on another id never matches.
    const idKeys = memory ? memoryChoiceKeys(tree) : new Set<string>();
    if (idKeys.size) {
        walkNodes(tree.root, (n) =>
            (n.decorators ?? []).forEach((d, i) => {
                if (d.type !== 'condition' || (d.op !== 'eq' && d.op !== 'ne') || !idKeys.has(d.key) || typeof d.value !== 'string' || !d.value) return;
                if (!memory!.items.some((m) => m.id === d.value)) push(ctx, 'warning', 'memory-id', `"${d.key}" holds memory item ids, and memory has no item "${d.value}".`, { node: n.id, decorator: i, field: 'value' });
            }),
        );
    }
    return ctx.out;
}

/** Problems of a schema itself (its keys). */
export function validateSchema(schema: BlackboardSchemaDoc): Issue[] {
    const out: Issue[] = [];
    const at = (key: string, field: string): Partial<Issue> => ({ schema: schema.id, node: key, field });
    const seen = new Set<string>();
    for (const k of schema.keys) {
        if (!isReadableId(k.name)) out.push({ severity: 'error', code: 'bad-id', message: `"${k.name}" is not a valid key name: use letters, digits, _ and -.`, ...at(k.name, 'name') });
        if (seen.has(k.name)) out.push({ severity: 'error', code: 'duplicate-id', message: `Key "${k.name}" exists twice.`, ...at(k.name, 'name') });
        if (k.name === 'context') out.push({ severity: 'error', code: 'reserved', message: '"context" is reserved: {context} in templates is the context pool.', ...at(k.name, 'name') });
        seen.add(k.name);
        if (k.type === 'enum') {
            if (!k.values?.length) out.push({ severity: 'error', code: 'enum-empty', message: `The enum key "${k.name}" has no values.`, ...at(k.name, 'values') });
            const vals = new Set<string>();
            for (const v of k.values ?? []) {
                if (vals.has(v.value)) out.push({ severity: 'error', code: 'duplicate', message: `"${k.name}" lists the value "${v.value}" twice.`, ...at(k.name, 'values') });
                vals.add(v.value);
                if (k.owner === 'ai' && !v.description.trim()) out.push({ severity: 'warning', code: 'enum-description', message: `"${k.name}" = "${v.value}" has no description; Choice questions show the model the description as the option.`, ...at(k.name, 'values') });
            }
        }
        if (!valueFits(k, k.default)) out.push({ severity: 'error', code: 'value-type', message: `The default ${JSON.stringify(k.default)} does not fit the ${k.type} key "${k.name}".`, ...at(k.name, 'default') });
    }
    return out;
}

/** Problems of an object's agent settings. */
export function validateAgent(objectId: string, agent: AgentDoc, doc: Pick<SceneDoc, 'behaviors' | 'blackboards'>): Issue[] {
    const out: Issue[] = [];
    const tree = doc.behaviors.find((t) => t.id === agent.tree);
    if (!tree) {
        out.push({ severity: 'error', code: 'agent-tree', message: `The behavior tree "${agent.tree}" does not exist.`, object: objectId, field: 'tree' });
        return out;
    }
    const schema = schemaOf(doc.blackboards, tree);
    for (const [name, v] of Object.entries(agent.values)) {
        const key = schema?.keys.find((k) => k.name === name);
        if (!key) out.push({ severity: 'warning', code: 'agent-key', message: `"${name}" is not a key of the tree's schema; the value is ignored.`, object: objectId, tree: tree.id, field: `values.${name}` });
        else if (!valueFits(key, v)) out.push({ severity: 'error', code: 'agent-value', message: `${JSON.stringify(v)} does not fit the ${key.type} key "${name}".`, object: objectId, tree: tree.id, field: `values.${name}` });
    }
    return out;
}

/** Every behavior problem of a scene. */
export function validateScene(doc: SceneDoc): Issue[] {
    const out: Issue[] = [];
    for (const s of doc.blackboards) out.push(...validateSchema(s));
    for (const t of doc.behaviors) out.push(...validateTree(t, doc.blackboards, doc.memory, doc.aiModels));
    for (const n of doc.nodes) if (n.agent) out.push(...validateAgent(n.id, n.agent, doc));
    out.push(...validateModels(doc.aiModels, doc.memory));
    return out;
}

/** Problems of the scene's models, and of the model the memory is embedded with. */
export function validateModels(models: readonly AiModelDoc[], memory?: MemoryDoc): Issue[] {
    const out: Issue[] = [];
    const bad = (model: string, code: string, field: string, message: string, severity: Severity = 'error') => out.push({ severity, code, message, model, field });
    const seen = new Set<string>();
    for (const m of models) {
        if (!isReadableId(m.id)) bad(m.id, 'bad-id', 'id', `"${m.id}" is not a valid model id: use letters, digits, _ and -.`);
        else if (seen.has(m.id) || BUILTIN_MODELS.some((b) => b.id === m.id)) bad(m.id, 'duplicate-id', 'id', `The model id "${m.id}" is taken${BUILTIN_MODELS.some((b) => b.id === m.id) ? ' by a built-in model' : ''}.`);
        seen.add(m.id);
        const kind = modelKind(m.kind);
        if (!kind) bad(m.id, 'model-kind', 'kind', `Unknown model kind "${m.kind}"; use ${MODEL_KINDS.map((k) => k.kind).join(', ')}.`);
        if (!isFolderUrl(m.url)) bad(m.id, 'model-url', 'url', 'The folder URL must be a web address ending with / (it holds tokenizer.json and the ONNX file).');
        if (!m.file.trim()) bad(m.id, 'required', 'file', 'The model file is required.');
        for (const name of Object.keys(m.options)) {
            if (kind && !kind.options.some((o) => o.name === name)) bad(m.id, 'model-option', `options.${name}`, `"${name}" is not a setting of ${kind.label} models; it is ignored.`, 'warning');
        }
    }
    if (memory) {
        const e = findModel(memory.embedder, models);
        if (!e) bad(memory.embedder, 'model-missing', 'memory.embedder', `The memory's embed model "${memory.embedder}" does not exist.`);
        else if (modelTask(e) !== 'embed') bad(memory.embedder, 'model-task', 'memory.embedder', `"${memory.embedder}" is a ${taskLabel(modelTask(e))} model; memory needs an embed model.`);
    }
    return out;
}

/** The web address of a folder (ending with /): absolute, or from the page (/..., ./..., ../...) for models hosted with the game. */
export function isFolderUrl(url: string): boolean {
    if (!url.endsWith('/') || /\s/.test(url)) return false;
    if (/^\.{0,2}\//.test(url)) return true;
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
        return false;
    }
}

/** "tree guard / node threat_gate / field key: message", for tool results and toasts. */
export function describeIssue(i: Issue, names?: { tree?: (id: string) => string; schema?: (id: string) => string }): string {
    const parts: string[] = [];
    if (i.tree) parts.push(`tree ${names?.tree?.(i.tree) ?? i.tree}`);
    if (i.schema) parts.push(`schema ${names?.schema?.(i.schema) ?? i.schema}`);
    if (i.object) parts.push(`object ${i.object}`);
    if (i.model) parts.push(`model ${i.model}`);
    if (i.node) parts.push(`${i.schema ? 'key' : 'node'} ${i.node}`);
    if (i.decorator !== undefined) parts.push(`decorator ${i.decorator}`);
    if (i.field) parts.push(`field ${i.field}`);
    return `${parts.join(' / ')}: ${i.message}`;
}

/**
 * What makes a problem the same problem before and after an edit, to tell
 * new problems from old ones: its kind and where it is, without its wording
 * (which names schemas and keys that can be renamed) or positions in lists
 * (a decorator added before it moves it). `node` is the node or key id,
 * mapped through the edit's renames. Equal keys are counted, not merged.
 */
export function issueKey(i: Issue, node = i.node): string {
    return [i.severity, i.code, i.tree ?? '', i.schema ?? '', i.object ?? '', i.model ?? '', node ?? '', (i.field ?? '').replace(/\[\d+\]/g, '[]')].join('|');
}

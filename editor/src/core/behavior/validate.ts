// Validation of behavior trees, blackboard schemas and agents. Errors point
// at a node id (and a field); the outliner marks them red, the edit layer
// refuses AI batches that add new ones, and the assistant's validate tool
// returns them. Warnings never block.

import type {
    AgentDoc, BehaviorTreeDoc, BlackboardKeyDoc, BlackboardSchemaDoc, BtDecoratorDoc, BtNodeDoc, BtServiceDoc, MemoryDoc,
    SceneDoc,
} from '../types';
import { isCompositeDoc, memoryChoiceKeys, schemaOf, walkNodes } from './format';
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
}

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
    out: Issue[];
}

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
        }
    }
}

/** {key} placeholders of a text: each names a key of the schema. */
function checkTemplate(ctx: Ctx, v: unknown, label: string, where: Partial<Issue>) {
    if (typeof v !== 'string' || !ctx.schema) return;
    for (const m of v.matchAll(/\{([^{}]+)\}/g)) {
        if (!keyOf(ctx, m[1].trim())) push(ctx, 'error', 'key-missing', `{${m[1]}} in ${label}: no key "${m[1].trim()}" in schema "${ctx.schema.name}".`, where);
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

/** Every problem of one tree. */
export function validateTree(tree: BehaviorTreeDoc, schemas: BlackboardSchemaDoc[], memory?: MemoryDoc): Issue[] {
    const ctx: Ctx = { tree, schema: schemaOf(schemas, tree), memory, out: [] };
    if (!ctx.schema) push(ctx, 'error', 'schema-missing', tree.schema ? `Schema "${tree.schema}" does not exist.` : 'The tree has no blackboard schema.', { field: 'schema' });

    const ids = new Map<string, number>();
    const asks: { id: string; keys: string[]; facts: string[] }[] = [];
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
            if (s.type === 'ask') asks.push({ id: s.id, keys: s.questions.map((q) => q.key), facts: s.facts });
        }
        if (node.type === 'ask') asks.push({ id: node.id, keys: node.questions.map((q) => q.key), facts: node.facts });
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

    // Ownership: every AI key has exactly one Ask.
    const writers = new Map<string, string[]>();
    for (const a of asks) for (const k of a.keys) writers.set(k, [...(writers.get(k) ?? []), a.id]);
    for (const [key, list] of writers) {
        if (list.length > 1) for (const id of list.slice(1)) push(ctx, 'error', 'owner-conflict', `"${key}" is also written by "${list[0]}"; an AI key is written by exactly one Ask.`, { node: id, field: 'questions' });
    }
    if (ctx.schema) {
        const read = new Set<string>();
        walkNodes(tree.root, (n) => {
            for (const d of n.decorators ?? []) if (d.type === 'condition') read.add(d.key);
        });
        for (const k of ctx.schema.keys) {
            if (k.owner === 'ai' && read.has(k.name) && !writers.has(k.name)) push(ctx, 'warning', 'ai-unwritten', `The AI key "${k.name}" is tested but no Ask of this tree writes it; it keeps its default.`, { field: 'schema' });
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
    for (const t of doc.behaviors) out.push(...validateTree(t, doc.blackboards, doc.memory));
    for (const n of doc.nodes) if (n.agent) out.push(...validateAgent(n.id, n.agent, doc));
    return out;
}

/** "tree guard / node threat_gate / field key: message", for tool results and toasts. */
export function describeIssue(i: Issue, names?: { tree?: (id: string) => string; schema?: (id: string) => string }): string {
    const parts: string[] = [];
    if (i.tree) parts.push(`tree ${names?.tree?.(i.tree) ?? i.tree}`);
    if (i.schema) parts.push(`schema ${names?.schema?.(i.schema) ?? i.schema}`);
    if (i.object) parts.push(`object ${i.object}`);
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
    return [i.severity, i.code, i.tree ?? '', i.schema ?? '', i.object ?? '', node ?? '', (i.field ?? '').replace(/\[\d+\]/g, '[]')].join('|');
}

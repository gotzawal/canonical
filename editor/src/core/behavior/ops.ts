// The edit operation layer: the one way behavior trees, blackboard schemas,
// agents and memory are changed. The editor UI and the assistant both send
// batches of operations here. A batch is applied to a copy as a whole or not
// at all, every tree and schema it touches is validated, and the editor
// commits it as one undo step (see Editor.applyBehaviorOps).

import { uid } from '../ids';
import type {
    AgentDoc, BehaviorTreeDoc, BlackboardKeyDoc, BlackboardKeyOwner, BlackboardKeyType, BlackboardSchemaDoc,
    BlackboardValue, BtCompositeDoc, BtDecoratorDoc, BtNodeDoc, BtServiceDoc, EnumValueDoc, MemoryDoc, MemoryItemDoc, NodeDoc,
    SceneDoc,
} from '../types';
import { findNode, findService, isCompositeDoc, newItemId, toReadableId, treeIds, uniqueId, walkNodes } from './format';
import {
    COMMON_FIELDS, decoratorType, DECORATOR_TYPES, fieldDefault, isReadableId, KEY_OWNERS, KEY_TYPES, NODE_TYPES, nodeType,
    serviceType, SERVICE_TYPES, typeDefault, valueFits, type FieldDef, type ItemTypeDef,
} from './nodeTypes';
import { issueKey, validateAgent, validateSchema, validateTree, type Issue } from './validate';

/** One operation: { op: 'add_node', tree: 'Guard', parent: 'root', node: {...} }. See OP_DOCS for the list. */
export type BehaviorOp = { op: string; [field: string]: unknown };

export interface OpError {
    /** Index of the operation in the batch (-1: the validation of the result). */
    op: number;
    name: string;
    message: string;
    tree?: string;
    schema?: string;
    node?: string;
    field?: string;
}

export interface BehaviorChanges {
    blackboards: BlackboardSchemaDoc[];
    behaviors: BehaviorTreeDoc[];
    memory: MemoryDoc;
    /** Objects whose agent changed: the new settings, or null to remove them. */
    agents: Map<string, AgentDoc | null>;
}

export interface Created {
    kind: 'schema' | 'tree' | 'node' | 'service' | 'memory';
    id: string;
    tree?: string;
    name?: string;
}

export interface OpsResult {
    ok: boolean;
    errors: OpError[];
    /** Problems of what the batch touched, after it. */
    issues: Issue[];
    /** Errors the batch would add; strict batches are refused when there are any. */
    added: Issue[];
    created: Created[];
    touched: { trees: string[]; schemas: string[]; objects: string[]; memory: boolean };
    /** The new behavior data, when the batch is ok and changed something. */
    changes: BehaviorChanges | null;
    /** Undo label, e.g. "Add Node" or "5 Behavior Edits". */
    label: string;
}

/**
 * 'strict' (the assistant): a batch that adds validation errors is refused.
 * 'lenient' (the editor UI and the JSON view): it is applied and the errors
 * are shown on the nodes until they are fixed.
 */
export type OpsMode = 'strict' | 'lenient';

class OpFail extends Error {
    constructor(message: string, readonly at: Partial<OpError> = {}) {
        super(message);
    }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// --------------------------------------------------------------- the list

/** Every operation with its fields, for the assistant's tool description and the reference. */
export const OP_DOCS: { op: string; fields: string; description: string }[] = [
    { op: 'create_schema', fields: 'name, keys?: [key], id?', description: 'New blackboard schema.' },
    { op: 'update_schema', fields: 'schema, name', description: 'Rename a schema.' },
    { op: 'delete_schema', fields: 'schema', description: 'Delete a schema no tree uses.' },
    { op: 'add_key', fields: 'schema, key: {name, type, owner, default?, description?, values?: [{value, description}]}, index?', description: 'Add a key.' },
    { op: 'update_key', fields: 'schema, key, set: {name?, type?, owner?, default?, description?, values?}', description: 'Change a key. A new name is also written into every tree and object that uses the key.' },
    { op: 'move_key', fields: 'schema, key, index', description: 'Reorder a key.' },
    { op: 'delete_key', fields: 'schema, key', description: 'Delete a key; refused while nodes use it (the error lists them).' },
    { op: 'create_tree', fields: 'name, schema, root?: node, id?', description: 'New behavior tree; the root defaults to an empty Selector "root".' },
    { op: 'update_tree', fields: 'tree, name?, schema?', description: 'Rename a tree or change its schema.' },
    { op: 'replace_tree', fields: 'tree, root: node, name?, schema?', description: 'Replace the whole tree (the JSON view).' },
    { op: 'delete_tree', fields: 'tree, force?', description: 'Delete a tree; refused while objects use it unless force (which removes their agents).' },
    { op: 'add_node', fields: 'tree, parent, node, index? | before? | after?', description: 'Add a node (with its children, decorators and services) under a Selector or Sequence: at index (0 first, default last), or before / after a sibling id.' },
    { op: 'update_node', fields: 'tree, node, set: {id?, type?, note?, <fields>}', description: 'Change a node\'s fields; set.id renames it; set.type switches Selector and Sequence, or one task type for another.' },
    { op: 'move_node', fields: 'tree, node, parent, index? | before? | after?', description: 'Move a node to another parent or position (index, or before / after a sibling id).' },
    { op: 'delete_node', fields: 'tree, node', description: 'Delete a node and everything under it.' },
    { op: 'duplicate_node', fields: 'tree, node, id?', description: 'Copy a node and its subtree (new ids) right after it.' },
    { op: 'wrap_nodes', fields: 'tree, nodes: [ids], type: selector|sequence, id?', description: 'Put sibling nodes (or the root) into a new Selector or Sequence where the first one was.' },
    { op: 'add_decorator', fields: 'tree, node, decorator: {type, ...fields}, index?', description: 'Attach a decorator.' },
    { op: 'update_decorator', fields: 'tree, node, index, set', description: 'Change a decorator (by its index on the node).' },
    { op: 'remove_decorator', fields: 'tree, node, index', description: 'Remove a decorator.' },
    { op: 'add_service', fields: 'tree, node, service: {type, id?, ...fields}', description: 'Attach a service.' },
    { op: 'update_service', fields: 'tree, service, set', description: 'Change a service (by its id); set.id renames it.' },
    { op: 'remove_service', fields: 'tree, service', description: 'Remove a service.' },
    { op: 'set_agent', fields: 'object, tree?, enabled?, values?: {key: value}', description: 'Make a scene object run a tree, or change its agent settings (values replace the initial value overrides).' },
    { op: 'remove_agent', fields: 'object', description: 'The object no longer runs a tree.' },
    { op: 'add_memory', fields: 'item: {id?, text, tags?}', description: 'Add a memory item (embed it afterwards).' },
    { op: 'update_memory', fields: 'item, set: {id?, text?, tags?}', description: 'Change a memory item; a new text drops its embedding.' },
    { op: 'delete_memory', fields: 'item', description: 'Delete a memory item.' },
    { op: 'set_memory_vectors', fields: 'embedder, vectors: {id: base64}', description: 'Store embeddings (the editor does this when it embeds memory).' },
];

// ---------------------------------------------------------------- draft

class Draft {
    blackboards: BlackboardSchemaDoc[];
    behaviors: BehaviorTreeDoc[];
    memory: MemoryDoc;
    agents = new Map<string, AgentDoc | null>();
    trees = new Set<string>();
    schemas = new Set<string>();
    objects = new Set<string>();
    memoryTouched = false;
    created: Created[] = [];

    constructor(readonly doc: SceneDoc) {
        this.blackboards = JSON.parse(JSON.stringify(doc.blackboards));
        this.behaviors = JSON.parse(JSON.stringify(doc.behaviors));
        this.memory = JSON.parse(JSON.stringify(doc.memory));
    }

    agentOf(id: string): AgentDoc | undefined {
        if (this.agents.has(id)) return this.agents.get(id) ?? undefined;
        return this.doc.nodes.find((n) => n.id === id)?.agent;
    }

    objectsWithAgents(): { node: NodeDoc; agent: AgentDoc }[] {
        const out: { node: NodeDoc; agent: AgentDoc }[] = [];
        for (const node of this.doc.nodes) {
            const agent = this.agentOf(node.id);
            if (agent) out.push({ node, agent });
        }
        return out;
    }

    tree(ref: unknown, field = 'tree'): BehaviorTreeDoc {
        if (typeof ref !== 'string' || !ref) throw new OpFail(`${field} is missing: give a tree id or name.`, { field });
        const t = this.behaviors.find((x) => x.id === ref) ?? byName(this.behaviors, ref, 'tree');
        if (!t) throw new OpFail(`No behavior tree "${ref}". Trees: ${this.behaviors.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}.`, { field });
        return t;
    }

    schema(ref: unknown, field = 'schema'): BlackboardSchemaDoc {
        if (typeof ref !== 'string' || !ref) throw new OpFail(`${field} is missing: give a schema id or name.`, { field });
        const s = this.blackboards.find((x) => x.id === ref) ?? byName(this.blackboards, ref, 'schema');
        if (!s) throw new OpFail(`No blackboard schema "${ref}". Schemas: ${this.blackboards.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}.`, { field });
        return s;
    }

    object(ref: unknown): NodeDoc {
        if (typeof ref !== 'string' || !ref) throw new OpFail('object is missing: give an object id or name.', { field: 'object' });
        const byId = this.doc.nodes.find((n) => n.id === ref);
        if (byId) return byId;
        const named = this.doc.nodes.filter((n) => n.name === ref);
        if (named.length > 1) throw new OpFail(`${named.length} objects are named "${ref}"; use the id (${named.map((n) => n.id).join(', ')}).`, { field: 'object' });
        if (!named.length) throw new OpFail(`No object "${ref}".`, { field: 'object' });
        return named[0];
    }

    touchTree(t: BehaviorTreeDoc) {
        this.trees.add(t.id);
    }
}

function byName<T extends { name: string; id: string }>(list: T[], ref: string, what: string): T | undefined {
    const want = ref.trim().toLowerCase();
    const found = list.filter((x) => x.name.trim().toLowerCase() === want);
    if (found.length > 1) throw new OpFail(`${found.length} ${what}s are named "${ref}"; use the id (${found.map((x) => x.id).join(', ')}).`, { field: what });
    return found[0];
}

function nodeIn(tree: BehaviorTreeDoc, ref: unknown, field = 'node'): { node: BtNodeDoc; parent: BtCompositeDoc | null } {
    if (typeof ref !== 'string' || !ref) throw new OpFail(`${field} is missing: give a node id.`, { tree: tree.id, field });
    const hit = findNode(tree, ref);
    if (!hit) throw new OpFail(`No node "${ref}" in tree "${tree.name}".`, { tree: tree.id, node: ref, field });
    return hit;
}

// ------------------------------------------------------------ field input

function coerceField(f: FieldDef, v: unknown, at: Partial<OpError>): unknown {
    const fail = (msg: string): never => {
        throw new OpFail(msg, { ...at, field: f.name });
    };
    switch (f.kind) {
        case 'number':
        case 'integer':
        case 'seconds':
        case 'unit': {
            const raw = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
            if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail(`${f.name} must be a number.`);
            const n = f.kind === 'integer' ? Math.round(raw) : raw;
            const min = f.kind === 'unit' ? 0 : f.min;
            const max = f.kind === 'unit' ? 1 : f.max;
            if (min !== undefined && n < min) return fail(`${f.name} must be at least ${min}.`);
            if (max !== undefined && n > max) return fail(`${f.name} must be at most ${max}.`);
            return n;
        }
        case 'text':
        case 'template':
            if (typeof v !== 'string') return fail(`${f.name} must be a string.`);
            return v.slice(0, 2000);
        case 'method':
        case 'key':
            if (typeof v !== 'string') return fail(`${f.name} must be a string.`);
            return v.trim();
        case 'bool':
            if (typeof v !== 'boolean') return fail(`${f.name} must be true or false.`);
            return v;
        case 'choice':
            if (!f.choices?.some((c) => c.value === v)) return fail(`${f.name} must be one of ${f.choices?.map((c) => c.value).join(', ')}.`);
            return v;
        case 'flags': {
            if (!Array.isArray(v)) return fail(`${f.name} must be a list of ${f.choices?.map((c) => c.value).join(', ')}.`);
            const out: string[] = [];
            for (const x of v) {
                if (!f.choices?.some((c) => c.value === x)) return fail(`${f.name}: "${x}" is not one of ${f.choices?.map((c) => c.value).join(', ')}.`);
                if (!out.includes(x)) out.push(x);
            }
            return out;
        }
        case 'keys':
        case 'tags': {
            const list = typeof v === 'string' ? v.split(',') : v;
            if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) return fail(`${f.name} must be a list of strings.`);
            const out: string[] = [];
            for (const x of list) {
                const s = x.trim();
                if (s && !out.includes(s)) out.push(s);
            }
            return out;
        }
        case 'value':
            if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return v;
            return fail(`${f.name} must be a bool, number, string or null.`);
        case 'questions': {
            if (!Array.isArray(v)) return fail('questions must be a list of { key, text }.');
            return v.map((q, i) => {
                if (!isObj(q) || typeof q.key !== 'string' || typeof q.text !== 'string') {
                    throw new OpFail(`questions[${i}] must be { key, text } with strings.`, { ...at, field: `questions[${i}]` });
                }
                for (const k of Object.keys(q)) if (k !== 'key' && k !== 'text') throw new OpFail(`questions[${i}] has no field "${k}" (only key and text).`, { ...at, field: `questions[${i}]` });
                return { key: q.key.trim(), text: q.text.slice(0, 1000) };
            });
        }
    }
}

function fieldNames(def: ItemTypeDef): string {
    return def.fields.map((f) => f.name).join(', ') || 'none';
}

/** Applies `set` to an item's fields. `extra` lists other settable names. */
function setFields(def: ItemTypeDef, item: Record<string, any>, set: Record<string, unknown>, at: Partial<OpError>, extra: string[]) {
    for (const [k, v] of Object.entries(set)) {
        if (extra.includes(k)) continue;
        const f = def.fields.find((x) => x.name === k);
        if (!f) throw new OpFail(`${def.label} has no field "${k}"; its fields are ${fieldNames(def)}.`, { ...at, field: k });
        item[k] = coerceField(f, v, at);
    }
}

function readableId(v: unknown, taken: Set<string>, at: Partial<OpError>): string {
    if (!isReadableId(v)) throw new OpFail(`${JSON.stringify(v)} is not a valid id: use letters, digits, _ and - (e.g. threat_gate).`, { ...at, field: 'id' });
    if (taken.has(v)) throw new OpFail(`The id "${v}" is already used in this tree.`, { ...at, field: 'id' });
    return v;
}

function note(v: unknown, at: Partial<OpError>): string | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new OpFail('note must be a string.', { ...at, field: 'note' });
    return v.trim().slice(0, 2000) || undefined;
}

function buildDecorator(input: unknown, at: Partial<OpError>): BtDecoratorDoc {
    if (!isObj(input)) throw new OpFail('A decorator must be an object like { "type": "condition", ... }.', at);
    const def = decoratorType(String(input.type));
    if (!def) throw new OpFail(`Unknown decorator type ${JSON.stringify(input.type)}; use ${DECORATOR_TYPES.map((d) => d.type).join(' or ')}.`, { ...at, field: 'type' });
    const out: Record<string, any> = { type: def.type };
    for (const f of def.fields) out[f.name] = fieldDefault(f);
    const { type: _t, ...rest } = input;
    setFields(def, out, rest, at, []);
    return out as BtDecoratorDoc;
}

function buildService(input: unknown, taken: Set<string>, at: Partial<OpError>): BtServiceDoc {
    if (!isObj(input)) throw new OpFail('A service must be an object like { "type": "ask", ... }.', at);
    const def = serviceType(String(input.type));
    if (!def) throw new OpFail(`Unknown service type ${JSON.stringify(input.type)}; use ${SERVICE_TYPES.map((d) => d.type).join(' or ')}.`, { ...at, field: 'type' });
    const id = input.id === undefined ? newItemId(def.type, taken) : readableId(input.id, taken, at);
    taken.add(id);
    const out: Record<string, any> = { id, type: def.type };
    for (const f of def.fields) out[f.name] = fieldDefault(f);
    const n = note(input.note, { ...at, node: id });
    if (n) out.note = n;
    const { type: _t, id: _i, note: _n, ...rest } = input;
    setFields(def, out, rest, { ...at, node: id }, []);
    return out as BtServiceDoc;
}

/** A node (and its subtree) from operation input, with every field; ids come from `taken`. */
function buildNode(input: unknown, taken: Set<string>, at: Partial<OpError>, isRoot = false, depth = 0): BtNodeDoc {
    if (!isObj(input)) throw new OpFail('A node must be an object like { "type": "sequence", "id": "patrol" }.', at);
    if (depth > 64) throw new OpFail('The tree is too deep.', at);
    const def = nodeType(String(input.type));
    if (!def) throw new OpFail(`Unknown node type ${JSON.stringify(input.type)}; use ${NODE_TYPES.map((d) => d.type).join(', ')}.`, { ...at, field: 'type' });
    const allowed = new Set(['id', 'type', 'note', 'decorators', 'services', 'children', ...def.fields.map((f) => f.name)]);
    for (const k of Object.keys(input)) {
        if (!allowed.has(k)) throw new OpFail(`${def.label} has no field "${k}"; its fields are ${fieldNames(def)} (plus id, note, decorators, services${def.category === 'composite' ? ', children' : ''}).`, { ...at, field: k });
    }
    if (def.category !== 'composite' && input.children !== undefined) throw new OpFail(`A ${def.label} has no children; only Selector and Sequence do.`, { ...at, field: 'children' });
    const id = input.id === undefined ? newItemId(def.type, taken) : readableId(input.id, taken, at);
    taken.add(id);
    const here = { ...at, node: id };
    const node: Record<string, any> = { id, type: def.type };
    for (const f of def.fields) node[f.name] = fieldDefault(f);
    setFields(def, node, Object.fromEntries(def.fields.filter((f) => f.name in input).map((f) => [f.name, input[f.name]])), here, []);
    const n = note(input.note, here);
    if (n) node.note = n;
    if (input.decorators !== undefined) {
        if (!Array.isArray(input.decorators)) throw new OpFail('decorators must be a list.', { ...here, field: 'decorators' });
        if (isRoot && input.decorators.length) throw new OpFail('The root cannot have decorators; wrap it in a Selector or Sequence and decorate that.', { ...here, field: 'decorators' });
        if (input.decorators.length) node.decorators = input.decorators.map((d: unknown) => buildDecorator(d, here));
    }
    if (input.services !== undefined) {
        if (!Array.isArray(input.services)) throw new OpFail('services must be a list.', { ...here, field: 'services' });
        if (input.services.length) node.services = input.services.map((s: unknown) => buildService(s, taken, here));
    }
    if (def.category === 'composite') {
        if (input.children !== undefined && !Array.isArray(input.children)) throw new OpFail('children must be a list of nodes.', { ...here, field: 'children' });
        node.children = ((input.children as unknown[]) ?? []).map((c) => buildNode(c, taken, at, false, depth + 1));
    }
    return node as BtNodeDoc;
}

// --------------------------------------------------------------- keys

function buildValues(v: unknown, at: Partial<OpError>): EnumValueDoc[] {
    if (!Array.isArray(v)) throw new OpFail('values must be a list of { value, description } (or of strings).', { ...at, field: 'values' });
    const out: EnumValueDoc[] = [];
    for (const x of v) {
        const value = typeof x === 'string' ? x.trim() : isObj(x) && typeof x.value === 'string' ? x.value.trim() : '';
        if (!value) throw new OpFail('Every enum value needs a non-empty "value".', { ...at, field: 'values' });
        if (out.some((o) => o.value === value)) throw new OpFail(`The enum value "${value}" is listed twice.`, { ...at, field: 'values' });
        const description = isObj(x) && typeof x.description === 'string' ? x.description.trim().slice(0, 300) : '';
        out.push({ value: value.slice(0, 100), description });
    }
    return out;
}

const KEY_FIELDS = ['name', 'type', 'owner', 'default', 'description', 'values'];

function keyType(v: unknown, at: Partial<OpError>): BlackboardKeyType {
    const t = KEY_TYPES.find((k) => k.type === v);
    if (!t) throw new OpFail(`type must be one of ${KEY_TYPES.map((k) => k.type).join(', ')}.`, { ...at, field: 'type' });
    return t.type;
}

function keyOwner(v: unknown, at: Partial<OpError>): BlackboardKeyOwner {
    const o = KEY_OWNERS.find((k) => k.owner === v);
    if (!o) throw new OpFail(`owner must be one of ${KEY_OWNERS.map((k) => k.owner).join(', ')} (fact: scripts write it, ai: one Ask writes it, tree: Set Key and script tasks write it).`, { ...at, field: 'owner' });
    return o.owner;
}

function buildKey(input: unknown, schema: BlackboardSchemaDoc, at: Partial<OpError>): BlackboardKeyDoc {
    if (!isObj(input)) throw new OpFail('key must be an object like { "name": "threat", "type": "probability", "owner": "ai" }.', at);
    for (const k of Object.keys(input)) if (!KEY_FIELDS.includes(k)) throw new OpFail(`A key has no field "${k}"; use ${KEY_FIELDS.join(', ')}.`, { ...at, field: k });
    if (!isReadableId(input.name)) throw new OpFail(`${JSON.stringify(input.name)} is not a valid key name: use letters, digits, _ and -.`, { ...at, field: 'name' });
    if (schema.keys.some((k) => k.name === input.name)) throw new OpFail(`Schema "${schema.name}" already has a key "${input.name}".`, { ...at, field: 'name' });
    const type = keyType(input.type ?? 'string', at);
    const key: BlackboardKeyDoc = { name: input.name, type, default: null, description: '', owner: keyOwner(input.owner ?? 'fact', at) };
    if (input.description !== undefined) {
        if (typeof input.description !== 'string') throw new OpFail('description must be a string.', { ...at, field: 'description' });
        key.description = input.description.trim().slice(0, 2000);
    }
    if (type === 'enum') key.values = input.values === undefined ? [] : buildValues(input.values, at);
    else if (input.values !== undefined) throw new OpFail('Only enum keys have values.', { ...at, field: 'values' });
    key.default = input.default === undefined ? typeDefault(type, key.values) : (input.default as BlackboardValue);
    if (!valueFits(key, key.default)) throw new OpFail(`The default ${JSON.stringify(input.default)} does not fit a ${type} key${type === 'enum' ? ` (values: ${key.values!.map((v) => v.value).join(', ') || 'none'})` : ''}.`, { ...at, field: 'default' });
    return key;
}

/** Where a key is used: node ids per tree, and objects with an initial value for it. */
export function keyUsers(doc: Pick<SceneDoc, 'behaviors' | 'nodes'>, schemaId: string, name: string, agentOf?: (id: string) => AgentDoc | undefined): { trees: { tree: BehaviorTreeDoc; nodes: string[] }[]; objects: NodeDoc[] } {
    const trees: { tree: BehaviorTreeDoc; nodes: string[] }[] = [];
    const placeholder = new RegExp(`\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}`);
    for (const tree of doc.behaviors) {
        if (tree.schema !== schemaId) continue;
        const nodes = new Set<string>();
        const visit = (id: string, item: any) => {
            if (item.key === name) nodes.add(id);
            if (Array.isArray(item.facts) && item.facts.includes(name)) nodes.add(id);
            if (Array.isArray(item.questions) && item.questions.some((q: any) => q.key === name)) nodes.add(id);
            for (const t of [item.query, item.memoryQuery]) if (typeof t === 'string' && placeholder.test(t)) nodes.add(id);
        };
        walkNodes(tree.root, (n) => {
            visit(n.id, n);
            for (const d of n.decorators ?? []) visit(n.id, d);
            for (const s of n.services ?? []) visit(s.id, s);
        });
        if (nodes.size) trees.push({ tree, nodes: Array.from(nodes) });
    }
    const treeIds = new Set(doc.behaviors.filter((t) => t.schema === schemaId).map((t) => t.id));
    const objects = doc.nodes.filter((n) => {
        const a = agentOf ? agentOf(n.id) : n.agent;
        return a && treeIds.has(a.tree) && name in a.values;
    });
    return { trees, objects };
}

function renameKeyEverywhere(d: Draft, schema: BlackboardSchemaDoc, from: string, to: string) {
    const placeholder = new RegExp(`\\{\\s*${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}`, 'g');
    const fix = (item: any) => {
        if (item.key === from) item.key = to;
        if (Array.isArray(item.facts)) item.facts = item.facts.map((k: string) => (k === from ? to : k));
        if (Array.isArray(item.questions)) for (const q of item.questions) if (q.key === from) q.key = to;
        for (const f of ['query', 'memoryQuery']) if (typeof item[f] === 'string') item[f] = item[f].replace(placeholder, `{${to}}`);
    };
    for (const tree of d.behaviors) {
        if (tree.schema !== schema.id) continue;
        let hit = false;
        walkNodes(tree.root, (n) => {
            const before = JSON.stringify(n);
            fix(n);
            for (const dec of n.decorators ?? []) fix(dec);
            for (const s of n.services ?? []) fix(s);
            if (JSON.stringify(n) !== before) hit = true;
        });
        if (hit) d.touchTree(tree);
        // Objects running this tree keep their initial value under the new name.
        for (const { node, agent } of d.objectsWithAgents()) {
            if (agent.tree !== tree.id || !(from in agent.values)) continue;
            const values: Record<string, BlackboardValue> = {};
            for (const [k, v] of Object.entries(agent.values)) values[k === from ? to : k] = v;
            d.agents.set(node.id, { ...agent, values });
            d.objects.add(node.id);
        }
    }
}

// ------------------------------------------------------------- operations

function need<T>(op: BehaviorOp, field: string): T {
    if (op[field] === undefined || op[field] === null) throw new OpFail(`${op.op} needs "${field}".`, { field });
    return op[field] as T;
}

function allowOnly(op: BehaviorOp, fields: string[]) {
    for (const k of Object.keys(op)) {
        if (k !== 'op' && !fields.includes(k)) throw new OpFail(`${op.op} has no field "${k}"; it takes ${fields.join(', ')}.`, { field: k });
    }
}

function index(v: unknown, length: number): number {
    if (v === undefined || v === null) return length;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new OpFail('index must be a whole number.', { field: 'index' });
    return Math.max(0, Math.min(length, n < 0 ? length + 1 + n : n));
}

/** Where to insert into a parent's children: index, or before / after a sibling (after the node itself was taken out). */
function placement(op: BehaviorOp, parent: BtCompositeDoc, tree: BehaviorTreeDoc): number {
    const sibling = op.before ?? op.after;
    if (sibling === undefined) return index(op.index, parent.children.length);
    if (op.index !== undefined) throw new OpFail('Give index or before / after, not both.', { tree: tree.id, field: 'index' });
    const i = parent.children.findIndex((c) => c.id === sibling);
    if (i < 0) throw new OpFail(`"${sibling}" is not a child of "${parent.id}".`, { tree: tree.id, node: String(sibling), field: op.before !== undefined ? 'before' : 'after' });
    return op.before !== undefined ? i : i + 1;
}

function asComposite(tree: BehaviorTreeDoc, ref: unknown, field = 'parent'): BtCompositeDoc {
    const { node } = nodeIn(tree, ref, field);
    if (!isCompositeDoc(node)) throw new OpFail(`"${node.id}" is a ${nodeType(node.type)?.label ?? node.type}; only Selector and Sequence nodes have children.`, { tree: tree.id, node: node.id, field });
    return node;
}

function isInside(root: BtNodeDoc, id: string): boolean {
    let found = false;
    walkNodes(root, (n) => {
        if (n.id === id) found = true;
    });
    return found;
}

function copyWithNewIds(node: BtNodeDoc, taken: Set<string>, rootId?: string): BtNodeDoc {
    const copy: BtNodeDoc = JSON.parse(JSON.stringify(node));
    let first = true;
    walkNodes(copy, (n) => {
        n.id = first && rootId ? rootId : uniqueId(`${n.id}_copy`, taken);
        first = false;
        taken.add(n.id);
        for (const s of n.services ?? []) {
            s.id = uniqueId(`${s.id}_copy`, taken);
            taken.add(s.id);
        }
    });
    return copy;
}

function apply(d: Draft, op: BehaviorOp) {
    switch (op.op) {
        // ------------------------------------------------------ schemas
        case 'create_schema': {
            allowOnly(op, ['name', 'keys', 'id']);
            const name = String(need<string>(op, 'name')).trim();
            if (!name) throw new OpFail('name is empty.', { field: 'name' });
            if (d.blackboards.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new OpFail(`A schema named "${name}" exists already.`, { field: 'name' });
            const id = op.id === undefined ? uid('bb') : String(op.id);
            if (d.blackboards.some((s) => s.id === id) || !id) throw new OpFail(`The schema id "${id}" is taken.`, { field: 'id' });
            const schema: BlackboardSchemaDoc = { id, name, version: 1, keys: [] };
            if (op.keys !== undefined) {
                if (!Array.isArray(op.keys)) throw new OpFail('keys must be a list.', { field: 'keys' });
                op.keys.forEach((k, i) => schema.keys.push(buildKey(k, schema, { schema: id, field: `keys[${i}]` })));
            }
            d.blackboards.push(schema);
            d.schemas.add(id);
            d.created.push({ kind: 'schema', id, name });
            return;
        }
        case 'update_schema': {
            allowOnly(op, ['schema', 'name']);
            const s = d.schema(op.schema);
            const name = String(need<string>(op, 'name')).trim();
            if (!name) throw new OpFail('name is empty.', { schema: s.id, field: 'name' });
            if (d.blackboards.some((x) => x !== s && x.name.toLowerCase() === name.toLowerCase())) throw new OpFail(`A schema named "${name}" exists already.`, { schema: s.id, field: 'name' });
            s.name = name;
            d.schemas.add(s.id);
            return;
        }
        case 'delete_schema': {
            allowOnly(op, ['schema']);
            const s = d.schema(op.schema);
            const users = d.behaviors.filter((t) => t.schema === s.id);
            if (users.length) throw new OpFail(`Schema "${s.name}" is used by ${users.map((t) => `"${t.name}"`).join(', ')}; delete those trees or give them another schema first.`, { schema: s.id });
            d.blackboards = d.blackboards.filter((x) => x !== s);
            d.schemas.add(s.id);
            return;
        }
        case 'add_key': {
            allowOnly(op, ['schema', 'key', 'index']);
            const s = d.schema(op.schema);
            const key = buildKey(need(op, 'key'), s, { schema: s.id, field: 'key' });
            s.keys.splice(index(op.index, s.keys.length), 0, key);
            d.schemas.add(s.id);
            return;
        }
        case 'update_key': {
            allowOnly(op, ['schema', 'key', 'set']);
            const s = d.schema(op.schema);
            const name = String(need<string>(op, 'key'));
            const key = s.keys.find((k) => k.name === name);
            if (!key) throw new OpFail(`Schema "${s.name}" has no key "${name}". Keys: ${s.keys.map((k) => k.name).join(', ') || 'none'}.`, { schema: s.id, field: 'key' });
            const set = need<Record<string, unknown>>(op, 'set');
            if (!isObj(set)) throw new OpFail('set must be an object.', { schema: s.id, field: 'set' });
            const at = { schema: s.id, node: key.name };
            for (const k of Object.keys(set)) if (!KEY_FIELDS.includes(k)) throw new OpFail(`A key has no field "${k}"; use ${KEY_FIELDS.join(', ')}.`, { ...at, field: k });
            if (set.type !== undefined) {
                key.type = keyType(set.type, at);
                if (key.type === 'enum') key.values ??= [];
                else delete key.values;
            }
            if (set.owner !== undefined) key.owner = keyOwner(set.owner, at);
            if (set.description !== undefined) {
                if (typeof set.description !== 'string') throw new OpFail('description must be a string.', { ...at, field: 'description' });
                key.description = set.description.trim().slice(0, 2000);
            }
            if (set.values !== undefined) {
                if (key.type !== 'enum') throw new OpFail('Only enum keys have values.', { ...at, field: 'values' });
                key.values = buildValues(set.values, at);
            }
            if (set.default !== undefined) {
                if (!valueFits(key, set.default)) throw new OpFail(`The default ${JSON.stringify(set.default)} does not fit a ${key.type} key.`, { ...at, field: 'default' });
                key.default = set.default as BlackboardValue;
            } else if (!valueFits(key, key.default)) {
                key.default = typeDefault(key.type, key.values);
            }
            if (set.name !== undefined && set.name !== key.name) {
                if (!isReadableId(set.name)) throw new OpFail(`${JSON.stringify(set.name)} is not a valid key name.`, { ...at, field: 'name' });
                if (s.keys.some((k) => k.name === set.name)) throw new OpFail(`Schema "${s.name}" already has a key "${set.name}".`, { ...at, field: 'name' });
                const from = key.name;
                key.name = set.name;
                renameKeyEverywhere(d, s, from, set.name);
            }
            d.schemas.add(s.id);
            return;
        }
        case 'move_key': {
            allowOnly(op, ['schema', 'key', 'index']);
            const s = d.schema(op.schema);
            const i = s.keys.findIndex((k) => k.name === op.key);
            if (i < 0) throw new OpFail(`Schema "${s.name}" has no key "${op.key}".`, { schema: s.id, field: 'key' });
            const [key] = s.keys.splice(i, 1);
            s.keys.splice(index(need(op, 'index'), s.keys.length), 0, key);
            d.schemas.add(s.id);
            return;
        }
        case 'delete_key': {
            allowOnly(op, ['schema', 'key']);
            const s = d.schema(op.schema);
            const name = String(need<string>(op, 'key'));
            if (!s.keys.some((k) => k.name === name)) throw new OpFail(`Schema "${s.name}" has no key "${name}".`, { schema: s.id, field: 'key' });
            const users = keyUsers({ behaviors: d.behaviors, nodes: d.doc.nodes }, s.id, name, (id) => d.agentOf(id));
            if (users.trees.length || users.objects.length) {
                const list = [
                    ...users.trees.map((u) => `tree "${u.tree.name}": ${u.nodes.join(', ')}`),
                    ...(users.objects.length ? [`initial values of ${users.objects.map((n) => `"${n.name}"`).join(', ')}`] : []),
                ];
                throw new OpFail(`"${name}" is in use and cannot be deleted. Used by ${list.join('; ')}.`, { schema: s.id, node: name });
            }
            s.keys = s.keys.filter((k) => k.name !== name);
            d.schemas.add(s.id);
            return;
        }
        // -------------------------------------------------------- trees
        case 'create_tree': {
            allowOnly(op, ['name', 'schema', 'root', 'id']);
            const name = String(need<string>(op, 'name')).trim();
            if (!name) throw new OpFail('name is empty.', { field: 'name' });
            if (d.behaviors.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new OpFail(`A tree named "${name}" exists already.`, { field: 'name' });
            const schema = d.schema(need(op, 'schema'));
            const id = op.id === undefined ? uid('bt') : String(op.id);
            if (!id || d.behaviors.some((t) => t.id === id)) throw new OpFail(`The tree id "${id}" is taken.`, { field: 'id' });
            const root = op.root === undefined ? ({ id: 'root', type: 'selector', children: [] } as BtNodeDoc) : buildNode(op.root, new Set(), { tree: id }, true);
            const tree: BehaviorTreeDoc = { id, name, version: 1, schema: schema.id, root };
            d.behaviors.push(tree);
            d.touchTree(tree);
            d.created.push({ kind: 'tree', id, name });
            return;
        }
        case 'update_tree': {
            allowOnly(op, ['tree', 'name', 'schema']);
            const t = d.tree(op.tree);
            if (op.name !== undefined) {
                const name = String(op.name).trim();
                if (!name) throw new OpFail('name is empty.', { tree: t.id, field: 'name' });
                if (d.behaviors.some((x) => x !== t && x.name.toLowerCase() === name.toLowerCase())) throw new OpFail(`A tree named "${name}" exists already.`, { tree: t.id, field: 'name' });
                t.name = name;
            }
            if (op.schema !== undefined) t.schema = d.schema(op.schema).id;
            d.touchTree(t);
            return;
        }
        case 'replace_tree': {
            allowOnly(op, ['tree', 'root', 'name', 'schema']);
            const t = d.tree(op.tree);
            t.root = buildNode(need(op, 'root'), new Set(), { tree: t.id }, true);
            if (op.name !== undefined) {
                const name = String(op.name).trim();
                if (name && d.behaviors.some((x) => x !== t && x.name.toLowerCase() === name.toLowerCase())) throw new OpFail(`A tree named "${name}" exists already.`, { tree: t.id, field: 'name' });
                if (name) t.name = name;
            }
            if (op.schema !== undefined) t.schema = d.schema(op.schema).id;
            d.touchTree(t);
            return;
        }
        case 'delete_tree': {
            allowOnly(op, ['tree', 'force']);
            const t = d.tree(op.tree);
            const users = d.objectsWithAgents().filter((x) => x.agent.tree === t.id);
            if (users.length && op.force !== true) {
                throw new OpFail(`Tree "${t.name}" runs on ${users.map((u) => `"${u.node.name}"`).join(', ')}; remove their agents first (or pass force: true).`, { tree: t.id });
            }
            for (const u of users) {
                d.agents.set(u.node.id, null);
                d.objects.add(u.node.id);
            }
            d.behaviors = d.behaviors.filter((x) => x !== t);
            d.trees.add(t.id);
            return;
        }
        // -------------------------------------------------------- nodes
        case 'add_node': {
            allowOnly(op, ['tree', 'parent', 'node', 'index', 'before', 'after']);
            const t = d.tree(op.tree);
            const parent = asComposite(t, need(op, 'parent'));
            const node = buildNode(need(op, 'node'), treeIds(t), { tree: t.id });
            parent.children.splice(placement(op, parent, t), 0, node);
            d.touchTree(t);
            walkNodes(node, (n) => d.created.push({ kind: 'node', id: n.id, tree: t.id }));
            return;
        }
        case 'update_node': {
            allowOnly(op, ['tree', 'node', 'set']);
            const t = d.tree(op.tree);
            const { node, parent } = nodeIn(t, op.node);
            const set = need<Record<string, unknown>>(op, 'set');
            if (!isObj(set)) throw new OpFail('set must be an object.', { tree: t.id, node: node.id, field: 'set' });
            const at = { tree: t.id, node: node.id };
            for (const k of ['children', 'decorators', 'services']) {
                if (k in set) throw new OpFail(`Change ${k} with their own operations (add_node / move_node, add_decorator, add_service...).`, { ...at, field: k });
            }
            let target: any = node;
            if (set.type !== undefined && set.type !== node.type) {
                const next = nodeType(String(set.type));
                if (!next) throw new OpFail(`Unknown node type ${JSON.stringify(set.type)}; use ${NODE_TYPES.map((x) => x.type).join(', ')}.`, { ...at, field: 'type' });
                const composite = isCompositeDoc(node);
                if (composite && next.category !== 'composite' && (node as BtCompositeDoc).children.length) {
                    throw new OpFail(`"${node.id}" has children; move or delete them before making it a ${next.label}.`, { ...at, field: 'type' });
                }
                // The node keeps its id, note, decorators and services (and children between composites).
                const fresh: Record<string, any> = { id: node.id, type: next.type };
                for (const f of next.fields) fresh[f.name] = fieldDefault(f);
                if (node.note) fresh.note = node.note;
                if (node.decorators) fresh.decorators = node.decorators;
                if (node.services) fresh.services = node.services;
                if (next.category === 'composite') fresh.children = composite ? (node as BtCompositeDoc).children : [];
                target = fresh;
                if (parent) parent.children[parent.children.indexOf(node)] = fresh as BtNodeDoc;
                else t.root = fresh as BtNodeDoc;
            }
            const def = nodeType(target.type)!;
            if (set.id !== undefined && set.id !== target.id) {
                const taken = treeIds(t);
                taken.delete(target.id);
                target.id = readableId(set.id, taken, at);
            }
            if (set.note !== undefined) {
                const n = note(set.note, at);
                if (n) target.note = n;
                else delete target.note;
            }
            setFields(def, target, set, at, ['id', 'type', 'note']);
            d.touchTree(t);
            return;
        }
        case 'move_node': {
            allowOnly(op, ['tree', 'node', 'parent', 'index', 'before', 'after']);
            const t = d.tree(op.tree);
            const { node, parent: from } = nodeIn(t, op.node);
            if (!from) throw new OpFail('The root cannot be moved.', { tree: t.id, node: node.id });
            const to = asComposite(t, need(op, 'parent'));
            if (isInside(node, to.id)) throw new OpFail(`"${node.id}" cannot move into itself or its own children.`, { tree: t.id, node: node.id, field: 'parent' });
            if (op.before === node.id || op.after === node.id) throw new OpFail(`"${node.id}" cannot be placed next to itself.`, { tree: t.id, node: node.id });
            from.children.splice(from.children.indexOf(node), 1);
            to.children.splice(placement(op, to, t), 0, node);
            d.touchTree(t);
            return;
        }
        case 'delete_node': {
            allowOnly(op, ['tree', 'node']);
            const t = d.tree(op.tree);
            const { node, parent } = nodeIn(t, op.node);
            if (!parent) throw new OpFail('The root cannot be deleted; change its type or replace the tree.', { tree: t.id, node: node.id });
            parent.children.splice(parent.children.indexOf(node), 1);
            d.touchTree(t);
            return;
        }
        case 'duplicate_node': {
            allowOnly(op, ['tree', 'node', 'id']);
            const t = d.tree(op.tree);
            const { node, parent } = nodeIn(t, op.node);
            if (!parent) throw new OpFail('The root cannot be duplicated.', { tree: t.id, node: node.id });
            const taken = treeIds(t);
            const rootId = op.id === undefined ? undefined : readableId(op.id, taken, { tree: t.id, node: node.id });
            const copy = copyWithNewIds(node, taken, rootId);
            parent.children.splice(parent.children.indexOf(node) + 1, 0, copy);
            d.touchTree(t);
            walkNodes(copy, (n) => d.created.push({ kind: 'node', id: n.id, tree: t.id }));
            return;
        }
        case 'wrap_nodes': {
            allowOnly(op, ['tree', 'nodes', 'type', 'id']);
            const t = d.tree(op.tree);
            const ids = need<unknown[]>(op, 'nodes');
            if (!Array.isArray(ids) || !ids.length) throw new OpFail('nodes must be a list of node ids.', { tree: t.id, field: 'nodes' });
            const type = String(need(op, 'type'));
            if (type !== 'selector' && type !== 'sequence') throw new OpFail('type must be selector or sequence.', { tree: t.id, field: 'type' });
            const taken = treeIds(t);
            const id = op.id === undefined ? newItemId(type, taken) : readableId(op.id, taken, { tree: t.id });
            const hits = ids.map((r) => nodeIn(t, r, 'nodes'));
            if (hits.length === 1 && !hits[0].parent) {
                t.root = { id, type, children: [t.root] } as BtNodeDoc;
            } else {
                const parent = hits[0].parent;
                if (!parent || hits.some((h) => h.parent !== parent)) throw new OpFail('Only siblings (nodes with the same parent) can be wrapped together.', { tree: t.id, field: 'nodes' });
                const nodes = parent.children.filter((c) => hits.some((h) => h.node === c));
                const at = parent.children.indexOf(nodes[0]);
                parent.children = parent.children.filter((c) => !nodes.includes(c));
                parent.children.splice(at, 0, { id, type, children: nodes } as BtNodeDoc);
            }
            d.touchTree(t);
            d.created.push({ kind: 'node', id, tree: t.id });
            return;
        }
        // --------------------------------------------------- decorators
        case 'add_decorator': {
            allowOnly(op, ['tree', 'node', 'decorator', 'index']);
            const t = d.tree(op.tree);
            const { node, parent } = nodeIn(t, op.node);
            if (!parent) throw new OpFail('The root cannot have decorators; wrap it in a Selector or Sequence and decorate that.', { tree: t.id, node: node.id });
            const dec = buildDecorator(need(op, 'decorator'), { tree: t.id, node: node.id });
            node.decorators ??= [];
            node.decorators.splice(index(op.index, node.decorators.length), 0, dec);
            d.touchTree(t);
            return;
        }
        case 'update_decorator':
        case 'remove_decorator': {
            allowOnly(op, op.op === 'update_decorator' ? ['tree', 'node', 'index', 'set'] : ['tree', 'node', 'index']);
            const t = d.tree(op.tree);
            const { node } = nodeIn(t, op.node);
            const list = node.decorators ?? [];
            const i = Number(need(op, 'index'));
            if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new OpFail(`"${node.id}" has ${list.length} decorator${list.length === 1 ? '' : 's'}; index ${op.index} is out of range.`, { tree: t.id, node: node.id, field: 'index' });
            const at = { tree: t.id, node: node.id };
            if (op.op === 'remove_decorator') {
                list.splice(i, 1);
                if (!list.length) delete node.decorators;
            } else {
                const set = need<Record<string, unknown>>(op, 'set');
                if (!isObj(set)) throw new OpFail('set must be an object.', { ...at, field: 'set' });
                let dec: any = list[i];
                if (set.type !== undefined && set.type !== dec.type) {
                    dec = buildDecorator({ type: set.type }, at);
                    list[i] = dec;
                }
                setFields(decoratorType(dec.type)!, dec, set, at, ['type']);
            }
            d.touchTree(t);
            return;
        }
        // ----------------------------------------------------- services
        case 'add_service': {
            allowOnly(op, ['tree', 'node', 'service', 'index']);
            const t = d.tree(op.tree);
            const { node } = nodeIn(t, op.node);
            const s = buildService(need(op, 'service'), treeIds(t), { tree: t.id, node: node.id });
            node.services ??= [];
            node.services.splice(index(op.index, node.services.length), 0, s);
            d.touchTree(t);
            d.created.push({ kind: 'service', id: s.id, tree: t.id });
            return;
        }
        case 'update_service':
        case 'remove_service': {
            allowOnly(op, op.op === 'update_service' ? ['tree', 'service', 'set'] : ['tree', 'service']);
            const t = d.tree(op.tree);
            const ref = String(need(op, 'service'));
            const hit = findService(t, ref);
            if (!hit) throw new OpFail(`No service "${ref}" in tree "${t.name}".`, { tree: t.id, node: ref, field: 'service' });
            const at = { tree: t.id, node: hit.service.id };
            if (op.op === 'remove_service') {
                hit.host.services = hit.host.services!.filter((s) => s !== hit.service);
                if (!hit.host.services.length) delete hit.host.services;
            } else {
                const set = need<Record<string, unknown>>(op, 'set');
                if (!isObj(set)) throw new OpFail('set must be an object.', { ...at, field: 'set' });
                let s: any = hit.service;
                if (set.type !== undefined && set.type !== s.type) {
                    const taken = treeIds(t);
                    taken.delete(s.id);
                    const fresh: any = buildService({ type: set.type, id: s.id }, taken, at);
                    hit.host.services![hit.host.services!.indexOf(hit.service)] = fresh;
                    s = fresh;
                }
                if (set.id !== undefined && set.id !== s.id) {
                    const taken = treeIds(t);
                    taken.delete(s.id);
                    s.id = readableId(set.id, taken, at);
                }
                if (set.note !== undefined) {
                    const n = note(set.note, at);
                    if (n) s.note = n;
                    else delete s.note;
                }
                setFields(serviceType(s.type)!, s, set, at, ['id', 'type', 'note']);
            }
            d.touchTree(t);
            return;
        }
        // ------------------------------------------------------- agents
        case 'set_agent': {
            allowOnly(op, ['object', 'tree', 'enabled', 'values']);
            const obj = d.object(op.object);
            const cur = d.agentOf(obj.id);
            if (!cur && op.tree === undefined) throw new OpFail(`"${obj.name}" has no agent yet; give the tree it runs.`, { field: 'tree' });
            const agent: AgentDoc = cur ? { ...cur, values: { ...cur.values } } : { tree: '', enabled: true, values: {} };
            if (op.tree !== undefined) agent.tree = d.tree(op.tree).id;
            if (op.enabled !== undefined) {
                if (typeof op.enabled !== 'boolean') throw new OpFail('enabled must be true or false.', { field: 'enabled' });
                agent.enabled = op.enabled;
            }
            if (op.values !== undefined) {
                if (!isObj(op.values)) throw new OpFail('values must be an object of key: value.', { field: 'values' });
                agent.values = {};
                for (const [k, v] of Object.entries(op.values)) {
                    if (!isReadableId(k)) throw new OpFail(`"${k}" is not a key name.`, { field: `values.${k}` });
                    if (!(v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) throw new OpFail(`values.${k} must be a bool, number, string or null.`, { field: `values.${k}` });
                    agent.values[k] = v as BlackboardValue;
                }
            }
            d.agents.set(obj.id, agent);
            d.objects.add(obj.id);
            return;
        }
        case 'remove_agent': {
            allowOnly(op, ['object']);
            const obj = d.object(op.object);
            if (!d.agentOf(obj.id)) throw new OpFail(`"${obj.name}" has no agent.`, { field: 'object' });
            d.agents.set(obj.id, null);
            d.objects.add(obj.id);
            return;
        }
        // ------------------------------------------------------- memory
        case 'add_memory': {
            allowOnly(op, ['item']);
            const item = need<Record<string, unknown>>(op, 'item');
            if (!isObj(item)) throw new OpFail('item must be { id?, text, tags? }.', { field: 'item' });
            const text = typeof item.text === 'string' ? item.text.trim().slice(0, 4000) : '';
            if (!text) throw new OpFail('item.text is empty.', { field: 'item.text' });
            const taken = new Set(d.memory.items.map((m) => m.id));
            let id: string;
            if (item.id === undefined) id = uniqueId(toReadableId(text.split(/\s+/).slice(0, 4).join('_').toLowerCase(), 'memory'), taken);
            else if (!isReadableId(item.id)) throw new OpFail(`${JSON.stringify(item.id)} is not a valid id.`, { field: 'item.id' });
            else if (taken.has(item.id)) throw new OpFail(`A memory item "${item.id}" exists already.`, { field: 'item.id' });
            else id = item.id;
            const tags = item.tags === undefined ? [] : (coerceField({ name: 'tags', kind: 'tags', label: 'Tags', description: '', default: [] }, item.tags, { field: 'item.tags' }) as string[]);
            d.memory.items.push({ id, text, tags });
            d.memoryTouched = true;
            d.created.push({ kind: 'memory', id });
            return;
        }
        case 'update_memory': {
            allowOnly(op, ['item', 'set']);
            const it = d.memory.items.find((m) => m.id === op.item);
            if (!it) throw new OpFail(`No memory item "${op.item}".`, { field: 'item' });
            const set = need<Record<string, unknown>>(op, 'set');
            if (!isObj(set)) throw new OpFail('set must be an object.', { field: 'set' });
            for (const k of Object.keys(set)) if (!['id', 'text', 'tags'].includes(k)) throw new OpFail(`A memory item has no field "${k}"; use id, text, tags.`, { field: k });
            if (set.id !== undefined && set.id !== it.id) {
                if (!isReadableId(set.id)) throw new OpFail(`${JSON.stringify(set.id)} is not a valid id.`, { field: 'id' });
                if (d.memory.items.some((m) => m.id === set.id)) throw new OpFail(`A memory item "${set.id}" exists already.`, { field: 'id' });
                it.id = set.id;
            }
            if (set.text !== undefined) {
                const text = typeof set.text === 'string' ? set.text.trim().slice(0, 4000) : '';
                if (!text) throw new OpFail('text is empty.', { field: 'text' });
                if (text !== it.text) delete it.vector;
                it.text = text;
            }
            if (set.tags !== undefined) it.tags = coerceField({ name: 'tags', kind: 'tags', label: 'Tags', description: '', default: [] }, set.tags, {}) as string[];
            d.memoryTouched = true;
            return;
        }
        case 'delete_memory': {
            allowOnly(op, ['item']);
            const before = d.memory.items.length;
            d.memory.items = d.memory.items.filter((m) => m.id !== op.item);
            if (d.memory.items.length === before) throw new OpFail(`No memory item "${op.item}".`, { field: 'item' });
            d.memoryTouched = true;
            return;
        }
        case 'set_memory_vectors': {
            allowOnly(op, ['embedder', 'vectors']);
            const embedder = String(need(op, 'embedder'));
            const vectors = need<Record<string, unknown>>(op, 'vectors');
            if (!isObj(vectors)) throw new OpFail('vectors must be an object of id: base64.', { field: 'vectors' });
            if (embedder !== d.memory.embedder) {
                // Vectors of another model cannot be compared with these: drop the old ones.
                for (const it of d.memory.items) delete it.vector;
                d.memory.embedder = embedder;
            }
            for (const [id, v] of Object.entries(vectors)) {
                const it: MemoryItemDoc | undefined = d.memory.items.find((m) => m.id === id);
                if (it && typeof v === 'string' && /^[A-Za-z0-9+/=]+$/.test(v)) it.vector = v;
            }
            d.memoryTouched = true;
            return;
        }
    }
    throw new OpFail(`Unknown operation ${JSON.stringify(op.op)}. Use one of: ${OP_DOCS.map((o) => o.op).join(', ')}.`, { field: 'op' });
}

// ----------------------------------------------------------------- batch

function label(ops: BehaviorOp[]): string {
    if (ops.length !== 1) return `${ops.length} Behavior Edits`;
    return String(ops[0].op)
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/** Validation problems of the given trees, schemas and objects in a document state. */
function issuesOf(state: Pick<SceneDoc, 'behaviors' | 'blackboards' | 'memory'>, agentOf: (id: string) => AgentDoc | undefined, trees: Set<string>, schemas: Set<string>, objects: Set<string>): Issue[] {
    const out: Issue[] = [];
    for (const s of state.blackboards) if (schemas.has(s.id)) out.push(...validateSchema(s));
    for (const t of state.behaviors) if (trees.has(t.id)) out.push(...validateTree(t, state.blackboards, state.memory));
    for (const id of objects) {
        const a = agentOf(id);
        if (a) out.push(...validateAgent(id, a, state));
    }
    return out;
}

/**
 * Applies a batch of operations to a copy of the document's behavior data.
 * Nothing changes when an operation fails; the result says which one and
 * where. The caller commits `changes` (Editor.applyBehaviorOps).
 */
export function applyBehaviorOps(doc: SceneDoc, input: unknown, mode: OpsMode): OpsResult {
    const ops: BehaviorOp[] = Array.isArray(input) ? input : [];
    const result: OpsResult = { ok: false, errors: [], issues: [], added: [], created: [], touched: { trees: [], schemas: [], objects: [], memory: false }, changes: null, label: label(ops) };
    if (!Array.isArray(input) || !ops.length) {
        result.errors.push({ op: -1, name: 'batch', message: 'ops must be a non-empty list of operations.' });
        return result;
    }
    const d = new Draft(doc);
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const name = isObj(op) && typeof op.op === 'string' ? op.op : '?';
        try {
            if (!isObj(op) || typeof op.op !== 'string') throw new OpFail('Every operation is an object with an "op" field.');
            apply(d, op);
        } catch (e) {
            if (!(e instanceof OpFail)) throw e;
            result.errors.push({ op: i, name, message: e.message, ...e.at });
            return result;
        }
    }
    // Trees that use a changed schema, and objects that run a changed tree, are checked too.
    const trees = new Set(d.trees);
    for (const t of d.behaviors) if (d.schemas.has(t.schema)) trees.add(t.id);
    const objects = new Set(d.objects);
    for (const { node, agent } of d.objectsWithAgents()) if (trees.has(agent.tree) || d.schemas.size) objects.add(node.id);
    const liveAgent = (id: string) => doc.nodes.find((n) => n.id === id)?.agent;
    const before = new Set(issuesOf(doc, liveAgent, trees, d.schemas, objects).map(issueKey));
    const after = issuesOf({ behaviors: d.behaviors, blackboards: d.blackboards, memory: d.memory }, (id) => d.agentOf(id), trees, d.schemas, objects);
    result.issues = after;
    result.added = after.filter((i) => i.severity === 'error' && !before.has(issueKey(i)));
    result.created = d.created;
    result.touched = { trees: Array.from(d.trees), schemas: Array.from(d.schemas), objects: Array.from(d.objects), memory: d.memoryTouched };
    if (mode === 'strict' && result.added.length) {
        result.errors = result.added.map((i) => ({ op: -1, name: 'validate', message: i.message, tree: i.tree, schema: i.schema, node: i.node, field: i.field }));
        return result;
    }
    // Every edited tree and schema gets a new revision (new ones start at 1).
    const created = new Set(d.created.filter((c) => c.kind === 'tree' || c.kind === 'schema').map((c) => c.id));
    for (const t of d.behaviors) if (d.trees.has(t.id) && !created.has(t.id)) t.version++;
    for (const s of d.blackboards) if (d.schemas.has(s.id) && !created.has(s.id)) s.version++;
    result.ok = true;
    const changed = d.trees.size || d.schemas.size || d.objects.size || d.memoryTouched;
    result.changes = changed ? { blackboards: d.blackboards, behaviors: d.behaviors, memory: d.memory, agents: d.agents } : null;
    return result;
}

/** Writes a batch's changes into a document (inside a store commit). */
export function writeBehaviorChanges(doc: SceneDoc, changes: BehaviorChanges) {
    doc.blackboards = changes.blackboards;
    doc.behaviors = changes.behaviors;
    doc.memory = changes.memory;
    for (const [id, agent] of changes.agents) {
        const node = doc.nodes.find((n) => n.id === id);
        if (!node) continue;
        if (agent) node.agent = agent;
        else delete node.agent;
    }
}

/** The fields a node or service can have, for errors and docs. */
export function itemFieldNames(def: ItemTypeDef): string[] {
    return [...COMMON_FIELDS.map((f) => f.name), ...def.fields.map((f) => f.name)];
}

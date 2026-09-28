// Defaults, repair and small helpers for the behavior formats (blackboard
// schemas, behavior trees, memory, agents). Repair keeps documents usable
// when they come from files or older builds; it does not judge them, that is
// validate.ts's job.

import { uid } from '../ids';
import { isObj, str } from '../schema';
import type {
    AgentDoc, BehaviorTreeDoc, BlackboardKeyDoc, BlackboardKeyOwner, BlackboardKeyType, BlackboardSchemaDoc, BlackboardValue,
    BtCompositeDoc, BtDecoratorDoc, BtNodeDoc, BtServiceDoc, EnumValueDoc, MemoryDoc, MemoryItemDoc, AiModelDoc,
} from '../types';
import { BUILTIN_MODELS, DEFAULT_DECIDE_MODEL, modelKind } from './models';
import {
    DECORATOR_TYPES, fieldDefault, isReadableId, KEY_OWNERS, KEY_TYPES, NODE_TYPES, SERVICE_TYPES, typeDefault, valueFits,
    type FieldDef, type ItemTypeDef,
} from './nodeTypes';

/** The embed model new scenes use (core/behavior/models.ts). */
export const DEFAULT_EMBEDDER = 'e5-small';

export function defaultMemory(): MemoryDoc {
    return { embedder: DEFAULT_EMBEDDER, items: [] };
}


/** A readable id from any text: letters, digits, _ and -. */
export function toReadableId(s: string, fallback = 'item'): string {
    const clean = s
        .normalize('NFKC')
        .trim()
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .replace(/^[^\p{L}_]+/u, '')
        .replace(/_+/g, '_')
        .replace(/_$/, '')
        .slice(0, 48);
    return clean || fallback;
}

/** `base`, or base_2, base_3... when taken. */
export function uniqueId(base: string, taken: Set<string>): string {
    const stem = toReadableId(base);
    if (!taken.has(stem)) return stem;
    let i = 2;
    while (taken.has(`${stem}_${i}`)) i++;
    return `${stem}_${i}`;
}

/** A new id for an item of a type: selector_1, wait_2... */
export function newItemId(type: string, taken: Set<string>): string {
    let i = 1;
    while (taken.has(`${type}_${i}`)) i++;
    return `${type}_${i}`;
}

// ---------------------------------------------------------------- walking

export function isCompositeDoc(n: BtNodeDoc): n is BtCompositeDoc {
    return n.type === 'selector' || n.type === 'sequence';
}

/** Every node of a tree, depth first (execution order). */
export function walkNodes(root: BtNodeDoc, fn: (node: BtNodeDoc, parent: BtCompositeDoc | null, depth: number) => void) {
    const visit = (n: BtNodeDoc, parent: BtCompositeDoc | null, depth: number) => {
        fn(n, parent, depth);
        if (isCompositeDoc(n)) for (const c of n.children) visit(c, n, depth + 1);
    };
    visit(root, null, 0);
}

export function findNode(tree: BehaviorTreeDoc, id: string): { node: BtNodeDoc; parent: BtCompositeDoc | null } | null {
    let found: { node: BtNodeDoc; parent: BtCompositeDoc | null } | null = null;
    walkNodes(tree.root, (node, parent) => {
        if (!found && node.id === id) found = { node, parent };
    });
    return found;
}

export function findService(tree: BehaviorTreeDoc, id: string): { service: BtServiceDoc; host: BtNodeDoc } | null {
    let found: { service: BtServiceDoc; host: BtNodeDoc } | null = null;
    walkNodes(tree.root, (node) => {
        if (found) return;
        const s = node.services?.find((x) => x.id === id);
        if (s) found = { service: s, host: node };
    });
    return found;
}

/** Ids of every node and service of a tree (they share one namespace). */
export function treeIds(tree: BehaviorTreeDoc): Set<string> {
    const out = new Set<string>();
    walkNodes(tree.root, (n) => {
        out.add(n.id);
        for (const s of n.services ?? []) out.add(s.id);
    });
    return out;
}

export function schemaOf(schemas: BlackboardSchemaDoc[], tree: BehaviorTreeDoc | undefined): BlackboardSchemaDoc | undefined {
    return tree ? schemas.find((s) => s.id === tree.schema) : undefined;
}

/** Keys that hold memory item ids: the keys an Ask of the tree chooses from memory. */
export function memoryChoiceKeys(tree: BehaviorTreeDoc): Set<string> {
    const out = new Set<string>();
    const visit = (item: BtNodeDoc | BtServiceDoc) => {
        if (item.type === 'ask' && item.choices === 'memory') for (const q of item.questions) out.add(q.key);
    };
    walkNodes(tree.root, (n) => {
        visit(n);
        for (const s of n.services ?? []) visit(s);
    });
    return out;
}

/**
 * The models some trees use (ids): the decide model of every Ask, the model
 * of every Model task, and the memory's embed model for Recall and choices
 * from memory when the memory has embeddings (without, search matches
 * shared words and needs no model).
 */
export function modelsNeeded(trees: BehaviorTreeDoc[], memoryEmbedded: boolean, embedder: string): string[] {
    const ids = new Set<string>();
    let search = false;
    const visit = (item: BtNodeDoc | BtServiceDoc) => {
        if (item.type === 'ask') {
            ids.add(item.model || DEFAULT_DECIDE_MODEL);
            if (item.choices === 'memory') search = true;
        }
        if (item.type === 'infer' && item.model) ids.add(item.model);
        if (item.type === 'recall') search = true;
    };
    for (const t of trees) {
        walkNodes(t.root, (n) => {
            visit(n);
            for (const s of n.services ?? []) visit(s);
        });
    }
    if (search && memoryEmbedded && embedder) ids.add(embedder);
    return Array.from(ids);
}

/** The models the enabled agents of a scene use. */
export function sceneModelsNeeded(doc: { nodes: { agent?: AgentDoc }[]; behaviors: BehaviorTreeDoc[]; memory: MemoryDoc }): string[] {
    const used = new Set(doc.nodes.filter((n) => n.agent?.enabled).map((n) => n.agent!.tree));
    return modelsNeeded(doc.behaviors.filter((t) => used.has(t.id)), doc.memory.items.some((m) => !!m.vector), doc.memory.embedder);
}

// ---------------------------------------------------------------- factories

export function newSchema(name: string, keys: BlackboardKeyDoc[] = []): BlackboardSchemaDoc {
    return { id: uid('bb'), name, version: 1, keys };
}

export function newTree(name: string, schema: string): BehaviorTreeDoc {
    return { id: uid('bt'), name, version: 1, schema, root: { id: 'root', type: 'selector', children: [] } };
}

export function newKey(name: string, type: BlackboardKeyType, owner: BlackboardKeyOwner, values?: EnumValueDoc[]): BlackboardKeyDoc {
    const key: BlackboardKeyDoc = { name, type, default: typeDefault(type, values), description: '', owner };
    if (type === 'enum') key.values = values ?? [];
    return key;
}

// ----------------------------------------------------------------- repair

function value(v: any): BlackboardValue {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean' || typeof v === 'string') return v;
    return null;
}

function stringList(v: any, max = 64): string[] {
    const out: string[] = [];
    for (const x of Array.isArray(v) ? v : []) {
        const s = typeof x === 'string' ? x.trim().slice(0, 200) : '';
        if (s && !out.includes(s)) out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

/** A field value repaired to its kind (the default when it cannot be). */
export function repairField(f: FieldDef, v: any): any {
    const clamp = (n: number) => Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
    switch (f.kind) {
        case 'number':
        case 'seconds':
            return typeof v === 'number' && Number.isFinite(v) ? clamp(v) : fieldDefault(f);
        case 'integer':
            return typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v)) : fieldDefault(f);
        case 'unit':
            return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fieldDefault(f);
        case 'text':
        case 'template':
        case 'method':
        case 'key':
        case 'model':
            return typeof v === 'string' ? v.slice(0, 2000) : fieldDefault(f);
        case 'bool':
            return typeof v === 'boolean' ? v : fieldDefault(f);
        case 'choice':
            return f.choices?.some((c) => c.value === v) ? v : fieldDefault(f);
        case 'flags':
            return Array.isArray(v) ? stringList(v).filter((x) => f.choices?.some((c) => c.value === x)) : fieldDefault(f);
        case 'keys':
        case 'tags':
            return Array.isArray(v) ? stringList(v) : fieldDefault(f);
        case 'value':
            return value(v);
        case 'questions': {
            if (!Array.isArray(v)) return fieldDefault(f);
            const out: { key: string; text: string }[] = [];
            for (const q of v) if (isObj(q)) out.push({ key: str(q.key, '', 200), text: str(q.text, '', 1000) });
            return out;
        }
    }
}

/** An item's fields repaired, with defaults for the missing ones. */
function repairFields(def: ItemTypeDef, raw: Record<string, any>, out: Record<string, any>) {
    for (const f of def.fields) out[f.name] = f.name in raw ? repairField(f, raw[f.name]) : fieldDefault(f);
}

function repairDecorator(raw: any): BtDecoratorDoc | null {
    if (!isObj(raw)) return null;
    const def = DECORATOR_TYPES.find((t) => t.type === raw.type);
    if (!def) return null;
    const out: Record<string, any> = { type: def.type };
    repairFields(def, raw, out);
    return out as BtDecoratorDoc;
}

function repairService(raw: any, taken: Set<string>): BtServiceDoc | null {
    if (!isObj(raw)) return null;
    const def = SERVICE_TYPES.find((t) => t.type === raw.type);
    if (!def) return null;
    const id = isReadableId(raw.id) && !taken.has(raw.id) ? raw.id : uniqueId(typeof raw.id === 'string' && raw.id ? raw.id : newItemId(def.type, taken), taken);
    taken.add(id);
    const out: Record<string, any> = { id, type: def.type };
    const note = str(raw.note, '', 2000).trim();
    if (note) out.note = note;
    repairFields(def, raw, out);
    return out as BtServiceDoc;
}

/** A node and its subtree repaired: known types, unique readable ids, every field. Null for unknown types. */
export function repairNode(raw: any, taken: Set<string>, depth = 0): BtNodeDoc | null {
    if (!isObj(raw) || depth > 64) return null;
    const def = NODE_TYPES.find((t) => t.type === raw.type);
    if (!def) return null;
    const id = isReadableId(raw.id) && !taken.has(raw.id) ? raw.id : uniqueId(typeof raw.id === 'string' && raw.id ? raw.id : newItemId(def.type, taken), taken);
    taken.add(id);
    const out: Record<string, any> = { id, type: def.type };
    const note = str(raw.note, '', 2000).trim();
    if (note) out.note = note;
    repairFields(def, raw, out);
    const decorators = (Array.isArray(raw.decorators) ? raw.decorators : []).map(repairDecorator).filter(Boolean) as BtDecoratorDoc[];
    if (decorators.length) out.decorators = decorators;
    const services = (Array.isArray(raw.services) ? raw.services : []).map((s: any) => repairService(s, taken)).filter(Boolean) as BtServiceDoc[];
    if (services.length) out.services = services;
    if (def.category === 'composite') {
        out.children = (Array.isArray(raw.children) ? raw.children : []).map((c: any) => repairNode(c, taken, depth + 1)).filter(Boolean);
    }
    return out as BtNodeDoc;
}

function repairKey(raw: any): BlackboardKeyDoc | null {
    if (!isObj(raw) || !isReadableId(raw.name)) return null;
    const type: BlackboardKeyType = KEY_TYPES.some((k) => k.type === raw.type) ? raw.type : 'string';
    const owner: BlackboardKeyOwner = KEY_OWNERS.some((o) => o.owner === raw.owner) ? raw.owner : 'fact';
    const key: BlackboardKeyDoc = { name: raw.name, type, default: null, description: str(raw.description, '', 2000), owner };
    if (type === 'enum') {
        const seen = new Set<string>();
        key.values = [];
        for (const v of Array.isArray(raw.values) ? raw.values : []) {
            const value = isObj(v) ? str(v.value, '', 100).trim() : typeof v === 'string' ? v.trim().slice(0, 100) : '';
            if (!value || seen.has(value)) continue;
            seen.add(value);
            key.values.push({ value, description: isObj(v) ? str(v.description, '', 300) : '' });
        }
    }
    const d = value(raw.default);
    key.default = valueFits(key, d) ? d : typeDefault(type, key.values);
    return key;
}

export function repairSchema(raw: any): BlackboardSchemaDoc | null {
    if (!isObj(raw)) return null;
    const keys: BlackboardKeyDoc[] = [];
    for (const k of Array.isArray(raw.keys) ? raw.keys : []) {
        const key = repairKey(k);
        if (key && !keys.some((x) => x.name === key.name)) keys.push(key);
    }
    return {
        id: str(raw.id, '', 100) || uid('bb'),
        name: str(raw.name, '', 200).trim() || 'Blackboard',
        version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
        keys,
    };
}

export function repairTree(raw: any): BehaviorTreeDoc | null {
    if (!isObj(raw)) return null;
    const root = repairNode(raw.root, new Set()) ?? { id: 'root', type: 'selector', children: [] };
    return {
        id: str(raw.id, '', 100) || uid('bt'),
        name: str(raw.name, '', 200).trim() || 'Behavior',
        version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
        schema: str(raw.schema, '', 100),
        root,
    };
}

/** Assets with unique ids (a repeated id gets a new one). */
function uniqueAssets<T extends { id: string }>(items: T[], prefix: string): T[] {
    const seen = new Set<string>();
    for (const it of items) {
        if (!it.id || seen.has(it.id)) it.id = uid(prefix);
        seen.add(it.id);
    }
    return items;
}

export function sanitizeBlackboards(raw: any): BlackboardSchemaDoc[] {
    return uniqueAssets((Array.isArray(raw) ? raw : []).map(repairSchema).filter(Boolean) as BlackboardSchemaDoc[], 'bb');
}

export function sanitizeBehaviors(raw: any): BehaviorTreeDoc[] {
    return uniqueAssets((Array.isArray(raw) ? raw : []).map(repairTree).filter(Boolean) as BehaviorTreeDoc[], 'bt');
}

export function sanitizeMemory(raw: any): MemoryDoc {
    const out = defaultMemory();
    if (!isObj(raw)) return out;
    out.embedder = str(raw.embedder, '', 200) || DEFAULT_EMBEDDER;
    const taken = new Set<string>();
    for (const it of Array.isArray(raw.items) ? raw.items : []) {
        if (!isObj(it)) continue;
        const text = str(it.text, '', 4000).trim();
        if (!text) continue;
        const id = isReadableId(it.id) && !taken.has(it.id) ? it.id : uniqueId(typeof it.id === 'string' && it.id ? it.id : 'memory', taken);
        taken.add(id);
        const item: MemoryItemDoc = { id, text, tags: stringList(it.tags, 32) };
        if (typeof it.vector === 'string' && /^[A-Za-z0-9+/=]+$/.test(it.vector)) item.vector = it.vector;
        out.items.push(item);
    }
    return out;
}

/** Scene models: readable ids unique among them and the built-in ones, scalar options. Unknown kinds stay for validation to name. */
export function sanitizeAiModels(raw: any): AiModelDoc[] {
    const out: AiModelDoc[] = [];
    const taken = new Set(BUILTIN_MODELS.map((m) => m.id));
    for (const m of Array.isArray(raw) ? raw : []) {
        if (!isObj(m)) continue;
        const id = isReadableId(m.id) && !taken.has(m.id) ? m.id : uniqueId(typeof m.id === 'string' && m.id ? m.id : 'model', taken);
        taken.add(id);
        const kind = str(m.kind, '', 64);
        const options: Record<string, BlackboardValue> = {};
        // Settings of the kind get their field's type; others are kept as they are (validation warns).
        const defs = modelKind(kind)?.options ?? [];
        if (isObj(m.options)) {
            for (const [k, v] of Object.entries(m.options)) {
                if (!isReadableId(k)) continue;
                const f = defs.find((o) => o.name === k);
                options[k] = f ? repairField(f, v) : value(v);
            }
        }
        out.push({ id, name: str(m.name, '', 200).trim() || id, kind, url: str(m.url, '', 2000).trim(), file: str(m.file, '', 500).trim() || modelKind(kind)?.file || 'onnx/model_quantized.onnx', options });
        if (out.length >= 64) break;
    }
    return out;
}

export function sanitizeAgent(raw: any): AgentDoc | undefined {
    if (!isObj(raw) || typeof raw.tree !== 'string' || !raw.tree) return undefined;
    const values: Record<string, BlackboardValue> = {};
    if (isObj(raw.values)) for (const [k, v] of Object.entries(raw.values)) if (isReadableId(k)) values[k] = value(v);
    // Tree ids are kept to 100 characters (repairTree): the agent must still find its tree.
    return { tree: raw.tree.slice(0, 100), enabled: raw.enabled !== false, values };
}

// Text views of the behavior data: the indented outline the assistant reads
// (node ids, types and key settings only, far fewer tokens than the JSON)
// and the summary of the node types for its system prompt. Both come from
// the node type definitions.

import type { BehaviorTreeDoc, BlackboardSchemaDoc, BtNodeDoc, SceneDoc } from '../types';
import { isCompositeDoc, schemaOf } from './format';
import {
    COMPARE_OPS, DECORATOR_TYPES, decoratorType, formatValue, KEY_OWNERS, KEY_TYPES, NODE_TYPES, nodeType, SERVICE_TYPES,
    serviceType, type FieldDef, type ItemTypeDef, type KeyLookup,
} from './nodeTypes';
import { allModels, BUILTIN_MODELS, MODEL_KINDS, modelTask } from './models';
import { OP_DOCS } from './ops';
import type { Issue } from './validate';

function keyLookup(schema: BlackboardSchemaDoc | undefined): KeyLookup {
    return (name) => schema?.keys.find((k) => k.name === name);
}

/** "fact player_action: enum [none, approach, draw_weapon] = none  (what the player does)" per key. */
export function schemaOutline(schema: BlackboardSchemaDoc, withDescriptions = true): string {
    const lines = [`schema ${schema.name} (id ${schema.id}, v${schema.version})`];
    for (const k of schema.keys) {
        const values = k.type === 'enum' ? ` [${(k.values ?? []).map((v) => v.value).join(', ')}]` : '';
        const desc = withDescriptions && k.description ? `  - ${k.description}` : '';
        lines.push(`  ${k.owner} ${k.name}: ${k.type}${values} = ${formatValue(k.default)}${desc}`);
    }
    if (!schema.keys.length) lines.push('  (no keys)');
    return lines.join('\n');
}

/** The indented outline of a tree, with problems marked after the node they belong to. */
export function treeOutline(tree: BehaviorTreeDoc, schemas: BlackboardSchemaDoc[], issues: Issue[] = []): string {
    const schema = schemaOf(schemas, tree);
    const keys = keyLookup(schema);
    const lines = [`tree ${tree.name} (id ${tree.id}, v${tree.version}) schema ${schema ? `${schema.name} (id ${schema.id})` : `${tree.schema || '(none)'} MISSING`}`];
    const marks = (id: string) => {
        const list = issues.filter((i) => i.node === id && i.tree === tree.id);
        return list.map((i) => `  !! ${i.severity}${i.field ? ` ${i.field}` : ''}: ${i.message}`).join('');
    };
    const visit = (n: BtNodeDoc, depth: number) => {
        const pad = '  '.repeat(depth);
        const def = nodeType(n.type);
        const brief = def?.brief(n, keys) ?? '';
        const decos = (n.decorators ?? []).map((d) => decoratorType(d.type)?.brief(d, keys) ?? d.type);
        lines.push(`${pad}${n.id}: ${n.type}${brief ? ` ${brief}` : ''}${decos.length ? ` [${decos.join('; ')}]` : ''}${n.note ? `  # ${n.note}` : ''}${marks(n.id)}`);
        for (const s of n.services ?? []) {
            lines.push(`${pad}  service ${s.id}: ${serviceType(s.type)?.brief(s, keys) ?? s.type}${s.note ? `  # ${s.note}` : ''}${marks(s.id)}`);
        }
        if (isCompositeDoc(n)) for (const c of n.children) visit(c, depth + 1);
    };
    visit(tree.root, 0);
    // Tree problems without a node, and problems of the objects running the tree (their starting values).
    const general = issues.filter((i) => i.tree === tree.id && !i.node);
    for (const i of general) lines.push(`!! ${i.severity}${i.object ? ` object ${i.object}` : ''}${i.field ? ` ${i.field}` : ''}: ${i.message}`);
    return lines.join('\n');
}

/** Schemas, trees and the objects running them, in a few lines. */
export function behaviorOverview(doc: SceneDoc): string {
    const lines: string[] = [];
    for (const s of doc.blackboards) lines.push(`schema ${s.name} (id ${s.id}): ${s.keys.length} keys, used by ${doc.behaviors.filter((t) => t.schema === s.id).map((t) => t.name).join(', ') || 'no tree'}`);
    for (const t of doc.behaviors) {
        const agents = doc.nodes.filter((n) => n.agent?.tree === t.id);
        let count = 0;
        const walk = (n: BtNodeDoc) => {
            count++;
            if (isCompositeDoc(n)) n.children.forEach(walk);
        };
        walk(t.root);
        lines.push(`tree ${t.name} (id ${t.id}, schema ${doc.blackboards.find((s) => s.id === t.schema)?.name ?? t.schema}): ${count} nodes, runs on ${agents.map((n) => `${n.name} (${n.id})${n.agent!.enabled ? '' : ' disabled'}`).join(', ') || 'no object'}`);
    }
    lines.push(`models: ${allModels(doc.aiModels ?? []).map((m) => `${m.id} (${m.kind}, ${modelTask(m) ?? '?'}${BUILTIN_MODELS.some((b) => b === m) ? ', built in' : ''})`).join(', ')}`);
    const embedded = doc.memory.items.filter((m) => m.vector).length;
    lines.push(`memory: ${doc.memory.items.length} items (${embedded} embedded with ${doc.memory.embedder})${doc.memory.items.length ? `, tags: ${Array.from(new Set(doc.memory.items.flatMap((m) => m.tags))).join(', ') || 'none'}` : ''}`);
    if (!doc.blackboards.length && !doc.behaviors.length) lines.unshift('No blackboard schemas or behavior trees yet.');
    return lines.join('\n');
}

// ----------------------------------------------------------- type summary

function fieldText(f: FieldDef): string {
    let t = `${f.name}`;
    const kind = f.kind === 'choice' || f.kind === 'flags' ? `${f.kind === 'flags' ? 'list of ' : ''}${f.choices!.map((c) => c.value).join('|')}` : f.kind;
    t += ` (${kind}${f.default !== undefined && f.default !== '' && !(Array.isArray(f.default) && !f.default.length) ? `, default ${JSON.stringify(f.default)}` : ''})`;
    const limits: string[] = [];
    if (f.keyOwners) limits.push(`${f.keyOwners.join('/')} keys`);
    if (f.keyTypes) limits.push(`${f.keyTypes.join('/')} keys`);
    if (f.whenText) limits.push(`when ${f.whenText}`);
    if (limits.length) t += ` [${limits.join(', ')}]`;
    return t;
}

function typeLine(def: ItemTypeDef): string {
    const where = def.attachTo ? ` Attaches to ${def.attachTo.join(' and ')} nodes.` : '';
    const fields = def.fields.length ? ` Fields: ${def.fields.map(fieldText).join('; ')}.` : '';
    return `- ${def.type} (${def.label}): ${def.summary}${where}${fields}`;
}

/** The node types, key types and operations, for the assistant's system prompt. Generated from the definitions. */
export function nodeTypesSummary(): string {
    return [
        'Composites (have children): every node has id (readable, unique in the tree; services share the namespace), optional note, decorators and services.',
        ...NODE_TYPES.filter((t) => t.category === 'composite').map(typeLine),
        'Tasks (leaves):',
        ...NODE_TYPES.filter((t) => t.category === 'task').map(typeLine),
        'Decorators (on a node, not the root; no id, addressed by index):',
        ...DECORATOR_TYPES.map(typeLine),
        'Services (on a node, run while it is active; have an id):',
        ...SERVICE_TYPES.map(typeLine),
        `Condition tests: ${COMPARE_OPS.map((o) => `${o.op} (${o.description})`).join(' ')}`,
        `Key types: ${KEY_TYPES.map((k) => `${k.type} (${k.description.replace(/\.$/, '')})`).join('; ')}.`,
        `Key owners: ${KEY_OWNERS.map((o) => `${o.owner}: ${o.description}`).join(' ')}`,
        `Model kinds (add_model; Ask uses decide models, Model tasks classify and generate models, memory an embed model): ${MODEL_KINDS.map((k) => `${k.kind} (${k.task}${k.options.length ? `; options ${k.options.map((o) => o.name).join(', ')}` : ''})`).join('; ')}. Built in: ${BUILTIN_MODELS.map((m) => `${m.id} (${m.kind})`).join(', ')}.`,
        `Operations for apply_behavior_ops: ${OP_DOCS.map((o) => `${o.op}(${o.fields})`).join('; ')}.`,
    ].join('\n');
}

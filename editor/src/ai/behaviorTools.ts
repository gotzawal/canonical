// The assistant's behavior tree tools: read the outline, apply a batch of
// edit operations (the same layer the editor UI uses), validate, and read
// the decision log. A batch is one undo step, and a whole request is one
// too (the agent wraps it), as in the editor.

import { behaviorOverview, schemaOutline, treeOutline } from '../core/behavior/outline';
import { OP_DOCS } from '../core/behavior/ops';
import { describeIssue, validateScene, validateTree, type Issue } from '../core/behavior/validate';
import type { DecisionLogEntry } from '../core/types';
import { formatValue } from '../core/behavior/nodeTypes';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { ToolError, type Json } from './toolUtil';

function def(name: string, description: string, properties: Json = {}, required: string[] = []): ToolDef {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

export function behaviorToolDefs(): ToolDef[] {
    return [
        def(
            'get_behavior_outline',
            'Outline of the AI behavior data as indented text: node ids, types and key settings, with problems marked "!!". No arguments: every schema, tree, the objects running them and the memory. With tree: that tree and its blackboard schema. With schema: that schema\'s keys (owner name: type [values] = default). With memory: the memory items.',
            {
                tree: { type: 'string', description: 'Tree id or name.' },
                schema: { type: 'string', description: 'Schema id or name.' },
                memory: { type: 'boolean', description: 'List the memory items (id, tags, embedded or not, text).' },
            },
        ),
        def(
            'apply_behavior_ops',
            `Apply a batch of edit operations to behavior trees, blackboard schemas, agents and memory. All or nothing: when an operation fails or the batch would add a validation error, nothing changes and the errors name the operation, node id and field. Returns the created ids, the remaining warnings and the new outline of the edited trees. Operations: ${OP_DOCS.map((o) => `${o.op}(${o.fields})`).join('; ')}.`,
            {
                ops: {
                    type: 'array',
                    items: { type: 'object', properties: { op: { type: 'string', enum: OP_DOCS.map((o) => o.op) } }, required: ['op'] },
                    description: 'Operations in order, e.g. [{"op":"add_node","tree":"Guard","parent":"root","node":{"type":"wait","id":"idle","seconds":2}}]. Nodes are objects {id?, type, <fields>, decorators?, services?, children?}.',
                },
            },
            ['ops'],
        ),
        def(
            'validate_behavior',
            'Check behavior trees, schemas and agents: errors (missing or wrong keys, key owners, question formats, duplicate ids, where decorators and services may go) and warnings (branches that are never reached, Selectors without a default branch, Asks that look at the same facts). Without tree: everything.',
            { tree: { type: 'string', description: 'Tree id or name.' } },
        ),
        def(
            'get_decision_log',
            'Decisions of the last Play session (run_play_test or Play): one entry per Ask request with the facts and context the model saw, the questions and options, the probabilities, the chosen value, confidence, and what became of it (written, low_confidence, superseded, held, timeout, unavailable), plus cache hit and latency. Use it to tune a tree: read the entries of a node id, change its fields, play again.',
            {
                node: { type: 'string', description: 'Ask node or service id.' },
                agent: { type: 'string', description: 'Object id or name.' },
                tree: { type: 'string', description: 'Tree id or name.' },
                outcome: { type: 'string', enum: ['written', 'low_confidence', 'superseded', 'held', 'timeout', 'unavailable'] },
                limit: { type: 'number', description: 'Newest entries, default 20, at most 100.' },
            },
        ),
    ];
}

function resolveTree(env: ToolEnv, ref: unknown) {
    const doc = env.editor.store.doc;
    if (typeof ref !== 'string' || !ref) return null;
    const want = ref.toLowerCase();
    const t = doc.behaviors.find((x) => x.id === ref) ?? doc.behaviors.find((x) => x.name.toLowerCase() === want);
    if (!t) throw new ToolError(`No behavior tree "${ref}". Trees: ${doc.behaviors.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}.`);
    return t;
}

function issueLines(env: ToolEnv, issues: Issue[]): string[] {
    const doc = env.editor.store.doc;
    const names = { tree: (id: string) => doc.behaviors.find((t) => t.id === id)?.name ?? id, schema: (id: string) => doc.blackboards.find((s) => s.id === id)?.name ?? id };
    return issues.map((i) => `${i.severity}: ${describeIssue(i, names)}`);
}

/** One log entry in a line or two. */
function entryText(e: DecisionLogEntry): string {
    const facts = Object.entries(e.facts).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ');
    const qs = e.questions
        .map((q) => {
            const probs = q.probabilities ? (q.format === 'noul' ? '' : ` [${(q.options ?? []).map((o, i) => `${o.value} ${q.probabilities![i]}`).join(', ')}]`) : '';
            // Model tasks: classify has labels as options, generate has its text as the value (and the input as the text).
            const answer = q.probabilities || (q.format === 'generate' && q.value !== null) ? `${q.key}=${formatValue(q.value)}` : `${q.key} (no answer)`;
            const input = q.format === 'classify' || q.format === 'generate' ? ` input ${JSON.stringify(q.text.slice(-200))}` : '';
            return `${answer}${q.confidence !== null ? ` conf ${q.confidence}` : ''} ${q.outcome}${probs}${input}`;
        })
        .join('; ');
    return `${e.time}s ${e.agentName} ${e.node}#${e.seq}: facts {${facts}}${e.context.length ? ` context [${e.context.join(', ')}]` : ''} -> ${qs} (${e.provider}${e.cache !== 'none' ? `, ${e.cache} cache` : ''}, ${e.latency} ms)`;
}

export async function runBehaviorTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult | null> {
    const ed = env.editor;
    const doc = () => ed.store.doc;
    switch (name) {
        case 'get_behavior_outline': {
            const d = doc();
            if (args.memory) {
                const lines = [`memory (${d.memory.items.length} items, embedder ${d.memory.embedder}):`];
                for (const m of d.memory.items.slice(0, 300)) lines.push(`  ${m.id}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}${m.vector ? '' : ' (not embedded)'}: ${m.text.replace(/\s+/g, ' ').slice(0, 200)}`);
                if (d.memory.items.length > 300) lines.push(`  ... ${d.memory.items.length - 300} more`);
                return { data: { outline: lines.join('\n') }, summary: `${d.memory.items.length} memory items` };
            }
            if (args.schema) {
                const want = String(args.schema).toLowerCase();
                const s = d.blackboards.find((x) => x.id === args.schema) ?? d.blackboards.find((x) => x.name.toLowerCase() === want);
                if (!s) throw new ToolError(`No schema "${args.schema}". Schemas: ${d.blackboards.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}.`);
                return { data: { outline: schemaOutline(s) }, summary: s.name };
            }
            const tree = resolveTree(env, args.tree);
            if (tree) {
                const issues = validateTree(tree, d.blackboards, d.memory, d.aiModels);
                const schema = d.blackboards.find((s) => s.id === tree.schema);
                const users = d.nodes.filter((n) => n.agent?.tree === tree.id).map((n) => `${n.name} (${n.id})${n.agent!.enabled ? '' : ' disabled'}`);
                return {
                    data: { outline: [treeOutline(tree, d.blackboards, issues), schema ? schemaOutline(schema) : '', `runs on: ${users.join(', ') || 'no object'}`].filter(Boolean).join('\n\n') },
                    summary: `${tree.name}${issues.some((i) => i.severity === 'error') ? ' (errors)' : ''}`,
                };
            }
            return { data: { outline: behaviorOverview(d) }, summary: `${d.behaviors.length} trees` };
        }
        case 'apply_behavior_ops': {
            const result = ed.applyBehaviorOps(args.ops, { mode: 'strict' });
            if (!result.ok) {
                return {
                    data: { ok: false, errors: result.errors.map((e) => ({ ...e, op: e.op >= 0 ? e.op : undefined })), note: 'Nothing was changed. Fix the named operation and send the whole batch again.' },
                    summary: `refused: ${result.errors[0]?.message.slice(0, 80) ?? 'error'}`,
                };
            }
            const d = doc();
            const outlines = result.touched.trees
                .map((id) => d.behaviors.find((t) => t.id === id))
                .filter(Boolean)
                .slice(0, 2)
                .map((t) => treeOutline(t!, d.blackboards, result.issues));
            const warnings = issueLines(env, result.issues.filter((i) => i.severity === 'warning'));
            const errors = issueLines(env, result.issues.filter((i) => i.severity === 'error'));
            return {
                data: {
                    ok: true,
                    created: result.created,
                    ...(errors.length ? { remaining_errors: errors, note: 'These errors were there before this batch.' } : {}),
                    ...(warnings.length ? { warnings } : {}),
                    ...(outlines.length ? { outline: outlines.join('\n\n') } : {}),
                },
                summary: `${result.label}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`,
            };
        }
        case 'validate_behavior': {
            const d = doc();
            const tree = resolveTree(env, args.tree);
            const issues = tree ? validateTree(tree, d.blackboards, d.memory, d.aiModels) : validateScene(d);
            const errors = issues.filter((i) => i.severity === 'error').length;
            return {
                data: { errors, warnings: issues.length - errors, issues: issueLines(env, issues), ...(issues.length ? {} : { note: 'No problems.' }) },
                summary: `${errors} error(s), ${issues.length - errors} warning(s)`,
            };
        }
        case 'get_decision_log': {
            const log = ed.player.agents.log;
            const tree = args.tree ? resolveTree(env, args.tree) : null;
            const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
            const entries = log.query({ node: args.node, agent: args.agent, tree: tree?.id, outcome: args.outcome, limit });
            const all = log.query({ node: args.node, agent: args.agent, tree: tree?.id });
            return {
                data: {
                    total: all.length,
                    outcomes: log.outcomes(all),
                    entries: entries.map(entryText),
                    ...(log.entries.length ? {} : { note: 'The log is empty: run the scene (run_play_test) with agents that have Ask nodes first.' }),
                },
                summary: `${entries.length} of ${all.length} entries`,
            };
        }
    }
    return null;
}

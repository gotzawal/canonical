// The assistant's code tools: scripts, shaders, the render graph and its
// post effects, the console, and Play to test them.

import type { ParamValue } from '../core/types';
import { recentLogs } from '../ui/statusbar';
import { node, num, params, r3, script, shader, ToolError, tools, type Json, type ToolEnv } from './toolUtil';

export const codeTools = tools({
    write_script: {
        groups: ['code'],
        description: 'Create a script, or replace the code of an existing one (pass id, or an existing name). Optionally attach it to objects. Returns the compile result, fields and methods.',
        params: {
            name: { type: 'string', description: 'File name, e.g. "Orbit.js".' },
            code: { type: 'string' },
            id: { type: 'string' },
            attach_to: { type: 'array', items: { type: 'string' }, description: 'Object ids or names.' },
            props: { type: 'object', description: 'Field values for the attached objects.' },
        },
        required: ['name', 'code'],
        run({ env, args, ed, store, doc }) {
            const code = String(args.code ?? '');
            if (!code.trim()) throw new ToolError('code is empty.');
            const name = String(args.name ?? 'Script.js');
            const existing = args.id ? script(doc(), args.id) : doc().scripts.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.name.toLowerCase() === (name + '.js').toLowerCase());
            let id: string;
            if (existing) {
                id = existing.id;
                ed.updateScript(id, code);
                if (args.id && name && name !== existing.name) ed.renameScript(id, name);
            } else {
                id = ed.createScript({ name, code, open: false }).id;
            }
            if (Array.isArray(args.attach_to) && args.attach_to.length) {
                const targets = args.attach_to.map((r: unknown) => node(doc(), r).id);
                const fresh = targets.filter((t: string) => !store.node(t)?.scripts?.some((r) => r.script === id));
                if (fresh.length) ed.attachScript(fresh, id, params(args.props));
                else if (args.props) setScriptProps(env, targets, id, params(args.props));
            }
            const info = compiledInfo(env, id);
            return { data: { id, name: doc().scripts.find((s) => s.id === id)?.name, ...info }, summary: `${name}${info.ok ? '' : ' (errors)'}` };
        },
    },
    read_script: {
        groups: ['read'],
        description: 'Code, compile status and runtime errors of a script.',
        params: { script: { type: 'string', description: 'Script id or name.' } },
        required: ['script'],
        run({ env, args, ed, doc }) {
            const s = script(doc(), args.script);
            const issues = ed.player.issues.filter((i) => i.script === s.id).map((i) => ({ method: i.method, line: i.line, message: i.message, object: i.node }));
            return { data: { id: s.id, name: s.name, code: s.code, ...compiledInfo(env, s.id), ...(issues.length ? { runtime_errors: issues } : {}) }, summary: s.name };
        },
    },
    attach_script: {
        groups: ['code'],
        description: 'Attach a script to objects, with optional field values.',
        params: {
            script: { type: 'string' },
            object_ids: { type: 'array', items: { type: 'string' } },
            props: { type: 'object' },
        },
        required: ['script', 'object_ids'],
        run({ env, args, ed, doc }) {
            const s = script(doc(), args.script);
            const targets = (Array.isArray(args.object_ids) ? args.object_ids : []).map((r: unknown) => node(doc(), r).id);
            if (!targets.length) throw new ToolError('object_ids is empty.');
            ed.attachScript(targets, s.id, params(args.props));
            return { data: { ok: true, ...compiledInfo(env, s.id) }, summary: s.name };
        },
    },
    detach_script: {
        groups: ['code'],
        description: 'Remove a script from an object.',
        params: { object_id: { type: 'string' }, script: { type: 'string' } },
        required: ['object_id', 'script'],
        run({ args, ed, doc }) {
            const n = node(doc(), args.object_id);
            const s = script(doc(), args.script);
            const i = n.scripts?.findIndex((r) => r.script === s.id) ?? -1;
            if (i < 0) throw new ToolError(`"${n.name}" does not have ${s.name}.`);
            ed.detachScript(n.id, i);
            return { data: { ok: true } };
        },
    },
    set_script_props: {
        groups: ['code'],
        description: 'Set field values of a script attached to an object.',
        params: { object_id: { type: 'string' }, script: { type: 'string' }, props: { type: 'object' } },
        required: ['object_id', 'script', 'props'],
        run({ env, args, doc }) {
            const n = node(doc(), args.object_id);
            const s = script(doc(), args.script);
            if (!n.scripts?.some((r) => r.script === s.id)) throw new ToolError(`"${n.name}" does not have ${s.name}; attach it first.`);
            setScriptProps(env, [n.id], s.id, params(args.props));
            return { data: { ok: true } };
        },
    },
    delete_script: {
        groups: ['code'],
        description: 'Delete a script asset (it is removed from every object).',
        params: { script: { type: 'string' } },
        required: ['script'],
        async run({ args, ed, doc }) {
            const s = script(doc(), args.script);
            await ed.deleteScript(s.id, false);
            return { data: { ok: true }, summary: s.name };
        },
    },
    write_shader: {
        groups: ['code', 'materials', 'effects'],
        description: 'Create a WGSL shader, or replace an existing one (pass id, or an existing name). Waits for the GPU compiler and returns errors with line numbers and the declared properties.',
        params: {
            name: { type: 'string', description: 'File name, e.g. "Hologram.wgsl".' },
            kind: { type: 'string', enum: ['material', 'post'] },
            lighting: { type: 'string', enum: ['lit', 'unlit'], description: 'Material shaders only.' },
            code: { type: 'string' },
            id: { type: 'string' },
        },
        required: ['name', 'kind', 'code'],
        async run({ env, args, ed, doc }) {
            const code = String(args.code ?? '');
            if (!code.trim()) throw new ToolError('code is empty.');
            const name = String(args.name ?? 'Shader.wgsl');
            const existing = args.id ? shader(doc(), args.id) : doc().shaders.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.name.toLowerCase() === (name + '.wgsl').toLowerCase());
            // A rewrite keeps the kind and lighting the call leaves out.
            const kind = args.kind === 'post' || args.kind === 'material' ? args.kind : existing?.kind ?? 'material';
            const lighting = args.lighting === 'unlit' || args.lighting === 'lit' ? args.lighting : existing?.lighting ?? 'lit';
            let id: string;
            if (existing) {
                id = existing.id;
                ed.updateShader(id, { code, kind, lighting });
            } else {
                id = ed.createShader({ name, code, kind, lighting, open: false }).id;
            }
            const info = await shaderInfo(env, id);
            return { data: { id, name: doc().shaders.find((s) => s.id === id)?.name, kind, ...(kind === 'material' ? { lighting } : {}), ...info }, summary: `${name}${info.ok ? '' : ' (errors)'}` };
        },
    },
    read_shader: {
        groups: ['read'],
        description: 'Code and compile status of a shader.',
        params: { shader: { type: 'string' } },
        required: ['shader'],
        async run({ env, args, doc }) {
            const s = shader(doc(), args.shader);
            return { data: { id: s.id, name: s.name, kind: s.kind, lighting: s.lighting, code: s.code, ...(await shaderInfo(env, s.id)) }, summary: s.name };
        },
    },
    assign_shader: {
        groups: ['code', 'materials'],
        description: 'Render primitive objects with a material shader (null goes back to the lit material).',
        params: {
            shader: { type: ['string', 'null'] },
            object_ids: { type: 'array', items: { type: 'string' } },
            params: { type: 'object' },
        },
        required: ['shader', 'object_ids'],
        async run({ env, args, ed, store, doc }) {
            const targets: string[] = (Array.isArray(args.object_ids) ? args.object_ids : []).map((r: unknown) => node(doc(), r).id);
            const meshes = targets.filter((id) => store.node(id)?.mesh);
            if (!meshes.length) throw new ToolError('None of these objects is a primitive with a material. For imported models use set_model_material with shader.');
            if (args.shader === null) {
                ed.assignShader(meshes, null);
                return { data: { ok: true } };
            }
            const s = shader(doc(), args.shader);
            if (s.kind !== 'material') throw new ToolError(`"${s.name}" is a post shader; use add_post_effect.`);
            ed.assignShader(meshes, s.id);
            if (args.params) {
                const p = params(args.params);
                store.commit('AI: Shader Params', (d) => {
                    for (const n of d.nodes) if (meshes.includes(n.id) && n.mesh) n.mesh.material.params = { ...(n.mesh.material.params ?? {}), ...p };
                }, { nodes: meshes });
            }
            return { data: { ok: true, objects: meshes.length, ...(await shaderInfo(env, s.id)) }, summary: s.name };
        },
    },
    delete_shader: {
        groups: ['code'],
        description: 'Delete a shader asset.',
        params: { shader: { type: 'string' } },
        required: ['shader'],
        async run({ args, ed, doc }) {
            const s = shader(doc(), args.shader);
            await ed.deleteShader(s.id, false);
            return { data: { ok: true }, summary: s.name };
        },
    },
    get_render_graph: {
        groups: ['read'],
        description: 'Render passes in execution order with the resources they read and write, and the post effect chain.',
        run({ ed, doc }) {
            const info = ed.graph.info();
            return {
                summary: `${info.passes.length} passes`,
                data: {
                    passes: info.passes
                        .slice()
                        .sort((a, b) => (a.order < 0 ? 1e6 : a.order) - (b.order < 0 ? 1e6 : b.order))
                        .map((p) => ({ name: p.name, enabled: p.enabled, order: p.order, reads: p.reads, writes: p.writes, ...(p.deps.length ? { after: p.deps } : {}), ...(p.essential ? { required: true } : {}) })),
                    post_chain: ed.graph.chain().map((c) => ({ name: c.name, enabled: c.enabled, ...(c.custom ? { id: c.custom } : {}), ...(c.final ? { final: true } : {}) })),
                    custom_post_effects: doc().renderGraph.posts,
                    error: info.error || undefined,
                },
            };
        },
    },
    set_render_pass: {
        groups: ['code', 'effects'],
        description: 'Switch a render pass off or on. Refused with a reason when the graph could not run.',
        params: { name: { type: 'string' }, enabled: { type: 'boolean' } },
        required: ['name', 'enabled'],
        run({ args, ed }) {
            const err = ed.setPassEnabled(String(args.name), !!args.enabled);
            if (err) throw new ToolError(err);
            return { data: { ok: true }, summary: `${args.name} ${args.enabled ? 'on' : 'off'}` };
        },
    },
    add_post_effect: {
        groups: ['effects', 'code'],
        description: 'Add a post shader to the post chain.',
        params: { shader: { type: 'string' }, params: { type: 'object' }, enabled: { type: 'boolean' } },
        required: ['shader'],
        async run({ env, args, ed, doc }) {
            const s = shader(doc(), args.shader);
            if (s.kind !== 'post') throw new ToolError(`"${s.name}" is a material shader.`);
            const id = ed.addPostEffect(s.id);
            if (!id) throw new ToolError('Could not add the effect.');
            if (args.params || args.enabled === false) ed.updatePostEffect(id, { params: params(args.params), enabled: args.enabled !== false }, 'AI: Post Effect');
            return { data: { id, ...(await shaderInfo(env, s.id)) }, summary: s.name };
        },
    },
    update_post_effect: {
        groups: ['effects', 'code'],
        description: 'Change a custom post effect: enabled, params, or move it (negative = earlier).',
        params: {
            id: { type: 'string' },
            enabled: { type: 'boolean' },
            params: { type: 'object' },
            move: { type: 'number' },
        },
        required: ['id'],
        run({ args, ed, doc }) {
            const p = doc().renderGraph.posts.find((x) => x.id === args.id);
            if (!p) throw new ToolError(`No post effect "${args.id}".`);
            if (args.enabled !== undefined || args.params !== undefined) {
                ed.updatePostEffect(p.id, { enabled: args.enabled, params: args.params ? params(args.params) : undefined }, 'AI: Post Effect');
            }
            if (args.move) ed.movePostEffect(p.id, Math.sign(num(args.move, 'move')));
            return { data: { ok: true } };
        },
    },
    remove_post_effect: {
        groups: ['effects', 'code'],
        description: 'Remove a custom post effect from the chain.',
        params: { id: { type: 'string' } },
        required: ['id'],
        run({ args, ed, doc }) {
            if (!doc().renderGraph.posts.some((x) => x.id === args.id)) throw new ToolError(`No post effect "${args.id}".`);
            ed.removePostEffect(String(args.id));
            return { data: { ok: true } };
        },
    },
    get_console: {
        groups: ['read'],
        description: 'Recent editor console messages (errors, warnings, script logs).',
        params: { limit: { type: 'number' }, errors_only: { type: 'boolean' } },
        run({ args }) {
            const limit = Math.min(200, Math.max(1, Number(args.limit) || 40));
            return { data: { messages: recentLogs(limit, args.errors_only ? ['error'] : ['error', 'warn', 'info']) } };
        },
    },
    run_play_test: {
        groups: ['play', 'code'],
        needs: 'play',
        description: 'Run the scene in Play mode for a few seconds, then stop and restore it. Returns script logs and errors. Use it to test scripts.',
        params: {
            seconds: { type: 'number', description: '0.5 to 20, default 3.' },
        },
        async run({ env, args, ed }) {
            if (!ed.compiler.trusted && ed.store.doc.scripts.length) throw new ToolError(PAUSED_TOOL_ERROR);
            const seconds = Math.min(20, Math.max(0.5, Number(args.seconds) || 3));
            const res = await ed.player.runFor(seconds);
            const log = ed.player.agents.log;
            const agents = ed.store.doc.nodes.filter((n) => n.agent?.enabled).length;
            return {
                summary: `${seconds}s, ${res.issues.length} error(s)`,
                data: {
                    seconds,
                    frames: res.frames,
                    errors: res.issues.map((i) => ({ script: i.scriptName, object: i.node, method: i.method, line: i.line, message: i.message, at: r3(i.time) })),
                    logs: res.logs.slice(-60).map((l) => `${r3(l.time)}s ${l.level}: ${l.text}`),
                    ...(agents ? { behavior: { agents, decisions: log.entries.length, outcomes: log.outcomes(), note: 'get_decision_log shows the decisions.' } } : {}),
                    note: res.frames < 2 ? 'Very few frames ran; the tab may be in the background.' : undefined,
                },
            };
        },
    },
    play: {
        groups: ['play', 'code'],
        needs: 'play',
        description: 'Start Play mode and leave it running for the user.',
        run({ env, ed }) {
            if (!ed.compiler.trusted && ed.store.doc.scripts.length) throw new ToolError(PAUSED_TOOL_ERROR);
            ed.play();
            return { data: { state: ed.player.state } };
        },
    },
    stop: {
        groups: ['play', 'code'],
        needs: 'play',
        description: 'Stop Play mode (restores the scene).',
        run({ ed }) {
            ed.stopPlay();
            return { data: { state: ed.player.state } };
        },
    },
});

const PAUSED_TOOL_ERROR =
    'Scripts in this scene are paused because it was opened from a file. Only the user can enable them (the "Enable Scripts" button above the viewport); ask them to review the scripts and enable them.';

function compiledInfo(env: ToolEnv, id: string): Json {
    const c = env.editor.compiler.get(id);
    if (!c) return { ok: false, error: 'missing' };
    if (c.paused) return { ok: false, paused: true, error: PAUSED_TOOL_ERROR };
    const out: Json = { ok: !c.error };
    if (c.error) out.error = { line: c.error.line, column: c.error.column, message: c.error.message };
    if (c.fieldError) out.field_error = c.fieldError;
    out.class = c.className;
    out.fields = c.fields.map((f) => ({ name: f.name, type: f.type, default: f.default }));
    out.methods = c.methods;
    return out;
}

async function shaderInfo(env: ToolEnv, id: string): Promise<Json> {
    await env.editor.shaders.whenIdle();
    const st = env.editor.shaders.status(id);
    return {
        ok: st.state === 'ok',
        state: st.state,
        errors: st.messages.filter((m) => m.severity === 'error').map((m) => ({ line: m.line, column: m.column, message: m.message })),
        warnings: st.messages.filter((m) => m.severity === 'warning').map((m) => ({ line: m.line, message: m.message })),
        properties: env.editor.shaders.props(id).map((p) => ({ name: p.name, type: p.type, default: p.default, ...(p.min !== undefined ? { min: p.min, max: p.max } : {}) })),
        in_use: st.state !== 'ok' && env.editor.shaders.isValid(id) ? 'the previous valid version is still rendering' : undefined,
    };
}

function setScriptProps(env: ToolEnv, ids: string[], scriptId: string, props: Record<string, ParamValue>) {
    env.editor.store.commit('AI: Script Fields', (d) => {
        for (const n of d.nodes) {
            if (!ids.includes(n.id)) continue;
            for (const r of n.scripts ?? []) if (r.script === scriptId) r.props = { ...r.props, ...props };
        }
    }, { nodes: ids });
}

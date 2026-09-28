// The assistant's effect tools: particle emitters from presets (fire,
// smoke, sparks, dust, rain, snow...) with any value changed, a vignette
// and the lift / gamma / gain color grade of the Finish stage.

import { uid } from '../core/ids';
import { Particles } from '../core/model';
import { PARTICLE_PRESETS, particleCount, presetParticles, sceneParticles } from '../core/particles';
import { patch, toolSchema } from '../core/schema';
import type { NodeDoc, ParticlesDoc } from '../core/types';
import { addColorGrade, addVignette } from '../design/effects';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { def, hex, node, num, str, ToolError, v3, type Json } from './toolUtil';

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const vec4 = { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 4, description: '[r, g, b, all] or [all]' };

/** The emitter's fields as tool arguments (the preset is chosen by id). */
const { preset: _preset, ...particleFields } = toolSchema(Particles).properties;

export function effectToolDefs(): ToolDef[] {
    return [
        def('add_particles', `Add a particle emitter (GPU particles), starting from a preset and changing any value. Presets: ${PARTICLE_PRESETS.map((p) => `${p.id} (${p.hint})`).join('; ')}`, {
            preset: { type: 'string', enum: PARTICLE_PRESETS.map((p) => p.id) },
            name: { type: 'string' },
            position: vec3,
            parent: { type: 'string', description: 'Object id or name to attach it to.' },
            ...particleFields,
        }, ['preset', 'position']),
        def('update_particles', 'Change a particle emitter: any value, or start again from a preset (texture kept).', {
            id: { type: 'string', description: 'Object id or name.' },
            preset: { type: 'string', enum: PARTICLE_PRESETS.map((p) => p.id) },
            ...particleFields,
        }, ['id']),
        def('add_vignette', 'Darken the screen edges with a vignette post effect (added once; later calls change its strength).', {
            strength: { type: 'number', description: '0..2, default 0.6.' },
        }),
        def('add_color_grade', 'Add or change the color grade of the Finish stage: lift raises the darks, gamma bends the mid tones, gain scales everything, then saturation. Each of lift, gamma and gain is [r, g, b, all] or [all] (neutral: lift 0, gamma 1, gain 1). Works on the HDR image before tone mapping; keep changes small (lift within 0.05, gamma 0.8-1.25, gain 0.8-1.25).', {
            lift: vec4,
            gamma: vec4,
            gain: vec4,
            saturation: { type: 'number', description: '0..2, 1 is neutral.' },
        }),
    ];
}

/** Tool arguments to emitter values: the emitter's fields, a texture that exists. */
function particleArgs(env: ToolEnv, args: Json, base: ParticlesDoc): ParticlesDoc {
    const { id: _id, preset: _preset, name: _name, position: _position, parent: _parent, ...fields } = args;
    if (fields.texture && !env.editor.store.doc.assets.some((a) => a.id === fields.texture && a.kind === 'texture')) throw new ToolError(`"${fields.texture}" is not a texture asset.`);
    return patch(Particles, base, fields, 'particles', hex);
}

export async function runEffectTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult | null> {
    const ed = env.editor;
    const store = ed.store;
    switch (name) {
        case 'add_particles': {
            const preset = str(args.preset, 'preset', 40);
            if (!PARTICLE_PRESETS.some((p) => p.id === preset)) throw new ToolError(`Unknown preset "${preset}".`);
            const particles = particleArgs(env, args, presetParticles(preset));
            const parent = args.parent !== undefined ? node(store.doc, args.parent).id : null;
            const label = PARTICLE_PRESETS.find((p) => p.id === preset)!.label;
            const n: NodeDoc = {
                id: uid(),
                name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : label,
                parent,
                visible: true,
                position: v3(args.position, 'position'),
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                particles,
            };
            store.commit('AI: Add Particles', (d) => {
                d.nodes.push(n);
            });
            return { data: { id: n.id, name: n.name, alive_at_most: particleCount(particles), scene_particles: sceneParticles(store.doc.nodes) }, summary: n.name };
        }
        case 'update_particles': {
            const target = node(store.doc, args.id);
            if (!target.particles) throw new ToolError(`${target.name} has no particle emitter.`);
            const base = args.preset !== undefined ? { ...presetParticles(str(args.preset, 'preset', 40)), texture: target.particles.texture } : target.particles;
            const particles = particleArgs(env, args, base);
            store.commit('AI: Edit Particles', (d) => {
                const n = d.nodes.find((x) => x.id === target.id);
                if (n) n.particles = particles;
            });
            return { data: { ok: true, alive_at_most: particleCount(particles), scene_particles: sceneParticles(store.doc.nodes) }, summary: target.name };
        }
        case 'add_vignette': {
            const id = addVignette(ed, args.strength !== undefined ? Math.max(0, Math.min(2, num(args.strength, 'strength'))) : undefined);
            if (!id) throw new ToolError('Could not add the vignette.');
            return { data: { ok: true, post: id }, summary: 'vignette' };
        }
        case 'add_color_grade': {
            const list = (v: unknown, what: string) => {
                if (v === undefined) return undefined;
                const a = typeof v === 'number' ? [v] : Array.isArray(v) ? v : null;
                if (!a || !a.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new ToolError(`${what} must be [r, g, b, all] or [all].`);
                return a as number[];
            };
            const id = addColorGrade(ed, {
                lift: list(args.lift, 'lift'),
                gamma: list(args.gamma, 'gamma'),
                gain: list(args.gain, 'gain'),
                saturation: args.saturation !== undefined ? Math.max(0, Math.min(2, num(args.saturation, 'saturation'))) : undefined,
            });
            if (!id) throw new ToolError('Could not add the color grade.');
            const post = store.doc.renderGraph.posts.find((p) => p.id === id);
            return { data: { ok: true, post: id, params: post?.params ?? {} }, summary: 'color grade' };
        }
    }
    return null;
}

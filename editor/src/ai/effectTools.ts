// The assistant's effect tools: particle emitters from presets (fire,
// smoke, sparks, dust, rain, snow...) with any value changed, a vignette
// and the lift / gamma / gain color grade of the Finish stage.

import { uid } from '../core/ids';
import { PARTICLE_PRESETS, PARTICLE_SHAPES, particleCount, presetParticles, sanitizeParticles, sceneParticles } from '../core/particles';
import type { NodeDoc, ParticlesDoc } from '../core/types';
import { addColorGrade, addVignette } from '../design/effects';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { node, num, str, ToolError, v3, type Json } from './toolUtil';

function def(name: string, description: string, properties: Json = {}, required: string[] = []): ToolDef {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const pair = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const vec4 = { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 4, description: '[r, g, b, all] or [all]' };

const particleFields = {
    rate: { type: 'number', description: 'Particles per second.' },
    max: { type: 'integer', description: 'Most particles alive at once.' },
    life: { ...pair, description: 'Seconds a particle lives [min, max].' },
    size: { ...pair, description: 'Size in meters at birth [min, max].' },
    size_end: { type: 'number', description: 'Size at the end of life as a factor of the birth size.' },
    shape: { type: 'string', enum: PARTICLE_SHAPES },
    radius: { type: 'number' },
    box: vec3,
    velocity_min: { ...vec3, description: 'Start velocity m/s per axis (object space), lowest.' },
    velocity_max: { ...vec3, description: 'Highest start velocity.' },
    gravity: { ...vec3, description: 'Constant acceleration m/s^2, e.g. [0, -9.8, 0].' },
    spin: { ...pair, description: 'Start rotation of each sprite in degrees [min, max].' },
    color_start: { type: 'string' },
    color_end: { type: 'string' },
    alpha_start: { type: 'number' },
    alpha_end: { type: 'number' },
    texture: { type: ['string', 'null'], description: 'Texture asset id for the sprite; null for a soft dot.' },
    blend: { type: 'string', enum: ['add', 'alpha'], description: 'add glows (fire, sparks), alpha covers (smoke, dust, rain).' },
    local: { type: 'boolean', description: 'Particles move with the object.' },
    prewarm: { type: 'number', description: 'Seconds simulated before the first frame.' },
};

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

/** Tool arguments to emitter values. */
function particleArgs(args: Json, base: ParticlesDoc): ParticlesDoc {
    const p: any = { ...base };
    const map: [string, keyof ParticlesDoc][] = [
        ['rate', 'rate'], ['max', 'max'], ['life', 'life'], ['size', 'size'], ['size_end', 'sizeEnd'], ['shape', 'shape'], ['radius', 'radius'],
        ['box', 'box'], ['velocity_min', 'velocityMin'], ['velocity_max', 'velocityMax'], ['gravity', 'gravity'], ['spin', 'spin'],
        ['color_start', 'colorStart'], ['color_end', 'colorEnd'], ['alpha_start', 'alphaStart'], ['alpha_end', 'alphaEnd'],
        ['texture', 'texture'], ['blend', 'blend'], ['local', 'local'], ['prewarm', 'prewarm'],
    ];
    for (const [arg, key] of map) if (args[arg] !== undefined) p[key] = args[arg];
    const out = sanitizeParticles(p);
    if (!out) throw new ToolError('Invalid particle values.');
    return out;
}

export async function runEffectTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult | null> {
    const ed = env.editor;
    const store = ed.store;
    switch (name) {
        case 'add_particles': {
            const preset = str(args.preset, 'preset', 40);
            if (!PARTICLE_PRESETS.some((p) => p.id === preset)) throw new ToolError(`Unknown preset "${preset}".`);
            if (args.texture && !store.doc.assets.some((a) => a.id === args.texture && a.kind === 'texture')) throw new ToolError(`"${args.texture}" is not a texture asset.`);
            const particles = particleArgs(args, presetParticles(preset));
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
            if (args.texture && !store.doc.assets.some((a) => a.id === args.texture && a.kind === 'texture')) throw new ToolError(`"${args.texture}" is not a texture asset.`);
            const base = args.preset !== undefined ? { ...presetParticles(str(args.preset, 'preset', 40)), texture: target.particles.texture } : target.particles;
            const particles = particleArgs(args, base);
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

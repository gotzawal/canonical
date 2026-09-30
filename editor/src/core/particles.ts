// Particle emitter defaults and presets. The emitter's fields are in
// core/model.ts (Particles).

import { Particles } from './model';
import { defaults } from './schema';
import type { NodeDoc, ParticlesDoc } from './types';

export { PARTICLE_SHAPES } from './model';

export const defaultParticles = (): ParticlesDoc => defaults(Particles);

export interface ParticlePreset {
    id: string;
    label: string;
    hint: string;
    values: Partial<ParticlesDoc>;
}

/** Starting points for common effects; every value can be changed afterwards. */
export const PARTICLE_PRESETS: ParticlePreset[] = [
    {
        id: 'fire',
        label: 'Fire',
        hint: 'Flames rising from a small circle (additive).',
        values: { rate: 45, life: [0.5, 0.9], size: [0.25, 0.4], sizeEnd: 0.25, shape: 'circle', radius: 0.15, velocityMin: [-0.1, 0.6, -0.1], velocityMax: [0.1, 1.1, 0.1], gravity: [0, 0.4, 0], colorStart: '#ff9d3c', colorEnd: '#ff2a08', alphaStart: 0.55, alphaEnd: 0, blend: 'add' },
    },
    {
        id: 'smoke',
        label: 'Smoke',
        hint: 'Slow gray puffs that grow and fade.',
        values: { rate: 12, life: [3, 5], size: [0.4, 0.7], sizeEnd: 3, shape: 'circle', radius: 0.3, velocityMin: [-0.15, 0.4, -0.15], velocityMax: [0.15, 0.8, 0.15], gravity: [0.05, 0.1, 0], colorStart: '#8a8a8a', colorEnd: '#5a5a5a', alphaStart: 0.45, alphaEnd: 0, blend: 'alpha' },
    },
    {
        id: 'sparks',
        label: 'Sparks',
        hint: 'Fast bright sparks that fall.',
        values: { rate: 50, life: [0.5, 1.2], size: [0.03, 0.06], sizeEnd: 0.5, shape: 'sphere', radius: 0.1, velocityMin: [-2, 1.5, -2], velocityMax: [2, 4, 2], gravity: [0, -9.8, 0], colorStart: '#fff2a8', colorEnd: '#ff7b1a', alphaStart: 1, alphaEnd: 0.2, blend: 'add' },
    },
    {
        id: 'embers',
        label: 'Embers',
        hint: 'Glowing specks drifting upward.',
        values: { rate: 10, life: [2, 4], size: [0.02, 0.05], sizeEnd: 0.6, shape: 'circle', radius: 0.5, velocityMin: [-0.2, 0.3, -0.2], velocityMax: [0.2, 0.9, 0.2], gravity: [0, 0.2, 0], colorStart: '#ffa040', colorEnd: '#ff4010', alphaStart: 1, alphaEnd: 0, blend: 'add' },
    },
    {
        id: 'dust',
        label: 'Dust motes',
        hint: 'Specks floating in the air of a room (light shafts).',
        values: { rate: 15, max: 1500, life: [6, 10], size: [0.01, 0.025], sizeEnd: 1, shape: 'box', box: [4, 2.5, 4], velocityMin: [-0.05, -0.03, -0.05], velocityMax: [0.05, 0.05, 0.05], gravity: [0, 0, 0], colorStart: '#fff4dc', colorEnd: '#fff4dc', alphaStart: 0.8, alphaEnd: 0, blend: 'add', prewarm: 8 },
    },
    {
        id: 'rain',
        label: 'Rain',
        hint: 'Falling streaks over a wide box; place it above the level.',
        values: { rate: 600, max: 6000, life: [0.8, 1], size: [0.02, 0.03], sizeEnd: 1, shape: 'box', box: [20, 0.5, 20], velocityMin: [0, -12, 0], velocityMax: [0, -10, 0], gravity: [0, -9.8, 0], colorStart: '#b8c8d8', colorEnd: '#b8c8d8', alphaStart: 0.5, alphaEnd: 0.5, blend: 'alpha', spin: [0, 0], prewarm: 2 },
    },
    {
        id: 'snow',
        label: 'Snow',
        hint: 'Slow flakes over a wide box; place it above the level.',
        values: { rate: 150, max: 6000, life: [6, 9], size: [0.03, 0.06], sizeEnd: 1, shape: 'box', box: [20, 0.5, 20], velocityMin: [-0.3, -1.2, -0.3], velocityMax: [0.3, -0.7, 0.3], gravity: [0.05, 0, 0], colorStart: '#ffffff', colorEnd: '#ffffff', alphaStart: 0.9, alphaEnd: 0.6, blend: 'alpha', prewarm: 9 },
    },
    {
        id: 'mist',
        label: 'Mist',
        hint: 'Low, slow fog puffs near the ground (waterfall spray, marsh).',
        values: { rate: 6, max: 400, life: [6, 10], size: [1.5, 2.5], sizeEnd: 2, shape: 'box', box: [6, 0.3, 6], velocityMin: [-0.1, 0, -0.1], velocityMax: [0.1, 0.1, 0.1], gravity: [0, 0, 0], colorStart: '#dfe6ee', colorEnd: '#dfe6ee', alphaStart: 0.18, alphaEnd: 0, blend: 'alpha', prewarm: 10 },
    },
    {
        id: 'steam',
        label: 'Steam',
        hint: 'White puffs rising from a vent or hot water that widen and fade (dryers, pipes, cups).',
        values: { rate: 14, max: 300, life: [1.5, 2.5], size: [0.12, 0.2], sizeEnd: 4, shape: 'circle', radius: 0.08, velocityMin: [-0.08, 0.6, -0.08], velocityMax: [0.08, 1, 0.08], gravity: [0, 0.15, 0], colorStart: '#eef2f5', colorEnd: '#e2e8ec', alphaStart: 0.35, alphaEnd: 0, blend: 'alpha', prewarm: 3 },
    },
    {
        id: 'spray',
        label: 'Sea spray',
        hint: 'Droplets thrown up where waves hit rocks, falling back as they spread; place it at the waterline.',
        values: { rate: 80, max: 800, life: [0.6, 1.2], size: [0.03, 0.07], sizeEnd: 2.5, shape: 'box', box: [2, 0.2, 0.6], velocityMin: [-1, 2.5, -1], velocityMax: [1, 5, 1], gravity: [0, -9.8, 0], colorStart: '#f4f8fa', colorEnd: '#d8e4ea', alphaStart: 0.7, alphaEnd: 0, blend: 'alpha', prewarm: 1 },
    },
    {
        id: 'magic',
        label: 'Magic sparkles',
        hint: 'Colorful sparkles around a point.',
        values: { rate: 40, life: [0.8, 1.6], size: [0.04, 0.1], sizeEnd: 0.2, shape: 'sphere', radius: 0.4, velocityMin: [-0.3, -0.1, -0.3], velocityMax: [0.3, 0.6, 0.3], gravity: [0, 0.3, 0], colorStart: '#8fd3ff', colorEnd: '#d06bff', alphaStart: 1, alphaEnd: 0, blend: 'add' },
    },
];

export function presetParticles(id: string): ParticlesDoc {
    const preset = PARTICLE_PRESETS.find((p) => p.id === id);
    return Particles.parse({ ...preset?.values, preset: preset?.id });
}

/** Particles alive at once at most: the rate times the longest life, within the cap. */
export function particleCount(p: ParticlesDoc): number {
    return Math.min(p.max, Math.ceil(p.rate * p.life[1]));
}

/** Particles of the whole scene at most, for the performance budget. */
export function sceneParticles(nodes: NodeDoc[]): number {
    let n = 0;
    for (const node of nodes) if (node.particles && node.visible) n += particleCount(node.particles);
    return n;
}

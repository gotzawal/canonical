import { describe, expect, it } from 'vitest';
import { Character, Environment, Geometry, Light, Material, Particles, Player } from '../../src/core/model';
import { defaults, InputError, patch, repair, toolSchema } from '../../src/core/schema';

describe('model schemas', () => {

    it('repair values from files: defaults for what does not fit, clamped numbers', () => {
        const c = repair(Character, { height: 50, radius: 'x', speed: -3, collide: 'yes', extra: 1 })!;
        expect(c).toMatchObject({ height: 20, radius: 0.35, speed: 0, collide: true });
        expect('extra' in c).toBe(false);
        expect(repair(Character, 'not an object')).toBeUndefined();
        // Fields that depend on each other: the body is at least twice its radius.
        expect(repair(Character, { height: 0.4, radius: 1 })!.radius).toBe(0.2);
        expect(repair(Material, { color: 'red', alphaMode: 'weird', tiling: [2, 'x'], params: { a: 1, b: {} } })).toMatchObject({
            color: '#c8c8c8', alphaMode: 'auto', tiling: [2, 1], params: { a: 1 },
        });
        expect(Geometry.parse({ type: 'sphere', radius: 'big' })).toEqual({ type: 'sphere', radius: 0.5, segments: 32 });
        expect(Geometry.parse({ type: 'blob' })).toEqual({ type: 'box', width: 1, height: 1, depth: 1 });
        const p = repair(Particles, { life: [5, 1], velocityMin: [1, 0, 0], velocityMax: [0, 0, 0], max: 12.6 })!;
        expect(p).toMatchObject({ life: [1, 5], velocityMin: [0, 0, 0], velocityMax: [1, 0, 0], max: 13 });
        expect(Environment.parse({ gi: { counts: [40, 40, 40] } }).gi.counts.every((n) => n <= 16)).toBe(true);
    });
});

describe('patch', () => {
    const hex = (v: unknown) => (v === 'red' ? '#ff0000' : String(v));

    it('applies snake_case tool arguments, clamping numbers and reading colors', () => {
        const out = patch(Light, defaults(Light), { cast_shadow: true, outer_angle: 500, color: 'red' }, 'light', hex);
        expect(out).toMatchObject({ castShadow: true, outerAngle: 179, color: '#ff0000' });
    });

    it('merges groups and keeps the fields it was not given', () => {
        const env = defaults(Environment);
        const out = patch(Environment, env, { bloom: { intensity: 2 } }, 'environment');
        expect(out.bloom).toEqual({ ...env.bloom, intensity: 2 });
        expect(out.fog).toEqual(env.fog);
    });

    it('names the argument of the wrong type', () => {
        expect(() => patch(Player, defaults(Player), { view: 'top' }, 'player')).toThrow(InputError);
        expect(() => patch(Player, defaults(Player), { look_speed: 'fast' }, 'player')).toThrow(/player\.look_speed/);
        expect(() => patch(Player, defaults(Player), 5, 'player')).toThrow(/player must be an object/);
        expect(() => patch(Environment, defaults(Environment), { bloom: { strength: 1 } }, 'environment')).toThrow(
            'environment.bloom has no strength; its fields are enable, intensity, threshold, levels, blur.',
        );
    });
});

describe('toolSchema', () => {
    it('describes the fields for the assistant in snake_case, all optional', () => {
        const s = toolSchema(Light);
        expect(s.type).toBe('object');
        expect(s.required).toBeUndefined();
        expect(s.properties.outer_angle).toMatchObject({ type: 'number', minimum: 1, maximum: 179, description: expect.stringMatching(/cone angle/) });
        expect(s.properties.type.enum).toEqual(['directional', 'point', 'spot']);
        expect(s.properties.color.description).toMatch(/#rrggbb/);
        expect(JSON.stringify(s)).not.toMatch(/prefixItems|\$schema|additionalProperties|"kind"|"slider"/);
        const env = toolSchema(Environment);
        expect(env.properties.gi.properties.counts).toMatchObject({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 });
    });
});

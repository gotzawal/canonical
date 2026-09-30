import { describe, expect, it } from 'vitest';
import { Scatter } from '../../src/core/model';
import { placeScatter, raySolid } from '../../src/core/scatter';
import { defaults } from '../../src/core/schema';
import type { ScatterDoc, Vec3 } from '../../src/core/types';

describe('scatter', () => {
    it('places the same copies from a seed, apart, on gentle ground and out of the way, and runs into solid ones', () => {
        const doc: ScatterDoc = { ...defaults(Scatter), sources: [{ model: 'rock', weight: 1, scale: [1, 1], solid: 'box' }], size: [40, 40], count: 300, spacing: 2, slope: [0, 20] };
        const frame = { origin: [0, 0, 0] as Vec3, x: [1, 0, 0] as Vec3, z: [0, 0, 1] as Vec3 };
        // Flat where x < 0, a 45 degree slope where x > 0.
        const ground = (x: number) => (x < 0 ? { y: 0, normal: [0, 1, 0] as Vec3 } : { y: x, normal: [-Math.SQRT1_2, Math.SQRT1_2, 0] as Vec3 });
        const avoid = [{ minX: -10, maxX: -5, minZ: -5, maxZ: 5 }];
        const copies = placeScatter(doc, frame, ground, avoid, 7);
        expect(placeScatter(doc, frame, ground, avoid, 7)).toEqual(copies);
        expect(copies.length).toBeGreaterThan(50);
        for (const [i, c] of copies.entries()) {
            const [x, , z] = c.position;
            expect(x).toBeLessThan(0);
            expect(x > -11 && x < -4 && z > -6 && z < 6).toBe(false);
            for (const o of copies.slice(i + 1)) expect(Math.hypot(o.position[0] - x, o.position[2] - z)).toBeGreaterThanOrEqual(2);
        }
        // A trunk from the ground up and a box turned a quarter: rays from the side stop at their faces.
        expect(raySolid({ kind: 'trunk', center: [0, 0, 0], size: [0.5, 4, 0.5], yaw: 0 }, [-5, 1, 0], [1, 0, 0], 10)?.t).toBeCloseTo(4.5, 5);
        const box = raySolid({ kind: 'box', center: [0, 1, 0], size: [2, 1, 0.5], yaw: Math.PI / 2 }, [-5, 1, 0], [1, 0, 0], 10);
        expect(box?.t).toBeCloseTo(4.5, 5);
        expect(box?.normal[0]).toBeCloseTo(-1, 5);
    });
});

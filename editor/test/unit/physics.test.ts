import { describe, expect, it } from 'vitest';
import { Geometry } from '../../src/core/model';
import { fitShape, primitiveShape } from '../../src/play/physics';

const geo = (g: object) => Geometry.parse(g);
/** The eight corners of a box from min to max, as a hull or mesh gets them. */
const corners = (min: number[], max: number[]) => new Float32Array([0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]));
const mesh = (points: Float32Array) => () => ({ points, indices: new Uint32Array([0, 1, 2, 1, 3, 2]) });

describe('primitiveShape', () => {
    it('fits primitives exactly, with their scale', () => {
        expect(primitiveShape(geo({ type: 'box', width: 1, height: 2, depth: 3 }), [2, 1, 1])).toEqual({ kind: 'cuboid', half: [1, 1, 1.5], at: [0, 0, 0] });
        expect(primitiveShape(geo({ type: 'sphere', radius: 0.5 }), [1, 3, 1])).toEqual({ kind: 'ball', radius: 1.5, at: [0, 0, 0] });
        // The capsule's height includes its caps; Rapier's half height does not.
        expect(primitiveShape(geo({ type: 'capsule', radius: 0.35, height: 1.8 }), [1, 1, 1])).toMatchObject({ kind: 'capsule', radius: 0.35 });
        expect((primitiveShape(geo({ type: 'capsule', radius: 0.35, height: 1.8 }), [1, 1, 1]) as { half: number }).half).toBeCloseTo(0.55);
    });

    it('puts a slab under a plane, so what lands on it rests at its height', () => {
        const s = primitiveShape(geo({ type: 'plane', width: 20, height: 10 }), [1, 1, 1]) as { half: number[]; at: number[] };
        expect(s.half[0]).toBe(10);
        expect(s.half[2]).toBe(5);
        expect(s.at[1] + s.half[1]).toBeCloseTo(0);
    });

    it('leaves shapes without an exact collider to their triangles', () => {
        expect(primitiveShape(geo({ type: 'cylinder', radiusTop: 0.2, radiusBottom: 0.5 }), [1, 1, 1])).toBeNull();
        expect(primitiveShape(geo({ type: 'cone', segments: 4 }), [1, 1, 1])).toBeNull();
        expect(primitiveShape(geo({ type: 'stairs' }), [1, 1, 1])).toBeNull();
    });
});

describe('fitShape', () => {
    const pts = corners([-1, 0, -2], [3, 2, 2]);
    const own = primitiveShape(geo({ type: 'box' }), [1, 1, 1]);

    it('keeps the exact primitive for auto', () => {
        expect(fitShape('auto', 'dynamic', own, mesh(pts))).toBe(own);
    });

    it('fits boxes, spheres and capsules to the bounds of the meshes', () => {
        expect(fitShape('box', 'dynamic', own, mesh(pts))).toEqual({ kind: 'cuboid', half: [2, 1, 2], at: [1, 1, 0] });
        expect(fitShape('sphere', 'dynamic', null, mesh(pts))).toEqual({ kind: 'ball', radius: 2, at: [1, 1, 0] });
        expect(fitShape('capsule', 'fixed', null, mesh(pts))).toEqual({ kind: 'capsule', half: 0, radius: 2, at: [1, 1, 0] });
    });

    it('wraps dynamic meshes in a hull and keeps the triangles of the rest', () => {
        expect(fitShape('mesh', 'dynamic', null, mesh(pts))).toMatchObject({ kind: 'hull' });
        expect(fitShape('auto', 'fixed', null, mesh(pts))).toMatchObject({ kind: 'mesh' });
        expect(fitShape('auto', 'kinematic', null, mesh(new Float32Array(6)))).toBeNull();
    });
});

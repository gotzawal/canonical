import { describe, expect, it } from 'vitest';
import { Scatter } from '../../src/core/model';
import { placeScatter, raySolid } from '../../src/core/scatter';
import { layerWeights } from '../../src/core/terrain';
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

    it('keeps its copies where the newer rules are off, and gathers, filters, tilts and buries them where they are on', () => {
        const base: ScatterDoc = { ...defaults(Scatter), sources: [{ model: 'rock', weight: 1, scale: [0.5, 2], solid: 'none' }], size: [80, 80], count: 400, spacing: 0.5 };
        const frame = { origin: [0, 0, 0] as Vec3, x: [1, 0, 0] as Vec3, z: [0, 0, 1] as Vec3 };
        const flat = () => ({ y: 0, normal: [0, 1, 0] as Vec3 });
        const plain = placeScatter(base, frame, flat, [], 3);
        // Clusters leave bare ground: copies have more neighbours close by than an even spread.
        const grouped = placeScatter({ ...base, clusters: 1, clusterSize: 12 }, frame, flat, [], 3);
        expect(grouped.length).toBeGreaterThan(200);
        const near = (list: typeof plain) => list.reduce((n, c) => n + list.filter((o) => o !== c && Math.hypot(o.position[0] - c.position[0], o.position[2] - c.position[2]) < 3).length, 0) / list.length;
        expect(near(grouped)).toBeGreaterThan(near(plain) * 1.5);
        // A layer: copies stand only where it shows (here: the east half).
        const onLayer = placeScatter({ ...base, layer: 2 }, frame, flat, [], 3, { layers: (x) => (x > 0 ? [0, 1] : [1, 0]) });
        expect(onLayer.length).toBeGreaterThan(100);
        for (const c of onLayer) expect(c.position[0]).toBeGreaterThan(0);
        // Tilt turns copies off upright; bury sinks them on a slope by their width.
        const tilted = placeScatter({ ...base, tilt: 40 }, frame, flat, [], 3);
        expect(tilted.some((c) => Math.abs(c.rotation[0]) + Math.abs(c.rotation[2]) > 0.05)).toBe(true);
        const slope = () => ({ y: 0, normal: [-Math.SQRT1_2, Math.SQRT1_2, 0] as Vec3 });
        const buried = placeScatter({ ...base, slope: [0, 90], bury: 1 }, frame, slope, [], 3, { footprint: () => 1 });
        for (const c of buried) expect(c.position[1]).toBeLessThan(-0.4 * c.scale);
        // Without the newer rules the copies are where they were.
        const again = placeScatter({ ...base, bury: 1, tilt: 0 }, frame, flat, [], 3, { footprint: () => 1 });
        expect(again.map((c) => c.position)).toEqual(plain.map((c) => c.position));
    });

    it('weighs terrain layers by their rules and paint as the material does', () => {
        const layer = (height: [number, number], slope: [number, number], onlyPainted = false) => ({ height, slope, heightBlend: 0.0001, slopeBlend: 0.0001, onlyPainted });
        const layers = [layer([-1e4, 1e4], [0, 90]), layer([-1e4, 2], [0, 90]), layer([-1e4, 1e4], [35, 90]), layer([-1e4, 1e4], [0, 90], true)];
        expect(layerWeights(layers, 1, 10)).toEqual([0, 1, 0, 0]);
        expect(layerWeights(layers, 5, 10)).toEqual([1, 0, 0, 0]);
        expect(layerWeights(layers, 5, 50)).toEqual([0, 0, 1, 0]);
        const painted = layerWeights(layers, 5, 10, [0, 0, 0, 1]);
        expect(painted[3]).toBeCloseTo(1, 5);
    });
});

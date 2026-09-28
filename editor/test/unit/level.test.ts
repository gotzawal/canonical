import { describe, expect, it } from 'vitest';
import type { RayHit } from '../../src/core/math';
import type { Vec3 } from '../../src/core/types';
import { builtBounds, checkLevel, summarize, type LevelScan } from '../../src/design/levelCheck';
import { planBuilding, type OpeningSpec } from '../../src/design/rooms';
import { CharacterMotor } from '../../src/play/motor';

interface Block {
    id: string;
    min: Vec3;
    max: Vec3;
}

/** Nearest hit of a ray on boxes, with the outward normal of the face it meets (from inside: the face it leaves by). */
function castBoxes(blocks: Block[], o: Vec3, dir: Vec3, maxDist: number, ignore?: (id: string) => boolean): RayHit | null {
    const n = Math.hypot(dir[0], dir[1], dir[2]);
    const d = dir.map((v) => v / n) as Vec3;
    let best: RayHit | null = null;
    for (const b of blocks) {
        if (ignore?.(b.id)) continue;
        let t0 = -Infinity, t1 = Infinity, a0 = 0, a1 = 0, miss = false;
        for (let i = 0; i < 3; i++) {
            if (Math.abs(d[i]) < 1e-12) {
                if (o[i] < b.min[i] || o[i] > b.max[i]) miss = true;
                continue;
            }
            const near = ((d[i] > 0 ? b.min[i] : b.max[i]) - o[i]) / d[i];
            const far = ((d[i] > 0 ? b.max[i] : b.min[i]) - o[i]) / d[i];
            if (near > t0) [t0, a0] = [near, i];
            if (far < t1) [t1, a1] = [far, i];
        }
        if (miss || t1 < Math.max(t0, 0)) continue;
        const inside = t0 < 0;
        const t = inside ? t1 : t0;
        if (t > maxDist || (best && t >= best.distance)) continue;
        const axis = inside ? a1 : a0;
        const normal: Vec3 = [0, 0, 0];
        normal[axis] = inside ? Math.sign(d[axis]) : -Math.sign(d[axis]);
        best = { distance: t, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], id: b.id, normal };
    }
    return best;
}

function scan(blocks: Block[]): LevelScan {
    return {
        objects: blocks.map((b) => ({ id: b.id, name: b.id, box: { min: b.min, max: b.max }, mesh: true })),
        cast: (o, d, m, ignore) => castBoxes(blocks, o, d, m, ignore),
        descendants: () => [],
    };
}

const ground: Block = { id: 'ground', min: [-10, -0.2, -10], max: [10, 0, 10] };

/** A 4 x 4 m room built by the room planner, as blocks. */
function room(openings: OpeningSpec[] = []): Block[] {
    const plan = planBuilding([{ name: 'Hall', min: [0, 0], max: [4, 4], floorY: 0, height: 3, floor: true, ceiling: true, open: [], openings, holes: [] }], { wall: 0.2, slab: 0.2 });
    return plan.pieces.map((p, i) => ({
        id: `${p.kind}${i}`,
        min: p.center.map((c, k) => c - p.size[k] / 2) as Vec3,
        max: p.center.map((c, k) => c + p.size[k] / 2) as Vec3,
    }));
}

const door: OpeningSpec = { side: 'z_min', kind: 'door', width: 1, height: 2.1, sill: 0 };
const body = { height: 1.8, radius: 0.35, stepHeight: 0.3 };
const region = { min: [-2, -1, -4.5] as Vec3, max: [6, 5, 6] as Vec3 };

function check(blocks: Block[], start: Vec3 | null = [2, 0, -3]) {
    return checkLevel(scan(blocks), { box: region, step: 0.5, body, start, targets: [{ name: 'inside', point: [2, 0, 2] }] });
}

describe('checkLevel', () => {
    it('finds a room with a door closed and walks in through the door', async () => {
        const { report } = await check([ground, ...room([door])]);
        expect(report.closed).toBe(true);
        expect(report.unreachable).toEqual([]);
        expect(report.sealed).toEqual([]);
        expect(report.openings.some((o) => o.kind === 'passage')).toBe(true);
        expect(report.stats.ceiling).toBe(3);
        expect(summarize(report)).toMatch(/^Closed and walkable/);
    });

    it('reports a room without a door as sealed and its inside out of reach', async () => {
        const { report } = await check([ground, ...room()]);
        expect(report.unreachable.map((u) => u.name)).toEqual(['inside']);
        expect(report.sealed.length).toBeGreaterThan(0);
        expect(report.ok).toBe(false);
    });

    it('reports walls that nearly meet and objects that float', async () => {
        const walls: Block[] = [
            { id: 'wallA', min: [-1, 0, 0], max: [1, 3, 0.2] },
            { id: 'wallB', min: [1.1, 0, 0], max: [3, 3, 0.2] },
            { id: 'crate', min: [4, 1.5, 4], max: [5, 2.5, 5] },
        ];
        const { report } = await check([ground, ...walls], null);
        expect(report.seams).toEqual([expect.objectContaining({ gap: 0.1 })]);
        expect(report.floating).toEqual([expect.objectContaining({ id: 'crate', gap: 1.51 })]);
        expect(report.notes.some((n) => /reach was not checked/.test(n))).toBe(true);
    });

    it('leaves wide ground planes out of the built bounds', () => {
        const huge: Block = { id: 'plane', min: [-500, 0, -500], max: [500, 0, 500] };
        const b = builtBounds(scan([huge, ...room()]).objects)!;
        [...b.min, ...b.max].forEach((v, i) => expect(v).toBeCloseTo([-0.1, -0.2, -0.1, 4.1, 3.2, 4.1][i]));
    });
});

describe('CharacterMotor', () => {
    const level: Block[] = [ground, { id: 'step', min: [1, 0, -1], max: [3, 0.2, 1] }, { id: 'wall', min: [5, 0, -2], max: [5.2, 3, 2] }];
    const cast = (o: Vec3, d: Vec3, m: number) => castBoxes(level, o, d, m);

    it('climbs a low step and stops at a wall', () => {
        const motor = new CharacterMotor(cast, body, [0, 0, 0]);
        let top = 0;
        for (let i = 0; i < 200; i++) {
            motor.step(1 / 60, [0.05, 0, 0], 14);
            if (motor.feet[0] > 1.5 && motor.feet[0] < 2.5) top = Math.max(top, motor.feet[1]);
        }
        expect(top).toBeCloseTo(0.2);
        expect(motor.feet[0]).toBeLessThanOrEqual(5 - body.radius + 1e-6);
        expect(motor.feet[0]).toBeGreaterThan(4);
    });

    it('jumps, falls back and lands', () => {
        const motor = new CharacterMotor(cast, body, [-5, 0, 0]);
        motor.step(1 / 60, [0, 0, 0], 14);
        expect(motor.grounded).toBe(true);
        motor.step(1 / 60, [0, 0, 0], 14, 4.5);
        let peak = 0;
        for (let i = 0; i < 120; i++) {
            motor.step(1 / 60, [0, 0, 0], 14);
            peak = Math.max(peak, motor.feet[1]);
        }
        expect(peak).toBeGreaterThan(0.5);
        expect(motor.grounded).toBe(true);
        expect(motor.feet[1]).toBeCloseTo(0);
    });
});

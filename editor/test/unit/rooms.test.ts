import { describe, expect, it } from 'vitest';
import { planBuilding, snapRooms, subtract, type Piece, type RoomSpec } from '../../src/design/rooms';
import type { Vec3 } from '../../src/core/types';

const room = (name: string, min: [number, number], max: [number, number], extra: Partial<RoomSpec> = {}): RoomSpec => ({
    name, min, max, floorY: 0, height: 3, floor: true, ceiling: true, open: [], openings: [], holes: [], ...extra,
});
const settings = { wall: 0.2, slab: 0.2 };

/** Volume two boxes share. */
function overlap(a: Piece, b: Piece): number {
    let v = 1;
    for (let i = 0; i < 3; i++) {
        const lo = Math.max(a.center[i] - a.size[i] / 2, b.center[i] - b.size[i] / 2);
        const hi = Math.min(a.center[i] + a.size[i] / 2, b.center[i] + b.size[i] / 2);
        v *= Math.max(0, hi - lo);
    }
    return v;
}

const inside = (p: Piece, pt: Vec3) => [0, 1, 2].every((i) => Math.abs(pt[i] - p.center[i]) < p.size[i] / 2);

/** Walls meet without overlapping at corners and junctions (floors reach under them by design). */
function expectNoOverlaps(pieces: Piece[]) {
    const walls = pieces.filter((p) => p.kind === 'wall');
    for (let i = 0; i < walls.length; i++) {
        for (let j = i + 1; j < walls.length; j++) expect(overlap(walls[i], walls[j])).toBeLessThan(1e-6);
    }
}

describe('planBuilding', () => {
    it('closes a room with walls, a floor and a ceiling, and cuts its door', () => {
        const plan = planBuilding([room('Hall', [0, 0], [4, 4], { openings: [{ side: 'z_min', kind: 'door', width: 1, height: 2.1, sill: 0 }] })], settings);
        expect(plan.warnings).toEqual([]);
        expect(plan.pieces.filter((p) => p.kind === 'floor')).toHaveLength(1);
        expect(plan.pieces.filter((p) => p.kind === 'ceiling')).toHaveLength(1);
        expect(plan.openings).toEqual([{ room: 'Hall', side: 'z_min', kind: 'door', at: 2, width: 1, bottom: 0, top: 2.1 }]);
        const walls = plan.pieces.filter((p) => p.kind === 'wall');
        // Nothing stands in the doorway; the lintel closes the wall above it.
        expect(walls.some((w) => inside(w, [2, 1, 0]))).toBe(false);
        expect(walls.some((w) => inside(w, [2, 2.5, 0]))).toBe(true);
        expectNoOverlaps(plan.pieces);
    });

    it('builds one wall between rooms that share a side', () => {
        const plan = planBuilding([room('A', [0, 0], [4, 4]), room('B', [4, 0], [8, 4])], settings);
        // The wall along z at x = 4 (the walls along x are centered there too).
        const shared = plan.pieces.filter((p) => p.kind === 'wall' && p.center[0] === 4 && p.size[2] > p.size[0]);
        expect(shared).toHaveLength(1);
        expect(shared[0].rooms.sort()).toEqual(['A', 'B']);
        expectNoOverlaps(plan.pieces);
    });

    it('leaves out a wall on an open side and warns about a door placed there', () => {
        const plan = planBuilding([room('Porch', [0, 0], [3, 3], { open: ['z_max'], openings: [{ side: 'z_max', kind: 'door', width: 1, height: 2, sill: 0 }] })], settings);
        expect(plan.openings).toEqual([]);
        expect(plan.warnings[0]).toMatch(/no wall on z_max/);
        expect(plan.pieces.some((p) => p.kind === 'wall' && p.center[2] === 3)).toBe(false);
    });
});

describe('subtract', () => {
    it('keeps the area around a hole', () => {
        const parts = subtract([0, 0, 4, 4], [[1, 1, 2, 2]]);
        const area = parts.reduce((s, [a, b, c, d]) => s + (c - a) * (d - b), 0);
        expect(area).toBeCloseTo(15);
        expect(parts.some(([a, b, c, d]) => a < 1.5 && 1.5 < c && b < 1.5 && 1.5 < d)).toBe(false);
    });

    it('returns the rectangle when the holes miss it', () => {
        expect(subtract([0, 0, 1, 1], [[5, 5, 6, 6]])).toEqual([[0, 0, 1, 1]]);
    });
});

describe('snapRooms', () => {
    it('joins sides a little apart into one wall line', () => {
        const rooms = [room('A', [0, 0], [4, 4]), room('B', [4.1, 0], [8, 4])];
        const notes = snapRooms(rooms, 0.3);
        expect(rooms[0].max[0]).toBe(rooms[1].min[0]);
        expect(notes).toHaveLength(1);
        expect(snapRooms([room('C', [0, 0], [1, 1]), room('D', [3, 0], [4, 1])], 0.3)).toEqual([]);
    });
});

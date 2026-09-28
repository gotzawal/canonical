// Buildings from a floor plan: every room is a rectangle of wall
// centerlines, and rooms that share an edge share one wall. The walls meet
// without gaps or overlaps at corners, T junctions and crossings, doors and
// windows are cut out of them, floors and ceilings close the rooms from
// below and above. The result is a list of boxes (the greybox) that is
// closed by construction; ai/levelTools.ts turns it into objects.

import type { Vec3 } from '../core/types';

/** The side of a room: the wall at its lowest or highest x or z. */
export type Side = 'x_min' | 'x_max' | 'z_min' | 'z_max';
export const SIDES: Side[] = ['x_min', 'x_max', 'z_min', 'z_max'];

export interface OpeningSpec {
    side: Side;
    kind: 'door' | 'window';
    /** World coordinate of the middle of the opening along its wall (x on z walls, z on x walls); the middle of the room's side when left out. */
    at?: number;
    width: number;
    /** Doors: clear height; windows: height of the opening. */
    height: number;
    /** Windows: bottom of the opening above the floor (doors: 0). */
    sill: number;
}

export interface RoomSpec {
    name: string;
    /** Corners of the wall centerlines, [x, z]. */
    min: [number, number];
    max: [number, number];
    /** Top of the floor. */
    floorY: number;
    /** Clear height from the floor to the ceiling. */
    height: number;
    floor: boolean;
    ceiling: boolean;
    /** Sides without a wall; a wall between two rooms goes when either leaves it open. */
    open: Side[];
    openings: OpeningSpec[];
    /** Holes in the floor (stairwells): [minX, minZ, maxX, maxZ]. */
    holes: [number, number, number, number][];
}

export interface BuildSettings {
    /** Wall thickness. */
    wall: number;
    /** Thickness of floors and ceilings. */
    slab: number;
}

export interface Piece {
    name: string;
    kind: 'floor' | 'ceiling' | 'wall';
    /** Room the piece belongs to (floors and ceilings), or the rooms a wall closes. */
    rooms: string[];
    /** World center and size of the box. */
    center: Vec3;
    size: Vec3;
}

export interface PlacedOpening {
    room: string;
    side: Side;
    kind: 'door' | 'window';
    /** Middle along the wall, width, bottom and top (world y). */
    at: number;
    width: number;
    bottom: number;
    top: number;
}

export interface BuildingPlan {
    pieces: Piece[];
    openings: PlacedOpening[];
    warnings: string[];
}

const EPS = 1e-3;

/** A room side as a line: 'x' runs along x (at z = c), 'z' along z (at x = c), from a0 to a1. */
interface Edge {
    axis: 'x' | 'z';
    c: number;
    a0: number;
    a1: number;
    y: number;
    top: number;
    room: number;
    side: Side;
    open: boolean;
}

interface Hole {
    a0: number;
    a1: number;
    bottom: number;
    top: number;
    opening: PlacedOpening;
}

/** A straight stretch of wall with one height. */
interface Run {
    axis: 'x' | 'z';
    c: number;
    y: number;
    top: number;
    /** Centerline extent. */
    a0: number;
    a1: number;
    /** Extent of the box after the junctions (longer at corners it covers, shorter where it meets a wall). */
    s0: number;
    s1: number;
    rooms: Set<number>;
    holes: Hole[];
}

const near = (a: number, b: number) => Math.abs(a - b) < EPS;
const key = (v: number) => Math.round(v * 1000);

function edgesOf(r: RoomSpec, i: number): Edge[] {
    const [x0, z0] = r.min;
    const [x1, z1] = r.max;
    const base = { y: r.floorY, top: r.floorY + r.height, room: i };
    return [
        { ...base, axis: 'z', c: x0, a0: z0, a1: z1, side: 'x_min', open: r.open.includes('x_min') },
        { ...base, axis: 'z', c: x1, a0: z0, a1: z1, side: 'x_max', open: r.open.includes('x_max') },
        { ...base, axis: 'x', c: z0, a0: x0, a1: x1, side: 'z_min', open: r.open.includes('z_min') },
        { ...base, axis: 'x', c: z1, a0: x0, a1: x1, side: 'z_max', open: r.open.includes('z_max') },
    ];
}

/**
 * The boxes of a building. Rooms are given by their wall centerlines; walls
 * are `wall` thick and reach from under the floor slab to the ceiling.
 */
export function planBuilding(rooms: RoomSpec[], s: BuildSettings): BuildingPlan {
    const warnings: string[] = [];
    const t = s.wall;
    const half = t / 2;
    const openings: PlacedOpening[] = [];

    // 1. Wall lines: the room sides on one line and floor, cut where any side
    //    starts or ends. A stretch is walled when a room has it and none leaves it open.
    const groups = new Map<string, Edge[]>();
    rooms.forEach((r, i) => {
        for (const e of edgesOf(r, i)) {
            const k = `${e.axis}|${key(e.c)}|${key(e.y)}`;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k)!.push(e);
        }
    });
    const runs: Run[] = [];
    for (const edges of groups.values()) {
        const cuts = [...new Set(edges.flatMap((e) => [key(e.a0), key(e.a1)]))].sort((a, b) => a - b).map((v) => v / 1000);
        let cur: Run | null = null;
        for (let i = 0; i + 1 < cuts.length; i++) {
            const b0 = cuts[i];
            const b1 = cuts[i + 1];
            const on = edges.filter((e) => e.a0 <= b0 + EPS && e.a1 >= b1 - EPS);
            if (!on.length || on.some((e) => e.open)) {
                cur = null;
                continue;
            }
            const top = Math.max(...on.map((e) => e.top));
            if (cur && near(cur.a1, b0) && near(cur.top, top)) {
                cur.a1 = b1;
                cur.s1 = b1;
                for (const e of on) cur.rooms.add(e.room);
                continue;
            }
            const e = on[0];
            cur = { axis: e.axis, c: e.c, y: e.y, top, a0: b0, a1: b1, s0: b0, s1: b1, rooms: new Set(on.map((x) => x.room)), holes: [] };
            runs.push(cur);
        }
    }

    // 2. Doors and windows go into the wall stretch under their middle.
    rooms.forEach((r, i) => {
        for (const o of r.openings) {
            const e = edgesOf(r, i).find((x) => x.side === o.side)!;
            const at = o.at ?? (e.a0 + e.a1) / 2;
            const run = runs.find((w) => w.axis === e.axis && near(w.c, e.c) && near(w.y, e.y) && w.a0 - EPS <= at && at <= w.a1 + EPS);
            if (!run) {
                warnings.push(`${r.name}: no wall on ${o.side} at ${round(at)} for the ${o.kind} (the side is open or the position is off it).`);
                continue;
            }
            // Keep a stub of wall at both ends, so corners stay solid.
            const room = run.a1 - run.a0 - 2 * t;
            let width = Math.max(0.1, o.width);
            if (width > room) {
                if (room < 0.3) {
                    warnings.push(`${r.name}: the ${o.side} wall is too short for a ${o.kind}.`);
                    continue;
                }
                warnings.push(`${r.name}: the ${o.kind} on ${o.side} was narrowed from ${round(width)} to ${round(room)} m to fit its wall.`);
                width = room;
            }
            const mid = Math.min(run.a1 - t - width / 2, Math.max(run.a0 + t + width / 2, at));
            const bottom = r.floorY + (o.kind === 'door' ? 0 : Math.max(0, o.sill));
            const top = Math.min(run.top, bottom + Math.max(0.1, o.height));
            if (top - bottom < 0.1) {
                warnings.push(`${r.name}: the ${o.kind} on ${o.side} does not fit under the ceiling.`);
                continue;
            }
            const placed: PlacedOpening = { room: r.name, side: o.side, kind: o.kind, at: round(mid), width: round(width), bottom: round(bottom), top: round(top) };
            const a0 = mid - width / 2;
            const a1 = mid + width / 2;
            if (run.holes.some((hole) => hole.a0 < a1 - EPS && a0 < hole.a1 - EPS)) {
                // The room on the other side asked for the same opening: one is enough.
                const same = run.holes.find((hole) => near(hole.a0, a0) && near(hole.a1, a1) && near(hole.bottom, bottom));
                if (!same) warnings.push(`${r.name}: the ${o.kind} on ${o.side} overlaps another opening of that wall and was left out.`);
                continue;
            }
            run.holes.push({ a0, a1, bottom, top, opening: placed });
            openings.push(placed);
        }
    });

    // 3. Junctions, where walls along x and along z meet: one wall takes the
    //    square they share (one that goes on through it, else the tallest)
    //    and the others stop at its faces; a wall crossing it is cut in two.
    //    Where a wall rises above the one taking the square, a post fills it up.
    const fillers: { x: number; z: number; bottom: number; top: number; rooms: Set<number> }[] = [];
    const xs = runs.filter((r) => r.axis === 'x');
    const zs = runs.filter((r) => r.axis === 'z');
    const covers = (r: Run, a: number) => r.a0 - EPS <= a && a <= r.a1 + EPS;
    const through = (r: Run, a: number) => r.a0 < a - EPS && a < r.a1 - EPS;
    const junctions = new Map<string, { x: number; z: number; y: number }>();
    for (const r of xs) {
        for (const w of zs) {
            if (near(r.y, w.y) && covers(r, w.c) && covers(w, r.c)) junctions.set(`${key(w.c)}|${key(r.c)}|${key(r.y)}`, { x: w.c, z: r.c, y: r.y });
        }
    }
    const cuts = new Map<Run, number[]>();
    for (const j of junctions.values()) {
        const along = (r: Run) => (r.axis === 'x' ? j.x : j.z);
        const meeting = [
            ...xs.filter((r) => near(r.y, j.y) && near(r.c, j.z) && covers(r, j.x)),
            ...zs.filter((r) => near(r.y, j.y) && near(r.c, j.x) && covers(r, j.z)),
        ];
        const passing = meeting.filter((r) => through(r, along(r)));
        const owner = passing[0] ?? meeting.reduce((a, b) => (b.top > a.top + EPS ? b : a));
        for (const r of meeting) {
            if (r === owner) {
                // Ending here, it reaches over the square.
                if (!through(r, along(r))) {
                    if (near(r.a1, along(r))) r.s1 = along(r) + half;
                    else r.s0 = along(r) - half;
                }
                continue;
            }
            if (through(r, along(r))) {
                if (!cuts.has(r)) cuts.set(r, []);
                cuts.get(r)!.push(along(r));
            } else if (near(r.a1, along(r))) r.s1 = along(r) - half;
            else r.s0 = along(r) + half;
        }
        const top = Math.max(...meeting.map((r) => r.top));
        if (top > owner.top + EPS) fillers.push({ x: j.x, z: j.z, bottom: owner.top, top, rooms: new Set(meeting.flatMap((r) => [...r.rooms])) });
    }
    const walls: Run[] = [];
    for (const r of runs) {
        let from = r.s0;
        const points = (cuts.get(r) ?? []).sort((a, b) => a - b);
        for (const at of [...points, null]) {
            const to = at === null ? r.s1 : at - half;
            const holes = r.holes.filter((hole) => hole.a0 >= from - EPS && hole.a1 <= to + EPS);
            walls.push({ ...r, s0: from, s1: to, holes });
            if (at !== null) from = at + half;
        }
        for (const hole of r.holes) {
            if (!walls.some((w) => w.holes.includes(hole))) warnings.push(`${hole.opening.room}: the ${hole.opening.kind} on ${hole.opening.side} at ${hole.opening.at} is where another wall crosses; it was left out.`);
            // A wall ending in a door or window leaves its end in the opening.
            else if (junctions.size && [...junctions.values()].some((j) => near(j.y, r.y) && near(r.axis === 'x' ? j.z : j.x, r.c) && hole.a0 - half < (r.axis === 'x' ? j.x : j.z) && (r.axis === 'x' ? j.x : j.z) < hole.a1 + half)) {
                warnings.push(`${hole.opening.room}: the ${hole.opening.kind} on ${hole.opening.side} at ${hole.opening.at} is where another wall meets this one; move it along the wall.`);
            }
        }
    }
    const dropped = new Set(runs.flatMap((r) => r.holes).filter((hole) => !walls.some((w) => w.holes.includes(hole))).map((hole) => hole.opening));
    const kept = openings.filter((o) => !dropped.has(o));

    // 4. Wall boxes: solid between the openings, a lintel over each one and a sill under windows.
    const pieces: Piece[] = [];
    const slabBottom = (r: Run) => r.y - s.slab;
    const names = (set: Set<number>) => [...set].map((i) => rooms[i].name);
    const wallBox = (r: Run, a0: number, a1: number, bottom: number, top: number) => {
        if (a1 - a0 < EPS || top - bottom < EPS) return;
        const mid = (a0 + a1) / 2;
        const center: Vec3 = r.axis === 'x' ? [mid, (bottom + top) / 2, r.c] : [r.c, (bottom + top) / 2, mid];
        const size: Vec3 = r.axis === 'x' ? [a1 - a0, top - bottom, t] : [t, top - bottom, a1 - a0];
        pieces.push({ name: 'Wall', kind: 'wall', rooms: names(r.rooms), center: round3(center), size: round3(size) });
    };
    for (const r of walls) {
        let cursor = r.s0;
        const bottom = slabBottom(r);
        for (const hole of [...r.holes].sort((a, b) => a.a0 - b.a0)) {
            wallBox(r, cursor, hole.a0, bottom, r.top);
            // Under a door the floors of both sides meet; a window has a sill.
            if (hole.opening.kind === 'window') wallBox(r, hole.a0, hole.a1, bottom, hole.bottom);
            wallBox(r, hole.a0, hole.a1, hole.top, r.top);
            cursor = hole.a1;
        }
        wallBox(r, cursor, r.s1, bottom, r.top);
    }
    for (const f of fillers) {
        pieces.push({ name: 'Wall', kind: 'wall', rooms: names(f.rooms), center: round3([f.x, (f.bottom + f.top) / 2, f.z]), size: round3([t, f.top - f.bottom, t]) });
    }

    // 5. Floors (around stairwell holes) and ceilings. A ceiling reaches over
    //    the outside walls; under a floor of the rooms above it is that floor.
    rooms.forEach((r, i) => {
        const [x0, z0] = r.min;
        const [x1, z1] = r.max;
        if (r.floor) {
            for (const [a, b, c, d] of subtract([x0, z0, x1, z1], r.holes)) {
                pieces.push({ name: `${r.name} Floor`, kind: 'floor', rooms: [r.name], center: round3([(a + c) / 2, r.floorY - s.slab / 2, (b + d) / 2]), size: round3([c - a, s.slab, d - b]) });
            }
        }
        if (!r.ceiling) return;
        const top = r.floorY + r.height;
        const above = rooms.some((o, j) => j !== i && o.floor && near(o.floorY, top + s.slab) && o.min[0] <= x0 + EPS && o.min[1] <= z0 + EPS && o.max[0] >= x1 - EPS && o.max[1] >= z1 - EPS);
        if (above) return;
        const shared = (side: Side) =>
            r.open.includes(side) ||
            rooms.some((o, j) => {
                if (j === i || !near(o.floorY, r.floorY)) return false;
                const [c, a0, a1, oc] =
                    side === 'x_min' ? [x0, z0, z1, o.max[0]] : side === 'x_max' ? [x1, z0, z1, o.min[0]] : side === 'z_min' ? [z0, x0, x1, o.max[1]] : [z1, x0, x1, o.min[1]];
                const [b0, b1] = side === 'x_min' || side === 'x_max' ? [o.min[1], o.max[1]] : [o.min[0], o.max[0]];
                return near(c, oc) && Math.min(a1, b1) - Math.max(a0, b0) > EPS;
            });
        const ex0 = shared('x_min') ? x0 : x0 - half;
        const ex1 = shared('x_max') ? x1 : x1 + half;
        const ez0 = shared('z_min') ? z0 : z0 - half;
        const ez1 = shared('z_max') ? z1 : z1 + half;
        pieces.push({ name: `${r.name} Ceiling`, kind: 'ceiling', rooms: [r.name], center: round3([(ex0 + ex1) / 2, top + s.slab / 2, (ez0 + ez1) / 2]), size: round3([ex1 - ex0, s.slab, ez1 - ez0]) });
    });
    return { pieces, openings: kept, warnings };
}

/** A rectangle [x0, z0, x1, z1] without the holes, as rectangles (rows of grid cells merged). */
export function subtract(rect: [number, number, number, number], holes: [number, number, number, number][]): [number, number, number, number][] {
    const [x0, z0, x1, z1] = rect;
    const inside = holes
        .map(([a, b, c, d]) => [Math.max(x0, Math.min(a, c)), Math.max(z0, Math.min(b, d)), Math.min(x1, Math.max(a, c)), Math.min(z1, Math.max(b, d))] as [number, number, number, number])
        .filter(([a, b, c, d]) => c - a > EPS && d - b > EPS);
    if (!inside.length) return [rect];
    const xsCut = [...new Set([x0, x1, ...inside.flatMap((h) => [h[0], h[2]])].map(key))].sort((a, b) => a - b).map((v) => v / 1000);
    const zsCut = [...new Set([z0, z1, ...inside.flatMap((h) => [h[1], h[3]])].map(key))].sort((a, b) => a - b).map((v) => v / 1000);
    const out: [number, number, number, number][] = [];
    for (let j = 0; j + 1 < zsCut.length; j++) {
        let start: number | null = null;
        for (let i = 0; i + 1 <= xsCut.length; i++) {
            const solid =
                i + 1 < xsCut.length &&
                !inside.some((h) => h[0] <= xsCut[i] + EPS && xsCut[i + 1] <= h[2] + EPS && h[1] <= zsCut[j] + EPS && zsCut[j + 1] <= h[3] + EPS);
            if (solid && start === null) start = xsCut[i];
            if (!solid && start !== null) {
                out.push([start, zsCut[j], xsCut[i], zsCut[j + 1]]);
                start = null;
            }
        }
    }
    // Rows of the same span on top of each other become one.
    const merged: [number, number, number, number][] = [];
    for (const r of out) {
        const prev = merged.find((m) => near(m[0], r[0]) && near(m[2], r[2]) && near(m[3], r[1]));
        if (prev) prev[3] = r[3];
        else merged.push([...r]);
    }
    return merged;
}

function round(v: number): number {
    return Math.round(v * 1000) / 1000;
}

function round3(v: Vec3): Vec3 {
    return [round(v[0]), round(v[1]), round(v[2])];
}

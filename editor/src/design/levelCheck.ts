// Checks a greybox level the way the player will meet it: are its
// buildings closed (no seams between walls, floors and ceilings, no gaps in
// walls, roofs or floors), can the player walk the route at its size (doors
// wide and high enough, steps low enough), does anything float, and where
// do large empty spaces make it less compact? The level is sampled on a
// grid of columns with ray casts; the findings come with a plan view.

import { layoutSignature, levelSignature, stageIndex } from '../core/design';
import type { RayHit } from '../core/math';
import type { AreaDoc, Vec3 } from '../core/types';
import type { Editor } from '../editor';
import { LevelRays } from '../engine/levelRays';
import type { Box } from '../engine/picking';
import { CharacterMotor } from '../play/motor';

export interface CheckBody {
    height: number;
    radius: number;
    stepHeight: number;
}

/** A shown object of the level: its world box, and whether it is a mesh (or a model). */
export interface LevelObject {
    id: string;
    name: string;
    box: Box;
    mesh: boolean;
}

/** What the check sees of the level (scanLevel makes it from the editor's scene). */
export interface LevelScan {
    objects: LevelObject[];
    /** Nearest hit of a ray against the meshes; `ignore` leaves objects out. */
    cast(origin: Vec3, dir: Vec3, maxDist: number, ignore?: (id: string) => boolean): RayHit | null;
    /** Ids of the objects under an object. */
    descendants(id: string): string[];
    /** The terrains (open ground by design: not counted as empty space). */
    lands?: Set<string>;
}

export interface LevelCheckOptions {
    /** The part of the level to check. */
    box: Box;
    /** Grid spacing in meters (made coarser for big levels). */
    step: number;
    body: CheckBody;
    /** Where the player starts; without it nothing is checked for reach. */
    start: Vec3 | null;
    /** The start is too far outside the region to walk from (checked for the note). */
    startOutside?: boolean;
    /** Points the player has to reach (route points). */
    targets: { name: string; point: Vec3 }[];
    /** The size the plan gives the level (layout size), to compare with what was built. */
    planned?: Vec3 | null;
}

export type OpeningKind = 'passage' | 'window' | 'gap_low' | 'gap_high';

export interface LevelReport {
    ok: boolean;
    /** No seams and no gaps in walls, roofs and floors. */
    closed: boolean;
    region: { min: Vec3; max: Vec3; step: number };
    /** Walls, floors and ceilings that nearly meet: a slit between them. */
    seams: { a: string; b: string; gap: number; at: Vec3 }[];
    /** Where the inside of a roofed space opens to the outside. Passages and windows are fine; gaps are not. */
    openings: { kind: OpeningKind; at: Vec3; width: number; heights: string }[];
    roofHoles: { at: Vec3; area: number }[];
    floorHoles: { at: Vec3; area: number }[];
    floating: { id: string; name: string; at: Vec3; gap: number | null }[];
    /** Route points (and the like) the player cannot walk to. */
    unreachable: { name: string; point: Vec3 }[];
    /** Roofed spaces the player cannot get into (no door, or one too small). */
    sealed: { at: Vec3; area: number }[];
    /** Large empty spaces: places 3.5 m (indoors) or 8 m (outdoors) from everything, `size` with the room around them, `clearance` the most. */
    empty: { at: Vec3; size: [number, number]; clearance: number; indoor: boolean }[];
    stats: {
        walkable: number;
        reachable: number | null;
        indoor: number;
        /** Median height of the roofed spaces, floor to ceiling. */
        ceiling: number | null;
        /** What was built, x by z (ground planes left out). */
        footprint: [number, number];
    };
    notes: string[];
}

const DOWN: Vec3 = [0, -1, 0];
const UP: Vec3 = [0, 1, 0];
const DIRS8: Vec3[] = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), 0, Math.sin((i * Math.PI) / 4)] as Vec3);
const DIRS4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** Heights above the floor the walls are probed at: under the knees, at the chest, under a door's lintel. */
const PROBES = [0.35, 1.2, 2.0];
/** A space counts as roofed when something is this close overhead. */
const ROOF = 12;
/** Space counts as empty this far (m) from everything: indoors and out. */
const EMPTY_INDOOR = 3.5;
const EMPTY_OUTDOOR = 8;
/** A check of one building or area grows up to this far (m) to take in the player standing outside it. */
const REACH_GROW = 15;

/** A place to stand: a surface in a column of the grid, with the room above it. */
export interface Cell {
    ix: number;
    iz: number;
    x: number;
    z: number;
    y: number;
    /** Distance to what is overhead, Infinity under the open sky. */
    head: number;
    walk: boolean;
    reached: boolean;
    /** The body fits here: nothing within its radius (worked out when needed). */
    fits?: boolean;
    /** Sampled for walls around it: most directions end at a wall. */
    indoor: boolean;
    /** Distance to the nearest obstacle at knee height (sampled cells). */
    clear: number;
    /** It stands on a terrain. */
    land?: boolean;
}

/** The grid of the check and what it found, for the plan view (drawMap). */
export interface LevelPlan {
    box: Box;
    step: number;
    nx: number;
    nz: number;
    columns: Cell[][];
    emptyCells: Cell[];
    objects: { box: Box }[];
    start: Vec3 | null;
    targets: { name: string; point: Vec3 }[];
}

/** The shown objects of the editor's scene but `skip`, with rays against their meshes. */
export function scanLevel(editor: Editor, skip: Set<string>): LevelScan {
    const { store, sync, picker } = editor;
    const rays = new LevelRays(picker, sync, store, (id) => skip.has(id));
    rays.refresh();
    const objects: LevelObject[] = [];
    for (const n of store.doc.nodes) {
        if (skip.has(n.id) || !sync.entries.get(n.id)?.visible) continue;
        // A scatter's area is no object: its solid copies are in the rays.
        if (n.scatter && !n.mesh && !n.model) continue;
        const box = picker.bounds(n.id, false);
        if (box) objects.push({ id: n.id, name: n.name, box, mesh: !!(n.mesh || n.model) });
    }
    return { objects, cast: rays.cast, descendants: (id) => store.descendants(id).map((n) => n.id), lands: new Set(sync.terrains().map((t) => t.id)) };
}

/** World box of what the objects cover, ground planes larger than `limit` left out. */
export function builtBounds(objects: LevelObject[], limit = 200): Box | null {
    let box: Box | null = null;
    for (const { box: b } of objects) {
        const flat = b.max[1] - b.min[1] < 0.05 && (b.max[0] - b.min[0] > limit / 2 || b.max[2] - b.min[2] > limit / 2);
        if (flat) continue;
        box = box ? { min: box.min.map((v, i) => Math.min(v, b.min[i])) as Vec3, max: box.max.map((v, i) => Math.max(v, b.max[i])) as Vec3 } : { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
    }
    return box;
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));
const round = (v: number, k = 100) => Math.round(v * k) / k;
const r2 = (p: Vec3): Vec3 => [round(p[0]), round(p[1]), round(p[2])];

/**
 * Runs the check. It casts many rays (a second or two for a large level)
 * and yields to the page now and then.
 */
export async function checkLevel(level: LevelScan, opts: LevelCheckOptions): Promise<{ report: LevelReport; plan: LevelPlan }> {
    const body = opts.body;
    // Rays against the meshes, and a box per object for seams and support.
    const rays = level;
    const objects = level.objects;

    // The region and its grid: coarser when the level is large.
    const box: Box = { min: [...opts.box.min] as Vec3, max: [...opts.box.max] as Vec3 };
    for (const o of objects) {
        const b = o.box;
        if (b.max[0] < box.min[0] || b.min[0] > box.max[0] || b.max[2] < box.min[2] || b.min[2] > box.max[2]) continue;
        box.max[1] = Math.max(box.max[1], b.max[1]);
    }
    let step = Math.max(0.25, opts.step);
    const span = [box.max[0] - box.min[0], box.max[2] - box.min[2]];
    while ((span[0] / step) * (span[1] / step) > 16000) step *= 1.25;
    step = round(step, 1000);
    const nx = Math.max(1, Math.ceil(span[0] / step));
    const nz = Math.max(1, Math.ceil(span[1] / step));
    const top = box.max[1] + 1;
    const bottom = box.min[1] - 2;
    const columns: Cell[][] = new Array(nx * nz);
    const at = (ix: number, iz: number): Cell[] | null => (ix < 0 || iz < 0 || ix >= nx || iz >= nz ? null : columns[iz * nx + ix]);
    const cellAt = (ix: number, iz: number, y: number, tol: number): Cell | null => {
        let best: Cell | null = null;
        for (const c of at(ix, iz) ?? []) if (Math.abs(c.y - y) <= tol && (!best || Math.abs(c.y - y) < Math.abs(best.y - y))) best = c;
        return best;
    };

    // 1. Columns: every surface to stand on, from the top down, with the room
    //    above it. A face seen from behind means the ray is inside a solid (a
    //    floor running under a wall): no place to stand there.
    const known = (hit: RayHit) => !!(hit.normal[0] || hit.normal[1] || hit.normal[2]);
    for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
            const x = box.min[0] + (ix + 0.5) * step;
            const z = box.min[2] + (iz + 0.5) * step;
            const list: Cell[] = [];
            let from = top;
            for (let k = 0; k < 10 && from > bottom; k++) {
                const hit = rays.cast([x, from, z], DOWN, from - bottom);
                if (!hit) break;
                const y = hit.point[1];
                from = y - 0.02;
                // The top of something, seen from above; else the ray is inside a solid or on a wall.
                if (known(hit) && hit.normal[1] < 0.3) continue;
                const up = rays.cast([x, y + 0.02, z], UP, ROOF);
                // Overhead, the underside of something; its top seen from below means inside a solid.
                if (up && known(up) && up.normal[1] > -0.3) continue;
                const head = up ? up.distance + 0.02 : Infinity;
                if (head >= 0.5) list.push({ ix, iz, x, z, y, head, walk: head >= body.height, reached: false, indoor: false, clear: Infinity, land: !!level.lands?.has(hit.id) });
            }
            columns[iz * nx + ix] = list;
        }
        if (iz % 20 === 19) await pause();
    }
    const cells = columns.flat();

    // 2. Walking: from the start, to the next column where the step up is
    //    small enough and the body passes (the same test the player moves by).
    const motor = new CharacterMotor((o, d, m) => rays.cast(o, d, m), body, [0, 0, 0]);
    const passes = (c: Cell, dx: number, dz: number): boolean => {
        for (const side of [0, 0.2, -0.2]) {
            // Somewhere across the width of the cell is enough.
            motor.feet = [c.x + dz * side * step, c.y, c.z + dx * side * step];
            if (!motor.blocked([dx * step, 0, dz * step])) return true;
        }
        return false;
    };
    // Nothing within the body's radius, above the step height.
    const fits = (c: Cell): boolean => {
        if (c.fits === undefined) {
            const low = body.stepHeight + 0.05;
            c.fits = [low, Math.max(low, body.height * 0.7)].every((h) => DIRS8.every((d) => !rays.cast([c.x, c.y + h, c.z], d, body.radius * 0.95)));
        }
        return c.fits;
    };
    let reachable: number | null = null;
    let startLost = false;
    const unreachable: LevelReport['unreachable'] = [];
    if (opts.start) {
        const s = opts.start;
        const six = Math.floor((s[0] - box.min[0]) / step);
        const siz = Math.floor((s[2] - box.min[2]) / step);
        const first = (at(six, siz) ?? []).filter((c) => c.walk && c.y <= s[1] + 0.6).sort((a, b) => b.y - a.y)[0];
        if (first) {
            first.reached = true;
            const queue = [first];
            for (let n = 0; n < queue.length; n++) {
                const c = queue[n];
                for (const [dx, dz] of DIRS4) {
                    const next = (at(c.ix + dx, c.iz + dz) ?? [])
                        .filter((o) => o.walk && !o.reached && o.y - c.y <= body.stepHeight + 0.05 && c.y - o.y <= 1.2)
                        .sort((a, b) => Math.abs(a.y - c.y) - Math.abs(b.y - c.y))[0];
                    if (!next || !passes(c, dx, dz)) continue;
                    next.reached = true;
                    queue.push(next);
                }
                if (n % 400 === 399) await pause();
            }
            // The body reaches past its center: floor along a wall, closer than
            // its radius, is reached from a reached cell next to it.
            const reach: Cell[] = [];
            for (const c of cells) {
                if (!c.walk || c.reached) continue;
                const near = DIRS4.map(([dx, dz]) => cellAt(c.ix + dx, c.iz + dz, c.y, body.stepHeight + 0.05)).filter((o): o is Cell => !!o?.reached);
                if (!near.length || fits(c)) continue;
                if (near.some((o) => !rays.cast([o.x, Math.max(o.y, c.y) + body.stepHeight + 0.05, o.z], [c.x - o.x, 0, c.z - o.z], step))) reach.push(c);
            }
            for (const c of reach) c.reached = true;
            reachable = cells.filter((c) => c.reached).length;
            for (const t of opts.targets) {
                const tix = Math.floor((t.point[0] - box.min[0]) / step);
                const tiz = Math.floor((t.point[2] - box.min[2]) / step);
                let ok = false;
                for (let dz = -1; dz <= 1 && !ok; dz++) for (let dx = -1; dx <= 1 && !ok; dx++) ok = !!cellAt(tix + dx, tiz + dz, t.point[1], 1.5)?.reached;
                if (!ok && tix >= 0 && tiz >= 0 && tix < nx && tiz < nz) unreachable.push({ name: t.name, point: r2(t.point) });
            }
        } else startLost = true;
    }

    // 3. Roofed spaces: probe the walls around sampled cells at three heights.
    //    Rays that leave the region there run through an opening.
    type Escape = { x: number; z: number; y: number; mask: number };
    const escapes: Escape[] = [];
    const exitDistance = (x: number, z: number, d: Vec3): number => {
        let t = Infinity;
        if (d[0] > 1e-6) t = Math.min(t, (box.max[0] - x) / d[0]);
        if (d[0] < -1e-6) t = Math.min(t, (box.min[0] - x) / d[0]);
        if (d[2] > 1e-6) t = Math.min(t, (box.max[2] - z) / d[2]);
        if (d[2] < -1e-6) t = Math.min(t, (box.min[2] - z) / d[2]);
        return Math.min(60, Math.max(0.5, t + 0.5));
    };
    const covered = (c: Cell | null) => !!c && c.head < ROOF;
    // Every other cell, fewer on large levels.
    const stride = Math.max(2, Math.ceil(Math.sqrt(cells.filter((c) => c.walk && covered(c)).length / 1500)));
    let probed = 0;
    for (const c of cells) {
        if (!c.walk || !covered(c) || c.ix % stride || c.iz % stride) continue;
        const heights = PROBES.filter((hgt) => hgt < c.head - 0.1);
        if (!heights.length) continue;
        const mid = heights.includes(1.2) ? 1.2 : heights[heights.length - 1];
        const open = DIRS8.map((d) => {
            let mask = 0;
            heights.forEach((hgt) => {
                if (!rays.cast([c.x, c.y + hgt, c.z], d, exitDistance(c.x, c.z, d))) mask |= 1 << PROBES.indexOf(hgt);
            });
            return mask;
        });
        const walled = open.filter((m) => !(m & (1 << PROBES.indexOf(mid)))).length;
        c.indoor = walled >= 6;
        if (c.indoor) {
            DIRS8.forEach((d, i) => {
                if (!open[i]) return;
                // Where the roofed space ends along the ray: there is the opening.
                let t = step;
                const limit = exitDistance(c.x, c.z, d);
                while (t < limit) {
                    const ix = Math.floor((c.x + d[0] * t - box.min[0]) / step);
                    const iz = Math.floor((c.z + d[2] * t - box.min[2]) / step);
                    if (!covered(cellAt(ix, iz, c.y, 0.6))) break;
                    t += step / 2;
                }
                const back = Math.max(0, t - step / 2);
                escapes.push({ x: c.x + d[0] * back, z: c.z + d[2] * back, y: c.y, mask: open[i] });
            });
        }
        if (++probed % 150 === 0) await pause();
    }
    const openings: LevelReport['openings'] = [];
    for (const cl of cluster(escapes, (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < 1.0 && Math.abs(a.y - b.y) < 0.6)) {
        const mask = cl.reduce((m, e) => m | e.mask, 0);
        const xs = cl.map((e) => e.x);
        const zs = cl.map((e) => e.z);
        const width = round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + step, 10);
        const low = !!(mask & 1), chest = !!(mask & 2), high = !!(mask & 4);
        const kind: OpeningKind = low && chest ? 'passage' : chest ? 'window' : low ? 'gap_low' : high && !chest ? 'gap_high' : 'window';
        const heights = PROBES.filter((_, i) => mask & (1 << i)).map((v) => `${v} m`).join(', ');
        openings.push({ kind, at: middle(cl), width, heights });
    }

    // 4. Holes: open sky inside a roof, nothing to stand on inside a floor.
    const roofHoles: LevelReport['roofHoles'] = [];
    const roofless = cells.filter((c) => c.walk && !covered(c) && DIRS4.filter(([dx, dz]) => covered(cellAt(c.ix + dx, c.iz + dz, c.y, 0.3))).length >= 3);
    for (const cl of cluster(roofless, (a, b) => Math.abs(a.ix - b.ix) + Math.abs(a.iz - b.iz) === 1 && Math.abs(a.y - b.y) < 0.3)) {
        roofHoles.push({ at: middle(cl), area: round(cl.length * step * step, 10) });
    }
    const floorHoles: LevelReport['floorHoles'] = [];
    const holes: { ix: number; iz: number; x: number; z: number; y: number }[] = [];
    const seen = new Set<string>();
    for (const c of cells) {
        // A terrain has no holes: a column a little higher or lower on it is its slope.
        if (!c.walk || c.land) continue;
        for (const [dx, dz] of DIRS4) {
            const ix = c.ix + dx, iz = c.iz + dz;
            if (!at(ix, iz) || cellAt(ix, iz, c.y, 0.15) || at(ix, iz)!.some((o) => o.land)) continue;
            const k = `${ix},${iz},${Math.round(c.y * 10)}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const around = DIRS4.filter(([ex, ez]) => cellAt(ix + ex, iz + ez, c.y, 0.15)?.walk).length;
            if (around < 3) continue;
            const x = box.min[0] + (ix + 0.5) * step;
            const z = box.min[2] + (iz + 0.5) * step;
            // Inside a solid (a wall standing there) is no hole: the top of it is seen from below.
            const up = rays.cast([x, c.y + 0.05, z], UP, ROOF);
            if (up && known(up) && up.normal[1] > -0.3) continue;
            holes.push({ ix, iz, x, z, y: c.y });
        }
    }
    // A column found from floors at slightly different heights is one hole.
    for (const cl of cluster(holes, (a, b) => Math.abs(a.ix - b.ix) + Math.abs(a.iz - b.iz) <= 1 && Math.abs(a.y - b.y) < 0.3)) {
        const columns = new Set(cl.map((c) => c.iz * nx + c.ix)).size;
        floorHoles.push({ at: middle(cl), area: round(columns * step * step, 10) });
    }

    // 5. Seams: walls, floors and ceilings that stop just short of each other.
    const structural = objects.filter((o) => o.mesh && isStructural(o.box));
    const seams: LevelReport['seams'] = [];
    const sorted = [...structural].sort((a, b) => a.box.min[0] - b.box.min[0]);
    for (let i = 0; i < sorted.length && seams.length < 60; i++) {
        const a = sorted[i];
        for (let j = i + 1; j < sorted.length; j++) {
            const b = sorted[j];
            if (b.box.min[0] > a.box.max[0] + 0.5) break;
            const gap = boxGap(a.box, b.box);
            if (gap.distance > 0.005 && gap.distance < 0.5) seams.push({ a: a.name, b: b.name, gap: round(gap.distance, 1000), at: r2(gap.at) });
        }
    }

    // 6. Floating: meshes touching nothing (not resting on, hanging from or fixed to anything).
    const floating: LevelReport['floating'] = [];
    const meshes = objects.filter((o) => o.mesh);
    for (const o of meshes) {
        const flat = o.box.max[1] - o.box.min[1] < 0.05 && (o.box.max[0] - o.box.min[0] > 50 || o.box.max[2] - o.box.min[2] > 50);
        if (flat) continue;
        const touching = objects.some((p) => p !== o && boxGap(o.box, p.box).distance <= 0.03);
        if (touching) continue;
        const own = new Set([o.id, ...level.descendants(o.id)]);
        const c: Vec3 = [(o.box.min[0] + o.box.max[0]) / 2, o.box.min[1] + 0.01, (o.box.min[2] + o.box.max[2]) / 2];
        const below = rays.cast(c, DOWN, 50, (id) => own.has(id));
        if (below && below.distance < 0.05) continue;
        floating.push({ id: o.id, name: o.name, at: r2(c), gap: below ? round(below.distance) : null });
        if (floating.length >= 30) break;
    }

    // 7. Sealed rooms: roofed space the player cannot get into, where the body
    //    fits (the floor along the walls of a room it reached is no room).
    const sealed: LevelReport['sealed'] = [];
    if (reachable !== null) {
        const inside = cells.filter((c) => c.walk && covered(c) && !c.reached && fits(c));
        for (const cl of cluster(inside, (a, b) => Math.abs(a.ix - b.ix) + Math.abs(a.iz - b.iz) === 1 && Math.abs(a.y - b.y) < body.stepHeight + 0.05)) {
            const area = cl.length * step * step;
            if (area >= 1 && cl.some((c) => c.indoor)) sealed.push({ at: middle(cl), area: round(area, 10) });
        }
    }

    // 8. Compactness: sampled cells far from everything, indoors and out.
    const sample = cells.filter((c) => c.walk && (reachable === null || c.reached) && c.ix % 2 === 0 && c.iz % 2 === 0);
    let n = 0;
    for (const c of sample) {
        let clear = 12;
        for (const d of DIRS8) {
            const hit = rays.cast([c.x, c.y + 0.5, c.z], d, clear);
            if (hit) clear = Math.min(clear, hit.distance);
        }
        c.clear = clear;
        if (++n % 300 === 0) await pause();
    }
    const empty: LevelReport['empty'] = [];
    const emptyCells: Cell[] = [];
    // Open terrain is a landscape by design, not a room left empty.
    const wide = sample.filter((c) => !(c.land && !covered(c)) && c.clear >= (covered(c) ? EMPTY_INDOOR : EMPTY_OUTDOOR));
    for (const cl of cluster(wide, (a, b) => Math.abs(a.ix - b.ix) <= 2 && Math.abs(a.iz - b.iz) <= 2 && Math.abs(a.y - b.y) < 0.5 && covered(a) === covered(b))) {
        if (cl.length < 2) continue;
        emptyCells.push(...cl);
        const indoor = covered(cl[0]);
        // The places that far from everything, and the room around them up to the nearest things, within the region.
        const margin = indoor ? EMPTY_INDOOR : EMPTY_OUTDOOR;
        const xs = cl.map((c) => c.x);
        const zs = cl.map((c) => c.z);
        const x0 = Math.max(box.min[0], Math.min(...xs) - margin), x1 = Math.min(box.max[0], Math.max(...xs) + margin);
        const z0 = Math.max(box.min[2], Math.min(...zs) - margin), z1 = Math.min(box.max[2], Math.max(...zs) + margin);
        empty.push({
            at: middle(cl),
            size: [round(x1 - x0, 10), round(z1 - z0, 10)],
            clearance: round(Math.max(...cl.map((c) => c.clear)), 10),
            indoor,
        });
    }
    empty.sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1]);

    // Stats and notes.
    const area = (list: Cell[]) => round(list.length * step * step, 10);
    const indoorCells = cells.filter((c) => c.walk && covered(c));
    const heights = indoorCells.map((c) => c.head).sort((a, b) => a - b);
    const ceiling = heights.length ? round(heights[Math.floor(heights.length / 2)], 10) : null;
    const built = builtBounds(objects);
    const footprint: [number, number] = built ? [round(built.max[0] - built.min[0], 10), round(built.max[2] - built.min[2], 10)] : [0, 0];
    const notes: string[] = [];
    if (ceiling !== null && ceiling > 4.5) notes.push(`Roofed spaces are ${ceiling} m high in the middle; rooms are usually 2.6-3.2 m (halls more).`);
    if (opts.planned && opts.planned[0] > 0 && opts.planned[2] > 0) {
        const kx = footprint[0] / opts.planned[0];
        const kz = footprint[1] / opts.planned[2];
        if (kx > 1.3 || kz > 1.3) notes.push(`What was built covers ${footprint[0]} x ${footprint[1]} m, the plan's layout ${opts.planned[0]} x ${opts.planned[2]} m.`);
    }
    if (!opts.start) {
        notes.push(
            opts.startOutside
                ? 'The player (or the first route point) stands far outside this part: reach was not checked here. Check the whole level for it.'
                : 'No player or route point to start from: reach was not checked. Place the player (place_player).',
        );
    }
    if (startLost) notes.push('There is no floor under the start (the player or the first route point): reach was not checked.');
    if (!cells.some((c) => c.walk)) notes.push('Nothing to stand on was found in the region.');
    const closed = !seams.length && !openings.some((o) => o.kind === 'gap_low' || o.kind === 'gap_high') && !roofHoles.length && !floorHoles.length;
    const report: LevelReport = {
        ok: closed && !unreachable.length && !sealed.length && !floating.length,
        closed,
        region: { min: r2(box.min), max: r2(box.max), step },
        seams,
        openings: openings.slice(0, 30),
        roofHoles: roofHoles.slice(0, 20),
        floorHoles: floorHoles.slice(0, 20),
        floating,
        unreachable,
        sealed: sealed.slice(0, 20),
        empty: empty.slice(0, 10),
        stats: {
            walkable: area(cells.filter((c) => c.walk)),
            reachable: reachable === null ? null : area(cells.filter((c) => c.reached)),
            indoor: area(indoorCells),
            ceiling,
            footprint,
        },
        notes,
    };
    return { report, plan: { box, step, nx, nz, columns, emptyCells, objects: structural, start: opts.start, targets: opts.targets } };
}

/** Walls, floors and ceilings: tall and thin, or flat and wide. */
function isStructural(b: Box): boolean {
    const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2];
    const wall = dy >= 1.2 && Math.min(dx, dz) <= 0.8 && Math.max(dx, dz) >= 0.6;
    const slab = dy <= 0.6 && dx >= 0.8 && dz >= 0.8;
    return wall || slab;
}

/** Distance between two boxes (0 when they touch or overlap) and the middle of the gap. */
function boxGap(a: Box, b: Box): { distance: number; at: Vec3 } {
    let sum = 0;
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const g = Math.max(a.min[i] - b.max[i], b.min[i] - a.max[i], 0);
        sum += g * g;
        if (a.max[i] < b.min[i]) p[i] = (a.max[i] + b.min[i]) / 2;
        else if (b.max[i] < a.min[i]) p[i] = (b.max[i] + a.min[i]) / 2;
        else p[i] = (Math.max(a.min[i], b.min[i]) + Math.min(a.max[i], b.max[i])) / 2;
    }
    return { distance: Math.sqrt(sum), at: p };
}

/** The middle of a group of places, at the height of its first. */
function middle(list: { x: number; y: number; z: number }[]): Vec3 {
    return r2([avg(list.map((c) => c.x)), list[0].y, avg(list.map((c) => c.z))]);
}

function avg(v: number[]): number {
    return v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
}

/** Groups items that are linked through `near` (connected components). */
function cluster<T>(items: T[], near: (a: T, b: T) => boolean): T[][] {
    const out: T[][] = [];
    const left = new Set(items);
    for (const seed of items) {
        if (!left.has(seed)) continue;
        left.delete(seed);
        const group = [seed];
        for (let i = 0; i < group.length; i++) {
            for (const o of left) {
                if (near(group[i], o)) {
                    left.delete(o);
                    group.push(o);
                }
            }
        }
        out.push(group);
    }
    return out;
}

// ------------------------------------------------------------------- map

const MAP_COLORS = {
    back: '#15181e',
    floor: '#3a404b',
    roofed: '#4b5568',
    reached: '#2f6b4f',
    reachedRoofed: '#3c8a66',
    empty: 'rgba(231, 180, 60, 0.35)',
    wall: '#e8ebf0',
    bad: '#ff5468',
    window: '#5ec8ff',
    passage: '#8bd142',
    float: '#ffa53d',
    text: '#d9dee6',
};

/** A plan view of the check (a PNG data URL): floors, walls, what the player reaches and every finding. */
export function drawMap(report: LevelReport, g: LevelPlan): string {
    const w = g.box.max[0] - g.box.min[0];
    const d = g.box.max[2] - g.box.min[2];
    const scale = Math.max(4, Math.min(48, 720 / Math.max(w, d, 1)));
    const legend = 62;
    const cw = Math.ceil(w * scale) + 20;
    const ch = Math.ceil(d * scale) + 20 + legend;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    // A software canvas: a GPU canvas can read back blank while the GPU is busy with the scene.
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // +x to the right, +z down: the plan as seen from above.
    const px = (x: number) => 10 + (x - g.box.min[0]) * scale;
    const pz = (z: number) => 10 + (z - g.box.min[2]) * scale;
    ctx.fillStyle = MAP_COLORS.back;
    ctx.fillRect(0, 0, cw, ch);
    const s = g.step * scale;
    for (const col of g.columns) {
        // The lowest place to stand shows; upper floors draw over it, roofs nobody reaches do not.
        const list = col.filter((c) => c.walk).sort((a, b) => a.y - b.y);
        for (const c of list) {
            if (c !== list[0] && !c.reached && c.head >= ROOF) continue;
            const roofed = c.head < ROOF;
            ctx.fillStyle = c.reached ? (roofed ? MAP_COLORS.reachedRoofed : MAP_COLORS.reached) : roofed ? MAP_COLORS.roofed : MAP_COLORS.floor;
            ctx.fillRect(px(c.x) - s / 2, pz(c.z) - s / 2, s + 0.5, s + 0.5);
        }
    }
    // Empty space: the sampled places (every other cell) far from everything.
    ctx.fillStyle = MAP_COLORS.empty;
    for (const c of g.emptyCells) ctx.fillRect(px(c.x) - s, pz(c.z) - s, 2 * s + 0.5, 2 * s + 0.5);
    // Walls (tall and thin): solid.
    ctx.fillStyle = MAP_COLORS.wall;
    for (const o of g.objects) {
        const b = o.box;
        if (b.max[1] - b.min[1] < 1.2) continue;
        ctx.fillRect(px(b.min[0]), pz(b.min[2]), Math.max(1, (b.max[0] - b.min[0]) * scale), Math.max(1, (b.max[2] - b.min[2]) * scale));
    }
    const ring = (x: number, z: number, r: number, color: string, fill = false) => {
        ctx.beginPath();
        ctx.arc(px(x), pz(z), r, 0, Math.PI * 2);
        if (fill) {
            ctx.fillStyle = color;
            ctx.fill();
        } else {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2.5;
            ctx.stroke();
        }
    };
    for (const o of report.openings) ring(o.at[0], o.at[2], 6, o.kind === 'passage' ? MAP_COLORS.passage : o.kind === 'window' ? MAP_COLORS.window : MAP_COLORS.bad, o.kind === 'passage' || o.kind === 'window');
    for (const h of [...report.roofHoles, ...report.floorHoles]) {
        ctx.strokeStyle = MAP_COLORS.bad;
        ctx.lineWidth = 2;
        const r = Math.max(5, Math.sqrt(h.area) * scale * 0.6);
        ctx.strokeRect(px(h.at[0]) - r, pz(h.at[2]) - r, 2 * r, 2 * r);
    }
    for (const sd of report.sealed) {
        const r = Math.max(6, Math.sqrt(sd.area) * scale * 0.5);
        ctx.strokeStyle = MAP_COLORS.bad;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 2;
        ctx.strokeRect(px(sd.at[0]) - r, pz(sd.at[2]) - r, 2 * r, 2 * r);
        ctx.setLineDash([]);
    }
    for (const seam of report.seams) ring(seam.at[0], seam.at[2], 9, MAP_COLORS.bad);
    for (const f of report.floating) {
        // A diamond where something hangs in the air.
        const x = px(f.at[0]), z = pz(f.at[2]);
        ctx.fillStyle = MAP_COLORS.float;
        ctx.beginPath();
        ctx.moveTo(x, z - 7);
        ctx.lineTo(x + 7, z);
        ctx.lineTo(x, z + 7);
        ctx.lineTo(x - 7, z);
        ctx.closePath();
        ctx.fill();
    }
    const cross = (x: number, z: number, color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(px(x) - 7, pz(z) - 7);
        ctx.lineTo(px(x) + 7, pz(z) + 7);
        ctx.moveTo(px(x) + 7, pz(z) - 7);
        ctx.lineTo(px(x) - 7, pz(z) + 7);
        ctx.stroke();
    };
    ctx.font = '600 11px system-ui, sans-serif';
    for (const t of g.targets) {
        const bad = report.unreachable.some((u) => u.name === t.name);
        if (bad) cross(t.point[0], t.point[2], MAP_COLORS.bad);
        else ring(t.point[0], t.point[2], 5, MAP_COLORS.passage, true);
        ctx.fillStyle = MAP_COLORS.text;
        ctx.fillText(t.name, px(t.point[0]) + 9, pz(t.point[2]) - 6);
    }
    if (g.start) {
        ring(g.start[0], g.start[2], 7, '#ffffff', true);
        ctx.fillStyle = MAP_COLORS.text;
        ctx.fillText('start', px(g.start[0]) + 9, pz(g.start[2]) + 4);
    }
    // Legend and scale.
    const y0 = ch - legend + 8;
    ctx.font = '11px system-ui, sans-serif';
    const keys: [string, string][] = [
        [MAP_COLORS.reachedRoofed, 'reached, roofed'],
        [MAP_COLORS.reached, 'reached'],
        [MAP_COLORS.roofed, 'roofed, not reached'],
        [MAP_COLORS.floor, 'floor, not reached'],
        [MAP_COLORS.wall, 'wall'],
        [MAP_COLORS.bad, 'problem'],
        [MAP_COLORS.window, 'window'],
        [MAP_COLORS.passage, 'passage'],
        [MAP_COLORS.empty, 'empty space'],
    ];
    let lx = 10;
    let ly = y0;
    for (const [color, label] of keys) {
        const tw = ctx.measureText(label).width + 22;
        if (lx + tw > cw - 8) {
            lx = 10;
            ly += 16;
        }
        ctx.fillStyle = color;
        ctx.fillRect(lx, ly, 10, 10);
        ctx.fillStyle = MAP_COLORS.text;
        ctx.fillText(label, lx + 14, ly + 9);
        lx += tw;
    }
    // Scale bar and the way the plan is turned, after the keys.
    const meters = [1, 2, 5, 10, 20, 50].find((m) => m * scale >= 50) ?? 100;
    const label = `${meters} m   (seen from above: +x right, +z down)`;
    if (lx + meters * scale + ctx.measureText(label).width + 16 > cw - 8) {
        lx = 10;
        ly += 16;
    }
    ctx.fillStyle = MAP_COLORS.text;
    ctx.fillRect(lx, ly + 4, meters * scale, 3);
    ctx.fillText(label, lx + meters * scale + 6, ly + 9);
    return canvas.toDataURL('image/png');
}

// --------------------------------------------------------------- running

/** Findings in a line, for the checklist and the assistant's context. */
export function summarize(r: LevelReport): string {
    const parts: string[] = [];
    const n = (count: number, one: string, many = one + 's') => (count ? [`${count} ${count === 1 ? one : many}`] : []);
    const gaps = r.openings.filter((o) => o.kind === 'gap_low' || o.kind === 'gap_high').length;
    parts.push(
        ...n(r.seams.length, 'seam'),
        ...n(gaps, 'gap in a wall', 'gaps in walls'),
        ...n(r.roofHoles.length, 'hole in a roof', 'holes in roofs'),
        ...n(r.floorHoles.length, 'hole in a floor', 'holes in floors'),
        ...n(r.floating.length, 'floating object'),
        ...n(r.unreachable.length, 'route point out of reach', 'route points out of reach'),
        ...n(r.sealed.length, 'sealed room'),
    );
    const soft = n(r.empty.length, 'large empty space');
    if (!parts.length) return `Closed and walkable${soft.length ? `; ${soft[0]}` : ''}.`;
    return parts.join(', ') + (soft.length ? `; ${soft[0]}` : '') + '.';
}

/**
 * Checks the whole level, one area of the plan or one object (a building),
 * with the player's body (the brief's without a player), walking from the
 * player or the first route point to the route points. A check of the whole
 * level is kept in the plan, where the Level checklist reads it; once the
 * Level stage is done, a passing check also clears its recheck mark (the
 * layout it passed with is what later changes are measured against).
 */
export async function runLevelCheck(editor: Editor, scope: { area?: AreaDoc | null; object?: string | null; step?: number } = {}): Promise<{ report: LevelReport; map: string; scope: string }> {
    const { store, picker, sync } = editor;
    const doc = store.doc;
    const d = doc.design;
    const signature = levelSignature(doc);
    const layout = layoutSignature(doc);
    const playerNode = doc.nodes.find((n) => n.player && n.character && sync.entries.get(n.id)?.visible);
    // Characters are not the level: they move in Play.
    const skip = new Set(doc.nodes.filter((n) => n.character).flatMap((n) => [n.id, ...store.descendants(n.id).map((c) => c.id)]));
    const c = playerNode?.character;
    const body: CheckBody = c ? { height: c.height, radius: c.radius, stepHeight: c.stepHeight } : { height: d.specs.playerHeight, radius: d.specs.playerRadius, stepHeight: d.specs.stepHeight };
    let start: Vec3 | null = null;
    const pb = playerNode ? picker.bounds(playerNode.id) : null;
    if (pb) start = [(pb.min[0] + pb.max[0]) / 2, pb.min[1], (pb.min[2] + pb.max[2]) / 2];
    const firstPoint = d.play.route.find((r) => r.position);
    if (!start && firstPoint?.position) start = [...firstPoint.position] as Vec3;
    const targets = d.play.route.filter((r) => r.position).map((r) => ({ name: r.name, point: [...r.position!] as Vec3 }));
    const level = scanLevel(editor, skip);

    let box: Box | null;
    let label: string;
    if (scope.object) {
        box = picker.bounds(scope.object);
        label = store.node(scope.object)?.name ?? scope.object;
    } else if (scope.area) {
        const b = scope.area.bounds;
        box = b ? { min: [b.center[0] - b.size[0] / 2, b.center[1] - 1, b.center[2] - b.size[2] / 2], max: [b.center[0] + b.size[0] / 2, b.center[1] + b.size[1] + 1, b.center[2] + b.size[2] / 2] } : null;
        label = scope.area.name;
        if (!box) throw new Error(`${scope.area.name} has no bounds in the plan.`);
    } else {
        box = builtBounds(level.objects);
        label = 'the level';
    }
    if (!box) throw new Error('There is nothing built to check yet.');
    const margin = 1.5;
    box = { min: [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin], max: [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin] };
    // A player standing near a checked building walks in from there: the region takes it in.
    if (start) {
        const out = Math.max(box.min[0] - start[0], start[0] - box.max[0], box.min[2] - start[2], start[2] - box.max[2]);
        if (out > 0 && out <= REACH_GROW) {
            box = {
                min: [Math.min(box.min[0], start[0] - margin), Math.min(box.min[1], start[1] - margin), Math.min(box.min[2], start[2] - margin)],
                max: [Math.max(box.max[0], start[0] + margin), Math.max(box.max[1], start[1] + body.height + margin), Math.max(box.max[2], start[2] + margin)],
            };
        }
    }
    const inRegion = (pt: Vec3) => pt[0] >= box!.min[0] && pt[0] <= box!.max[0] && pt[2] >= box!.min[2] && pt[2] <= box!.max[2];
    const { report, plan } = await checkLevel(level, {
        box,
        step: scope.step ?? 0.5,
        body,
        start: start && inRegion(start) ? start : null,
        startOutside: !!start && !inRegion(start),
        targets: targets.filter((t) => inRegion(t.point)),
        planned: scope.object || scope.area ? null : d.layout.size,
    });
    const result = { report, map: drawMap(report, plan) };
    if (!scope.object && !scope.area) {
        const summary = summarize(result.report);
        store.patch((dd) => {
            dd.design.levelCheck = { at: new Date().toISOString(), ok: result.report.ok, signature, summary };
            if (result.report.ok && stageIndex(dd.design.stage) > stageIndex('level')) dd.design.stages.level.signature = layout;
        }, { design: true });
    }
    return { ...result, scope: label };
}

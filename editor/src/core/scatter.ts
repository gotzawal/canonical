// Where the copies of a scatter (NodeDoc.scatter) stand. The document keeps
// only the rules: the copies are placed again from them and the seed
// whenever the rules, the object's place or its ground change. Pure: the
// engine (engine/scatter.ts) draws the copies, and Play, the level check
// and the navigation mesh take the solid ones as trunks and boxes.

import type { Quat, Vec3 } from './math';
import type { ScatterDoc } from './types';
import { seededRandom } from './terrainGen';

/** The ground at a point: its height and its normal (unit, pointing up). */
export interface GroundSample {
    y: number;
    normal: Vec3;
}

/** The ground under (x, z), or null where there is none. */
export type GroundQuery = (x: number, z: number) => GroundSample | null;

/** Where a scatter lies: its object's world position and its turned x and z axes (sizes are meters). */
export interface ScatterFrame {
    origin: Vec3;
    x: Vec3;
    z: Vec3;
}

/** A world x-z box copies stay out of (an object to avoid). */
export interface AvoidBox {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}

/** One copy: its source, where its origin goes, its rotation and scale. */
export interface Placement {
    source: number;
    position: Vec3;
    /** Yaw, then the lean with the ground: x, y, z, w. */
    rotation: Quat;
    scale: number;
    /** The yaw alone, radians (solids turn by it). */
    yaw: number;
    /** 0 to 1: which piece of a source that is a set of pieces (rocks side by side) the copy shows. */
    variant: number;
}

/** Tries per copy asked for before giving up on a crowded area. */
const TRIES = 12;

/**
 * The copies of a scatter: darts thrown over its area from its seed (`salt`
 * keeps two objects with the same seed apart), each kept where the ground
 * is, its height and slope are within the rules, it is clear of the boxes
 * to avoid (and their margin) and of the copies before it by the spacing.
 * Every try draws the same six numbers, so a copy that is left out does
 * not move the ones after it.
 */
export function placeScatter(doc: ScatterDoc, frame: ScatterFrame, ground: GroundQuery | null, avoid: readonly AvoidBox[], salt = 0): Placement[] {
    const weights = doc.sources.map((s) => (s.model && s.weight > 0 ? s.weight : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0) || doc.count <= 0) return [];
    const random = seededRandom(Math.imul(doc.seed + 1, 2654435761) ^ salt);
    const [w, d] = doc.size;
    const { origin: o, x: ax, z: az } = frame;
    const spacing = Math.max(0, doc.spacing);
    // A spacing grid: cells a spacing's diagonal wide hold one copy each, so
    // copies closer than the spacing are at most two cells apart.
    const cell = spacing > 0 ? spacing / Math.SQRT2 : 0;
    const grid = new Map<number, number>();
    const keyOf = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
    const out: Placement[] = [];
    const [h0, h1] = doc.height;
    const [s0, s1] = doc.slope;
    const margin = Math.max(0, doc.margin);
    const tries = Math.min(doc.count * TRIES + 50, 400000);
    for (let n = 0; n < tries && out.length < doc.count; n++) {
        const u = (random() - 0.5) * w;
        const v = (random() - 0.5) * d;
        const pick = random() * total;
        const turn = random();
        const grow = random();
        const variant = random();
        const x = o[0] + ax[0] * u + az[0] * v;
        const z = o[2] + ax[2] * u + az[2] * v;
        if (avoid.some((b) => x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin)) continue;
        let ci = 0;
        let cj = 0;
        if (cell > 0) {
            ci = Math.floor(x / cell);
            cj = Math.floor(z / cell);
            if (crowded(grid, out, keyOf, ci, cj, x, z, spacing)) continue;
        }
        const g = ground ? ground(x, z) : { y: o[1] + ax[1] * u + az[1] * v, normal: [0, 1, 0] as Vec3 };
        if (!g || g.y < h0 || g.y > h1) continue;
        const slope = (Math.acos(Math.min(1, Math.max(-1, g.normal[1]))) * 180) / Math.PI;
        if (slope < s0 || slope > s1) continue;
        let source = 0;
        for (let acc = weights[0]; acc <= pick && source < weights.length - 1; acc += weights[++source]);
        while (!weights[source] && source > 0) source--;
        const src = doc.sources[source];
        const yaw = turn * Math.PI * 2;
        out.push({
            source,
            position: [x, g.y - doc.sink, z],
            rotation: leanWith(g.normal, doc.align, yaw),
            scale: src.scale[0] + (src.scale[1] - src.scale[0]) * grow,
            yaw,
            variant,
        });
        if (cell > 0) grid.set(keyOf(ci, cj), out.length - 1);
    }
    return out;
}

/** Whether a copy within `spacing` of (x, z) is already placed. */
function crowded(grid: Map<number, number>, out: Placement[], keyOf: (i: number, j: number) => number, ci: number, cj: number, x: number, z: number, spacing: number): boolean {
    for (let i = ci - 2; i <= ci + 2; i++) {
        for (let j = cj - 2; j <= cj + 2; j++) {
            const k = grid.get(keyOf(i, j));
            if (k === undefined) continue;
            const p = out[k].position;
            if ((p[0] - x) ** 2 + (p[2] - z) ** 2 < spacing * spacing) return true;
        }
    }
    return false;
}

/** A turn by `yaw` around +Y, then a lean `align` of the way from upright to the ground's normal. */
export function leanWith(normal: Vec3, align: number, yaw: number): Quat {
    const qy: Quat = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    const a = Math.min(1, Math.max(0, align));
    const nx = normal[0] * a, ny = 1 - a + normal[1] * a, nz = normal[2] * a;
    const len = Math.hypot(nx, ny, nz) || 1;
    const cos = Math.min(1, Math.max(-1, ny / len));
    // Up turned onto the leaned normal: about (up x n), by the angle between them.
    const axisLen = Math.hypot(nz, nx);
    if (axisLen < 1e-9 || cos > 1 - 1e-9) return qy;
    const half = Math.acos(cos) / 2;
    const s = Math.sin(half) / axisLen;
    const qt: Quat = [nz * s, 0, -nx * s, Math.cos(half)];
    return mulQuat(qt, qy);
}

/** a * b: b first, then a. */
function mulQuat(a: Quat, b: Quat): Quat {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

// ------------------------------------------------------------------ solids

/**
 * A copy characters and bodies run into: a trunk (an upright cylinder from
 * its base) or a box turned by its yaw. World space.
 */
export interface ScatterSolid {
    kind: 'trunk' | 'box';
    /** Trunk: the middle of its base; box: its middle. */
    center: Vec3;
    /** Trunk: [radius, height, radius]; box: half its size along its own axes. */
    size: Vec3;
    /** Turn around +Y, radians. */
    yaw: number;
}

/** A world box around a solid. */
export function solidBounds(s: ScatterSolid): { min: Vec3; max: Vec3 } {
    if (s.kind === 'trunk') {
        const [r, h] = s.size;
        return { min: [s.center[0] - r, s.center[1], s.center[2] - r], max: [s.center[0] + r, s.center[1] + h, s.center[2] + r] };
    }
    const c = Math.abs(Math.cos(s.yaw)), n = Math.abs(Math.sin(s.yaw));
    const ex = s.size[0] * c + s.size[2] * n, ez = s.size[0] * n + s.size[2] * c;
    return { min: [s.center[0] - ex, s.center[1] - s.size[1], s.center[2] - ez], max: [s.center[0] + ex, s.center[1] + s.size[1], s.center[2] + ez] };
}

/**
 * Distance along a ray (`dir` unit length) to a solid, within `maxDist`,
 * and the normal where it enters; null when it misses or starts inside.
 */
export function raySolid(s: ScatterSolid, origin: Vec3, dir: Vec3, maxDist: number): { t: number; normal: Vec3 } | null {
    if (s.kind === 'trunk') return rayTrunk(s, origin, dir, maxDist);
    // Into the box's own frame (turned back by its yaw).
    const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
    const px = origin[0] - s.center[0], py = origin[1] - s.center[1], pz = origin[2] - s.center[2];
    const o: Vec3 = [c * px - n * pz, py, n * px + c * pz];
    const d: Vec3 = [c * dir[0] - n * dir[2], dir[1], n * dir[0] + c * dir[2]];
    let near = -Infinity, far = Infinity, axis = -1, sign = 0;
    for (let k = 0; k < 3; k++) {
        const h = s.size[k];
        if (Math.abs(d[k]) < 1e-12) {
            if (o[k] < -h || o[k] > h) return null;
            continue;
        }
        let t0 = (-h - o[k]) / d[k], t1 = (h - o[k]) / d[k];
        let face = -1;
        if (t0 > t1) {
            [t0, t1] = [t1, t0];
            face = 1;
        }
        if (t0 > near) {
            near = t0;
            axis = k;
            sign = face;
        }
        far = Math.min(far, t1);
        if (near > far) return null;
    }
    if (axis < 0 || near < 0 || near > maxDist) return null;
    const local: Vec3 = [0, 0, 0];
    local[axis] = sign;
    // Back to the world: turned by the yaw.
    return { t: near, normal: [c * local[0] + n * local[2], local[1], -n * local[0] + c * local[2]] };
}

function rayTrunk(s: ScatterSolid, o: Vec3, d: Vec3, maxDist: number): { t: number; normal: Vec3 } | null {
    const [r, h] = s.size;
    const [cx, y0, cz] = s.center;
    const y1 = y0 + h;
    let best: { t: number; normal: Vec3 } | null = null;
    // The side: |(o + t d) - c| = r in x-z.
    const ox = o[0] - cx, oz = o[2] - cz;
    const a = d[0] * d[0] + d[2] * d[2];
    if (a > 1e-12) {
        const b = ox * d[0] + oz * d[2];
        const q = ox * ox + oz * oz - r * r;
        const disc = b * b - a * q;
        if (disc >= 0) {
            const t = (-b - Math.sqrt(disc)) / a;
            const y = o[1] + d[1] * t;
            if (t >= 0 && t <= maxDist && y >= y0 && y <= y1) best = { t, normal: [(ox + d[0] * t) / r, 0, (oz + d[2] * t) / r] };
        }
    }
    // The caps.
    if (Math.abs(d[1]) > 1e-12) {
        for (const [y, ny] of [[y1, 1], [y0, -1]] as const) {
            const t = (y - o[1]) / d[1];
            if (t < 0 || t > maxDist || (best && t >= best.t) || Math.sign(d[1]) === ny) continue;
            const x = ox + d[0] * t, z = oz + d[2] * t;
            if (x * x + z * z <= r * r) best = { t, normal: [0, ny, 0] };
        }
    }
    return best;
}

/** Sides a trunk has in the navigation mesh and colliders made of triangles. */
const TRUNK_SIDES = 8;

/** The triangles of solids (world space), for the navigation mesh: boxes, and trunks as prisms. */
export function solidTriangles(solids: readonly ScatterSolid[]): { positions: Float32Array; indices: Uint32Array } {
    const pos: number[] = [];
    const idx: number[] = [];
    for (const s of solids) {
        const base = pos.length / 3;
        if (s.kind === 'box') {
            const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
            for (let i = 0; i < 8; i++) {
                const lx = i & 1 ? s.size[0] : -s.size[0], ly = i & 2 ? s.size[1] : -s.size[1], lz = i & 4 ? s.size[2] : -s.size[2];
                pos.push(s.center[0] + c * lx + n * lz, s.center[1] + ly, s.center[2] - n * lx + c * lz);
            }
            // Each face as two triangles, corners by their bits (x 1, y 2, z 4).
            for (const [a, b, e, f] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) idx.push(base + a, base + b, base + e, base + a, base + e, base + f);
            continue;
        }
        const [r, h] = s.size;
        for (let i = 0; i < TRUNK_SIDES; i++) {
            const a = (i / TRUNK_SIDES) * Math.PI * 2;
            const x = s.center[0] + Math.cos(a) * r, z = s.center[2] + Math.sin(a) * r;
            pos.push(x, s.center[1], z, x, s.center[1] + h, z);
        }
        for (let i = 0; i < TRUNK_SIDES; i++) {
            const j = (i + 1) % TRUNK_SIDES;
            const b0 = base + i * 2, t0 = b0 + 1, b1 = base + j * 2, t1 = b1 + 1;
            idx.push(b0, t0, t1, b0, t1, b1);
            // Its top as a fan (the base is on the ground).
            if (i > 0 && i < TRUNK_SIDES - 1) idx.push(base + 1, base + j * 2 + 1, base + i * 2 + 1);
        }
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

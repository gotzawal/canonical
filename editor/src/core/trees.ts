// Trees grown from a few rules (NodeDoc.tree, ScatterSource.tree): a trunk,
// the limbs along it and the branches along those, and cards of leaves (or
// needles) where the twigs are, all from a species and a seed. A tree comes
// in three levels of detail grown from one skeleton: everything near; the
// thin branches gone and fewer, larger cards farther; the trunk, its limbs
// and a few large cards far away (simplifying the triangles would tear the
// crown apart). Each vertex carries how far the wind moves it, its phase
// and how much the crown shades it. Pure: engine/trees.ts draws them, and
// the unit tests run it in Node.

import { add, cross, dot, len, normalize, scale, sub, type Vec3 } from './math';
import { seededRandom } from './terrainGen';

export const TREE_SPECIES = ['oak', 'birch', 'spruce'] as const;
export type TreeSpecies = (typeof TREE_SPECIES)[number];
/** Each species' name in the editor. */
export const SPECIES_NAME: Record<TreeSpecies, string> = { oak: 'Oak', birch: 'Birch', spruce: 'Spruce' };

/** What a tree is grown from: its species and how it differs from the species' own. */
export interface TreeShape {
    species: TreeSpecies;
    /** Meters from the ground to the top. */
    height: number;
    /** Crown width, times the species' own. */
    width: number;
    /** Trunk and limb thickness, times the species' own. */
    trunk: number;
    /** How many branches, times the species' own. */
    branches: number;
    /** How many leaf cards, times the species' own. */
    leaves: number;
    /** Leaf card size, times the species' own. */
    leafSize: number;
    /** How crooked the trunk and branches grow, 0 straight to 1 gnarled. */
    gnarl: number;
}

/**
 * One part of a level of detail. `data` is TEXCOORD_1: x the meters the
 * wind moves the vertex (times its strength), y the crown's shade (its
 * integer part, 0 to 255) plus the phase of its branch (the fraction).
 */
export interface TreeMesh {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    data: Float32Array;
    indices: Uint32Array;
}

export interface TreeLod {
    bark: TreeMesh;
    leaves: TreeMesh;
}

export interface GrownTree {
    /** Levels of detail 0 (near) to 2 (far). */
    lods: TreeLod[];
    /** The box around it at scale 1, its origin at the bottom of its trunk. */
    min: Vec3;
    max: Vec3;
    height: number;
    /** What characters run into: the trunk's radius and how high it rises bare. */
    trunk: { radius: number; height: number };
    /** The crown as an ellipsoid: its middle and radii. */
    crown: { center: Vec3; radius: Vec3 };
}

/** Columns of the leaf texture (engine/treeTextures.ts): sprigs of leaves side by side, the last a dense one for far cards. */
export const LEAF_CELLS = 4;
/** Meters of bark one repeat of its texture covers along a branch. */
export const BARK_TILE = 1.6;
/** Meters the trunk reaches under the ground, so it does not float on slopes. */
export const TRUNK_SINK = 0.35;

type Crown = 'spherical' | 'hemispherical' | 'conical' | 'flame' | 'oval';
type Arrange = 'spiral' | 'whorl' | 'plane';

interface LevelDef {
    /** Children per meter of the parent; with 0, `count` children in all (a trunk's limbs). */
    perMeter: number;
    count: number;
    /** Where along the parent they grow, 0 its base and 1 its tip. */
    start: number;
    end: number;
    /** Degrees from the parent's direction, for children at its base and at its tip, and a random spread. */
    angle: [number, number];
    angleJitter: number;
    /** Length: a share of the tree's height (limbs, times the crown's shape) or of the parent's length. */
    length: number;
    lengthJitter: number;
    /** Base radius, a share of the parent's where it grows. */
    radius: number;
    /** Degrees the branch bends toward the sky over its length (negative droops), at its base and at its tip. */
    rise: [number, number];
    /** Random wandering, degrees over its length. */
    gnarl: number;
    steps: number;
    /** Sides of its tube at each level of detail; 0 leaves it out. */
    sides: [number, number, number];
    arrange: Arrange;
    /** Whorls: children per ring and meters between rings. */
    whorl?: { count: number; spacing: number };
    /** Meters its tip moves in the wind (times its strength), per meter of its length. */
    flex: number;
}

interface LeafDef {
    /** The branch levels (1 limbs, 2 branches, 3 twigs) that carry cards. */
    on: number[];
    /** Where along those branches cards begin. */
    from: number;
    /** Cards per meter along them, and at each tip. */
    perMeter: number;
    tip: number;
    /** Card width and length, meters. */
    size: [number, number];
    /** How cards point: 0 out of the crown (sprigs), 1 along their branch (fronds). */
    along: number;
    /** How much sprigs face out of the crown, and the sky (fronds: how flat they lie), rather than any way. */
    outward: number;
    facing: number;
    /** Meters the card's far end sags. */
    droop: number;
    /** How much its normal leans toward the crown's outside instead of its own face (soft, round crowns). */
    round: number;
    /** Share of the cards kept at levels of detail 1 and 2 (outer ones first). */
    keep: [number, number];
    /** Meters the wind flutters the far end of a card (times its strength). */
    flutter: number;
}

interface SpeciesDef {
    trunk: {
        /** Share of the height the trunk itself reaches. */
        length: number;
        /** Base radius, a share of the height. */
        radius: number;
        /** How much it narrows toward its top (1 to a point). */
        taper: number;
        /** How much wider its foot is, and in how many lobes (roots). */
        flare: number;
        lobes: number;
        /** Degrees it may lean, and wander over its length. */
        lean: number;
        gnarl: number;
        steps: number;
        sides: [number, number, number];
    };
    crown: Crown;
    levels: LevelDef[];
    leaves: LeafDef;
}

const SPECIES: Record<TreeSpecies, SpeciesDef> = {
    // A broad, rounded crown on a stout trunk that forks into heavy, crooked limbs.
    oak: {
        trunk: { length: 0.62, radius: 0.03, taper: 0.62, flare: 0.55, lobes: 5, lean: 4, gnarl: 14, steps: 14, sides: [14, 8, 6] },
        crown: 'spherical',
        levels: [
            { perMeter: 0, count: 9, start: 0.32, end: 1, angle: [62, 30], angleJitter: 12, length: 0.5, lengthJitter: 0.18, radius: 0.62, rise: [10, 22], gnarl: 40, steps: 9, sides: [8, 5, 3], arrange: 'spiral', flex: 0.012 },
            { perMeter: 1.7, count: 0, start: 0.18, end: 0.98, angle: [52, 40], angleJitter: 15, length: 0.48, lengthJitter: 0.2, radius: 0.55, rise: [8, 18], gnarl: 50, steps: 5, sides: [5, 0, 0], arrange: 'spiral', flex: 0.03 },
            { perMeter: 3, count: 0, start: 0.25, end: 1, angle: [48, 36], angleJitter: 18, length: 0.42, lengthJitter: 0.25, radius: 0.5, rise: [12, 18], gnarl: 50, steps: 3, sides: [0, 0, 0], arrange: 'spiral', flex: 0.05 },
        ],
        leaves: { on: [2, 3], from: 0.4, perMeter: 2.6, tip: 2, size: [1.0, 1.05], along: 0, outward: 1, facing: 0.45, droop: 0.05, round: 0.7, keep: [0.3, 0.13], flutter: 0.045 },
    },
    // A slender white trunk to the top, with an airy, narrow crown of hanging twigs.
    birch: {
        trunk: { length: 0.97, radius: 0.0125, taper: 0.9, flare: 0.25, lobes: 3, lean: 5, gnarl: 6, steps: 16, sides: [12, 7, 5] },
        crown: 'oval',
        levels: [
            { perMeter: 0, count: 15, start: 0.3, end: 0.97, angle: [55, 30], angleJitter: 10, length: 0.26, lengthJitter: 0.25, radius: 0.5, rise: [14, -12], gnarl: 18, steps: 8, sides: [6, 4, 0], arrange: 'spiral', flex: 0.02 },
            { perMeter: 2.4, count: 0, start: 0.2, end: 1, angle: [42, 34], angleJitter: 14, length: 0.5, lengthJitter: 0.25, radius: 0.5, rise: [-10, -45], gnarl: 26, steps: 5, sides: [4, 0, 0], arrange: 'spiral', flex: 0.05 },
            { perMeter: 3, count: 0, start: 0.25, end: 1, angle: [30, 20], angleJitter: 14, length: 0.5, lengthJitter: 0.3, radius: 0.5, rise: [-35, -60], gnarl: 20, steps: 3, sides: [0, 0, 0], arrange: 'spiral', flex: 0.08 },
        ],
        leaves: { on: [3], from: 0.25, perMeter: 3.4, tip: 2, size: [0.7, 0.85], along: 0.25, outward: 0.8, facing: 0.25, droop: 0.12, round: 0.62, keep: [0.32, 0.14], flutter: 0.06 },
    },
    // A straight trunk to a pointed top, with rings of limbs that droop and turn up at their tips, dense with needles.
    spruce: {
        trunk: { length: 1, radius: 0.016, taper: 0.97, flare: 0.35, lobes: 4, lean: 2, gnarl: 3, steps: 20, sides: [10, 6, 5] },
        crown: 'conical',
        levels: [
            { perMeter: 0, count: 0, start: 0.12, end: 0.97, angle: [86, 56], angleJitter: 8, length: 0.27, lengthJitter: 0.12, radius: 0.4, rise: [-18, 26], gnarl: 10, steps: 6, sides: [4, 3, 0], arrange: 'whorl', whorl: { count: 4.5, spacing: 0.62 }, flex: 0.025 },
            { perMeter: 1.7, count: 0, start: 0.15, end: 0.92, angle: [55, 45], angleJitter: 10, length: 0.34, lengthJitter: 0.2, radius: 0.45, rise: [-12, -6], gnarl: 14, steps: 3, sides: [0, 0, 0], arrange: 'plane', flex: 0.05 },
        ],
        leaves: { on: [1, 2], from: 0.05, perMeter: 2.2, tip: 1, size: [0.85, 1], along: 1, outward: 0, facing: 0.62, droop: 0.2, round: 0.5, keep: [0.26, 0.12], flutter: 0.02 },
    },
};

/** Variants a scatter's tree grows in: its copies pick one each. */
export const TREE_VARIANTS = 4;

/** The seed variant k of a tree grows from (variant 0 is the tree itself). */
export const variantSeed = (seed: number, k: number): number => (seed + k * 7919) % 1_000_000;

/** The variant of `count` a scatter copy grows as, from its placement's variant (0 to 1). */
export const variantIndex = (v: number, count: number): number => Math.max(0, Math.min(count - 1, Math.floor(v * count)));

/** Each species' usual height in meters: a tree's default, and the size its leaf cards are drawn for. */
export const SPECIES_HEIGHT: Record<TreeSpecies, number> = { oak: 14, birch: 15, spruce: 18 };

/** A limb, branch or twig: points along its middle with a radius each, and its frame (for its tube). */
interface Branch {
    level: number;
    points: Vec3[];
    radii: number[];
    /** Meters along it at each point. */
    along: number[];
    tangents: Vec3[];
    normals: Vec3[];
    binormals: Vec3[];
    length: number;
    /** Meters the wind moves each point (times its strength). */
    flex: number[];
    phase: number;
    /** The trunk's foot: lobes of its flare. */
    lobes?: { count: number; amount: number; turn: number };
}

/** A card of leaves: where it grows from, which way it points and faces, how large it is. */
interface Card {
    base: Vec3;
    up: Vec3;
    normal: Vec3;
    width: number;
    length: number;
    cell: number;
    flex: number;
    phase: number;
    /** 0 to 1, to pick the cards kept at farther levels. */
    pick: number;
    /** How far out of the crown it is, 0 its middle to 1 its edge (set once the crown is known). */
    out: number;
}

const DEG = Math.PI / 180;
const UP: Vec3 = [0, 1, 0];

function hashSpecies(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

function smoothstep(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/** A unit vector at right angles to `v`. */
function perpendicular(v: Vec3): Vec3 {
    const a: Vec3 = Math.abs(v[1]) < 0.9 ? UP : [1, 0, 0];
    return normalize(cross(v, a));
}

/** `v` turned by `angle` radians about the unit axis `k` (Rodrigues). */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle), s = Math.sin(angle);
    const kv = cross(k, v);
    const d = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}

/** A random unit vector. */
function randomUnit(random: () => number): Vec3 {
    const z = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
}

/** How long limbs grow where they leave the trunk: `ratio` is 1 at the crown's bottom and 0 at its top. */
function crownShape(crown: Crown, ratio: number): number {
    switch (crown) {
        case 'conical': return 0.12 + 0.88 * ratio;
        case 'spherical': return 0.3 + 0.7 * Math.sin(Math.PI * ratio);
        case 'hemispherical': return 0.25 + 0.75 * Math.sin(0.5 * Math.PI * ratio);
        case 'flame': return ratio <= 0.7 ? 0.15 + 0.85 * (ratio / 0.7) : 0.15 + 0.85 * ((1 - ratio) / 0.3);
        case 'oval': return 0.35 + 0.65 * Math.sin(Math.PI * Math.pow(ratio, 0.8));
    }
}

/**
 * A branch's middle line: from `start` along `dir` for `length` meters in
 * `steps`, bending toward the sky by `rise` degrees over its length (from
 * the first value at its base to the second at its tip; negative droops)
 * and wandering at random by up to `gnarl` degrees.
 */
function growLine(start: Vec3, dir: Vec3, length: number, steps: number, rise: [number, number], gnarl: number, random: () => number): Vec3[] {
    const points: Vec3[] = [start];
    let d = normalize(dir);
    let p = start;
    const step = length / steps;
    for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) / steps;
        const bend = ((rise[0] + (rise[1] - rise[0]) * t) * DEG) / steps;
        // Toward the sky (or the ground) about the level axis across the branch.
        const side = cross(d, UP);
        if (len(side) > 1e-4) d = rotate(d, normalize(side), bend);
        else if (bend < 0) d = normalize(add(d, scale(perpendicular(d), -bend)));
        if (gnarl > 0) {
            const k = perpendicular(d);
            d = normalize(rotate(d, rotate(k, d, random() * Math.PI * 2), ((random() - 0.5) * 2 * gnarl * DEG) / Math.sqrt(steps)));
        }
        p = add(p, scale(d, step));
        points.push(p);
    }
    return points;
}

/** A branch from its middle line and radii: lengths along it and a frame at each point that does not twist. */
function makeBranch(level: number, points: Vec3[], radii: number[], phase: number): Branch {
    const n = points.length;
    const along = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + len(sub(points[i], points[i - 1])));
    const tangents: Vec3[] = points.map((_, i) => normalize(sub(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)])));
    const normals: Vec3[] = [];
    const binormals: Vec3[] = [];
    let nrm = perpendicular(tangents[0]);
    for (let i = 0; i < n; i++) {
        // Carried along: the last normal with the new direction taken out of it.
        const t = tangents[i];
        const p = sub(nrm, scale(t, dot(nrm, t)));
        nrm = len(p) > 1e-6 ? normalize(p) : perpendicular(t);
        normals.push(nrm);
        binormals.push(normalize(cross(t, nrm)));
    }
    return { level, points, radii, along, tangents, normals, binormals, length: along[n - 1], flex: new Array(n).fill(0), phase };
}

/** The point, frame, radius and flex of a branch at `t` (0 base, 1 tip) of its length. */
function sample(b: Branch, t: number): { p: Vec3; t: Vec3; n: Vec3; b: Vec3; r: number; flex: number } {
    const s = Math.min(1, Math.max(0, t)) * b.length;
    let i = 0;
    while (i < b.along.length - 2 && b.along[i + 1] < s) i++;
    const seg = b.along[i + 1] - b.along[i];
    const f = seg > 1e-9 ? (s - b.along[i]) / seg : 0;
    const mix = (a: Vec3, c: Vec3): Vec3 => [a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f, a[2] + (c[2] - a[2]) * f];
    return {
        p: mix(b.points[i], b.points[i + 1]),
        t: normalize(mix(b.tangents[i], b.tangents[i + 1])),
        n: normalize(mix(b.normals[i], b.normals[i + 1])),
        b: normalize(mix(b.binormals[i], b.binormals[i + 1])),
        r: b.radii[i] + (b.radii[i + 1] - b.radii[i]) * f,
        flex: b.flex[i] + (b.flex[i + 1] - b.flex[i]) * f,
    };
}

/** Radii along a branch: from `base` narrowing by `taper` toward its tip (never under a few millimeters). */
function taperRadii(points: Vec3[], base: number, taper: number): number[] {
    const n = points.length;
    return points.map((_, i) => Math.max(0.003, base * (1 - taper * Math.pow(i / (n - 1), 0.9))));
}

/** Where the children of a branch grow along it (0 to 1) and how far around it they turn (radians). */
function childPlaces(def: LevelDef, parent: Branch, density: number, random: () => number): { t: number; turn: number }[] {
    const out: { t: number; turn: number }[] = [];
    const span = Math.max(0, def.end - def.start);
    if (def.arrange === 'whorl' && def.whorl) {
        const meters = parent.length * span;
        const rings = Math.max(1, Math.round((meters / def.whorl.spacing) * Math.min(1.5, density)));
        const base = random() * Math.PI * 2;
        for (let r = 0; r < rings; r++) {
            const t = def.start + span * ((r + 0.2 + random() * 0.6) / rings);
            const count = Math.max(2, Math.round(def.whorl.count * (0.8 + random() * 0.4)));
            const turn0 = base + r * 0.7 + random();
            for (let k = 0; k < count; k++) out.push({ t, turn: turn0 + (k / count) * Math.PI * 2 + (random() - 0.5) * 0.5 });
        }
        return out;
    }
    const n = def.perMeter > 0 ? Math.round(def.perMeter * parent.length * span * density + random() * 0.5) : Math.max(1, Math.round(def.count * density));
    let turn = random() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
        const t = def.start + span * ((k + 0.25 + random() * 0.5) / Math.max(1, n));
        if (def.arrange === 'plane') turn = (k % 2 ? 0.5 : -0.5) * Math.PI + (random() - 0.5) * 0.6;
        else turn += 137.5 * DEG + (random() - 0.5) * 0.7;
        out.push({ t, turn });
    }
    return out;
}

/**
 * The skeleton and leaf cards of a tree: grown at its species' own scale,
 * then scaled so its top is at `shape.height`.
 */
function growSkeleton(shape: TreeShape, seed: number): { branches: Branch[]; cards: Card[]; def: SpeciesDef; trunkHeight: number } {
    const def = SPECIES[shape.species];
    const random = seededRandom(Math.imul(seed + 1, 2654435761) ^ hashSpecies(shape.species));
    const H = Math.max(1, shape.height);
    const gnarl = 0.4 + 1.2 * Math.min(1, Math.max(0, shape.gnarl));
    const thick = Math.max(0.2, shape.trunk);
    const branches: Branch[] = [];

    // The trunk: up from under the ground, leaning a little and wandering.
    const tr = def.trunk;
    const leanTurn = random() * Math.PI * 2;
    const trunkDir = rotate(UP, [Math.cos(leanTurn), 0, Math.sin(leanTurn)], random() * tr.lean * DEG);
    const trunkLength = H * tr.length + TRUNK_SINK;
    const trunkPoints = growLine([0, -TRUNK_SINK, 0], trunkDir, trunkLength, tr.steps, [0, 0], tr.gnarl * gnarl, random);
    const trunkRadius = H * tr.radius * thick;
    const trunk = makeBranch(0, trunkPoints, taperRadii(trunkPoints, trunkRadius, tr.taper), random());
    trunk.lobes = { count: tr.lobes, amount: tr.flare, turn: random() * Math.PI * 2 };
    branches.push(trunk);

    // Limbs, branches and twigs, each level along the one before.
    let parents: Branch[] = [trunk];
    for (let level = 1; level <= def.levels.length; level++) {
        const lv = def.levels[level - 1];
        const next: Branch[] = [];
        for (const parent of parents) {
            const places = childPlaces(lv, parent, Math.max(0.1, shape.branches), random);
            for (const place of places) {
                const at = sample(parent, place.t);
                const out = add(scale(at.n, Math.cos(place.turn)), scale(at.b, Math.sin(place.turn)));
                const angle = (lv.angle[0] + (lv.angle[1] - lv.angle[0]) * place.t + (random() - 0.5) * 2 * lv.angleJitter) * DEG;
                let dir = normalize(add(scale(at.t, Math.cos(angle)), scale(out, Math.sin(angle))));
                // Limbs spread out from the trunk as wide as the crown allows; nothing grows into the ground.
                if (level === 1) dir = normalize([dir[0] * shape.width, dir[1], dir[2] * shape.width]);
                if (dir[1] < -0.5) dir = normalize([dir[0], -0.5, dir[2]]);
                let length: number;
                if (level === 1) {
                    const ratio = (1 - place.t) / Math.max(0.01, 1 - lv.start);
                    length = H * lv.length * crownShape(def.crown, Math.min(1, Math.max(0, ratio))) * Math.max(0.3, shape.width);
                } else {
                    length = parent.length * lv.length * (1 - 0.45 * place.t);
                }
                length *= 1 + (random() - 0.5) * 2 * lv.lengthJitter;
                if (length < 0.08) continue;
                const steps = Math.max(2, Math.round(lv.steps * Math.min(1.4, 0.6 + length / (H * 0.25))));
                const points = growLine(at.p, dir, length, steps, lv.rise, lv.gnarl * gnarl, random);
                const radius = Math.max(0.004, Math.min(at.r * 0.92, at.r * lv.radius * (level === 1 ? Math.sqrt(length / (H * lv.length)) + 0.25 : 1)));
                const b = makeBranch(level, points, taperRadii(points, radius, 0.92), level === 1 ? random() : (parent.phase + random() * 0.25) % 1);
                // The wind moves a branch as much as where it grows from, and its own tip further.
                for (let i = 0; i < b.points.length; i++) {
                    const s = b.along[i] / Math.max(1e-6, b.length);
                    b.flex[i] = at.flex + lv.flex * b.length * s * s;
                }
                next.push(b);
            }
        }
        branches.push(...next);
        parents = next;
    }

    // Cards along the branches that carry them, and at their tips.
    const lf = def.leaves;
    const cards: Card[] = [];
    const leafScale = Math.max(0.2, shape.leafSize) * Math.sqrt(H / SPECIES_HEIGHT[shape.species]);
    // The crown's middle (about): sprigs face out of it.
    let mid = 0, tips = 0;
    for (const b of branches) {
        if (!lf.on.includes(b.level)) continue;
        mid += b.points[b.points.length - 1][1];
        tips++;
    }
    const middle: Vec3 = [0, tips ? mid / tips : H * 0.6, 0];
    // Cards grow with the root of the height and the branches they line with
    // the height: fewer per meter on a taller tree (more on a smaller one)
    // keep its crown as full, and its triangles near the species' own.
    const density = Math.min(2, SPECIES_HEIGHT[shape.species] / H);
    for (const b of branches) {
        if (!lf.on.includes(b.level)) continue;
        const span = Math.max(0, 1 - lf.from);
        const n = Math.round(lf.perMeter * density * b.length * span * Math.max(0.05, shape.leaves) + random() * 0.6);
        const ts: number[] = [];
        for (let k = 0; k < n; k++) ts.push(lf.from + span * ((k + random()) / Math.max(1, n)));
        for (let k = 0; k < lf.tip; k++) if (density >= 1 || random() < density) ts.push(1);
        for (const t of ts) {
            const at = sample(b, t);
            let up: Vec3, normal: Vec3;
            if (lf.along >= 0.5) {
                // Fronds lie along their branch, flat as the species likes, each rolled a little.
                up = normalize(add(at.t, scale(randomUnit(random), 0.15)));
                normal = sub(UP, scale(up, dot(UP, up)));
                normal = len(normal) > 1e-4 ? normalize(normal) : perpendicular(up);
                normal = normalize(add(scale(normal, lf.facing), scale(rotate(normal, up, Math.PI / 2), (random() - 0.5) * 2 * (1 - lf.facing))));
            } else {
                // Sprigs face out of the crown (and the sky): from outside, most face the viewer.
                const out = sub(at.p, middle);
                const outward = len(out) > 1e-4 ? normalize([out[0], out[1] * 0.6, out[2]]) : UP;
                normal = normalize(add(add(scale(outward, lf.outward), scale(UP, lf.facing)), scale(randomUnit(random), 0.6)));
                // Their length runs along their twig, as far as it lies in their face.
                const along = normalize(add(scale(at.t, 1 - lf.along), scale(UP, lf.along)));
                up = sub(along, scale(normal, dot(along, normal)));
                up = len(up) > 1e-3 ? normalize(up) : perpendicular(normal);
            }
            const size = (0.8 + random() * 0.4) * leafScale;
            cards.push({
                base: at.p,
                up,
                normal,
                width: lf.size[0] * size,
                length: lf.size[1] * size,
                cell: Math.floor(random() * (LEAF_CELLS - 1)),
                flex: at.flex,
                phase: (b.phase + random() * 0.15) % 1,
                pick: random(),
                out: 1,
            });
        }
    }

    // Scaled so the top is where it should be: the crown's height varies with its random limbs.
    let top = 0;
    for (const b of branches) for (const p of b.points) top = Math.max(top, p[1]);
    for (const c of cards) top = Math.max(top, c.base[1] + c.up[1] * c.length);
    const k = H / Math.max(0.5, top);
    for (const b of branches) {
        b.points = b.points.map((p) => scale(p, k));
        b.radii = b.radii.map((r) => r * k);
        b.along = b.along.map((a) => a * k);
        b.length *= k;
        b.flex = b.flex.map((f) => f * k);
    }
    for (const c of cards) {
        c.base = scale(c.base, k);
        c.width *= k;
        c.length *= k;
        c.flex *= k;
    }
    // The trunk rises bare up to its lowest limb.
    let lowest = H;
    for (const b of branches) if (b.level === 1) lowest = Math.min(lowest, b.points[0][1]);
    return { branches, cards, def, trunkHeight: Math.max(1, lowest) };
}

/** Collects the vertices and triangles of one part. */
class MeshBuilder {
    private p: number[] = [];
    private n: number[] = [];
    private uv: number[] = [];
    private d: number[] = [];
    private idx: number[] = [];

    get count(): number {
        return this.p.length / 3;
    }

    vertex(p: Vec3, n: Vec3, u: number, v: number, flex: number, shade: number, phase: number): number {
        this.p.push(p[0], p[1], p[2]);
        this.n.push(n[0], n[1], n[2]);
        this.uv.push(u, v);
        // The shade's integer part and the phase's fraction share one float.
        this.d.push(flex, Math.round(Math.min(1, Math.max(0, shade)) * 255) + Math.min(0.999, Math.max(0, phase)));
        return this.count - 1;
    }

    tri(a: number, b: number, c: number) {
        this.idx.push(a, b, c);
    }

    build(): TreeMesh {
        return {
            positions: new Float32Array(this.p),
            normals: new Float32Array(this.n),
            uvs: new Float32Array(this.uv),
            data: new Float32Array(this.d),
            indices: new Uint32Array(this.idx),
        };
    }
}

/** The crown's shade at a point: dark deep inside it and under it, open at its outside. */
function crownShade(p: Vec3, crown: { center: Vec3; radius: Vec3 }, depth: number): { out: number; shade: number } {
    const q: Vec3 = [(p[0] - crown.center[0]) / crown.radius[0], (p[1] - crown.center[1]) / crown.radius[1], (p[2] - crown.center[2]) / crown.radius[2]];
    const out = Math.min(1.5, len(q));
    const inside = 1 - smoothstep(0.15, 1.0, out);
    const below = 1 - smoothstep(-0.9, 0.7, q[1]);
    return { out, shade: 1 - depth * (0.72 * inside + 0.25 * below * (1 - smoothstep(1.0, 1.4, out))) };
}

/** A branch's tube at a level of detail: rings of `sides` around every `every`th point. */
function addTube(m: MeshBuilder, b: Branch, sides: number, every: number, crown: { center: Vec3; radius: Vec3 }) {
    const n = b.points.length;
    const rows: number[] = [];
    for (let i = 0; i < n; i += every) rows.push(i);
    if (rows[rows.length - 1] !== n - 1) rows.push(n - 1);
    // Bark repeats around a branch about once per tile of its girth, at least once.
    const around = Math.max(1, Math.round((2 * Math.PI * b.radii[0]) / (BARK_TILE * 0.55)));
    const first = m.count;
    for (const i of rows) {
        const p = b.points[i], N = b.normals[i], B = b.binormals[i];
        const s = b.along[i];
        for (let j = 0; j <= sides; j++) {
            const a = (j / sides) * Math.PI * 2;
            const dir = add(scale(N, Math.cos(a)), scale(B, Math.sin(a)));
            let r = b.radii[i];
            if (b.lobes) {
                // The trunk's foot spreads into roots near the ground.
                const foot = Math.exp(-Math.max(0, p[1] + TRUNK_SINK) / Math.max(0.2, b.radii[0] * 2.2));
                r *= 1 + b.lobes.amount * foot * (0.55 + 0.45 * Math.sin(b.lobes.count * a + b.lobes.turn));
            }
            const v = add(p, scale(dir, r));
            // Low on the trunk the ground shades the bark a little, and the crown inside it.
            const ground = 0.8 + 0.2 * smoothstep(0, 1.6, v[1]);
            const { shade } = crownShade(v, crown, 0.28);
            m.vertex(v, dir, (j / sides) * around, s / BARK_TILE, b.flex[i], ground * shade, b.phase);
        }
    }
    for (let r = 0; r + 1 < rows.length; r++) {
        for (let j = 0; j < sides; j++) {
            const a = first + r * (sides + 1) + j, c = a + sides + 1;
            m.tri(a, c, a + 1);
            m.tri(a + 1, c, c + 1);
        }
    }
}

/**
 * A card at a level of detail: folded along its middle near (four
 * triangles), flat farther (two). `grow` scales it (fewer cards cover as
 * much), `cell` picks its column of the leaf texture.
 */
/** Meters a card's lowest corner keeps above the ground. */
const GROUND_CLEAR = 0.05;

/** The height of a card's lowest corner, grown `grow` times about its middle (as addCard makes it). */
function cardBottom(c: Card, droop: number, grow: number): number {
    const w = c.width * grow, l = c.length * grow;
    const right = normalize(cross(c.up, c.normal));
    const base = grow > 1 ? c.base[1] + c.up[1] * ((c.length - l) / 2) : c.base[1];
    const tip = base + c.up[1] * l - droop * l;
    // Its side corners, and the fold's middle standing out of it.
    return Math.min(base, tip) - Math.abs(right[1]) * (w / 2) - Math.abs(c.normal[1]) * w * 0.12;
}

function addCard(m: MeshBuilder, c: Card, crown: { center: Vec3; radius: Vec3 }, round: number, droop: number, folded: boolean, grow: number, cell: number) {
    const w = c.width * grow, l = c.length * grow;
    const right = normalize(cross(c.up, c.normal));
    // A grown card keeps its middle where the near one has it: the crown keeps its outline.
    const base = grow > 1 ? add(c.base, scale(c.up, (c.length - l) / 2)) : c.base;
    const tip = add(base, add(scale(c.up, l), scale(UP, -droop * l)));
    // Its normal leans toward the crown's outside: the crown shades as one round mass.
    const toOut = (p: Vec3): Vec3 => {
        const q: Vec3 = [(p[0] - crown.center[0]) / (crown.radius[0] * crown.radius[0]), (p[1] - crown.center[1]) / (crown.radius[1] * crown.radius[1]), (p[2] - crown.center[2]) / (crown.radius[2] * crown.radius[2])];
        return len(q) > 1e-6 ? normalize(q) : UP;
    };
    const mid = scale(add(base, tip), 0.5);
    const outN = toOut(mid);
    const face = dot(c.normal, outN) < 0 ? scale(c.normal, -1) : c.normal;
    const normal = normalize(add(scale(face, 1 - round), scale(outN, round)));
    const { shade } = crownShade(mid, crown, 0.6);
    const u0 = cell / LEAF_CELLS, u1 = (cell + 1) / LEAF_CELLS, um = (u0 + u1) / 2;
    const half = scale(right, w / 2);
    const vert = (p: Vec3, u: number, v: number) => m.vertex(p, normal, u, v, c.flex, shade, c.phase);
    if (folded) {
        // The middle stands a little out of the card: the halves fall away from it.
        const lift = scale(c.normal, w * 0.12);
        const bl = vert(sub(base, half), u0, 1), bm = vert(add(base, lift), um, 1), br = vert(add(base, half), u1, 1);
        const tl = vert(sub(tip, half), u0, 0), tm = vert(add(tip, lift), um, 0), tr = vert(add(tip, half), u1, 0);
        m.tri(bl, bm, tm);
        m.tri(bl, tm, tl);
        m.tri(bm, br, tr);
        m.tri(bm, tr, tm);
    } else {
        const bl = vert(sub(base, half), u0, 1), br = vert(add(base, half), u1, 1);
        const tl = vert(sub(tip, half), u0, 0), tr = vert(add(tip, half), u1, 0);
        m.tri(bl, br, tr);
        m.tri(bl, tr, tl);
    }
}

/**
 * Grows a tree: its skeleton from the shape and the seed (the same tree
 * every time), then its three levels of detail.
 */
export function growTree(shape: TreeShape, seed: number): GrownTree {
    const grown = growSkeleton(shape, seed);
    const { branches, def, trunkHeight } = grown;
    const H = Math.max(1, shape.height);
    const droop = def.leaves.droop;
    // Cards that would reach into the ground go, as the lowest twigs of a real tree die off.
    const cards = grown.cards.filter((c) => cardBottom(c, droop, 1) > GROUND_CLEAR);

    // The crown: the box around the cards, as an ellipsoid a little larger.
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of cards) {
        for (const p of [c.base, add(c.base, scale(c.up, c.length))]) {
            for (let i = 0; i < 3; i++) {
                lo[i] = Math.min(lo[i], p[i]);
                hi[i] = Math.max(hi[i], p[i]);
            }
        }
    }
    const crown = cards.length
        ? { center: scale(add(lo, hi), 0.5), radius: [0, 1, 2].map((i) => Math.max(0.5, (hi[i] - lo[i]) * 0.55)) as Vec3 }
        : { center: [0, H * 0.6, 0] as Vec3, radius: [H * 0.3, H * 0.35, H * 0.3] as Vec3 };
    for (const c of cards) c.out = crownShade(add(c.base, scale(c.up, c.length * 0.5)), crown, 1).out;

    // Which cards each farther level keeps: the outer ones more likely (the inner ones hide), grown to cover as much.
    const weights = cards.map((c) => 0.3 + 0.7 * Math.min(1, c.out) ** 2);
    const meanWeight = weights.reduce((a, b) => a + b, 0) / Math.max(1, weights.length);
    const kept = (share: number) => cards.map((c, i) => c.pick < Math.min(1, (share * weights[i]) / meanWeight));

    const lods: TreeLod[] = [];
    for (let lod = 0; lod < 3; lod++) {
        const bark = new MeshBuilder();
        for (const b of branches) {
            const sides = b.level === 0 ? def.trunk.sides[lod] : def.levels[b.level - 1].sides[lod];
            if (sides >= 3) addTube(bark, b, sides, lod === 0 ? 1 : lod === 1 ? 2 : 3, crown);
        }
        const leaves = new MeshBuilder();
        if (lod === 0) {
            for (const c of cards) addCard(leaves, c, crown, def.leaves.round, droop, true, 1, c.cell);
        } else {
            const keep = kept(def.leaves.keep[lod - 1]);
            const n = keep.filter(Boolean).length;
            const grow = Math.min(3.6, Math.sqrt(cards.length / Math.max(1, n)));
            cards.forEach((c, i) => {
                if (!keep[i]) return;
                // Grown less near the ground, so it stays above it.
                let g = grow;
                while (g > 1 && cardBottom(c, droop, g) < GROUND_CLEAR) g = Math.max(1, g - 0.2);
                // Far cards show the dense sprig: from afar it reads as a mass of leaves.
                addCard(leaves, c, crown, def.leaves.round, droop, false, g, lod === 2 ? LEAF_CELLS - 1 : c.cell);
            });
        }
        lods.push({ bark: bark.build(), leaves: leaves.build() });
    }

    // The box holds every level: far cards grow past the near ones.
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const part of lods.flatMap((l) => [l.bark, l.leaves])) {
        const p = part.positions;
        for (let i = 0; i < p.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], p[i + k]);
                max[k] = Math.max(max[k], p[i + k]);
            }
        }
    }
    const trunk = branches[0];
    const r1 = sample(trunk, Math.min(1, (1 + TRUNK_SINK) / Math.max(0.1, trunk.length))).r;
    return { lods, min, max, height: H, trunk: { radius: r1, height: trunkHeight }, crown };
}

/** Leaf flutter, leaf droop and the rest of the species' look that the shaders need. */
export function leafFlutter(species: TreeSpecies): number {
    return SPECIES[species].leaves.flutter;
}

/** Triangles of a tree at each level of detail (bark and leaves together). */
export function treeTriangles(t: GrownTree): number[] {
    return t.lods.map((l) => (l.bark.indices.length + l.leaves.indices.length) / 3);
}

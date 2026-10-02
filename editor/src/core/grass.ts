// How the blades of a grass field (NodeDoc.grass) vary: their shapes (how
// wide they are along their length, how much they bend) and how sizes and
// shapes spread over the field. Pure: engine/grass.ts gives the blades
// these, and the unit tests run it in Node.

export const GRASS_SHAPES = ['blade', 'leaf', 'needle'] as const;
export type GrassShape = (typeof GRASS_SHAPES)[number];

export const SIZE_DISTRIBUTIONS = ['uniform', 'bell', 'short', 'patches'] as const;
export type SizeDistribution = (typeof SIZE_DISTRIBUTIONS)[number];

export const SHAPE_DISTRIBUTIONS = ['mixed', 'patches'] as const;
export type ShapeDistribution = (typeof SHAPE_DISTRIBUTIONS)[number];

/** How much each shape bends, times the field's curvature. */
const BEND: Record<GrassShape, number> = { blade: 1, leaf: 1.5, needle: 0.45 };

/**
 * A shape's width at each of `rows + 1` rows from root to tip, times the
 * blade width: a blade tapers evenly, a leaf is broad in its lower middle
 * and rounds to a point, a needle is narrow with a long point.
 */
export function bladeProfile(shape: GrassShape, rows: number): number[] {
    return Array.from({ length: rows + 1 }, (_, i) => {
        const t = i / rows;
        if (shape === 'leaf') return 1.3 * (1 - t) * (0.6 + 2 * t);
        if (shape === 'needle') return 0.4 * (1 - Math.pow(t, 0.7));
        return 1 - t;
    });
}

/** A shape's bend for a curvature the field picked (0 to 1). */
export function bladeBend(shape: GrassShape, curvature: number): number {
    return Math.min(1, curvature * BEND[shape]);
}

/** 0 to 1 hashed from a lattice point and a seed. */
function lattice(i: number, j: number, seed: number): number {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, 0 to 1, about one patch across every `size` meters. */
export function patchNoise(x: number, z: number, size: number, seed: number): number {
    const px = x / Math.max(0.01, size), pz = z / Math.max(0.01, size);
    const i = Math.floor(px), j = Math.floor(pz);
    const fx = px - i, fz = pz - j;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = lattice(i, j, seed), b = lattice(i + 1, j, seed), c = lattice(i, j + 1, seed), d = lattice(i + 1, j + 1, seed);
    return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

/**
 * Where a blade's size falls in its range, 0 to 1: `r` and `extra` are its
 * random numbers, `patch` the patch noise where it stands. uniform: any size
 * as likely; bell: most near the middle; short: most small, a few large;
 * patches: large and small ones gather in patches.
 */
export function sizeAt(distribution: SizeDistribution, r: number, extra: [number, number], patch: number): number {
    if (distribution === 'bell') return (r + extra[0] + extra[1]) / 3;
    if (distribution === 'short') return Math.pow(r, 2.5);
    if (distribution === 'patches') return Math.min(1, Math.max(0, (patch - 0.5) * 1.8 + 0.5 + (r - 0.5) * 0.35));
    return r;
}

/**
 * Which shape a blade takes, by the shares given: mixed picks each blade's
 * by its random number; patches gathers the same shapes in patches (a few
 * blades of the others among them).
 */
export function shapeAt(shares: Record<GrassShape, number>, distribution: ShapeDistribution, r: number, patch: number): GrassShape {
    const total = GRASS_SHAPES.reduce((s, k) => s + Math.max(0, shares[k] ?? 0), 0);
    if (!(total > 0)) return 'blade';
    const pick = (distribution === 'patches' ? (r < 0.15 ? r / 0.15 : patch) : r) * total;
    let acc = 0;
    for (const k of GRASS_SHAPES) {
        acc += Math.max(0, shares[k] ?? 0);
        if (pick < acc) return k;
    }
    return GRASS_SHAPES.filter((k) => (shares[k] ?? 0) > 0).at(-1) ?? 'blade';
}

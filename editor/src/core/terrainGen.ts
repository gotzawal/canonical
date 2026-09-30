// Shaping terrain heightmaps (core/heightmap.ts): seeded noise for islands,
// hills and mountains, and the brushes the editor and the assistant sculpt
// and paint a terrain with. Positions here are in samples (x along a row,
// z down the rows) and heights normalized 0..1; core/terrain.ts converts
// from meters.

import type { Heightmap } from './heightmap';

/** mulberry32: a small, fast seeded random generator (0 <= r < 1). */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const GRAD = [
    [1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1],
];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** 2D simplex noise (Gustavson) with a seeded permutation, about -1..1. */
export class Noise2 {
    private perm = new Uint8Array(512);

    constructor(seed: number) {
        const rand = seededRandom(seed);
        const p = Array.from({ length: 256 }, (_, i) => i);
        for (let i = 255; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [p[i], p[j]] = [p[j], p[i]];
        }
        for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    }

    noise(x: number, y: number): number {
        const s = (x + y) * F2;
        const i = Math.floor(x + s);
        const j = Math.floor(y + s);
        const t = (i + j) * G2;
        const x0 = x - (i - t);
        const y0 = y - (j - t);
        const i1 = x0 > y0 ? 1 : 0;
        const j1 = 1 - i1;
        const x1 = x0 - i1 + G2;
        const y1 = y0 - j1 + G2;
        const x2 = x0 - 1 + 2 * G2;
        const y2 = y0 - 1 + 2 * G2;
        const ii = i & 255;
        const jj = j & 255;
        const p = this.perm;
        const corner = (g: number, dx: number, dy: number) => {
            let k = 0.5 - dx * dx - dy * dy;
            if (k < 0) return 0;
            k *= k;
            const d = GRAD[g & 7];
            return k * k * (d[0] * dx + d[1] * dy);
        };
        return 70 * (corner(p[ii + p[jj]], x0, y0) + corner(p[ii + i1 + p[jj + j1]], x1, y1) + corner(p[ii + 1 + p[jj + 1]], x2, y2));
    }

    /** Fractal sum of octaves, about -1..1. */
    fbm(x: number, y: number, octaves: number, gain: number): number {
        let sum = 0;
        let amp = 1;
        let norm = 0;
        for (let o = 0; o < octaves; o++) {
            sum += amp * this.noise(x, y);
            norm += amp;
            amp *= gain;
            x *= 2.03;
            y *= 2.03;
        }
        return sum / norm;
    }

    /** Ridges (sharp crests, as mountain ranges have), 0..1. */
    ridged(x: number, y: number, octaves: number, gain: number): number {
        let sum = 0;
        let amp = 1;
        let norm = 0;
        let weight = 1;
        for (let o = 0; o < octaves; o++) {
            let v = 1 - Math.abs(this.noise(x, y));
            v *= v * weight;
            weight = Math.min(1, v * 2);
            sum += amp * v;
            norm += amp;
            amp *= gain;
            x *= 2.03;
            y *= 2.03;
        }
        return sum / norm;
    }
}

export const TERRAIN_SHAPES = ['island', 'hills', 'mountains', 'plains', 'flat'] as const;
export type TerrainShape = (typeof TERRAIN_SHAPES)[number];

/** Where an island's coast is, as a normalized height: a terrain puts it at the water's height. */
export const ISLAND_COAST = 0.2;

export interface GenerateOptions {
    shape: TerrainShape;
    /** Samples per side (a power of two plus one, e.g. 513). */
    resolution: number;
    seed: number;
    /** 0 smooth .. 1 rugged. */
    roughness?: number;
}

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/**
 * A new heightmap of a shape. An island rises from a sea floor near 0 with
 * its coast at ISLAND_COAST; the other shapes span 0..1 (flat is all 0).
 */
export function generateHeightmap(o: GenerateOptions): Heightmap {
    const n = Math.max(3, Math.round(o.resolution));
    const data = new Float32Array(n * n);
    const map: Heightmap = { width: n, height: n, data };
    if (o.shape === 'flat') return map;
    const noise = new Noise2(o.seed);
    const rough = Math.min(1, Math.max(0, o.roughness ?? 0.5));
    const gain = 0.35 + 0.2 * rough;
    const rand = seededRandom(o.seed ^ 0x9e3779b9);
    const ox = rand() * 100;
    const oy = rand() * 100;
    // An island's highest point, somewhat off its middle.
    const px = (rand() - 0.5) * 0.4;
    const pz = (rand() - 0.5) * 0.4;
    // Islands: how high the land above the coast rises, scaled below so the highest point reaches 1.
    const above = o.shape === 'island' ? new Float32Array(n * n) : null;
    const shelf = o.shape === 'island' ? new Float32Array(n * n) : null;
    for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) {
            // Centered, -1..1 across the map.
            const u = (x / (n - 1)) * 2 - 1;
            const v = (z / (n - 1)) * 2 - 1;
            // A warped domain turns noise blobs into more natural forms.
            const wx = u + 0.3 * noise.fbm(u * 1.2 + ox, v * 1.2 + oy, 3, 0.5);
            const wy = v + 0.3 * noise.fbm(u * 1.2 + oy + 5.2, v * 1.2 + ox + 1.3, 3, 0.5);
            const i = z * n + x;
            if (above && shelf) {
                // A wobbly coast around the middle: a shelf rising from the sea floor to it, then land rising inland.
                const r = Math.hypot(u, v) + 0.2 * noise.fbm(wx * 1.1 + ox, wy * 1.1 + oy, 3, 0.5);
                shelf[i] = smoothstep(0.92, 0.7, r);
                const inland = smoothstep(0.74, 0.2, r);
                const dome = smoothstep(1.1, 0, Math.hypot(u - px, v - pz));
                const hills = 0.5 + 0.5 * noise.fbm(wx * 1.4 + ox, wy * 1.4 + oy, 5, gain);
                above[i] = inland * (0.6 * dome + 0.4 * hills);
            } else if (o.shape === 'mountains') {
                data[i] = Math.pow(noise.ridged(wx * 1.2 + ox, wy * 1.2 + oy, 6, gain + 0.1), 1.4);
            } else if (o.shape === 'plains') {
                data[i] = noise.fbm(wx * 0.8 + ox, wy * 0.8 + oy, 3, 0.35);
            } else {
                data[i] = noise.fbm(wx * 1.2 + ox, wy * 1.2 + oy, 5, gain);
            }
        }
    }
    if (above && shelf) {
        let top = 0;
        for (const a of above) top = Math.max(top, a);
        const k = top > 0 ? 1 / top : 0;
        for (let i = 0; i < data.length; i++) data[i] = 0.03 + (ISLAND_COAST - 0.03) * shelf[i] + (1 - ISLAND_COAST) * above[i] * k;
        return map;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of data) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
    }
    const span = hi - lo || 1;
    for (let i = 0; i < data.length; i++) data[i] = (data[i] - lo) / span;
    return map;
}

export const SCULPT_OPS = ['raise', 'lower', 'flatten', 'smooth', 'path'] as const;
export type SculptOp = (typeof SCULPT_OPS)[number];

/** A stroke: points along it, how wide it reaches and how strongly it works. */
export interface Stroke {
    /** Points in samples; one point is a single dab. */
    points: [number, number][];
    /** Samples from the stroke where it fades out. */
    radius: number;
    /** 0..1: how much of the change it makes where it is full. */
    strength: number;
}

/** A changed region of a map, in samples (x0, z0 inclusive, x1, z1 exclusive). */
export interface Region {
    x0: number;
    z0: number;
    x1: number;
    z1: number;
}

/** Distance from a point to a polyline, and where along it the closest point is (segment index + t). */
function toStroke(px: number, pz: number, pts: [number, number][]): { d: number; at: number } {
    if (pts.length === 1) return { d: Math.hypot(px - pts[0][0], pz - pts[0][1]), at: 0 };
    let best = Infinity;
    let at = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[i + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const len2 = dx * dx + dz * dz || 1;
        const t = Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / len2));
        const d = Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
        if (d < best) {
            best = d;
            at = i + t;
        }
    }
    return { d: best, at };
}

/** How much a sample at `d` from the stroke is changed: full in the middle, fading smoothly to the radius. */
const falloff = (d: number, radius: number) => {
    if (d >= radius) return 0;
    const t = d / radius;
    const k = 1 - t * t;
    return k * k;
};

function regionOf(map: Heightmap, s: Stroke): Region {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of s.points) {
        x0 = Math.min(x0, x - s.radius);
        z0 = Math.min(z0, z - s.radius);
        x1 = Math.max(x1, x + s.radius);
        z1 = Math.max(z1, z + s.radius);
    }
    return {
        x0: Math.max(0, Math.floor(x0)),
        z0: Math.max(0, Math.floor(z0)),
        x1: Math.min(map.width, Math.ceil(x1) + 1),
        z1: Math.min(map.height, Math.ceil(z1) + 1),
    };
}

/**
 * Sculpts a heightmap along a stroke; returns the region it changed.
 * raise and lower move by `amount` (normalized) where the stroke is full,
 * flatten pulls toward `target` (normalized; the height under the first
 * point without one), smooth evens out bumps, and path levels the ground
 * across the stroke to its own height along it (a walkable way that keeps
 * the slope of the ground it follows).
 */
export function sculpt(map: Heightmap, op: SculptOp, stroke: Stroke, opts: { amount?: number; target?: number } = {}): Region {
    const r = regionOf(map, stroke);
    if (r.x1 <= r.x0 || r.z1 <= r.z0 || stroke.radius <= 0) return r;
    const { width: w, data } = map;
    const strength = Math.min(1, Math.max(0, stroke.strength));
    const pts = stroke.points;
    const heightUnder = (x: number, z: number) => {
        const cx = Math.min(w - 1, Math.max(0, Math.round(x)));
        const cz = Math.min(map.height - 1, Math.max(0, Math.round(z)));
        return data[cz * w + cx];
    };
    // A path's height along it: the ground under its points, evened out.
    let profile: number[] = [];
    if (op === 'path') {
        const raw = pts.map(([x, z]) => heightUnder(x, z));
        profile = raw.map((_, i) => {
            let s = 0;
            let k = 0;
            for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 2); j++) {
                s += raw[j];
                k++;
            }
            return s / k;
        });
    }
    const target = opts.target ?? heightUnder(pts[0][0], pts[0][1]);
    const src = op === 'smooth' ? data.slice() : data;
    // Smoothing reaches as far as a tenth of the radius (at least a sample).
    const blur = Math.max(1, Math.round(stroke.radius / 10));
    for (let z = r.z0; z < r.z1; z++) {
        for (let x = r.x0; x < r.x1; x++) {
            const { d, at } = toStroke(x, z, pts);
            const f = falloff(d, stroke.radius) * strength;
            if (f <= 0) continue;
            const i = z * w + x;
            const h = data[i];
            if (op === 'raise') data[i] = h + (opts.amount ?? 0.01) * f;
            else if (op === 'lower') data[i] = h - (opts.amount ?? 0.01) * f;
            else if (op === 'flatten') data[i] = h + (target - h) * f;
            else if (op === 'path') {
                const k = Math.min(profile.length - 1, Math.floor(at));
                const t = at - k;
                const want = profile.length > 1 ? profile[k] + ((profile[Math.min(k + 1, profile.length - 1)] ?? profile[k]) - profile[k]) * t : profile[0];
                // Level across the whole width, fading only at the edge.
                const edge = Math.min(1, Math.max(0, (stroke.radius - d) / Math.max(1, stroke.radius * 0.35)));
                data[i] = h + (want - h) * edge * strength;
            } else {
                let s = 0;
                let k = 0;
                for (let dz = -blur; dz <= blur; dz++) {
                    const zz = z + dz;
                    if (zz < 0 || zz >= map.height) continue;
                    for (let dx = -blur; dx <= blur; dx++) {
                        const xx = x + dx;
                        if (xx < 0 || xx >= w) continue;
                        s += src[zz * w + xx];
                        k++;
                    }
                }
                data[i] = h + (s / k - h) * f;
            }
            data[i] = Math.min(1, Math.max(0, data[i]));
        }
    }
    return r;
}

/**
 * Paints a terrain layer (0..3) into a splat map (RGBA, a channel per
 * layer, 0 leaves the layer rules alone) along a stroke; returns the region
 * it changed. A painted layer takes over from the others.
 */
export function paintSplat(splat: { width: number; height: number; data: Uint8Array }, layer: number, stroke: Stroke): Region {
    const map = { width: splat.width, height: splat.height, data: new Float32Array(0) };
    const r = regionOf(map, stroke);
    const strength = Math.min(1, Math.max(0, stroke.strength));
    for (let z = r.z0; z < r.z1; z++) {
        for (let x = r.x0; x < r.x1; x++) {
            const f = falloff(toStroke(x, z, stroke.points).d, stroke.radius) * strength;
            if (f <= 0) continue;
            const i = (z * splat.width + x) * 4;
            for (let c = 0; c < 4; c++) {
                const v = splat.data[i + c];
                splat.data[i + c] = Math.round(c === layer ? v + (255 - v) * f : v * (1 - f));
            }
        }
    }
    return r;
}

// Paints the textures of trees (engine/treeTextures.ts makes GPU textures of
// them): bark that tiles around and along a branch, from noise that wraps
// (color, relief and a mask of the shade in its cracks and its roughness),
// and a strip of LEAF_CELLS square cells of leafy branchlets or needled
// fronds drawn on a 2D canvas, the last a dense one for far cards, their
// color pushed out under the transparent parts so the far mip levels, which
// average texels, do not darken the leaves' edges. Only plain arithmetic
// and an OffscreenCanvas for the leaves: the bark paints in Node too.

import { LEAF_CELLS, type TreeSpecies } from '../core/trees';
import { seededRandom } from '../core/terrainGen';

export const BARK_SIZE = 512;
export const LEAF_W = 512 * LEAF_CELLS;
export const LEAF_H = 512;

// ------------------------------------------------------------------- noise

/** 0 to 1 hashed from a lattice point (wrapped to its period) and a seed. */
function hash(i: number, j: number, seed: number): number {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Smooth value noise over the unit square that tiles: `px` cells across
 * and `py` down, so a texture made of it repeats without a seam.
 */
function tileNoise(u: number, v: number, px: number, py: number, seed: number): number {
    const x = u * px, y = v * py;
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const i0 = ((i % px) + px) % px, j0 = ((j % py) + py) % py;
    const i1 = (i0 + 1) % px, j1 = (j0 + 1) % py;
    const a = hash(i0, j0, seed), b = hash(i1, j0, seed), c = hash(i0, j1, seed), d = hash(i1, j1, seed);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Octaves of tiling noise, 0 to 1. */
function tileFbm(u: number, v: number, px: number, py: number, octaves: number, seed: number): number {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += tileNoise(u, v, px << o, py << o, seed + o * 101) * amp;
        norm += amp;
        amp *= 0.5;
    }
    return sum / norm;
}

/**
 * Tiling cells (Worley): the distances to the nearest and second nearest
 * cell point (in cells), the nearest one's id (0 to 1) and how far below
 * its point the texel lies (in cells, for scales lit at their lower edge).
 */
function tileCells(u: number, v: number, px: number, py: number, seed: number, stretch = 0.8): [number, number, number, number] {
    const x = u * px, y = v * py;
    const i = Math.floor(x), j = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0, below = 0;
    // Measured less along v, a nearer point can be two rows away.
    const rows = stretch < 0.7 ? 2 : 1;
    for (let dj = -rows; dj <= rows; dj++) {
        for (let di = -1; di <= 1; di++) {
            const ci = i + di, cj = j + dj;
            const wi = ((ci % px) + px) % px, wj = ((cj % py) + py) % py;
            const cx = ci + 0.15 + 0.7 * hash(wi, wj, seed), cy = cj + 0.15 + 0.7 * hash(wi, wj, seed + 7);
            const d = Math.hypot(cx - x, (cy - y) * stretch);
            if (d < f1) {
                f2 = f1;
                f1 = d;
                id = hash(wi, wj, seed + 13);
                below = y - cy;
            } else if (d < f2) f2 = d;
        }
    }
    return [f1, f2, id, below];
}

function smoothstep(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Linear from an sRGB 0 to 1 value. */
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// -------------------------------------------------------------------- bark

/** A bark texel: its color (sRGB 0 to 1), relief (0 deep cracks to 1 the surface), roughness. */
type BarkTexel = (u: number, v: number) => { r: number; g: number; b: number; h: number; rough: number };

const BARK: Record<TreeSpecies, BarkTexel> = {
    // Long plates up the trunk between deep furrows that wander, part and join: gray-brown,
    // rounded and weathered lighter on top, lichen here and there, dark brown deep down.
    oak: (u, v) => {
        const w1 = tileFbm(u, v, 4, 3, 3, 11) - 0.5;
        const w2 = tileFbm(u, v, 12, 6, 2, 13) - 0.5;
        // Cells measured less along the trunk than across it: their borders run up it, furrows rather than cracks.
        const [f1, f2, id] = tileCells(u + w1 * 0.07 + w2 * 0.02, v + w1 * 0.05, 11, 5, 23, 0.42);
        const gap = f2 - f1;
        const wide = tileFbm(u, v, 6, 4, 2, 29);
        const plate = Math.pow(smoothstep(0.01 + 0.04 * wide, 0.18 + 0.14 * wide, gap), 0.65);
        const fine = tileFbm(u, v, 48, 24, 3, 41);
        const grain = tileFbm(u, v, 128, 12, 2, 43);
        const streak = tileFbm(u, v, 64, 4, 2, 47);
        const h = Math.max(0, Math.min(1, plate * (0.66 + 0.2 * fine + 0.14 * streak) + 0.08 * grain));
        const t = smoothstep(0.02, 0.7, h);
        const top = smoothstep(0.55, 0.95, h) * (0.5 + 0.5 * fine);
        const lichen = smoothstep(0.6, 0.7, tileFbm(u, v, 4, 3, 3, 53)) * smoothstep(0.45, 0.8, h) * (0.6 + 0.4 * grain);
        const tone = (0.82 + 0.3 * id) * (0.85 + 0.3 * tileFbm(u, v, 3, 5, 3, 59));
        let r = mix(0.1, 0.46 * tone, t) + 0.12 * top, g = mix(0.085, 0.41 * tone, t) + 0.11 * top, b = mix(0.065, 0.35 * tone, t) + 0.1 * top;
        const k = 0.86 + 0.28 * grain;
        r = mix(r * k, 0.5, lichen * 0.55);
        g = mix(g * k, 0.53, lichen * 0.6);
        b = mix(b * k, 0.39, lichen * 0.42);
        return { r, g, b, h, rough: 0.78 + 0.2 * (1 - h) };
    },
    // White paper bark with dark horizontal lenticels and black, cracked patches.
    birch: (u, v) => {
        const band = tileFbm(u, v, 2, 24, 3, 61);
        const fine = tileFbm(u, v, 24, 24, 3, 67);
        const lenticel = smoothstep(0.7, 0.8, tileNoise(u, v, 7, 96, 71) * (0.75 + 0.5 * tileNoise(u, v, 3, 12, 73)));
        const patch = smoothstep(0.66, 0.74, tileFbm(u, v, 4, 6, 4, 79));
        const crack = patch * smoothstep(0.45, 0.6, 1 - Math.abs(2 * tileFbm(u, v, 8, 3, 3, 83) - 1));
        const white = 0.8 + 0.12 * band - 0.06 * fine;
        const dark = Math.max(lenticel * 0.85, patch * 0.92);
        const r = mix(white, 0.07, dark) * 1.0, g = mix(white * 0.985, 0.065, dark), b = mix(white * 0.94, 0.06, dark);
        const h = 0.75 - 0.35 * lenticel - 0.45 * crack + 0.1 * fine;
        return { r, g, b, h: Math.max(0, Math.min(1, h)), rough: mix(0.78, 0.94, dark) };
    },
    // Small, thin scales, rounded and a little lifted at their lower edge, gray-brown to
    // reddish, with fine cracks between them.
    spruce: (u, v) => {
        const w = tileFbm(u, v, 6, 8, 3, 89) - 0.5;
        const [f1, f2, id, below] = tileCells(u + w * 0.07, v + w * 0.05, 14, 24, 97, 1.1);
        // Some cracks close up: the scales run together in places.
        const open = smoothstep(0.3, 0.6, tileFbm(u, v, 10, 14, 2, 99));
        const edge = 1 - (1 - smoothstep(0.0, 0.06, f2 - f1)) * (0.35 + 0.65 * open);
        const fine = tileFbm(u, v, 64, 64, 3, 101);
        // A scale lies over the one below it: lighter where it is lifted, its lower edge.
        const lift = smoothstep(-0.3, 0.4, below);
        const h = Math.min(1, edge * (0.45 + 0.3 * lift + 0.2 * id) + 0.08 * fine);
        const patch = tileFbm(u, v, 3, 4, 3, 105);
        const k = (0.84 + 0.3 * fine) * (0.88 + 0.22 * lift) * (0.85 + 0.3 * patch);
        const red = id * (0.4 + 0.6 * patch);
        const r = mix(0.15, mix(0.35, 0.43, red), edge) * k;
        const g = mix(0.12, mix(0.3, 0.3, red), edge) * k;
        const b = mix(0.1, mix(0.27, 0.23, red), edge) * k;
        return { r, g, b, h, rough: 0.75 + 0.2 * (1 - h) };
    },
};

export function paintBark(species: TreeSpecies): { color: Uint8Array; normal: Uint8Array; mask: Uint8Array; mean: [number, number, number] } {
    const n = BARK_SIZE;
    const texel = BARK[species];
    const height = new Float32Array(n * n);
    const color = new Uint8Array(n * n * 4);
    const mask = new Uint8Array(n * n * 4);
    const mean = [0, 0, 0];
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const t = texel(x / n, y / n);
            const i = y * n + x;
            height[i] = t.h;
            color[i * 4] = Math.round(Math.min(1, t.r) * 255);
            color[i * 4 + 1] = Math.round(Math.min(1, t.g) * 255);
            color[i * 4 + 2] = Math.round(Math.min(1, t.b) * 255);
            color[i * 4 + 3] = 255;
            mean[0] += toLinear(Math.min(1, t.r));
            mean[1] += toLinear(Math.min(1, t.g));
            mean[2] += toLinear(Math.min(1, t.b));
            // The cracks are in shade; roughness as painted; no metal.
            mask[i * 4] = Math.round((0.72 + 0.28 * smoothstep(0.02, 0.55, t.h)) * 255);
            mask[i * 4 + 1] = Math.round(Math.min(1, t.rough) * 255);
            mask[i * 4 + 2] = 0;
            mask[i * 4 + 3] = 255;
        }
    }
    // The normal map from the relief (it wraps, as the bark does); the shaders read its red and green.
    const normal = new Uint8Array(n * n * 4);
    const depth = 5.5;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const hx = height[y * n + ((x + 1) % n)] - height[y * n + ((x + n - 1) % n)];
            const hy = height[((y + 1) % n) * n + x] - height[((y + n - 1) % n) * n + x];
            let nx = -hx * depth, ny = -hy * depth;
            const l = Math.hypot(nx, ny, 1);
            nx /= l;
            ny /= l;
            const i = (y * n + x) * 4;
            normal[i] = Math.round((nx * 0.5 + 0.5) * 255);
            normal[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            normal[i + 2] = Math.round((1 / l) * 255);
            normal[i + 3] = 255;
        }
    }
    const count = n * n;
    return { color, normal, mask, mean: [mean[0] / count, mean[1] / count, mean[2] / count] };
}

// ------------------------------------------------------------------ leaves

/** A leaf's half width at `s` along its midrib (0 at its stalk, 1 at its tip), times its width. */
type Outline = (s: number, random: number) => number;

const OUTLINES: Record<'oak' | 'birch', Outline> = {
    // Widest past its middle, with deep, rounded lobes.
    oak: (s, r) => {
        const body = Math.sin(Math.PI * Math.pow(s, 0.68)) * (0.5 + 0.5 * s);
        const lobes = 0.52 + 0.48 * Math.pow(Math.abs(Math.sin((3.5 + Math.round(r * 1.5)) * Math.PI * s)), 0.6);
        return body * lobes;
    },
    // A broad base narrowing to a long point, with a finely toothed edge.
    birch: (s) => {
        const body = s < 0.3 ? Math.sin((s / 0.3) * Math.PI * 0.5) : Math.pow(1 - (s - 0.3) / 0.7, 1.15);
        return body * (0.93 + 0.07 * Math.abs(Math.sin(s * 38)));
    },
};

interface LeafPalette {
    /** Colors leaves pick from (sRGB 0 to 1), and the twig's. */
    leaf: [number, number, number][];
    vein: [number, number, number];
    twig: [number, number, number];
}

const PALETTES: Record<TreeSpecies, LeafPalette> = {
    oak: { leaf: [[0.27, 0.4, 0.12], [0.32, 0.46, 0.14], [0.23, 0.36, 0.11], [0.37, 0.48, 0.16]], vein: [0.6, 0.66, 0.36], twig: [0.33, 0.27, 0.19] },
    birch: { leaf: [[0.36, 0.52, 0.15], [0.42, 0.58, 0.18], [0.33, 0.48, 0.14], [0.48, 0.6, 0.2]], vein: [0.64, 0.72, 0.4], twig: [0.3, 0.22, 0.17] },
    spruce: { leaf: [[0.12, 0.25, 0.14], [0.14, 0.29, 0.16], [0.1, 0.22, 0.13], [0.24, 0.38, 0.17]], vein: [0.34, 0.42, 0.24], twig: [0.36, 0.26, 0.17] },
};

const css = (c: [number, number, number], a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const shade = (c: [number, number, number], k: number): [number, number, number] => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

/** One leaf at (x, y) pointing `angle` (radians, 0 up the cell), `size` pixels long, on a stalk. */
function drawLeaf(g: OffscreenCanvasRenderingContext2D, species: 'oak' | 'birch', x: number, y: number, angle: number, size: number, random: () => number, palette: LeafPalette) {
    const outline = OUTLINES[species];
    const r = random();
    const width = size * (species === 'oak' ? 0.58 : 0.42) * (0.85 + 0.3 * random());
    const stalk = size * (species === 'oak' ? 0.08 : 0.16);
    const base = palette.leaf[Math.floor(random() * palette.leaf.length)];
    const k = 0.85 + 0.3 * random();
    // Now and then a yellower or browner leaf.
    const odd = random();
    const color: [number, number, number] = odd < 0.03 ? [base[0] * 1.5, base[1] * 1.18, base[2] * 0.7] : odd < 0.045 ? [base[0] * 1.4, base[1] * 0.95, base[2] * 0.6] : shade(base, k);
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    // The stalk.
    g.strokeStyle = css(palette.twig);
    g.lineWidth = Math.max(1, size * 0.018);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(0, -stalk);
    g.stroke();
    g.translate(0, -stalk);
    // The blade: its outline down one side and up the other, a little crooked.
    const steps = 40;
    const bend = (random() - 0.5) * 0.18 * size;
    const at = (s: number, side: number) => {
        const w = outline(s, r) * width * 0.5;
        return [side * w + bend * s * s, -s * size] as const;
    };
    g.beginPath();
    g.moveTo(0, 0);
    for (let i = 1; i <= steps; i++) g.lineTo(...at(i / steps, 1));
    for (let i = steps; i >= 0; i--) g.lineTo(...at(i / steps, -1));
    g.closePath();
    const grad = g.createLinearGradient(-width / 2, 0, width / 2, -size * 0.3);
    grad.addColorStop(0, css(shade(color, 0.86)));
    grad.addColorStop(0.5, css(color));
    grad.addColorStop(1, css(shade(color, 1.12)));
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = css(shade(color, 0.7), 0.35);
    g.lineWidth = 1;
    g.stroke();
    // The midrib and the veins off it, lighter.
    g.strokeStyle = css(palette.vein, 0.55);
    g.lineWidth = Math.max(0.8, size * 0.012);
    g.beginPath();
    g.moveTo(0, 0);
    for (let i = 1; i <= 10; i++) {
        const s = i / 10;
        g.lineTo(bend * s * s, -s * size * 0.96);
    }
    g.stroke();
    g.strokeStyle = css(palette.vein, 0.22);
    g.lineWidth = Math.max(0.6, size * 0.007);
    const veins = species === 'oak' ? 6 : 8;
    for (let i = 1; i <= veins; i++) {
        const s = i / (veins + 1.5);
        for (const side of [-1, 1]) {
            const w = outline(s + 0.08, r) * width * 0.5 * 0.85;
            g.beginPath();
            g.moveTo(bend * s * s, -s * size);
            g.lineTo(side * w + bend * s * s, -(s + 0.09) * size);
            g.stroke();
        }
    }
    g.restore();
}

/** A line of a branchlet: from (x, y) heading `angle` (0 up the cell, radians), `length` pixels, bending by `bend`. */
interface Twig {
    x: number;
    y: number;
    angle: number;
    length: number;
    bend: number;
    width: number;
}

/** A point of a twig at `s` (0 its base, 1 its tip), and its heading there. */
function along(t: Twig, s: number): [number, number, number] {
    const a = t.angle + t.bend * s;
    // Integrated in a few steps: the twig curves gently.
    let x = t.x, y = t.y;
    const n = 8;
    for (let i = 0; i < n; i++) {
        const ai = t.angle + t.bend * ((i + 0.5) / n) * s;
        x += Math.sin(ai) * (t.length * s) / n;
        y -= Math.cos(ai) * (t.length * s) / n;
    }
    return [x, y, a];
}

function drawTwig(g: OffscreenCanvasRenderingContext2D, t: Twig, color: [number, number, number]) {
    g.strokeStyle = css(color);
    g.lineCap = 'round';
    const n = 10;
    for (let i = 0; i < n; i++) {
        const [x0, y0] = along(t, i / n), [x1, y1] = along(t, (i + 1) / n);
        g.lineWidth = Math.max(1, t.width * (1 - 0.75 * (i / n)));
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
    }
}

/**
 * A branchlet of a broadleaf filling a square cell: a twig up its middle
 * with side twigs off it, leaves along them all and a cluster at each tip.
 * The dense one (far cards) is full of leaves, so far crowns read as a mass.
 */
function drawBranchlet(g: OffscreenCanvasRenderingContext2D, species: 'oak' | 'birch', x0: number, w: number, h: number, dense: boolean, random: () => number) {
    const palette = PALETTES[species];
    const oak = species === 'oak';
    const main: Twig = { x: x0 + w / 2 + (random() - 0.5) * w * 0.08, y: h - 6, angle: (random() - 0.5) * 0.25, length: h * 0.84, bend: (random() - 0.5) * 0.5, width: 7 };
    const twigs: Twig[] = [main];
    const sides = dense ? 6 : oak ? 3 + Math.floor(random() * 2) : 4 + Math.floor(random() * 2);
    for (let i = 0; i < sides; i++) {
        const s = 0.18 + 0.62 * ((i + 0.3 + random() * 0.4) / sides);
        const [x, y, a] = along(main, s);
        const side = i % 2 ? 1 : -1;
        twigs.push({ x, y, angle: a + side * (0.55 + 0.4 * random()), length: h * (0.5 - 0.28 * s) * (0.8 + 0.4 * random()), bend: -side * (0.2 + 0.4 * random()) * (oak ? 1 : -0.6), width: 4 });
    }
    for (const t of twigs) drawTwig(g, t, palette.twig);
    // Leaves along every twig, alternately left and right, and a few at each tip; the lower ones first.
    const leaves: { x: number; y: number; angle: number; size: number; order: number }[] = [];
    const leafSize = (oak ? 0.17 : 0.105) * h * (dense ? 0.85 : 1);
    for (const t of twigs) {
        const n = Math.round((t.length / (leafSize * (oak ? 0.55 : 0.42))) * (dense ? 1.6 : 1));
        for (let k = 0; k < n; k++) {
            const s = 0.15 + 0.85 * ((k + random() * 0.6) / n);
            const [x, y, a] = along(t, s);
            const side = k % 2 ? 1 : -1;
            leaves.push({ x, y, angle: a + side * (0.7 + 0.5 * random()), size: leafSize * (0.7 + 0.45 * random()) * (oak ? 0.75 + 0.35 * s : 1.05 - 0.3 * s), order: s + random() * 0.2 });
        }
        const [tx, ty, ta] = along(t, 1);
        for (let k = 0; k < (oak ? 3 : 2); k++) leaves.push({ x: tx, y: ty, angle: ta + (k - (oak ? 1 : 0.5)) * 0.45 + (random() - 0.5) * 0.3, size: leafSize * (0.85 + 0.3 * random()), order: 2 });
    }
    if (dense) {
        // Fill the gaps: more leaves anywhere near the twigs.
        for (let k = 0; k < 40; k++) {
            const t = twigs[Math.floor(random() * twigs.length)];
            const [x, y, a] = along(t, 0.2 + 0.8 * random());
            leaves.push({ x: x + (random() - 0.5) * leafSize, y: y + (random() - 0.5) * leafSize, angle: a + (random() - 0.5) * 2.6, size: leafSize * (0.7 + 0.4 * random()), order: random() * 2 });
        }
    }
    leaves.sort((a, b) => a.order - b.order);
    for (const l of leaves) {
        // Kept inside the cell: a leaf that would cross its edge turns in a little and shrinks.
        const tipX = l.x + Math.sin(l.angle) * l.size, tipY = l.y - Math.cos(l.angle) * l.size;
        const over = Math.max(x0 + 8 - tipX, tipX - (x0 + w - 8), 8 - tipY, tipY - (h - 4));
        const size = over > 0 ? Math.max(l.size * 0.45, l.size - over) : l.size;
        drawLeaf(g, species, l.x, l.y, l.angle, size, random, palette);
    }
}

/**
 * A frond of spruce filling a square cell: a shoot up its middle with side
 * shoots off it (shorter toward its tip), all thick with short needles
 * pointing forward, the young ones at the tips lighter.
 */
function drawFrond(g: OffscreenCanvasRenderingContext2D, x0: number, w: number, h: number, dense: boolean, random: () => number) {
    const palette = PALETTES.spruce;
    const main: Twig = { x: x0 + w / 2, y: h - 6, angle: (random() - 0.5) * 0.1, length: h * 0.9, bend: (random() - 0.5) * 0.2, width: 6 };
    const shoots: Twig[] = [main];
    const sides = dense ? 18 : 13 + Math.floor(random() * 3);
    for (let i = 0; i < sides; i++) {
        const s = 0.08 + 0.82 * ((i + random() * 0.5) / sides);
        const [x, y, a] = along(main, s);
        const side = i % 2 ? 1 : -1;
        const length = Math.min((0.5 - 0.36 * s) * w, (w / 2 - 14) / Math.max(0.35, Math.sin(0.95)));
        shoots.push({ x, y, angle: a + side * (0.85 + 0.25 * random()), length: length * (0.85 + 0.3 * random()), bend: -side * 0.25 * random(), width: 3 });
        // Second side shoots off the longer ones.
        if (length > w * 0.16) {
            const t = shoots[shoots.length - 1];
            for (const q of [0.3, 0.55, 0.8]) {
                const [qx, qy, qa] = along(t, q);
                const qs = (random() < 0.5 ? 1 : -1);
                shoots.push({ x: qx, y: qy, angle: qa + qs * (0.75 + 0.3 * random()), length: t.length * 0.35, bend: 0, width: 2 });
            }
        }
    }
    for (const t of shoots) drawTwig(g, t, palette.twig);
    const spacing = dense ? 2 : 2.3;
    for (const t of shoots) {
        const n = Math.floor(t.length / spacing);
        for (let k = 0; k < n; k++) {
            const s = k / n;
            const [px, py, a] = along(t, s);
            for (const side of [-1, 1]) {
                const na = a + side * (0.6 + 0.35 * random());
                const l = (15 + 9 * random()) * (1 - 0.3 * s) * (dense ? 1.15 : 1);
                const young = smoothstep(0.7, 1, s) * (t === main ? 1 : 0.8);
                const base = palette.leaf[Math.floor(random() * 3)];
                const c: [number, number, number] = [mix(base[0], 0.3, young), mix(base[1], 0.46, young), mix(base[2], 0.18, young)];
                g.strokeStyle = css(shade(c, 0.82 + 0.4 * random()));
                g.lineWidth = 1.7 + random() * 0.7;
                g.beginPath();
                g.moveTo(px, py);
                g.lineTo(px + Math.sin(na) * l, py - Math.cos(na) * l);
                g.stroke();
            }
        }
    }
}

/**
 * Fills the color of transparent texels from the leaves around them (pull,
 * then push, over a pyramid of halved images), so averaging them into far
 * mip levels keeps the leaves' color at their edges. Alpha stays.
 */
function bleed(data: Uint8ClampedArray, w: number, h: number) {
    const levels: { w: number; h: number; c: Float32Array; a: Float32Array }[] = [];
    let c = new Float32Array(w * h * 3), a = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const al = data[i * 4 + 3] / 255;
        a[i] = al > 0.02 ? 1 : 0;
        c[i * 3] = data[i * 4] * a[i];
        c[i * 3 + 1] = data[i * 4 + 1] * a[i];
        c[i * 3 + 2] = data[i * 4 + 2] * a[i];
    }
    levels.push({ w, h, c, a });
    // Pull: each coarser texel is the coverage-weighted mean of the four under it.
    while (levels[levels.length - 1].w > 1 && levels[levels.length - 1].h > 1) {
        const p = levels[levels.length - 1];
        const nw = p.w >> 1, nh = p.h >> 1;
        const nc = new Float32Array(nw * nh * 3), na = new Float32Array(nw * nh);
        for (let y = 0; y < nh; y++) {
            for (let x = 0; x < nw; x++) {
                let sa = 0;
                const s = [0, 0, 0];
                for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                    const j = (y * 2 + dy) * p.w + x * 2 + dx;
                    sa += p.a[j];
                    s[0] += p.c[j * 3];
                    s[1] += p.c[j * 3 + 1];
                    s[2] += p.c[j * 3 + 2];
                }
                const i = y * nw + x;
                const k = sa > 0 ? 1 / sa : 0;
                na[i] = Math.min(1, sa);
                nc[i * 3] = s[0] * k * na[i];
                nc[i * 3 + 1] = s[1] * k * na[i];
                nc[i * 3 + 2] = s[2] * k * na[i];
            }
        }
        levels.push({ w: nw, h: nh, c: nc, a: na });
    }
    // Push: an empty texel takes the color of the coarser one over it.
    for (let l = levels.length - 2; l >= 0; l--) {
        const p = levels[l], q = levels[l + 1];
        for (let y = 0; y < p.h; y++) {
            for (let x = 0; x < p.w; x++) {
                const i = y * p.w + x;
                if (p.a[i] >= 1) continue;
                const j = Math.min(q.h - 1, y >> 1) * q.w + Math.min(q.w - 1, x >> 1);
                const qa = q.a[j] > 0 ? 1 / q.a[j] : 0;
                const t = 1 - p.a[i];
                p.c[i * 3] = p.c[i * 3] + q.c[j * 3] * qa * t;
                p.c[i * 3 + 1] = p.c[i * 3 + 1] + q.c[j * 3 + 1] * qa * t;
                p.c[i * 3 + 2] = p.c[i * 3 + 2] + q.c[j * 3 + 2] * qa * t;
                p.a[i] = 1;
            }
        }
    }
    const top = levels[0];
    for (let i = 0; i < w * h; i++) {
        if (data[i * 4 + 3] > 5) continue;
        data[i * 4] = top.c[i * 3];
        data[i * 4 + 1] = top.c[i * 3 + 1];
        data[i * 4 + 2] = top.c[i * 3 + 2];
    }
}

export function paintLeaves(species: TreeSpecies): { data: Uint8Array; mean: [number, number, number] } {
    const canvas = new OffscreenCanvas(LEAF_W, LEAF_H);
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    const random = seededRandom(species === 'oak' ? 101 : species === 'birch' ? 202 : 303);
    const cellW = LEAF_W / LEAF_CELLS;
    for (let cell = 0; cell < LEAF_CELLS; cell++) {
        const dense = cell === LEAF_CELLS - 1;
        g.save();
        g.beginPath();
        g.rect(cell * cellW + 2, 2, cellW - 4, LEAF_H - 4);
        g.clip();
        if (species === 'spruce') drawFrond(g, cell * cellW, cellW, LEAF_H, dense, random);
        else drawBranchlet(g, species, cell * cellW, cellW, LEAF_H, dense, random);
        g.restore();
    }
    const image = g.getImageData(0, 0, LEAF_W, LEAF_H);
    const mean = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < LEAF_W * LEAF_H; i++) {
        if (image.data[i * 4 + 3] < 128) continue;
        mean[0] += toLinear(image.data[i * 4] / 255);
        mean[1] += toLinear(image.data[i * 4 + 1] / 255);
        mean[2] += toLinear(image.data[i * 4 + 2] / 255);
        n++;
    }
    bleed(image.data, LEAF_W, LEAF_H);
    return { data: new Uint8Array(image.data.buffer.slice(0)), mean: [mean[0] / Math.max(1, n), mean[1] / Math.max(1, n), mean[2] / Math.max(1, n)] };
}

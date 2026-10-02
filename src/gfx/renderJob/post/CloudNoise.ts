/**
 * The tiling noise volumes the volumetric clouds are carved from (CloudPost),
 * made once on the CPU as RGBA8 3D textures:
 *
 * - shape (64^3): r the cloud shape (Perlin carved by Worley), g billows
 *   (Worley over three octaves), b the weather (where clouds gather: soft
 *   low Perlin with Worley clumps), a spare (fine Worley).
 * - detail (32^3): r, g, b Worley at three sizes, a their sum, for wearing
 *   the edges into wisps and billows.
 *
 * Every channel is equalized (its values spread evenly over 0..1), so a
 * threshold of 1 - c keeps about c of it: coverage means what it says.
 * Made once a page in a worker (about a second), or between frames where
 * there is no worker.
 *
 * @internal
 */
export function cloudVolumes(): Promise<CloudVolumes> {
    made ??= inWorker().catch(() => new Promise<CloudVolumes>((resolve) => setTimeout(() => resolve(generateVolumes()), 0)));
    return made;
}

export interface CloudVolumes {
    shape: Uint8Array;
    shapeSize: number;
    detail: Uint8Array;
    detailSize: number;
}

let made: Promise<CloudVolumes> | null = null;

/** Runs generateVolumes in a worker made from its own source (it uses nothing outside itself). */
function inWorker(): Promise<CloudVolumes> {
    return new Promise((resolve, reject) => {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return reject(new Error('no workers'));
        const code = `const generateVolumes = ${generateVolumes.toString()};\nconst v = generateVolumes();\npostMessage(v, [v.shape.buffer, v.detail.buffer]);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        let worker: Worker;
        try {
            worker = new Worker(url);
        } catch (e) {
            URL.revokeObjectURL(url);
            return reject(e);
        }
        const done = () => {
            worker.terminate();
            URL.revokeObjectURL(url);
        };
        worker.onmessage = (e) => {
            done();
            resolve(e.data as CloudVolumes);
        };
        worker.onerror = (e) => {
            done();
            reject(e);
        };
    });
}

/** Makes the volumes. Self-contained: a worker runs it from its source. */
export function generateVolumes(): CloudVolumes {
    function generate(): CloudVolumes {
        const shapeSize = 64, detailSize = 32;
        const shape = volume(shapeSize, (u, v, w, n) => {
            const w4 = worley(u, v, w, 4, 1), w8 = worley(u, v, w, 8, 2), w16 = worley(u, v, w, 16, 3);
            const cells = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
            const p = perlinFbm(u, v, w, 4, 4, 11);
            // Perlin-Worley: the soft Perlin shape, its low parts cut away where the Worley cells part.
            n[0] = cells + p * (1 - cells) - (1 - cells) * 0.6;
            n[1] = cells;
            n[2] = perlinFbm(u, v, w, 2, 3, 21) * 0.75 + worley(u, v, w, 4, 5) * 0.25;
            n[3] = worley(u, v, w, 32, 6);
        });
        const detail = volume(detailSize, (u, v, w, n) => {
            n[0] = worley(u, v, w, 4, 7);
            n[1] = worley(u, v, w, 8, 8);
            n[2] = worley(u, v, w, 16, 9);
            n[3] = n[0] * 0.625 + n[1] * 0.25 + n[2] * 0.125;
        });
        return { shape, shapeSize, detail, detailSize };
    }

    /** A size^3 RGBA8 volume from `fill` (u, v, w in 0..1), each channel equalized. */
    function volume(size: number, fill: (u: number, v: number, w: number, out: Float32Array) => void): Uint8Array {
        const count = size * size * size;
        const raw = new Float32Array(count * 4);
        const out = new Float32Array(4);
        for (let z = 0, i = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++, i++) {
            fill((x + 0.5) / size, (y + 0.5) / size, (z + 0.5) / size, out);
            raw.set(out, i * 4);
        }
        // Equalized through a fine histogram: each value goes to the share of values below it.
        const BINS = 4096;
        const bytes = new Uint8Array(count * 4);
        const hist = new Float64Array(BINS);
        for (let c = 0; c < 4; c++) {
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < count; i++) {
                const v = raw[i * 4 + c];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            const scale = (BINS - 1) / Math.max(1e-9, hi - lo);
            hist.fill(0);
            for (let i = 0; i < count; i++) hist[Math.round((raw[i * 4 + c] - lo) * scale)]++;
            let acc = 0;
            for (let b = 0; b < BINS; b++) {
                const n = hist[b];
                hist[b] = (acc + n * 0.5) / count;
                acc += n;
            }
            for (let i = 0; i < count; i++) bytes[i * 4 + c] = Math.round(hist[Math.round((raw[i * 4 + c] - lo) * scale)] * 255);
        }
        return bytes;
    }

    /** 0..1 hashed from a lattice point and a seed. */
    function hash(i: number, j: number, k: number, seed: number): number {
        let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1440662683) ^ Math.imul(seed, 2246822519);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h = Math.imul(h ^ (h >>> 16), 2654435761);
        return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
    }

    const wrap = (v: number, p: number) => (v < 0 ? v + p : v >= p ? v - p : v);

    /** Feature points (Worley) or gradients (Perlin) of a lattice, by (period, seed): three numbers a cell. */
    const tables = new Map<string, Float32Array>();
    function lattice(kind: 'points' | 'grads', period: number, seed: number): Float32Array {
        const key = `${kind}${period}|${seed}`;
        let t = tables.get(key);
        if (t) return t;
        t = new Float32Array(period * period * period * 3);
        for (let c = 0; c < period; c++) for (let b = 0; b < period; b++) for (let a = 0; a < period; a++) {
            const o = ((c * period + b) * period + a) * 3;
            if (kind === 'points') {
                t[o] = hash(a, b, c, seed);
                t[o + 1] = hash(a, b, c, seed + 101);
                t[o + 2] = hash(a, b, c, seed + 211);
            } else {
                // A gradient on the unit sphere from two hashes.
                const th = hash(a, b, c, seed) * Math.PI * 2, z = hash(a, b, c, seed + 7) * 2 - 1, r = Math.sqrt(1 - z * z);
                t[o] = r * Math.cos(th);
                t[o + 1] = r * Math.sin(th);
                t[o + 2] = z;
            }
        }
        tables.set(key, t);
        return t;
    }

    /** Worley noise tiling with `period` cells across: 1 at a cell's point, falling to 0 a cell away. */
    function worley(u: number, v: number, w: number, period: number, seed: number): number {
        const pts = lattice('points', period, seed);
        const px = u * period, py = v * period, pz = w * period;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        let best = 9;
        for (let dz = -1; dz <= 1; dz++) {
            const cz = iz + dz, c = wrap(cz, period);
            for (let dy = -1; dy <= 1; dy++) {
                const cy = iy + dy, b = wrap(cy, period);
                for (let dx = -1; dx <= 1; dx++) {
                    const cx = ix + dx, o = ((c * period + b) * period + wrap(cx, period)) * 3;
                    const fx = cx + pts[o] - px, fy = cy + pts[o + 1] - py, fz = cz + pts[o + 2] - pz;
                    const d = fx * fx + fy * fy + fz * fz;
                    if (d < best) best = d;
                }
            }
        }
        return 1 - Math.min(1, Math.sqrt(best));
    }

    /** Gradient noise tiling with `period` lattice cells across, about -1..1. */
    function perlin(u: number, v: number, w: number, period: number, seed: number): number {
        const g = lattice('grads', period, seed);
        const px = u * period, py = v * period, pz = w * period;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const fx = px - ix, fy = py - iy, fz = pz - iz;
        const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
        const ux = fade(fx), uy = fade(fy), uz = fade(fz);
        let sum = 0;
        for (let k = 0; k < 8; k++) {
            const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
            const o = ((wrap(iz + dz, period) * period + wrap(iy + dy, period)) * period + wrap(ix + dx, period)) * 3;
            const d = g[o] * (fx - dx) + g[o + 1] * (fy - dy) + g[o + 2] * (fz - dz);
            sum += d * (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
        }
        return sum * 1.6;
    }

    /** Perlin over `octaves` octaves from `period`, 0..1 about. */
    function perlinFbm(u: number, v: number, w: number, period: number, octaves: number, seed: number): number {
        let sum = 0, amp = 1, total = 0;
        for (let o = 0; o < octaves; o++) {
            sum += perlin(u, v, w, period << o, seed + o) * amp;
            total += amp;
            amp *= 0.5;
        }
        return sum / total * 0.5 + 0.5;
    }

    return generate();
}

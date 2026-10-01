// A terrain (NodeDoc.terrain): a heightmap stretched over `size` meters
// around the object, `height` meters high above it, drawn in chunks that
// get coarser with distance. What the engine, Play (physics, navigation),
// grass, scatter and the tools share: where a point is on the map, the
// height and slope there, rays against it, and the chunk geometry. A
// terrain takes only its object's position: it does not turn or scale.

import { heightAt, type Heightmap } from './heightmap';
import type { TerrainLayerDoc } from './model';

/** Where a terrain lies in the world: its middle, its extent and its height scale, meters. */
export interface TerrainFrame {
    x: number;
    y: number;
    z: number;
    sizeX: number;
    sizeZ: number;
    height: number;
}

/** A terrain's heights in its frame; the map may be missing while it loads (flat until then). */
export interface TerrainSurface {
    frame: TerrainFrame;
    map: Heightmap | null;
}

/** World x, z to samples of the map (x along a row, z down the rows). */
export function toSamples(s: TerrainSurface, x: number, z: number): [number, number] {
    const f = s.frame;
    const w = s.map?.width ?? 2;
    const h = s.map?.height ?? 2;
    return [((x - f.x) / f.sizeX + 0.5) * (w - 1), ((z - f.z) / f.sizeZ + 0.5) * (h - 1)];
}

/** Samples to world x, z. */
export function fromSamples(s: TerrainSurface, sx: number, sz: number): [number, number] {
    const f = s.frame;
    const w = s.map?.width ?? 2;
    const h = s.map?.height ?? 2;
    return [f.x + (sx / (w - 1) - 0.5) * f.sizeX, f.z + (sz / (h - 1) - 0.5) * f.sizeZ];
}

/** True when world x, z is over the terrain. */
export function covers(s: TerrainSurface, x: number, z: number): boolean {
    const f = s.frame;
    return Math.abs(x - f.x) <= f.sizeX / 2 && Math.abs(z - f.z) <= f.sizeZ / 2;
}

/** The ground's world height at world x, z (clamped to the edge outside it). */
export function groundHeight(s: TerrainSurface, x: number, z: number): number {
    if (!s.map) return s.frame.y;
    const [sx, sz] = toSamples(s, x, z);
    return s.frame.y + heightAt(s.map, sx, sz) * s.frame.height;
}

/** The ground's normal at world x, z (unit, pointing up). */
export function groundNormal(s: TerrainSurface, x: number, z: number): [number, number, number] {
    if (!s.map) return [0, 1, 0];
    const f = s.frame;
    const dx = f.sizeX / (s.map.width - 1);
    const dz = f.sizeZ / (s.map.height - 1);
    const hx = groundHeight(s, x + dx, z) - groundHeight(s, x - dx, z);
    const hz = groundHeight(s, x, z + dz) - groundHeight(s, x, z - dz);
    const nx = -hx / (2 * dx);
    const nz = -hz / (2 * dz);
    const len = Math.hypot(nx, 1, nz);
    return [nx / len, 1 / len, nz / len];
}

/** The slope at world x, z in degrees (0 flat, 90 a wall). */
export function groundSlope(s: TerrainSurface, x: number, z: number): number {
    return (Math.acos(Math.min(1, groundNormal(s, x, z)[1])) * 180) / Math.PI;
}

/**
 * Where a ray first meets the terrain from above: the distance along the
 * (unit) direction, or null. It marches at a sample's width and then
 * halves the last step, so thin ridges are found too.
 */
export function rayTerrain(s: TerrainSurface, origin: ArrayLike<number>, dir: ArrayLike<number>, maxDistance = 1e4): number | null {
    const f = s.frame;
    // Clip the ray to the terrain's box.
    let t0 = 0;
    let t1 = maxDistance;
    const lo = [f.x - f.sizeX / 2, f.y - 1e-3, f.z - f.sizeZ / 2];
    const hi = [f.x + f.sizeX / 2, f.y + f.height + 1e-3, f.z + f.sizeZ / 2];
    for (let k = 0; k < 3; k++) {
        if (Math.abs(dir[k]) < 1e-9) {
            if (origin[k] < lo[k] || origin[k] > hi[k]) return null;
            continue;
        }
        let a = (lo[k] - origin[k]) / dir[k];
        let b = (hi[k] - origin[k]) / dir[k];
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) return null;
    }
    const w = s.map?.width ?? 2;
    const step = Math.max(0.05, Math.min(f.sizeX, f.sizeZ) / (w - 1));
    const above = (t: number) => origin[1] + dir[1] * t - groundHeight(s, origin[0] + dir[0] * t, origin[2] + dir[2] * t);
    let prev = t0;
    if (above(prev) < 0) return prev;
    for (let t = t0 + step; t <= t1 + step; t += step) {
        const tt = Math.min(t, t1);
        if (above(tt) < 0) {
            let a = prev;
            let b = tt;
            for (let i = 0; i < 16; i++) {
                const m = (a + b) / 2;
                if (above(m) < 0) b = m;
                else a = m;
            }
            return b;
        }
        prev = tt;
        if (tt >= t1) break;
    }
    return null;
}

/** Quads along a chunk's side at full detail: about eight chunks a side, 32 to 128 quads each. */
export function chunkQuads(map: Heightmap): number {
    const quads = map.width - 1;
    const want = 2 ** Math.round(Math.log2(Math.max(1, quads / 8)));
    return Math.min(128, Math.max(32, want));
}

/** How many chunks the map has along x and z. */
export function chunkCounts(map: Heightmap): [number, number] {
    const q = chunkQuads(map);
    return [Math.max(1, Math.ceil((map.width - 1) / q)), Math.max(1, Math.ceil((map.height - 1) / q))];
}

/** Levels of detail of a chunk: every sample, then every 2nd, 4th and 8th. */
export const TERRAIN_LODS = 4;

export interface ChunkMesh {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
    /** Index ranges of the levels of detail (0 the finest), all over the same vertices. */
    lods: { start: number; count: number }[];
}

/** A chunk's samples: where it starts, how many along x and z, and its rim (grid indices around it). */
interface ChunkGrid {
    x0: number;
    z0: number;
    nx: number;
    nz: number;
    rim: number[];
}

function chunkGrid(map: Heightmap, cx: number, cz: number): ChunkGrid {
    const q = chunkQuads(map);
    const x0 = cx * q;
    const z0 = cz * q;
    const nx = Math.min(map.width - 1, x0 + q) - x0 + 1;
    const nz = Math.min(map.height - 1, z0 + q) - z0 + 1;
    const rim: number[] = [];
    for (let i = 0; i < nx; i++) rim.push(i);
    for (let j = 1; j < nz; j++) rim.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) rim.push((nz - 1) * nx + i);
    for (let j = nz - 2; j > 0; j--) rim.push(j * nx);
    return { x0, z0, nx, nz, rim };
}

/**
 * Writes a chunk's vertices from the map: its samples, then its rim again
 * `skirt` meters lower (the skirt that hides gaps between neighbors at
 * other levels of detail). Normals come from the full map, so the light
 * matches across chunk edges at every level.
 */
function fillChunk(map: Heightmap, frame: Pick<TerrainFrame, 'sizeX' | 'sizeZ' | 'height'>, g: ChunkGrid, skirt: number, positions: Float32Array, normals: Float32Array, uvs?: Float32Array) {
    const w = map.width;
    const h = map.height;
    const d = map.data;
    const dx = frame.sizeX / (w - 1);
    const dz = frame.sizeZ / (h - 1);
    const at = (x: number, z: number) => d[Math.min(h - 1, Math.max(0, z)) * w + Math.min(w - 1, Math.max(0, x))];
    const put = (i: number, x: number, z: number, down: number) => {
        positions[i * 3] = (x / (w - 1) - 0.5) * frame.sizeX;
        positions[i * 3 + 1] = at(x, z) * frame.height - down;
        positions[i * 3 + 2] = (z / (h - 1) - 0.5) * frame.sizeZ;
        const gx = ((at(x + 1, z) - at(x - 1, z)) * frame.height) / (2 * dx);
        const gz = ((at(x, z + 1) - at(x, z - 1)) * frame.height) / (2 * dz);
        const len = Math.hypot(gx, 1, gz);
        normals[i * 3] = -gx / len;
        normals[i * 3 + 1] = 1 / len;
        normals[i * 3 + 2] = -gz / len;
        if (uvs) {
            uvs[i * 2] = x / (w - 1);
            uvs[i * 2 + 1] = z / (h - 1);
        }
    };
    for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) put(j * g.nx + i, g.x0 + i, g.z0 + j, 0);
    const base = g.nx * g.nz;
    g.rim.forEach((v, k) => put(base + k, g.x0 + (v % g.nx), g.z0 + Math.floor(v / g.nx), skirt));
}

/**
 * The mesh of chunk (cx, cz) in the terrain object's space: every sample
 * of it and its skirt, with an index range for each level of detail (a
 * level draws every 2^level-th sample, and its own skirt).
 */
export function chunkMesh(map: Heightmap, frame: Pick<TerrainFrame, 'sizeX' | 'sizeZ' | 'height'>, cx: number, cz: number, skirt: number): ChunkMesh {
    const g = chunkGrid(map, cx, cz);
    const { nx, nz, rim } = g;
    const count = nx * nz + rim.length;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    fillChunk(map, frame, g, skirt, positions, normals, uvs);
    const lowered = new Map(rim.map((v, k) => [v, nx * nz + k]));
    const list: number[] = [];
    const lods: { start: number; count: number }[] = [];
    const steps = (n: number, s: number) => {
        const out: number[] = [];
        for (let i = 0; i < n - 1; i += s) out.push(i);
        out.push(n - 1);
        return out;
    };
    for (let lod = 0; lod < TERRAIN_LODS; lod++) {
        const s = 2 ** lod;
        const xs = steps(nx, s);
        const zs = steps(nz, s);
        const start = list.length;
        for (let j = 0; j + 1 < zs.length; j++) {
            for (let i = 0; i + 1 < xs.length; i++) {
                const a = zs[j] * nx + xs[i];
                const b = zs[j] * nx + xs[i + 1];
                const c = zs[j + 1] * nx + xs[i];
                const e = zs[j + 1] * nx + xs[i + 1];
                // Counter-clockwise from above.
                list.push(a, c, b, b, c, e);
            }
        }
        // The rim at this level: along the -z edge toward +x, then +z, -x and -z.
        const ring: number[] = [];
        for (const x of xs) ring.push(x);
        for (const z of zs.slice(1)) ring.push(z * nx + nx - 1);
        for (const x of xs.slice(0, -1).reverse()) ring.push((nz - 1) * nx + x);
        for (const z of zs.slice(1, -1).reverse()) ring.push(z * nx);
        for (let k = 0; k < ring.length; k++) {
            const a = ring[k];
            const b = ring[(k + 1) % ring.length];
            const a2 = lowered.get(a)!;
            const b2 = lowered.get(b)!;
            // Facing out of the chunk.
            list.push(a, b, a2, b, b2, a2);
        }
        lods.push({ start, count: list.length - start });
    }
    const indices = count > 65535 ? new Uint32Array(list) : new Uint16Array(list);
    return { positions, normals, uvs, indices, lods };
}

/** Writes a chunk's positions and normals again from the map (after sculpting), in place. */
export function refillChunk(map: Heightmap, frame: Pick<TerrainFrame, 'sizeX' | 'sizeZ' | 'height'>, cx: number, cz: number, skirt: number, positions: Float32Array, normals: Float32Array) {
    fillChunk(map, frame, chunkGrid(map, cx, cz), skirt, positions, normals);
}

/** A chunk's samples as a region of the map (x0, z0 inclusive, x1, z1 exclusive). */
export function chunkRegion(map: Heightmap, cx: number, cz: number): { x0: number; z0: number; x1: number; z1: number } {
    const g = chunkGrid(map, cx, cz);
    return { x0: g.x0, z0: g.z0, x1: g.x0 + g.nx, z1: g.z0 + g.nz };
}

/**
 * The whole terrain as one triangle list in world space, every `step`
 * samples (for physics and the navigation mesh, which need no detail
 * finer than a character).
 */
export function terrainTriangles(s: TerrainSurface, step = 1): { positions: Float32Array; indices: Uint32Array } {
    const map = s.map ?? { width: 2, height: 2, data: new Float32Array(4) };
    const f = s.frame;
    const xs: number[] = [];
    const zs: number[] = [];
    for (let x = 0; x < map.width - 1; x += step) xs.push(x);
    xs.push(map.width - 1);
    for (let z = 0; z < map.height - 1; z += step) zs.push(z);
    zs.push(map.height - 1);
    const positions = new Float32Array(xs.length * zs.length * 3);
    let p = 0;
    for (const z of zs) {
        for (const x of xs) {
            positions[p++] = f.x + (x / (map.width - 1) - 0.5) * f.sizeX;
            positions[p++] = f.y + map.data[z * map.width + x] * f.height;
            positions[p++] = f.z + (z / (map.height - 1) - 0.5) * f.sizeZ;
        }
    }
    const indices = new Uint32Array((xs.length - 1) * (zs.length - 1) * 6);
    let n = 0;
    for (let j = 0; j + 1 < zs.length; j++) {
        for (let i = 0; i + 1 < xs.length; i++) {
            const a = j * xs.length + i;
            const c = a + xs.length;
            indices[n++] = a;
            indices[n++] = c;
            indices[n++] = a + 1;
            indices[n++] = a + 1;
            indices[n++] = c;
            indices[n++] = c + 1;
        }
    }
    return { positions, indices };
}

/** A smooth step from 0 at the edge's low side to 1 past its high side, as WGSL's smoothstep. */
function smooth(lo: number, hi: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
}

/** 1 within [lo, hi], fading over `soft` across each limit (the terrain material's band). */
function band(x: number, lo: number, hi: number, soft: number): number {
    const s = Math.max(soft, 0.0001) * 0.5;
    return smooth(lo - s, lo + s, x) * (1 - smooth(hi - s, hi + s, x));
}

/**
 * How much each layer of a terrain shows at a point of height `y` and
 * `slope` degrees, as the terrain material places them (each later layer
 * over those before it by its rules, then the paint, a channel a layer,
 * 0 to 1), without the noise that roughens their edges in the view.
 */
export function layerWeights(
    layers: readonly Pick<TerrainLayerDoc, 'height' | 'slope' | 'heightBlend' | 'slopeBlend' | 'onlyPainted'>[],
    y: number,
    slope: number,
    paint?: readonly number[] | null,
): number[] {
    const w: number[] = layers.map((_, i) => (i === 0 ? 1 : 0));
    for (let i = 1; i < layers.length; i++) {
        const l = layers[i];
        const a = l.onlyPainted ? 0 : band(y, l.height[0], l.height[1], l.heightBlend) * band(slope, l.slope[0], l.slope[1], l.slopeBlend);
        for (let j = 0; j < i; j++) w[j] *= 1 - a;
        w[i] = a;
    }
    if (paint) {
        const painted = Math.min(1, paint.slice(0, w.length).reduce((s, v) => s + v, 0));
        for (let i = 0; i < w.length; i++) w[i] = w[i] * (1 - painted) + (paint[i] ?? 0);
    }
    const total = w.reduce((s, v) => s + v, 0);
    return total > 0 ? w.map((v) => v / total) : w;
}

/** The paint (RGBA bytes, a channel a layer) of a terrain at world x, z, 0 to 1 each, or null outside it. */
export function paintAt(frame: TerrainFrame, paint: { width: number; height: number; data: Uint8Array }, x: number, z: number): number[] | null {
    const u = (x - (frame.x - frame.sizeX / 2)) / frame.sizeX;
    const v = (z - (frame.z - frame.sizeZ / 2)) / frame.sizeZ;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const i = Math.min(paint.width - 1, Math.floor(u * paint.width));
    const j = Math.min(paint.height - 1, Math.floor(v * paint.height));
    const o = (j * paint.width + i) * 4;
    return [paint.data[o] / 255, paint.data[o + 1] / 255, paint.data[o + 2] / 255, paint.data[o + 3] / 255];
}

// Grass fields (packages/geometry): the blades of a Grass component drawn
// by one renderer at the scene root. Each blade is a transform of its own
// in the engine's matrix table, placed here where a vertical line through
// it meets the ground object, so a field follows any terrain.

import { Engine3D, Object3D, RendererMask, Uint8ArrayTexture, Vector2, Vector3, VertexAttributeName, type RenderNode, type Texture } from '@orillusion/core';
import { GrassComponent } from '@orillusion/geometry/grass';
import { covers, groundHeight, groundNormal, type TerrainSurface } from '../core/terrain';
import type { GrassDoc } from '../core/types';
import { hexToColor } from './color';
import { ownIndices } from './lod';

/** Blades on slopes steeper than this (the up component of the ground's normal) are left out: 60 degrees. */
const MAX_SLOPE = 0.5;
/** The engine's blade rises in five segments of 0.2, 0.4 ... 1.0 times its height setting: three times it in all. */
const SEGMENT_SUM = 3;

/** One field: its renderer and the blades' transforms. */
export class GrassField {
    readonly root: Object3D;
    readonly renderer: GrassComponent;

    constructor(scene: Object3D, doc: GrassDoc) {
        this.root = new Object3D();
        this.root.name = 'Grass';
        this.renderer = this.root.addComponent(GrassComponent);
        // Blades are shaped in the vertex stage: the depth prepass would draw them flat.
        this.renderer.addRendererMask(RendererMask.IgnoreDepthPass);
        this.renderer.castGI = false;
        this.renderer.setGrass(doc.width, doc.height, 5, 1, doc.count);
        scene.addChild(this.root);
    }

    /** Colors, wind, height and shadows (the blades stay where they are). */
    apply(doc: GrassDoc) {
        const m = this.renderer.grassMaterial;
        m.grassBaseColor = hexToColor(doc.bottomColor);
        m.grassTopColor = hexToColor(doc.topColor);
        // The shader takes where the wind comes from; gusts move 100 texels (meters) a second at speed 1.
        const a = (doc.windDirection * Math.PI) / 180;
        m.windDirection = new Vector2(-Math.sin(a), -Math.cos(a));
        m.windPower = doc.wind;
        m.windSpeed = doc.windSpeed / 100;
        m.grassHeight = doc.height / SEGMENT_SUM;
        m.castShadow = doc.castShadow;
        m.drawDistance = doc.distance;
        this.renderer.castShadow = doc.castShadow;
    }

    setTextures(blade: Texture, gusts: Texture) {
        const m = this.renderer.grassMaterial;
        if (m.baseMap !== blade) m.baseMap = blade;
        if (m.shader.getTexture('windMap') !== gusts) m.windMap = gusts;
    }

    /**
     * Scatters the blades over the area around the object (`frame`, see
     * fieldFrame), each standing on `ground` below it, or flat at the
     * object's height without one. `seed` keeps the layout the same.
     */
    place(doc: GrassDoc, frame: FieldFrame, ground: Ground | null, seed: number) {
        const nodes = this.renderer.nodes;
        const random = mulberry32(seed);
        const pos = new Vector3(), rot = new Vector3(), scale = new Vector3();
        const [w, d] = doc.size;
        const { origin: o, x: ax, z: az } = frame;
        for (const node of nodes) {
            // Drawn in the same order every time, so a blade keeps its place and size.
            const u = (random() - 0.5) * w, v = (random() - 0.5) * d;
            const yaw = random() * 360, wide = 0.7 + random() * 0.6, tall = 0.7 + random() * 0.6;
            const x = o[0] + ax[0] * u + az[0] * v;
            const z = o[2] + ax[2] * u + az[2] * v;
            const y = ground ? ground.height(x, z) : o[1] + ax[1] * u + az[1] * v;
            if (y === null) {
                // No ground here: a blade of no size draws nothing.
                scale.set(0, 0, 0);
            } else {
                pos.set(x, y, z);
                rot.set(0, yaw, 0);
                scale.set(wide, tall, wide);
                node.localPosition = pos;
                node.localRotation = rot;
            }
            node.localScale = scale;
            node.updateWorldMatrix(true);
        }
    }

    setVisible(visible: boolean) {
        this.renderer.enable = visible;
    }

    /** Takes it out of the scene; `dispose` frees it once the GPU is done with it. */
    remove(dispose: (res: { destroy(force?: boolean): void }) => void) {
        this.root.removeFromParent();
        dispose(this.root);
    }
}

/** Where a field lies: the object's position and its turned x and z axes, without its scale (sizes are meters). */
export interface FieldFrame {
    origin: [number, number, number];
    x: [number, number, number];
    z: [number, number, number];
}

export function fieldFrame(m: ArrayLike<number>): FieldFrame {
    const unit = (a: number, b: number, c: number): [number, number, number] => {
        const l = Math.hypot(a, b, c) || 1;
        return [a / l, b / l, c / l];
    };
    return { origin: [m[12], m[13], m[14]], x: unit(m[0], m[1], m[2]), z: unit(m[8], m[9], m[10]) };
}

/** The world x-z box of a field's area, where its ground is looked at. */
export function fieldArea(frame: FieldFrame, size: [number, number]): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const [w, d] = size;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [u, v] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
        const x = frame.origin[0] + frame.x[0] * u + frame.z[0] * v, z = frame.origin[2] + frame.x[2] * u + frame.z[2] * v;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
    }
    return { minX, maxX, minZ, maxZ };
}

/** What things stand on: the height of the ground at (x, z), or null where there is none or it is too steep. */
export interface Ground {
    height(x: number, z: number): number | null;
}

/** The ground at a point, however steep: its height and normal (unit, up). */
export interface GroundPoint {
    y: number;
    normal: [number, number, number];
}

/**
 * Ground made of meshes (a GroundGrid) and terrains: the highest of them
 * at each point. Terrains answer from their heightmaps, whatever level of
 * detail their chunks draw.
 */
export class LayeredGround implements Ground {
    constructor(private meshes: GroundGrid | null, private lands: TerrainSurface[], private maxSlope = MAX_SLOPE) {}

    height(x: number, z: number): number | null {
        let best: number | null = this.meshes?.height(x, z) ?? null;
        for (const s of this.lands) {
            if (!covers(s, x, z)) continue;
            if (groundNormal(s, x, z)[1] < this.maxSlope) continue;
            const y = groundHeight(s, x, z);
            if (best === null || y > best) best = y;
        }
        return best;
    }

    /** The highest ground at (x, z) with its normal, however steep; null where there is none. */
    sample(x: number, z: number): GroundPoint | null {
        let best = this.meshes?.sample(x, z) ?? null;
        for (const s of this.lands) {
            if (!covers(s, x, z)) continue;
            const y = groundHeight(s, x, z);
            if (!best || y > best.y) best = { y, normal: groundNormal(s, x, z) };
        }
        return best;
    }
}

/**
 * The ground under a field: the triangles of its renderers in world space,
 * binned on a grid over the field's area, so each blade tests a few.
 */
export class GroundGrid implements Ground {
    private tris: number[] = [];
    /** Per triangle: the up component of its normal. */
    private ups: number[] = [];
    /** Per triangle: its normal, turned up. */
    private normals: number[] = [];
    /** The height of the triangle top() found last. */
    private hitY = 0;
    private cells: number[][];
    private readonly n = 64;
    private readonly minX: number;
    private readonly minZ: number;
    private readonly sx: number;
    private readonly sz: number;

    constructor(renderers: RenderNode[], area: { minX: number; maxX: number; minZ: number; maxZ: number }) {
        this.minX = area.minX;
        this.minZ = area.minZ;
        this.sx = this.n / Math.max(1e-6, area.maxX - area.minX);
        this.sz = this.n / Math.max(1e-6, area.maxZ - area.minZ);
        this.cells = Array.from({ length: this.n * this.n }, () => []);
        for (const r of renderers) this.add(r, area);
    }

    private add(r: RenderNode, area: { minX: number; maxX: number; minZ: number; maxZ: number }) {
        const geo = r.geometry;
        const pos = geo?.getAttribute(VertexAttributeName.position)?.data as ArrayLike<number> | undefined;
        if (!pos || !r.object3D) return;
        const idx = ownIndices(geo);
        const m = r.object3D.transform.worldMatrix.rawData;
        const count = Math.floor(pos.length / 3);
        const world = new Float64Array(count * 3);
        for (let i = 0; i < count; i++) {
            const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
            world[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            world[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            world[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const triangles = idx && idx.length >= 3 ? Math.floor(idx.length / 3) : Math.floor(count / 3);
        for (let t = 0; t < triangles; t++) {
            const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
            if (a >= count || b >= count || c >= count) continue;
            const ax = world[a * 3], ay = world[a * 3 + 1], az = world[a * 3 + 2];
            const bx = world[b * 3], by = world[b * 3 + 1], bz = world[b * 3 + 2];
            const cx = world[c * 3], cy = world[c * 3 + 1], cz = world[c * 3 + 2];
            const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx), z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
            if (x1 < area.minX || x0 > area.maxX || z1 < area.minZ || z0 > area.maxZ) continue;
            // Walls seen from above have no area to stand on.
            const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const len = Math.hypot(nx, ny, nz);
            if (!(len > 1e-12) || Math.abs(ny) < 1e-9 * len) continue;
            const id = this.ups.length;
            this.tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
            this.ups.push(Math.abs(ny) / len);
            const up = ny < 0 ? -1 / len : 1 / len;
            this.normals.push(nx * up, ny * up, nz * up);
            const i0 = this.cell(x0, this.minX, this.sx), i1 = this.cell(x1, this.minX, this.sx);
            const j0 = this.cell(z0, this.minZ, this.sz), j1 = this.cell(z1, this.minZ, this.sz);
            for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this.cells[j * this.n + i].push(id);
        }
    }

    private cell(v: number, min: number, s: number): number {
        return Math.min(this.n - 1, Math.max(0, Math.floor((v - min) * s)));
    }

    /** Height of the highest ground at (x, z), or null where there is none or it is too steep. */
    height(x: number, z: number): number | null {
        const id = this.top(x, z);
        return id >= 0 && this.ups[id] >= MAX_SLOPE ? this.hitY : null;
    }

    /** The highest ground at (x, z) with its normal, however steep; null where there is none. */
    sample(x: number, z: number): GroundPoint | null {
        const id = this.top(x, z);
        return id < 0 ? null : { y: this.hitY, normal: [this.normals[id * 3], this.normals[id * 3 + 1], this.normals[id * 3 + 2]] };
    }

    /** The highest triangle over (x, z), its height in hitY; -1 where there is none. */
    private top(x: number, z: number): number {
        const list = this.cells[this.cell(z, this.minZ, this.sz) * this.n + this.cell(x, this.minX, this.sx)];
        let best = -Infinity, found = -1;
        const t = this.tris;
        for (const id of list) {
            const o = id * 9;
            const x0 = t[o], z0 = t[o + 2], x1 = t[o + 3], z1 = t[o + 5], x2 = t[o + 6], z2 = t[o + 8];
            const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
            const w0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det;
            const w1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det;
            const w2 = 1 - w0 - w1;
            if (!(w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6)) continue;
            const y = w0 * t[o + 1] + w1 * t[o + 4] + w2 * t[o + 7];
            if (y > best) {
                best = y;
                found = id;
            }
        }
        this.hitY = best;
        return found;
    }
}

/** A small seeded random generator (mulberry32): the same field every time. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A 32-bit hash of a string (an object id): the seed of its field. */
export function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
}

/**
 * Built-in gusts: a tiling noise in red and green (one pixel is a meter
 * of the field), soft patches of 8 to 32 meters.
 */
export function gustTexture(ctx: any): Texture {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    const channel = (seed: number) => {
        const random = mulberry32(seed);
        const out = new Float32Array(size * size);
        let total = 0;
        for (const [cell, weight] of [[32, 0.55], [16, 0.3], [8, 0.15]] as const) {
            const n = size / cell;
            const lattice = Array.from({ length: n * n }, () => random());
            const at = (i: number, j: number) => lattice[((j + n) % n) * n + ((i + n) % n)];
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const fx = x / cell, fy = y / cell;
                    const i = Math.floor(fx), j = Math.floor(fy);
                    const sx = smooth(fx - i), sy = smooth(fy - j);
                    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
                    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
                    out[y * size + x] += (top + (bottom - top) * sy) * weight;
                }
            }
            total += weight;
        }
        return out.map((v) => v / total);
    };
    const r = channel(7), g = channel(13);
    for (let i = 0; i < size * size; i++) {
        data[i * 4] = Math.round(r[i] * 255);
        data[i * 4 + 1] = Math.round(g[i] * 255);
        data[i * 4 + 3] = 255;
    }
    const tex = new Uint8ArrayTexture().create(size, size, data, false, ctx);
    tex.name = 'grass-gusts';
    return tex;
}

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/** The white texture: plain blades. */
export function plainBlades(ctx: any): Texture {
    return Engine3D.resFor(ctx).whiteTexture;
}

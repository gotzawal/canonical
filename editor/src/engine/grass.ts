// Grass fields (packages/geometry): the blades of a Grass component drawn
// in chunks at the scene root, each chunk one renderer. Each blade is a transform of its own
// in the engine's matrix table, placed here where a vertical line through
// it meets the ground object, so a field follows any terrain.

import { Engine3D, Object3D, RendererMask, Uint8ArrayTexture, Vector2, Vector3, VertexAttributeName, type RenderNode, type Texture } from '@orillusion/core';
import { GrassComponent } from '@orillusion/geometry/grass';
import { covers, groundHeight, groundNormal, type TerrainSurface } from '../core/terrain';
import type { GrassDoc } from '../core/types';
import { bladeBend, bladeProfile, GRASS_SHAPES, patchNoise, shapeAt, sizeAt, type GrassShape } from '../core/grass';
import { hexToColor } from './color';
import { ownIndices } from './lod';

/** Blades on slopes steeper than this (the up component of the ground's normal) are left out: 60 degrees. */
const MAX_SLOPE = 0.5;
/** The engine's blade rises in five segments of 0.2, 0.4 ... 1.0 times its height setting: three times it in all. */
const SEGMENT_SUM = 3;

/** Blades a chunk aims at, and the most chunks a side. */
const PER_CHUNK = 1500;
const MAX_CHUNKS = 6;
/** Meters from the camera where chunks switch to blades of two segments, then one (times the tier's LOD distance). */
const LOD_NEAR = 14;
const LOD_FAR = 35;

/** A part of a field: its renderer (one draw), its blades and the box they fill. */
interface GrassChunk {
    renderer: GrassComponent;
    /** Its cell of the field: column, row. */
    ci: number;
    cj: number;
    min: Vector3;
    max: Vector3;
    /** Whether it has blades standing (a box to cull by). */
    placed: boolean;
}

/**
 * One field: chunks of blades over its area, each its own renderer (one
 * draw) with the box its blades fill, so chunks out of view are not drawn,
 * those past the draw distance are switched off and far ones draw their
 * blades with fewer segments (levels of detail). Blades vary in size and
 * shape by the field's spreads.
 */
export class GrassField {
    readonly root: Object3D;
    private chunks: GrassChunk[] = [];
    private side: number;
    private visible = true;
    private distance = 0;
    private lodScale = 1;
    /** The shapes the blades were last given (to reshape only when they change). */
    private shaped = '';

    constructor(scene: Object3D, doc: GrassDoc) {
        this.root = new Object3D();
        this.root.name = 'Grass';
        this.side = Math.max(1, Math.min(MAX_CHUNKS, Math.round(Math.sqrt(doc.count / PER_CHUNK))));
        const n = this.side * this.side;
        for (let k = 0; k < n; k++) {
            const count = Math.floor(doc.count / n) + (k < doc.count % n ? 1 : 0);
            if (count <= 0) continue;
            const obj = new Object3D();
            obj.name = 'Grass chunk';
            this.root.addChild(obj);
            const renderer = obj.addComponent(GrassComponent);
            // Blades are shaped in the vertex stage: the depth prepass would draw them flat.
            renderer.addRendererMask(RendererMask.IgnoreDepthPass);
            renderer.castGI = false;
            renderer.setGrass(doc.width, doc.height, 5, 1, count);
            this.chunks.push({ renderer, ci: k % this.side, cj: Math.floor(k / this.side), min: new Vector3(), max: new Vector3(), placed: false });
        }
        scene.addChild(this.root);
    }

    /** The chunks' renderers. */
    get renderers(): GrassComponent[] {
        return this.chunks.map((c) => c.renderer);
    }

    /** Colors, wind, height, shadows and draw distance (the blades stay where they are). */
    apply(doc: GrassDoc) {
        const a = (doc.windDirection * Math.PI) / 180;
        for (const { renderer } of this.chunks) {
            const m = renderer.grassMaterial;
            m.grassBaseColor = hexToColor(doc.bottomColor);
            m.grassTopColor = hexToColor(doc.topColor);
            // The shader takes where the wind comes from; gusts move 100 texels (meters) a second at speed 1.
            m.windDirection = new Vector2(-Math.sin(a), -Math.cos(a));
            m.windPower = doc.wind;
            m.windSpeed = doc.windSpeed / 100;
            m.grassHeight = doc.height / SEGMENT_SUM;
            m.castShadow = doc.castShadow;
            m.drawDistance = doc.distance;
            renderer.castShadow = doc.castShadow;
        }
        this.distance = doc.distance;
    }

    /** Whether its textures are set yet. */
    get hasTextures(): boolean {
        return !!this.chunks[0]?.renderer.grassMaterial.baseMap;
    }

    setTextures(blade: Texture, gusts: Texture) {
        for (const { renderer } of this.chunks) {
            const m = renderer.grassMaterial;
            if (m.baseMap !== blade) m.baseMap = blade;
            if (m.shader.getTexture('windMap') !== gusts) m.windMap = gusts;
        }
    }

    setShadowCacheMode(mode: 'auto' | 'static' | 'dynamic') {
        for (const { renderer } of this.chunks) renderer.shadowCacheMode = mode;
    }

    /** Scales the distances where chunks switch to simpler blades (the graphics tier's). */
    setLodScale(scale: number) {
        this.lodScale = Math.max(0.1, scale);
    }

    /**
     * Scatters the blades over the area around the object (`frame`, see
     * fieldFrame), each chunk's over its cell of it, each blade standing on
     * `ground` below it, or flat at the object's height without one. Sizes
     * and shapes follow the field's spreads. `seed` keeps the layout the
     * same.
     */
    place(doc: GrassDoc, frame: FieldFrame, ground: Ground | null, seed: number) {
        const random = mulberry32(seed);
        // Sizes and shapes draw from their own stream: a field without them keeps its blades.
        const more = mulberry32(seed ^ 0x5bd1e995);
        const noiseSeed = seed ^ 0x2f6b;
        const pos = new Vector3(), rot = new Vector3(), scale = new Vector3();
        const [w, d] = doc.size;
        const cw = w / this.side, cd = d / this.side;
        const { origin: o, x: ax, z: az } = frame;
        const shapes: GrassShape[][] = [];
        for (const chunk of this.chunks) {
            const nodes = chunk.renderer.nodes;
            const own: GrassShape[] = [];
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (const node of nodes) {
                // Drawn in the same order every time, so a blade keeps its place and size.
                const u = -w / 2 + (chunk.ci + random()) * cw, v = -d / 2 + (chunk.cj + random()) * cd;
                const yaw = random() * 360, rw = random(), rh = random();
                const extra: [number, number] = [more(), more()];
                const rs = more();
                const x = o[0] + ax[0] * u + az[0] * v;
                const z = o[2] + ax[2] * u + az[2] * v;
                const patch = doc.sizes === 'patches' || doc.shapeSpread === 'patches' ? patchNoise(x, z, doc.patchSize, noiseSeed) : 0.5;
                const tall = lerp(doc.heights, sizeAt(doc.sizes, rh, extra, patch));
                // A blade's width follows its height in patches (tall and broad together), else its own number.
                const wide = lerp(doc.widths, sizeAt(doc.sizes, doc.sizes === 'patches' ? rh : rw, [extra[1], extra[0]], patch));
                own.push(shapeAt(doc.shapes, doc.shapeSpread, rs, patchNoise(x, z, doc.patchSize, noiseSeed ^ 0x77)));
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
                    const top = y + doc.height * tall * 1.1;
                    min[0] = Math.min(min[0], x - 0.5);
                    max[0] = Math.max(max[0], x + 0.5);
                    min[1] = Math.min(min[1], y);
                    max[1] = Math.max(max[1], top);
                    min[2] = Math.min(min[2], z - 0.5);
                    max[2] = Math.max(max[2], z + 0.5);
                }
                node.localScale = scale;
                node.updateWorldMatrix(true);
            }
            shapes.push(own);
            chunk.placed = min[0] <= max[0];
            if (chunk.placed) {
                chunk.min.set(min[0], min[1], min[2]);
                chunk.max.set(max[0], max[1], max[2]);
                // Culled by the box its blades fill (the blades bend a little past it in the wind).
                chunk.renderer.setMinMax(new Vector3(min[0] - 0.5, min[1] - 0.5, min[2] - 0.5), new Vector3(max[0] + 0.5, max[1] + 0.5, max[2] + 0.5));
                chunk.renderer.alwaysRender = false;
            }
        }
        // Their shapes: the geometry is written again only when they changed.
        const key = JSON.stringify([doc.shapes, doc.shapeSpread, doc.curvature, doc.patchSize, seed]);
        if (key !== this.shaped) {
            this.shaped = key;
            const profiles = Object.fromEntries(GRASS_SHAPES.map((k) => [k, bladeProfile(k, 5)])) as Record<GrassShape, number[]>;
            const bend = mulberry32(seed ^ 0x1b873593);
            this.chunks.forEach((chunk, i) => {
                chunk.renderer.grassGeometry.reshape((b) => {
                    const shape = shapes[i][b] ?? 'blade';
                    return { profile: profiles[shape], curvature: bladeBend(shape, lerp(doc.curvature, bend())) };
                });
            });
        }
        this.updateVisible();
    }

    setVisible(visible: boolean) {
        this.visible = visible;
        this.updateVisible();
    }

    private updateVisible() {
        for (const c of this.chunks) c.renderer.enable = this.visible && c.placed;
    }

    /**
     * Fits the chunks to a camera at `eye` (world): those past the draw
     * distance are switched off, the others draw the level of detail their
     * distance calls for (with a margin, so one at a limit does not flicker).
     */
    update(eye: ArrayLike<number>) {
        if (!this.visible) return;
        for (const c of this.chunks) {
            if (!c.placed) continue;
            const dx = Math.max(c.min.x - eye[0], 0, eye[0] - c.max.x);
            const dy = Math.max(c.min.y - eye[1], 0, eye[1] - c.max.y);
            const dz = Math.max(c.min.z - eye[2], 0, eye[2] - c.max.z);
            const d = Math.hypot(dx, dy, dz);
            const on = !(this.distance > 0) || d <= this.distance;
            if (c.renderer.enable !== on) c.renderer.enable = on;
            if (!on) continue;
            const cur = c.renderer.lodLevel;
            const near = LOD_NEAR * this.lodScale * (cur === 0 ? 1.05 : 0.95);
            const far = LOD_FAR * this.lodScale * (cur === 2 ? 0.95 : 1.05);
            const level = d > far ? 2 : d > near ? 1 : 0;
            if (level !== cur) c.renderer.lodLevel = level;
        }
    }

    /** Takes it out of the scene; `dispose` frees it once the GPU is done with it. */
    remove(dispose: (res: { destroy(force?: boolean): void }) => void) {
        this.root.removeFromParent();
        dispose(this.root);
    }
}

function lerp(range: readonly [number, number] | number[], t: number): number {
    return range[0] + (range[1] - range[0]) * t;
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

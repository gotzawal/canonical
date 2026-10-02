// Small stones on the ground around the camera (core/clutter.ts): cells
// of CELL meters within reach are made as the camera comes (a few a
// frame, nearest first) and let go when it leaves. A cell is one merged
// mesh and one draw, culled by its box; every cell shares one material
// whose colors come from a palette (a row a terrain layer, its mean color
// in a few shades), picked by the stones' UVs. Stones cast no shadow.

import { GeometryBase, LitMaterial, MeshRenderer, Object3D, Uint8ArrayTexture, VertexAttributeName, type Context3D } from '@orillusion/core';
import { clutterCell, type ClutterGround, type Stone } from '../core/clutter';
import { srgbToLinear } from './color';

const CELL = 6;
const SHAPES = 4;
const SHADES = 8;
const ROWS = 4;
/** Cells made at most in a frame. */
const BUILD_PER_FRAME = 3;

interface Shape {
    positions: number[];
    indices: number[];
}

/** Stone shapes: icosahedra pushed in and out at random, a unit across, resting on y = 0. */
function stoneShapes(): Shape[] {
    const t = (1 + Math.sqrt(5)) / 2;
    const base = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    const faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: SHAPES }, () => {
        const positions: number[] = [];
        for (const v of base) {
            const r = (0.75 + 0.4 * random()) / (2 * Math.hypot(v[0], v[1], v[2]));
            positions.push(v[0] * r, v[1] * r + 0.5, v[2] * r);
        }
        return { positions, indices: faces };
    });
}

export class GroundClutter {
    private root = new Object3D();
    private cells = new Map<string, { obj: Object3D; geometry: GeometryBase } | null>();
    private shapes = stoneShapes();
    private material: LitMaterial;
    private palette: Uint8ArrayTexture | null = null;
    private ground: ClutterGround | null = null;

    constructor(scene: Object3D, private ctx: Context3D) {
        this.root.name = 'Ground clutter';
        scene.addChild(this.root);
        this.material = new LitMaterial(ctx);
        this.material.roughness = 0.9;
        this.material.metallic = 0;
    }

    /**
     * What the stones lie on and their colors (each layer's mean color,
     * linear rgb), or none: the cells are made again from it.
     */
    setGround(ground: ClutterGround | null, colors: readonly (readonly number[])[]) {
        this.ground = ground;
        this.clear();
        const data = new Uint8Array(SHADES * ROWS * 4);
        const srgb = (v: number) => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
        for (let r = 0; r < ROWS; r++) {
            const c = colors[r] ?? [srgbToLinear(0.45), srgbToLinear(0.42), srgbToLinear(0.38)];
            for (let s = 0; s < SHADES; s++) {
                // Stones in a range of shades around the ground they lie on, more of them lighter.
                const k = 0.7 + (0.9 * s) / (SHADES - 1);
                const o = (r * SHADES + s) * 4;
                data[o] = srgb(c[0] * k);
                data[o + 1] = srgb(c[1] * k);
                data[o + 2] = srgb(c[2] * k);
                data[o + 3] = 255;
            }
        }
        const old = this.palette;
        this.palette = new Uint8ArrayTexture().createQueued(SHADES, ROWS, data, this.ctx);
        this.palette.minFilter = this.palette.magFilter = 'nearest';
        this.material.baseMap = this.palette;
        old?.destroy(true);
    }

    /** Makes the cells within `radius` of `eye` (a few a frame) and lets go of those past it; 0 for none. */
    update(eye: ArrayLike<number>, radius: number) {
        if (!this.ground || radius <= 0) {
            if (this.cells.size) this.clear();
            return;
        }
        const [ex, ez] = [eye[0], eye[2]];
        for (const [key, cell] of this.cells) {
            const [ci, cj] = key.split(',').map(Number);
            if (Math.hypot((ci + 0.5) * CELL - ex, (cj + 0.5) * CELL - ez) > radius + CELL * 1.5) {
                this.cells.delete(key);
                this.drop(cell);
            }
        }
        const missing: [number, number, number][] = [];
        const r = Math.ceil(radius / CELL);
        const c0 = Math.floor(ex / CELL), c1 = Math.floor(ez / CELL);
        for (let j = c1 - r; j <= c1 + r; j++) {
            for (let i = c0 - r; i <= c0 + r; i++) {
                const d = Math.hypot((i + 0.5) * CELL - ex, (j + 0.5) * CELL - ez);
                if (d <= radius + CELL && !this.cells.has(`${i},${j}`)) missing.push([d, i, j]);
            }
        }
        missing.sort((a, b) => a[0] - b[0]);
        for (const [, i, j] of missing.slice(0, BUILD_PER_FRAME)) this.cells.set(`${i},${j}`, this.build(i, j));
    }

    private build(ci: number, cj: number): { obj: Object3D; geometry: GeometryBase } | null {
        const stones = clutterCell(ci, cj, CELL, this.ground!, SHAPES);
        if (!stones.length) return null;
        const verts = this.shapes[0].positions.length / 3, tris = this.shapes[0].indices.length;
        const positions = new Float32Array(stones.length * verts * 3);
        const normals = new Float32Array(positions.length);
        const uvs = new Float32Array(stones.length * verts * 2);
        const indices = new Uint32Array(stones.length * tris);
        stones.forEach((s: Stone, n) => {
            const shape = this.shapes[s.shape];
            const cos = Math.cos(s.yaw), sin = Math.sin(s.yaw);
            const sy = s.flat;
            const u = (Math.min(SHADES - 1, Math.floor(s.shade * SHADES)) + 0.5) / SHADES, v = (Math.min(ROWS - 1, s.layer) + 0.5) / ROWS;
            for (let k = 0; k < verts; k++) {
                const px = shape.positions[k * 3], py = shape.positions[k * 3 + 1], pz = shape.positions[k * 3 + 2];
                const o = (n * verts + k) * 3;
                positions[o] = s.x + (px * cos - pz * sin) * s.size;
                positions[o + 1] = s.y + py * sy * s.size;
                positions[o + 2] = s.z + (px * sin + pz * cos) * s.size;
                // Normals of the flattened shape: away from its middle, squashed the other way.
                const nx = px, ny = (py - 0.5) / sy, nz = pz, l = Math.hypot(nx, ny, nz) || 1;
                normals[o] = (nx * cos - nz * sin) / l;
                normals[o + 1] = ny / l;
                normals[o + 2] = (nx * sin + nz * cos) / l;
                // Spread a little within the palette's texel: the shader builds its tangents from how UVs change.
                uvs[(n * verts + k) * 2] = u + (px * 0.6) / SHADES;
                uvs[(n * verts + k) * 2 + 1] = v + (pz * 0.6) / ROWS;
            }
            for (let k = 0; k < tris; k++) indices[n * tris + k] = shape.indices[k] + n * verts;
        });
        const geometry = new GeometryBase();
        geometry.setIndices(indices);
        geometry.setAttribute(VertexAttributeName.position, positions);
        geometry.setAttribute(VertexAttributeName.normal, normals);
        geometry.setAttribute(VertexAttributeName.uv, uvs);
        geometry.setAttribute(VertexAttributeName.TEXCOORD_1, uvs);
        geometry.addSubGeometry({ indexStart: 0, indexCount: indices.length, vertexStart: 0, vertexCount: 0, firstStart: 0, index: 0, topology: 0 });
        const obj = new Object3D();
        obj.name = 'Stones';
        const renderer = obj.addComponent(MeshRenderer);
        renderer.geometry = geometry;
        renderer.material = this.material;
        renderer.castShadow = false;
        renderer.receiveShadow = true;
        renderer.castGI = false;
        this.root.addChild(obj);
        return { obj, geometry };
    }

    private drop(cell: { obj: Object3D; geometry: GeometryBase } | null) {
        if (!cell) return;
        // Not destroyed: that would take the shared material with it.
        cell.obj.removeFromParent();
        cell.geometry.destroy();
    }

    private clear() {
        for (const cell of this.cells.values()) this.drop(cell);
        this.cells.clear();
    }

    dispose() {
        this.clear();
        this.root.removeFromParent();
        this.palette?.destroy(true);
    }
}

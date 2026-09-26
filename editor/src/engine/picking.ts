import { Object3D, RenderNode, VertexAttributeName } from '@orillusion/core';
import {
    Mat4, Ray, add, invert, mul, normalize, rayBox, rayTriangle, sub, transform4, transformDir, transformPoint,
} from '../core/math';
import type { Store } from '../core/store';
import type { Vec3 } from '../core/types';
import type { Runtime } from './runtime';
import type { SceneSync } from './sync';

export interface ScreenPoint {
    x: number;
    y: number;
    /** False when the point is behind the camera. */
    visible: boolean;
    /** Clip-space w: distance in front of the camera. */
    depth: number;
}

export interface Hit {
    id: string;
    distance: number;
    point: Vec3;
    /** The renderer that was hit (a part of a model, or the node's mesh). */
    renderer: RenderNode;
}

export interface ObjectHit {
    renderer: RenderNode;
    object: Object3D;
    distance: number;
    point: Vec3;
}

export interface Box {
    min: Vec3;
    max: Vec3;
}

/**
 * Camera projection helpers and CPU ray casting against the document's
 * meshes. Everything works in CSS pixels relative to the viewport canvas.
 */
export class Picker {
    private viewProj: Mat4 = new Float64Array(16);
    private invViewProj: Mat4 = new Float64Array(16);
    private cameraPos: Vec3 = [0, 0, 0];
    private cameraForward: Vec3 = [0, 0, 1];

    constructor(private runtime: Runtime, private sync: SceneSync, private store: Store) {}

    /** Refreshes cached camera matrices; call once per frame / interaction. */
    update() {
        const cam = this.runtime.activeCamera;
        const world = cam.transform.worldMatrix.rawData;
        const view = invert(world) ?? new Float64Array(16);
        mul(cam.projectionMatrix.rawData, view, this.viewProj);
        invert(this.viewProj, this.invViewProj);
        this.cameraPos = [world[12], world[13], world[14]];
        if (cam === this.runtime.camera) {
            this.cameraForward = normalize(sub(this.store.camera.target, this.cameraPos));
        } else {
            // Scene cameras look down their local +Z axis.
            this.cameraForward = normalize([world[8], world[9], world[10]]);
        }
    }

    get eye(): Vec3 {
        return this.cameraPos;
    }

    get forward(): Vec3 {
        return this.cameraForward;
    }

    get size(): [number, number] {
        return this.runtime.cssSize;
    }

    project(p: Vec3): ScreenPoint {
        const [w, h] = this.size;
        const c = transform4(this.viewProj, p);
        if (c[3] <= 1e-6) return { x: 0, y: 0, visible: false, depth: c[3] };
        const nx = c[0] / c[3];
        const ny = c[1] / c[3];
        return { x: (nx * 0.5 + 0.5) * w, y: (0.5 - ny * 0.5) * h, visible: true, depth: c[3] };
    }

    ray(x: number, y: number): Ray {
        const [w, h] = this.size;
        const nx = (x / w) * 2 - 1;
        const ny = 1 - (y / h) * 2;
        const near = transformPoint(this.invViewProj, [nx, ny, 0]);
        const far = transformPoint(this.invViewProj, [nx, ny, 0.5]);
        return { origin: near, dir: normalize(sub(far, near)) };
    }

    /** World units per CSS pixel at the depth of `p`. */
    pixelSize(p: Vec3): number {
        const [, h] = this.size;
        const cam = this.runtime.activeCamera;
        const depth = Math.max(0.001, transform4(this.viewProj, p)[3]);
        return (2 * Math.tan(((cam.fov || 50) * Math.PI) / 360) * depth) / Math.max(1, h);
    }

    // ------------------------------------------------------------- picking

    pick(x: number, y: number, ignoreHidden = true): Hit | null {
        const ray = this.ray(x, y);
        let best: Hit | null = null;
        for (const node of this.store.doc.nodes) {
            const entry = this.sync.entries.get(node.id);
            if (!entry || (ignoreHidden && !entry.visible)) continue;
            for (const r of this.sync.renderersOf(node.id)) {
                if (!r.enable) continue;
                const t = this.intersectRenderer(r, ray);
                if (t !== null && (!best || t < best.distance)) {
                    best = { id: node.id, distance: t, point: add(ray.origin, [ray.dir[0] * t, ray.dir[1] * t, ray.dir[2] * t]), renderer: r };
                }
            }
        }
        return best;
    }

    /**
     * Ray cast against every enabled renderer under `root`, including
     * objects that are not document nodes (e.g. spawned by scripts).
     */
    pickObject(x: number, y: number, root: Object3D, skip?: (o: Object3D) => boolean): ObjectHit | null {
        const ray = this.ray(x, y);
        let best: ObjectHit | null = null;
        const visit = (o: Object3D) => {
            if (skip?.(o)) return;
            o.components.forEach((c) => {
                if (!(c instanceof RenderNode)) return;
                const r = c as RenderNode;
                if (!r.enable || !r.geometry) return;
                const t = this.intersectRenderer(r, ray);
                if (t !== null && (!best || t < best.distance)) {
                    best = { renderer: r, object: o, distance: t, point: add(ray.origin, [ray.dir[0] * t, ray.dir[1] * t, ray.dir[2] * t]) };
                }
            });
            for (const child of o.entityChildren as Object3D[]) if (child instanceof Object3D) visit(child);
        };
        visit(root);
        return best;
    }

    intersectRenderer(r: RenderNode, ray: Ray): number | null {
        const geo = r.geometry;
        if (!geo || !r.object3D) return null;
        const world = r.object3D.transform.worldMatrix.rawData;
        const inv = invert(world);
        if (!inv) return null;
        // Local-space ray with an unnormalized direction keeps t comparable
        // to world-space distances along the original ray.
        const o = transformPoint(inv, ray.origin);
        const d = transformDir(inv, ray.dir);
        const local: Ray = { origin: o, dir: d };
        const b = geo.bounds;
        if (!b) return null;
        const pad = 1e-4;
        const boxT = rayBox(local, [b.min.x - pad, b.min.y - pad, b.min.z - pad], [b.max.x + pad, b.max.y + pad, b.max.z + pad]);
        if (boxT === null) return null;

        const pos = geo.getAttribute(VertexAttributeName.position)?.data as ArrayLike<number> | undefined;
        const idx = geo.getAttribute(VertexAttributeName.indices)?.data as ArrayLike<number> | undefined;
        const topology = (r.materials?.[0] as any)?.topology;
        if (!pos || pos.length < 9 || (topology && topology !== 'triangle-list')) return boxT;

        let best: number | null = null;
        const tri = (a: number, b2: number, c: number) => {
            const t = rayTriangle(
                o[0], o[1], o[2], d[0], d[1], d[2],
                pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2],
                pos[b2 * 3], pos[b2 * 3 + 1], pos[b2 * 3 + 2],
                pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2],
            );
            if (t !== null && (best === null || t < best)) best = t;
        };
        const vertexCount = Math.floor(pos.length / 3);
        if (idx && idx.length >= 3) {
            for (let i = 0; i + 2 < idx.length; i += 3) {
                const a = idx[i], b2 = idx[i + 1], c = idx[i + 2];
                if (a < vertexCount && b2 < vertexCount && c < vertexCount) tri(a, b2, c);
            }
        } else {
            for (let i = 0; i + 2 < vertexCount; i += 3) tri(i, i + 1, i + 2);
        }
        return best;
    }

    // -------------------------------------------------------------- bounds

    /** World AABB of a node's renderers, optionally including child nodes. */
    bounds(id: string, deep = true): Box | null {
        const ids = [id];
        if (deep) for (const n of this.store.descendants(id)) ids.push(n.id);
        let box: Box | null = null;
        for (const nid of ids) {
            for (const r of this.sync.renderersOf(nid)) {
                const b = r.geometry?.bounds;
                if (!b || !r.object3D || !Number.isFinite(b.min.x) || !Number.isFinite(b.max.x)) continue;
                const m = r.object3D.transform.worldMatrix.rawData;
                for (let i = 0; i < 8; i++) {
                    const p = transformPoint(m, [
                        i & 1 ? b.max.x : b.min.x,
                        i & 2 ? b.max.y : b.min.y,
                        i & 4 ? b.max.z : b.min.z,
                    ]);
                    if (!box) box = { min: [...p] as Vec3, max: [...p] as Vec3 };
                    else {
                        for (let k = 0; k < 3; k++) {
                            if (p[k] < box.min[k]) box.min[k] = p[k];
                            if (p[k] > box.max[k]) box.max[k] = p[k];
                        }
                    }
                }
            }
        }
        return box;
    }

    /** Oriented box corners (8 world points) for each renderer of a node. */
    localBoxes(id: string): Vec3[][] {
        const out: Vec3[][] = [];
        for (const r of this.sync.renderersOf(id)) {
            const b = r.geometry?.bounds;
            if (!b || !r.object3D || !Number.isFinite(b.min.x) || !Number.isFinite(b.max.x)) continue;
            const m = r.object3D.transform.worldMatrix.rawData;
            const corners: Vec3[] = [];
            for (let i = 0; i < 8; i++) {
                corners.push(transformPoint(m, [
                    i & 1 ? b.max.x : b.min.x,
                    i & 2 ? b.max.y : b.min.y,
                    i & 4 ? b.max.z : b.min.z,
                ]));
            }
            out.push(corners);
        }
        return out;
    }

    worldMatrix(id: string): ArrayLike<number> | null {
        const e = this.sync.entries.get(id);
        return e ? e.obj.transform.worldMatrix.rawData : null;
    }
}

// Levels of detail for meshes: simpler versions of a shape (the same
// vertices, fewer triangles, made with meshoptimizer's simplifier) kept in
// its index buffer after its own triangles, as the levels 1 and 2 of each
// sub-mesh, which the engine draws by the renderer's lodLevel. Scatters pick
// a level per cell (engine/scatter.ts); models placed one by one pick one
// per renderer by how large it looks (ModelLods). What reads a shape's
// triangles (picking, physics, navigation) reads only its own: ownIndices.

import { GeometryBase, VertexAttributeName, type RenderNode } from '@orillusion/core';

/** What the simpler levels keep of a shape's triangles, and the error each may make (a share of its size). */
const LOD_STEPS = [
    { keep: 0.35, error: 0.01 },
    { keep: 0.12, error: 0.04 },
];

type Simplifier = (typeof import('meshoptimizer/simplifier'))['MeshoptSimplifier'];
let simplifierLoad: Promise<Simplifier | null> | null = null;

/** meshoptimizer's simplifier (WebAssembly), loaded the first time a shape needs it; null where it cannot run. */
function loadSimplifier(): Promise<Simplifier | null> {
    simplifierLoad ??= import('meshoptimizer/simplifier')
        .then(async ({ MeshoptSimplifier }) => {
            await MeshoptSimplifier.ready;
            return MeshoptSimplifier.supported ? MeshoptSimplifier : null;
        })
        .catch(() => null);
    return simplifierLoad;
}

/** How many of a shape's indices are its own triangles (the simpler levels follow them). */
const OWN = new WeakMap<GeometryBase, number>();

/** A shape's own triangles, without the simpler levels of detail kept after them. */
export function ownIndices(g: GeometryBase): ArrayLike<number> | undefined {
    const idx = g.getAttribute(VertexAttributeName.indices)?.data as ArrayLike<number> | undefined;
    const own = OWN.get(g);
    if (!idx || own === undefined) return idx;
    return (idx as Uint32Array).subarray(0, own);
}

/**
 * A copy of a shape whose index buffer also holds simpler versions of each
 * of its sub-meshes, as their levels of detail 1 and 2 (the same vertices).
 * A sub-mesh that does not simplify keeps its own triangles at every level;
 * a shape where none does is returned as it is.
 */
function withLods(g: GeometryBase, simplifier: Simplifier): GeometryBase {
    const posData = g.getAttribute(VertexAttributeName.position)?.data as ArrayLike<number> | undefined;
    const idxData = g.getAttribute(VertexAttributeName.indices)?.data as ArrayLike<number> | undefined;
    if (!posData || !idxData || !g.subGeometries.length || g.subGeometries.some((s) => !s.lodLevels?.length)) return g;
    const positions = posData instanceof Float32Array ? posData : Float32Array.from(posData);
    const indices = idxData instanceof Uint32Array ? idxData : Uint32Array.from(idxData);
    const chunks: Uint32Array[] = [indices];
    let at = indices.length;
    const subs = g.subGeometries.map((sub) => {
        const base = sub.lodLevels[0];
        const own = indices.subarray(base.indexStart, base.indexStart + base.indexCount);
        const levels = [{ ...base }];
        for (const step of LOD_STEPS) {
            const target = Math.max(3, Math.floor((own.length * step.keep) / 3) * 3);
            const [simpler] = own.length >= 36 ? simplifier.simplify(own, positions, 3, target, step.error) : [own];
            if (!(simpler.length >= 3 && simpler.length < own.length * 0.9)) {
                levels.push({ ...base });
                continue;
            }
            levels.push({ ...base, indexStart: at, indexCount: simpler.length });
            chunks.push(simpler);
            at += simpler.length;
        }
        return levels;
    });
    if (chunks.length === 1) return g;
    const all = new Uint32Array(at);
    let o = 0;
    for (const c of chunks) {
        all.set(c, o);
        o += c.length;
    }
    const out = new GeometryBase();
    out.name = (g.name || 'shape') + ' (levels of detail)';
    out.setAttribute(VertexAttributeName.position, positions);
    for (const [name, attr] of g.vertexAttributeMap) {
        if (name !== VertexAttributeName.indices && name !== VertexAttributeName.position) out.setAttribute(name, attr.data);
    }
    out.setIndices(all);
    for (const levels of subs) out.addSubGeometry(...levels);
    OWN.set(out, indices.length);
    return out;
}

/** Shapes with their simpler levels by the shape they are made from: promised (made or being made), and made. */
const made = new WeakMap<GeometryBase, Promise<GeometryBase>>();
const done = new WeakMap<GeometryBase, GeometryBase>();

/**
 * The shape with its simpler levels (made once per shape; the shape itself
 * where they cannot be made). What draws it holds it, and the last renderer
 * to go destroys it (an object deleted, the scene built again when Play
 * stops): it is then made again.
 */
export function geometryWithLods(g: GeometryBase): Promise<GeometryBase> {
    if (OWN.has(g)) return Promise.resolve(g);
    let p = made.get(g);
    const last = done.get(g);
    if (!p || (last && last !== g && !last.subGeometries)) {
        p = loadSimplifier().then((simplifier) => {
            let out = g;
            if (simplifier) {
                try {
                    out = withLods(g, simplifier);
                } catch (e) {
                    console.warn('[editor] a shape could not be simplified', e);
                }
            }
            done.set(g, out);
            return out;
        });
        made.set(g, p);
    }
    return p;
}

/** How large (its radius over its distance) a renderer must look to draw level 0, else level 1; smaller draws level 2. */
const LOOK_FULL = 0.06;
const LOOK_HALF = 0.02;

interface Tracked {
    renderer: RenderNode;
    /** Its bounds' radius in its own space (times its object's scale when measured). */
    radius: number;
}

/**
 * The renderers of models placed one by one that have simpler levels: each
 * draws the level its apparent size calls for, measured a share of them a
 * frame (with a margin, so one at a limit does not flicker).
 */
export class ModelLods {
    private tracked: Tracked[] = [];
    private next = 0;

    /** Gives these renderers their simpler levels (once loaded) and keeps their level fitted from then on. */
    async add(renderers: RenderNode[], alive: () => boolean) {
        for (const r of renderers) {
            const lod = await geometryWithLods(r.geometry);
            if (!alive() || r.isDestroyed) return;
            if (lod === r.geometry) continue;
            r.geometry = lod;
            const b = lod.bounds;
            const radius = b ? Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2 : 1;
            this.tracked.push({ renderer: r, radius });
        }
    }

    /** Fits the level of a share of the renderers (each at least every 8 frames) to a camera at `eye`; `scale` is the tier's. */
    update(eye: ArrayLike<number>, scale: number) {
        const list = this.tracked;
        if (!list.length) return;
        const n = Math.max(1, Math.ceil(list.length / 8));
        for (let k = 0; k < n; k++) {
            if (this.next >= list.length) this.next = 0;
            const t = list[this.next];
            if (t.renderer.isDestroyed) {
                list.splice(this.next, 1);
                continue;
            }
            this.next++;
            const tr = t.renderer.object3D?.transform;
            if (!tr) continue;
            const p = tr.worldPosition;
            const s = tr.worldMatrix.getMaxScaleOnAxis?.() ?? 1;
            const d = Math.max(0.01, Math.hypot(p.x - eye[0], p.y - eye[1], p.z - eye[2]));
            const look = (t.radius * s) / d / Math.max(0.1, scale);
            const cur = t.renderer.lodLevel;
            const full = LOOK_FULL * (cur === 0 ? 0.95 : 1.05);
            const half = LOOK_HALF * (cur === 2 ? 1.05 : 0.95);
            const level = look >= full ? 0 : look >= half ? 1 : 2;
            if (level !== cur) t.renderer.lodLevel = level;
        }
    }
}

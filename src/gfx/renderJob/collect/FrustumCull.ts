import type { RenderNode } from '../../../components/renderer/RenderNode';
import type { Camera3D } from '../../../core/Camera3D';

/**
 * How a pass leaves out renderers its camera cannot see:
 *  - `'none'`: draws every renderer (the default);
 *  - `'frustum'`: skips renderers whose world bounds lie outside the
 *    camera's frustum;
 *  - `'shadow'`: the same, but keeps renderers between the light and the
 *    camera's near plane, which still cast into the shadow map.
 *
 * Only renderers with {@link RenderNode.frustumCulled} set are ever left
 * out: their geometry bounds must hold everything they draw (not skinned,
 * morphed or vertex-displaced meshes).
 *
 * @group GFX
 */
export type FrustumCullMode = 'none' | 'frustum' | 'shadow';

/** Frustum planes (a, b, c, d) of the camera being tested: inside where a x + b y + c z + d >= 0. */
const planes = new Float64Array(24);

/** World box per renderer, as [cx, cy, cz, ex, ey, ez], and the frame it was taken in; ex < 0 when unknown. */
const boxes = new WeakMap<RenderNode, { frame: number; box: Float64Array }>();

/**
 * Loads the planes of `camera` from its projection-view matrix (the same
 * rows as {@link Frustum.update}); returns how many to test.
 */
export function loadCullPlanes(camera: Camera3D, mode: FrustumCullMode): number {
    const m = camera.pvMatrix.rawData;
    const set = (i: number, a: number, b: number, c: number, d: number) => {
        planes[i * 4] = a;
        planes[i * 4 + 1] = b;
        planes[i * 4 + 2] = c;
        planes[i * 4 + 3] = d;
    };
    set(0, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
    set(1, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
    set(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
    set(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);
    // Far.
    set(4, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);
    // Near (w + z >= 0: looser than WebGPU's z >= 0, so never too tight).
    set(5, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);
    return mode === 'shadow' ? 5 : 6;
}

/**
 * The renderer's world box this frame, from its bounds (its cull bounds, or
 * its geometry's) and its world matrix, as [cx, cy, cz, ex, ey, ez]; ex < 0
 * when unknown. The array is kept per renderer: read it before asking for
 * another frame.
 */
export function worldBox(node: RenderNode, frame: number): Float64Array {
    let rec = boxes.get(node);
    if (!rec) {
        rec = { frame: -1, box: new Float64Array(6) };
        boxes.set(node, rec);
    }
    if (rec.frame === frame) return rec.box;
    rec.frame = frame;
    const box = rec.box;
    const b = node.cullBounds ?? node.geometry?.bounds;
    const lo = b?.min, hi = b?.max;
    if (!lo || !hi || !(lo.x <= hi.x && lo.y <= hi.y && lo.z <= hi.z)) {
        box[3] = -1;
        return box;
    }
    const lx = (lo.x + hi.x) / 2, ly = (lo.y + hi.y) / 2, lz = (lo.z + hi.z) / 2;
    const ex = (hi.x - lo.x) / 2, ey = (hi.y - lo.y) / 2, ez = (hi.z - lo.z) / 2;
    // The matrix the renderer is drawn with this frame.
    const w = node.transform.worldMatrix.rawData;
    box[0] = w[0] * lx + w[4] * ly + w[8] * lz + w[12];
    box[1] = w[1] * lx + w[5] * ly + w[9] * lz + w[13];
    box[2] = w[2] * lx + w[6] * ly + w[10] * lz + w[14];
    box[3] = Math.abs(w[0]) * ex + Math.abs(w[4]) * ey + Math.abs(w[8]) * ez;
    box[4] = Math.abs(w[1]) * ex + Math.abs(w[5]) * ey + Math.abs(w[9]) * ez;
    box[5] = Math.abs(w[2]) * ex + Math.abs(w[6]) * ey + Math.abs(w[10]) * ez;
    if (!(box[3] >= 0 && box[4] >= 0 && box[5] >= 0)) box[3] = -1;
    return box;
}

/**
 * True when the renderer may be seen by the planes last loaded with
 * {@link loadCullPlanes}: renderers that do not take part in culling, or
 * whose bounds are unknown, always are.
 */
export function inCullPlanes(node: RenderNode, count: number, frame: number): boolean {
    if (!node.frustumCulled || node.alwaysRender) return true;
    const box = worldBox(node, frame);
    if (box[3] < 0) return true;
    const cx = box[0], cy = box[1], cz = box[2], ex = box[3], ey = box[4], ez = box[5];
    for (let i = 0; i < count; i++) {
        const a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
        if (a * cx + b * cy + c * cz + d + Math.abs(a) * ex + Math.abs(b) * ey + Math.abs(c) * ez < 0) return false;
    }
    return true;
}

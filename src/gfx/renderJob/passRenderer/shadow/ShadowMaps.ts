import type { RenderNode } from '../../../../components/renderer/RenderNode';

/**
 * Shared pieces of the shadow passes: the six faces a point light's shadow
 * is drawn in (and the WGSL that finds them again), the faces a spot light's
 * cone needs, packing lights' faces into one atlas, and the signatures that
 * tell a shadow map it is still up to date.
 *
 * @internal
 * @group GFX
 */

type V3 = [number, number, number];

/** The six faces as directions from the light: +X, -X, +Y, -Y, +Z, -Z. */
export const SHADOW_FACE_AXES: readonly V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** The up hint each face's camera looks with (Transform.lookAt). */
export const SHADOW_FACE_UPS: readonly V3[] = [[0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Each face camera's axes as Matrix4.lookAt makes them: x = up × forward,
 * y = forward × x, z = forward. A world direction d from the light lands at
 * ndc (-d·x / d·z, d·y / d·z): the engine's projection mirrors x.
 */
export const SHADOW_FACE_BASES: readonly { x: V3; y: V3; z: V3 }[] = SHADOW_FACE_AXES.map((z, i) => {
    const x = normalize(cross(SHADOW_FACE_UPS[i], z));
    return { x, y: cross(z, x), z };
});

const wgslVec = (v: V3) => `vec3<f32>(${v.map((n) => n.toFixed(1)).join(', ')})`;

/**
 * WGSL: `shadowFaceOf(d)` (the face a direction from the light falls in)
 * and `shadowFaceUV(d, face)` (where in that face's map, 0..1), matching
 * how PointShadowPass draws the faces.
 */
export const SHADOW_FACE_WGSL = /*wgsl*/ `
    const SHADOW_FACE_X = array<vec3<f32>, 6>(${SHADOW_FACE_BASES.map((b) => wgslVec(b.x)).join(', ')});
    const SHADOW_FACE_Y = array<vec3<f32>, 6>(${SHADOW_FACE_BASES.map((b) => wgslVec(b.y)).join(', ')});
    const SHADOW_FACE_Z = array<vec3<f32>, 6>(${SHADOW_FACE_BASES.map((b) => wgslVec(b.z)).join(', ')});

    fn shadowFaceOf(d: vec3<f32>) -> i32 {
        let a = abs(d);
        if (a.x >= a.y && a.x >= a.z) { return select(1, 0, d.x >= 0.0); }
        if (a.y >= a.z) { return select(3, 2, d.y >= 0.0); }
        return select(5, 4, d.z >= 0.0);
    }

    fn shadowFaceUV(d: vec3<f32>, face: i32) -> vec2<f32> {
        let z = max(dot(d, SHADOW_FACE_Z[face]), 1e-6);
        return vec2<f32>(0.5 - 0.5 * dot(d, SHADOW_FACE_X[face]) / z, 0.5 - 0.5 * dot(d, SHADOW_FACE_Y[face]) / z);
    }
`;

function faceOf(x: number, y: number, z: number): number {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
    if (ay >= az) return y >= 0 ? 2 : 3;
    return z >= 0 ? 4 : 5;
}

/** All six faces. */
export const ALL_SHADOW_FACES = 0b111111;

/**
 * The faces a spot light's cone reaches (a bit per face), from its
 * direction and half angle in radians: the face of its axis and those of
 * directions around its rim, a little wider than the cone.
 */
export function spotShadowFaces(dx: number, dy: number, dz: number, halfAngle: number): number {
    if (halfAngle >= Math.PI * 0.49) return ALL_SHADOW_FACES;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    // Two axes across the direction.
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; }
    let rx = uy * dz - uz * dy, ry = uz * dx - ux * dz, rz = ux * dy - uy * dx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const qx = dy * rz - dz * ry, qy = dz * rx - dx * rz, qz = dx * ry - dy * rx;
    const a = Math.min(halfAngle + 3 * Math.PI / 180, Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    let mask = 1 << faceOf(dx, dy, dz);
    for (let i = 0; i < 32; i++) {
        const t = (i / 32) * Math.PI * 2;
        const ct = Math.cos(t) * s, st = Math.sin(t) * s;
        mask |= 1 << faceOf(dx * c + rx * ct + qx * st, dy * c + ry * ct + qy * st, dz * c + rz * ct + qz * st);
    }
    return mask;
}

const faceCount = (mask: number) => {
    let n = 0;
    for (let m = mask; m; m &= m - 1) n++;
    return n;
};

const maxFaces = new Map<number, number>();

/**
 * The most faces a cone of this half angle reaches, pointed anywhere: the
 * tiles a spot light keeps, so turning it never repacks the atlas.
 */
export function spotMaxFaces(halfAngle: number): number {
    const key = Math.round(halfAngle * 1000);
    let n = maxFaces.get(key);
    if (n !== undefined) return n;
    n = 1;
    const dirs: V3[] = [...SHADOW_FACE_AXES];
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
        dirs.push([x, y, 0], [x, 0, y], [0, x, y]);
        for (const z of [-1, 1]) dirs.push([x, y, z]);
    }
    // And a spread of others (a Fibonacci sphere).
    for (let i = 0; i < 128; i++) {
        const y = 1 - (2 * (i + 0.5)) / 128;
        const r = Math.sqrt(1 - y * y), t = i * 2.399963;
        dirs.push([Math.cos(t) * r, y, Math.sin(t) * r]);
    }
    for (const d of dirs) n = Math.max(n, faceCount(spotShadowFaces(d[0], d[1], d[2], halfAngle)));
    maxFaces.set(key, n);
    return n;
}

export interface AtlasTile {
    x: number;
    y: number;
    size: number;
}

/**
 * Packs square tiles (power-of-two sizes) into the smallest atlas that
 * holds them: a power-of-two square, or two of them side by side, halving
 * every tile above the smallest size while its longer side would be more
 * than `max`. Returns the atlas size and each tile where it went, in the
 * order given.
 */
export function packShadowAtlas(sizes: readonly number[], max: number, min = 64): { width: number; height: number; tiles: AtlasTile[] } {
    if (!sizes.length) return { width: 0, height: 0, tiles: [] };
    let list = sizes.map((s) => Math.max(min, 1 << Math.round(Math.log2(Math.max(1, s)))));
    let size = 0;
    let wide = false;
    for (;;) {
        const area = list.reduce((a, s) => a + s * s, 0);
        const largest = Math.max(...list);
        // The smallest square side that holds the area; half of it twice when that is enough.
        size = Math.max(largest, 1 << Math.ceil(Math.log2(Math.sqrt(area))));
        wide = size > largest && 2 * (size / 2) * (size / 2) >= area;
        if (wide) size /= 2;
        if ((wide ? 2 * size : size) <= max || list.every((s) => s <= min)) break;
        list = list.map((s) => Math.max(min, s / 2));
    }
    // Largest first: every free block is then at least the size placed next.
    const order = list.map((_, i) => i).sort((a, b) => list[b] - list[a] || a - b);
    const free = new Map<number, { x: number; y: number }[]>([[size, wide ? [{ x: size, y: 0 }, { x: 0, y: 0 }] : [{ x: 0, y: 0 }]]]);
    const tiles: AtlasTile[] = new Array(list.length);
    for (const i of order) {
        const s = list[i];
        let t = s;
        while (t <= size && !free.get(t)?.length) t *= 2;
        const block = free.get(t)?.pop();
        if (!block) {
            tiles[i] = { x: 0, y: 0, size: 0 };
            continue;
        }
        while (t > s) {
            t /= 2;
            const rest = free.get(t) ?? [];
            rest.push({ x: block.x + t, y: block.y }, { x: block.x, y: block.y + t }, { x: block.x + t, y: block.y + t });
            free.set(t, rest);
        }
        tiles[i] = { x: block.x, y: block.y, size: s };
    }
    return { width: wide ? 2 * size : size, height: size, tiles };
}

const scratchF = new Float32Array(16);
const scratchI = new Int32Array(scratchF.buffer);

/** Folds numbers into an FNV-1a hash by the bits of their 32-bit floats. */
export function hashFloats(h: number, values: ArrayLike<number>, count = values.length): number {
    for (let i = 0; i < count; i += 16) {
        const n = Math.min(16, count - i);
        for (let k = 0; k < n; k++) scratchF[k] = values[i + k];
        for (let k = 0; k < n; k++) h = Math.imul(h ^ scratchI[k], 16777619);
    }
    return h;
}

export const HASH_START = 0x811c9dc5;

/**
 * A caster that can change its shape where it stands (skinned, morphed or
 * displaced in its vertex shader, which leave `frustumCulled` off), or is
 * marked so: the shadow it falls in is drawn again every frame.
 */
export function castsChangingShadow(node: RenderNode): boolean {
    if (node.shadowCacheMode === 'dynamic') return true;
    if (node.shadowCacheMode === 'static') return false;
    return !node.frustumCulled || node.alwaysRender;
}

/** Adds a caster to a shadow map's signature: which one, and where. */
export function hashCaster(h: number, node: RenderNode): number {
    const t = node.transform;
    h = Math.imul(h ^ (t.index | 0), 16777619);
    return hashFloats(h, t.worldMatrix.rawData, 16);
}

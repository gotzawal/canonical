// Small allocation-friendly math used by the viewport. Matrices are
// column-major Float64Array(16), the same layout as the engine's Matrix4
// rawData (translation in elements 12..14). Quaternions follow the engine
// (Hamilton product, x y z w) and Euler angles use the engine's ZYX order,
// so values round-trip through Transform.rotationX/Y/Z unchanged.
//
// The engine's Matrix4 allocates a slot in a WASM pool on construction, so
// the editor never creates Matrix4 instances for scratch math.

import type { Vec3 } from './types';

export type Mat4 = Float64Array;
export type Quat = [number, number, number, number];

const DEG = Math.PI / 180;

export function v3(x = 0, y = 0, z = 0): Vec3 { return [x, y, z]; }
export function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
export function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function len(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
export function normalize(a: Vec3): Vec3 {
    const l = len(a);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function mat4(): Mat4 {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

export function mat4From(src: ArrayLike<number>): Mat4 {
    const m = new Float64Array(16);
    for (let i = 0; i < 16; i++) m[i] = src[i];
    return m;
}

/** out = a * b (column-major, applies b first). */
export function mul(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4 = new Float64Array(16)): Mat4 {
    const r = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
        for (let row = 0; row < 4; row++) {
            r[c * 4 + row] =
                a[row] * b[c * 4] +
                a[4 + row] * b[c * 4 + 1] +
                a[8 + row] * b[c * 4 + 2] +
                a[12 + row] * b[c * 4 + 3];
        }
    }
    out.set(r);
    return out;
}

export function invert(m: ArrayLike<number>, out: Mat4 = new Float64Array(16)): Mat4 | null {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
}

export function transformPoint(m: ArrayLike<number>, p: Vec3): Vec3 {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    return [
        (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
        (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
        (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
}

export function transformDir(m: ArrayLike<number>, d: Vec3): Vec3 {
    const x = d[0], y = d[1], z = d[2];
    return [
        m[0] * x + m[4] * y + m[8] * z,
        m[1] * x + m[5] * y + m[9] * z,
        m[2] * x + m[6] * y + m[10] * z,
    ];
}

/** Homogeneous transform without the divide; returns [x, y, z, w]. */
export function transform4(m: ArrayLike<number>, p: Vec3): [number, number, number, number] {
    const x = p[0], y = p[1], z = p[2];
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
        m[3] * x + m[7] * y + m[11] * z + m[15],
    ];
}

export function getTranslation(m: ArrayLike<number>): Vec3 { return [m[12], m[13], m[14]]; }

export function getColumn(m: ArrayLike<number>, c: number): Vec3 {
    return [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
}

// ---------------------------------------------------------------- quaternions

export function quatIdentity(): Quat { return [0, 0, 0, 1]; }

export function quatMul(a: Quat, b: Quat): Quat {
    const [x1, y1, z1, w1] = a;
    const [x2, y2, z2, w2] = b;
    return [
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    ];
}

export function quatInvert(q: Quat): Quat {
    const l = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1;
    return [-q[0] / l, -q[1] / l, -q[2] / l, q[3] / l];
}

export function quatNormalize(q: Quat): Quat {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Axis must be normalized. Angle in radians. */
export function quatAxisAngle(axis: Vec3, angle: number): Quat {
    const s = Math.sin(angle / 2);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
    const [qx, qy, qz, qw] = q;
    const [x, y, z] = v;
    const w1 = -qx * x - qy * y - qz * z;
    const x1 = qw * x + qy * z - qz * y;
    const y1 = qw * y - qx * z + qz * x;
    const z1 = qw * z + qx * y - qy * x;
    return [
        -w1 * qx + x1 * qw - y1 * qz + z1 * qy,
        -w1 * qy + x1 * qz + y1 * qw - z1 * qx,
        -w1 * qz - x1 * qy + y1 * qx + z1 * qw,
    ];
}

/** Same formula as engine Quaternion.setFromEuler (degrees). */
export function quatFromEuler(e: Vec3): Quat {
    const hx = e[0] * DEG * 0.5, hy = e[1] * DEG * 0.5, hz = e[2] * DEG * 0.5;
    const cx = Math.cos(hx), sx = Math.sin(hx);
    const cy = Math.cos(hy), sy = Math.sin(hy);
    const cz = Math.cos(hz), sz = Math.sin(hz);
    return [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
    ];
}

/** Same formula as engine Quaternion.getEulerAngles (degrees). */
export function eulerFromQuat(q: Quat): Vec3 {
    const [qx, qy, qz, qw] = q;
    const a2 = 2 * (qw * qy - qx * qz);
    let x: number, y: number, z: number;
    if (a2 <= -0.99999) {
        x = 2 * Math.atan2(qx, qw);
        y = -Math.PI / 2;
        z = 0;
    } else if (a2 >= 0.99999) {
        x = 2 * Math.atan2(qx, qw);
        y = Math.PI / 2;
        z = 0;
    } else {
        x = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy));
        y = Math.asin(a2);
        z = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
    }
    return [x / DEG, y / DEG, z / DEG];
}

/** Rotation part of an (orthogonal, possibly scaled) matrix. */
export function quatFromMatrix(m: ArrayLike<number>): Quat {
    const sx = Math.hypot(m[0], m[1], m[2]) || 1;
    const sy = Math.hypot(m[4], m[5], m[6]) || 1;
    const sz = Math.hypot(m[8], m[9], m[10]) || 1;
    const m11 = m[0] / sx, m12 = m[4] / sy, m13 = m[8] / sz;
    const m21 = m[1] / sx, m22 = m[5] / sy, m23 = m[9] / sz;
    const m31 = m[2] / sx, m32 = m[6] / sy, m33 = m[10] / sz;
    const trace = m11 + m22 + m33;
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / s;
        x = (m32 - m23) * s;
        y = (m13 - m31) * s;
        z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
        const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        w = (m32 - m23) / s;
        x = 0.25 * s;
        y = (m12 + m21) / s;
        z = (m13 + m31) / s;
    } else if (m22 > m33) {
        const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        w = (m13 - m31) / s;
        x = (m12 + m21) / s;
        y = 0.25 * s;
        z = (m23 + m32) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        w = (m21 - m12) / s;
        x = (m13 + m31) / s;
        y = (m23 + m32) / s;
        z = 0.25 * s;
    }
    return quatNormalize([x, y, z, w]);
}

/** Column-major TRS matrix, same as engine Matrix4.compose. */
export function compose(p: Vec3, q: Quat, s: Vec3, out: Mat4 = new Float64Array(16)): Mat4 {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = (1 - (yy + zz)) * s[0];
    out[1] = (xy + wz) * s[0];
    out[2] = (xz - wy) * s[0];
    out[3] = 0;
    out[4] = (xy - wz) * s[1];
    out[5] = (1 - (xx + zz)) * s[1];
    out[6] = (yz + wx) * s[1];
    out[7] = 0;
    out[8] = (xz + wy) * s[2];
    out[9] = (yz - wx) * s[2];
    out[10] = (1 - (xx + yy)) * s[2];
    out[11] = 0;
    out[12] = p[0];
    out[13] = p[1];
    out[14] = p[2];
    out[15] = 1;
    return out;
}

export function decompose(m: ArrayLike<number>): { position: Vec3; rotation: Quat; scale: Vec3 } {
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const det =
        m[0] * (m[5] * m[10] - m[9] * m[6]) -
        m[4] * (m[1] * m[10] - m[9] * m[2]) +
        m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (det < 0) sx = -sx;
    const r = mat4From(m);
    r[0] /= sx; r[1] /= sx; r[2] /= sx;
    r[4] /= sy; r[5] /= sy; r[6] /= sy;
    r[8] /= sz; r[9] /= sz; r[10] /= sz;
    return { position: [m[12], m[13], m[14]], rotation: quatFromMatrix(r), scale: [sx, sy, sz] };
}

export function localMatrix(position: Vec3, rotation: Vec3, s: Vec3): Mat4 {
    return compose(position, quatFromEuler(rotation), s);
}

// --------------------------------------------------------------------- rays

export interface Ray { origin: Vec3; dir: Vec3; }

/** Returns distance along the ray, or null when parallel / behind. */
export function rayPlane(ray: Ray, point: Vec3, normal: Vec3): number | null {
    const d = dot(ray.dir, normal);
    if (Math.abs(d) < 1e-8) return null;
    const t = dot(sub(point, ray.origin), normal) / d;
    return t >= 0 ? t : null;
}

export function rayAt(ray: Ray, t: number): Vec3 {
    return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
}

/** Slab test against an axis aligned box; returns entry distance or null. */
export function rayBox(ray: Ray, min: Vec3, max: Vec3): number | null {
    let tmin = -Infinity, tmax = Infinity;
    for (let i = 0; i < 3; i++) {
        const o = ray.origin[i], d = ray.dir[i];
        if (Math.abs(d) < 1e-12) {
            if (o < min[i] || o > max[i]) return null;
        } else {
            let t1 = (min[i] - o) / d, t2 = (max[i] - o) / d;
            if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        }
    }
    if (tmax < 0) return null;
    return tmin >= 0 ? tmin : 0;
}

/** Moller-Trumbore, double sided. Returns distance or null. */
export function rayTriangle(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
): number | null {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return null;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-6 ? t : null;
}

/** Closest point parameters between a ray and an infinite line. */
export function closestOnLine(ray: Ray, linePoint: Vec3, lineDir: Vec3): number | null {
    // Returns the parameter s along lineDir of the point closest to the ray.
    const w0 = sub(ray.origin, linePoint);
    const a = dot(ray.dir, ray.dir);
    const b = dot(ray.dir, lineDir);
    const c = dot(lineDir, lineDir);
    const d = dot(ray.dir, w0);
    const e = dot(lineDir, w0);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-10) return null;
    return (a * e - b * d) / denom;
}

// -------------------------------------------------------------------- misc

export function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

export function snap(v: number, step: number): number {
    return step > 0 ? Math.round(v / step) * step : v;
}

/** Trims float noise such as 0.30000000000000004 for display and storage. */
export function tidy(v: number, digits = 5): number {
    const f = Math.pow(10, digits);
    const r = Math.round(v * f) / f;
    return Object.is(r, -0) ? 0 : r;
}

export function tidy3(v: Vec3, digits = 5): Vec3 {
    return [tidy(v[0], digits), tidy(v[1], digits), tidy(v[2], digits)];
}

export const RAD = 1 / DEG;
export { DEG };

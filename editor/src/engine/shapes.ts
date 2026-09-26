import { GeometryBase, VertexAttributeName } from '@orillusion/core';
import type { Vec3 } from '../core/types';

// Greybox shapes the engine has no geometry for: ramp, stairs and capsule.
// Like the engine's box they are centered on their origin. The ramp and the
// stairs rise toward -Z, so a player walking from +Z climbs them.

type V = Vec3;

/** Collects flat or smooth faces into one indexed triangle list. */
class MeshBuilder {
    positions: number[] = [];
    normals: number[] = [];
    uvs: number[] = [];
    indices: number[] = [];

    vertex(p: V, n: V, u: number, v: number): number {
        this.positions.push(p[0], p[1], p[2]);
        this.normals.push(n[0], n[1], n[2]);
        this.uvs.push(u, v);
        return this.positions.length / 3 - 1;
    }

    /** Triangle wound counter-clockwise when seen from the side `n` points to. */
    triangle(a: number, b: number, c: number, n: V) {
        const p = this.positions;
        const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
        const e1: V = [p[b * 3] - ax, p[b * 3 + 1] - ay, p[b * 3 + 2] - az];
        const e2: V = [p[c * 3] - ax, p[c * 3 + 1] - ay, p[c * 3 + 2] - az];
        const cx = e1[1] * e2[2] - e1[2] * e2[1];
        const cy = e1[2] * e2[0] - e1[0] * e2[2];
        const cz = e1[0] * e2[1] - e1[1] * e2[0];
        if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.indices.push(a, b, c);
        else this.indices.push(a, c, b);
    }

    /** Flat quad a-b-c-d (in order around its edge) with UVs spanning 0..1. */
    quad(a: V, b: V, c: V, d: V, n: V) {
        const i0 = this.vertex(a, n, 0, 1);
        const i1 = this.vertex(b, n, 1, 1);
        const i2 = this.vertex(c, n, 1, 0);
        const i3 = this.vertex(d, n, 0, 0);
        this.triangle(i0, i1, i2, n);
        this.triangle(i0, i2, i3, n);
    }

    flatTriangle(a: V, b: V, c: V, n: V) {
        const i0 = this.vertex(a, n, 0, 1);
        const i1 = this.vertex(b, n, 1, 1);
        const i2 = this.vertex(c, n, 0, 0);
        this.triangle(i0, i1, i2, n);
    }

    build(target: GeometryBase) {
        const count = this.positions.length / 3;
        const indices = count > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices);
        const uv = new Float32Array(this.uvs);
        target.setIndices(indices);
        target.setAttribute(VertexAttributeName.position, new Float32Array(this.positions));
        target.setAttribute(VertexAttributeName.normal, new Float32Array(this.normals));
        target.setAttribute(VertexAttributeName.uv, uv);
        target.setAttribute(VertexAttributeName.TEXCOORD_1, uv);
        target.addSubGeometry({
            indexStart: 0,
            indexCount: this.indices.length,
            vertexStart: 0,
            vertexCount: 0,
            firstStart: 0,
            index: 0,
            topology: 0,
        });
    }
}

function normalize(v: V): V {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

/** Wedge: bottom and back faces full, top sloping up from the front bottom edge to the back top edge. */
export class RampGeometry extends GeometryBase {
    constructor(readonly width: number, readonly height: number, readonly depth: number) {
        super();
        const x = width / 2, y = height / 2, z = depth / 2;
        const m = new MeshBuilder();
        m.quad([-x, -y, z], [x, -y, z], [x, -y, -z], [-x, -y, -z], [0, -1, 0]);
        m.quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1]);
        m.quad([-x, -y, z], [x, -y, z], [x, y, -z], [-x, y, -z], normalize([0, depth, height]));
        m.flatTriangle([x, -y, z], [x, -y, -z], [x, y, -z], [1, 0, 0]);
        m.flatTriangle([-x, -y, -z], [-x, -y, z], [-x, y, -z], [-1, 0, 0]);
        m.build(this);
    }
}

/** Solid flight of stairs: `steps` equal steps from the front (+Z) up to the back (-Z). */
export class StairsGeometry extends GeometryBase {
    constructor(readonly width: number, readonly height: number, readonly depth: number, readonly steps: number) {
        super();
        const n = Math.max(1, Math.min(200, Math.round(steps)));
        const x = width / 2, y0 = -height / 2, zf = depth / 2;
        const sd = depth / n, sh = height / n;
        const m = new MeshBuilder();
        for (let i = 0; i < n; i++) {
            const za = zf - i * sd, zb = zf - (i + 1) * sd;
            const yt = y0 + (i + 1) * sh, yr = y0 + i * sh;
            // Tread and riser.
            m.quad([-x, yt, za], [x, yt, za], [x, yt, zb], [-x, yt, zb], [0, 1, 0]);
            m.quad([-x, yr, za], [x, yr, za], [x, yt, za], [-x, yt, za], [0, 0, 1]);
            // Side walls of this column, down to the ground.
            m.quad([x, y0, za], [x, y0, zb], [x, yt, zb], [x, yt, za], [1, 0, 0]);
            m.quad([-x, y0, zb], [-x, y0, za], [-x, yt, za], [-x, yt, zb], [-1, 0, 0]);
        }
        m.quad([x, y0, -zf], [-x, y0, -zf], [-x, y0 + height, -zf], [x, y0 + height, -zf], [0, 0, -1]);
        m.quad([-x, y0, zf], [x, y0, zf], [x, y0, -zf], [-x, y0, -zf], [0, -1, 0]);
        m.build(this);
    }
}

/** Cylinder with round caps; `height` includes the caps (a standing player). */
export class CapsuleGeometry extends GeometryBase {
    constructor(readonly radius: number, readonly height: number, segments: number) {
        super();
        const r = Math.max(0.001, radius);
        const half = Math.max(0, height / 2 - r);
        const seg = Math.max(6, Math.min(128, Math.round(segments)));
        const cap = Math.max(3, Math.round(seg / 4));
        // Profile rings from the top pole to the bottom pole: [y, ring radius, normal y, normal radial].
        const rings: [number, number, number, number][] = [];
        for (let i = 0; i <= cap; i++) {
            const a = (i / cap) * (Math.PI / 2);
            rings.push([half + Math.cos(a) * r, Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
        }
        for (let i = 0; i <= cap; i++) {
            const a = Math.PI / 2 + (i / cap) * (Math.PI / 2);
            rings.push([-half + Math.cos(a) * r, Math.sin(a) * r, Math.cos(a), Math.sin(a)]);
        }
        const total = height > 0 ? height : 2 * r;
        const m = new MeshBuilder();
        const first: number[] = [];
        for (let k = 0; k < rings.length; k++) {
            const [y, rr, ny, nr] = rings[k];
            first.push(m.positions.length / 3);
            for (let j = 0; j <= seg; j++) {
                const t = (j / seg) * Math.PI * 2;
                const c = Math.cos(t), s = Math.sin(t);
                m.vertex([rr * s, y, rr * c], [nr * s, ny, nr * c], j / seg, 1 - (y + total / 2) / total);
            }
        }
        for (let k = 0; k + 1 < rings.length; k++) {
            if (Math.abs(rings[k][0] - rings[k + 1][0]) < 1e-9 && Math.abs(rings[k][1] - rings[k + 1][1]) < 1e-9) continue;
            for (let j = 0; j < seg; j++) {
                const a = first[k] + j, b = a + 1, c = first[k + 1] + j, d = c + 1;
                const t = ((j + 0.5) / seg) * Math.PI * 2;
                const mid = (rings[k][0] + rings[k + 1][0]) / 2;
                const nrm: V = normalize([Math.sin(t), mid > half ? 1 : mid < -half ? -1 : 0, Math.cos(t)]);
                // Degenerate triangles at the poles are harmless and keep the loop simple.
                m.triangle(a, c, b, nrm);
                m.triangle(b, c, d, nrm);
            }
        }
        m.build(this);
    }
}

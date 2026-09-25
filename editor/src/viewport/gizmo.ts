import {
    Quat, closestOnLine, cross, dot, eulerFromQuat, getColumn, invert, len, mat4, normalize, quatAxisAngle,
    quatFromMatrix, quatInvert, quatMul, rayAt, rayPlane, scale, snap, sub, add, tidy, tidy3, transformPoint, DEG,
} from '../core/math';
import type { Store, Tool } from '../core/store';
import type { Vec3 } from '../core/types';
import type { Picker, ScreenPoint } from '../engine/picking';

export type Handle = 'x' | 'y' | 'z' | 'xy' | 'yz' | 'xz' | 'view' | 'uniform';

export const AXIS_COLORS = ['#ff5468', '#8bd142', '#4a8dff'];
const HOVER = '#ffd54a';
const AXIS_HANDLES: Handle[] = ['x', 'y', 'z'];
const PLANES: { handle: Handle; a: number; b: number; n: number }[] = [
    { handle: 'xy', a: 0, b: 1, n: 2 },
    { handle: 'yz', a: 1, b: 2, n: 0 },
    { handle: 'xz', a: 0, b: 2, n: 1 },
];
const GIZMO_PX = 92;

interface Layout {
    mode: Exclude<Tool, 'select'>;
    pivot: Vec3;
    axes: [Vec3, Vec3, Vec3];
    length: number;
    center: ScreenPoint;
}

interface DragItem {
    id: string;
    invParent: Float64Array;
    parentRot: Quat;
    worldPos: Vec3;
    worldRot: Quat;
    scale: Vec3;
}

interface Drag {
    layout: Layout;
    handle: Handle;
    items: DragItem[];
    startX: number;
    startY: number;
    startHit: Vec3 | null;
    startParam: number;
    startVec: Vec3 | null;
    rotAxis: Vec3;
    angle: number;
    lastRaw: number;
    tangent: [number, number] | null;
    changed: boolean;
    /** Display info for the overlay. */
    info: string;
}

const LABELS: Record<Exclude<Tool, 'select'>, string> = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' };

/**
 * Translate / rotate / scale gizmo drawn on the 2D overlay. Dragging writes
 * the document inside one store transaction, so a drag is one undo step.
 */
export class Gizmo {
    hover: Handle | null = null;
    private drag: Drag | null = null;

    constructor(private store: Store, private picker: Picker) {}

    get dragging(): boolean {
        return !!this.drag;
    }

    get dragInfo(): string {
        return this.drag?.info ?? '';
    }

    /** Layout used for hit testing and drag math; frozen while dragging. */
    layout(): Layout | null {
        return this.drag ? this.drag.layout : this.computeLayout();
    }

    /** Layout at the object's current transform. */
    private computeLayout(): Layout | null {
        const tool = this.store.prefs.tool;
        if (tool === 'select') return null;
        const node = this.store.primary;
        if (!node) return null;
        const m = this.picker.worldMatrix(node.id);
        if (!m) return null;
        const pivot: Vec3 = [m[12], m[13], m[14]];
        const local = tool === 'scale' || this.store.prefs.space === 'local';
        const axes: [Vec3, Vec3, Vec3] = local
            ? [normalize(getColumn(m, 0)), normalize(getColumn(m, 1)), normalize(getColumn(m, 2))]
            : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        for (let i = 0; i < 3; i++) if (len(axes[i]) < 0.5) axes[i] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]][i] as Vec3;
        const center = this.picker.project(pivot);
        if (!center.visible) return null;
        return { mode: tool, pivot, axes, length: this.picker.pixelSize(pivot) * GIZMO_PX, center };
    }

    // ------------------------------------------------------------ hit test

    hitTest(x: number, y: number): Handle | null {
        const L = this.layout();
        if (!L) return null;
        const c = L.center;
        if (L.mode === 'translate') {
            if (Math.hypot(x - c.x, y - c.y) < 9) return 'view';
            for (const p of PLANES) {
                const quad = this.planeQuad(L, p.a, p.b);
                if (quad && pointInPoly(x, y, quad)) return p.handle;
            }
            for (let i = 0; i < 3; i++) {
                const end = this.axisEnd(L, i);
                if (end && distToSegment(x, y, c.x, c.y, end.x, end.y) < 8) return AXIS_HANDLES[i];
            }
        } else if (L.mode === 'scale') {
            if (Math.abs(x - c.x) < 9 && Math.abs(y - c.y) < 9) return 'uniform';
            for (let i = 0; i < 3; i++) {
                const end = this.axisEnd(L, i);
                if (end && distToSegment(x, y, c.x, c.y, end.x, end.y) < 8) return AXIS_HANDLES[i];
            }
        } else {
            let best: Handle | null = null;
            let bestD = 8;
            for (let i = 0; i < 3; i++) {
                const d = this.ringDistance(L, i, x, y);
                if (d < bestD) {
                    bestD = d;
                    best = AXIS_HANDLES[i];
                }
            }
            if (best) return best;
            const r = this.viewRingRadius(L);
            if (Math.abs(Math.hypot(x - c.x, y - c.y) - r) < 7) return 'view';
        }
        return null;
    }

    private axisEnd(L: Layout, i: number): ScreenPoint | null {
        const end = this.picker.project(add(L.pivot, scale(L.axes[i], L.length)));
        if (!end.visible) return null;
        // An axis pointing at the camera cannot be dragged meaningfully.
        if (Math.hypot(end.x - L.center.x, end.y - L.center.y) < 14) return null;
        return end;
    }

    private planeQuad(L: Layout, a: number, b: number): [number, number][] | null {
        const s0 = L.length * 0.22, s1 = L.length * 0.42;
        const A = L.axes[a], B = L.axes[b];
        const pts = [
            add(L.pivot, add(scale(A, s0), scale(B, s0))),
            add(L.pivot, add(scale(A, s1), scale(B, s0))),
            add(L.pivot, add(scale(A, s1), scale(B, s1))),
            add(L.pivot, add(scale(A, s0), scale(B, s1))),
        ].map((p) => this.picker.project(p));
        if (pts.some((p) => !p.visible)) return null;
        const quad = pts.map((p) => [p.x, p.y] as [number, number]);
        return Math.abs(polyArea(quad)) < 30 ? null : quad;
    }

    private ringPoints(L: Layout, i: number, radius = L.length): { p: ScreenPoint; front: boolean }[] {
        const axis = L.axes[i];
        const u = normalize(Math.abs(axis[1]) < 0.9 ? cross(axis, [0, 1, 0]) : cross(axis, [1, 0, 0]));
        const v = cross(axis, u);
        const toEye = normalize(sub(this.picker.eye, L.pivot));
        const out: { p: ScreenPoint; front: boolean }[] = [];
        const N = 72;
        for (let k = 0; k <= N; k++) {
            const t = (k / N) * Math.PI * 2;
            const dir = add(scale(u, Math.cos(t)), scale(v, Math.sin(t)));
            out.push({ p: this.picker.project(add(L.pivot, scale(dir, radius))), front: dot(dir, toEye) > -0.05 });
        }
        return out;
    }

    private ringDistance(L: Layout, i: number, x: number, y: number): number {
        const pts = this.ringPoints(L, i);
        let best = Infinity;
        for (let k = 0; k < pts.length - 1; k++) {
            const a = pts[k], b = pts[k + 1];
            if (!a.front || !b.front || !a.p.visible || !b.p.visible) continue;
            best = Math.min(best, distToSegment(x, y, a.p.x, a.p.y, b.p.x, b.p.y));
        }
        return best;
    }

    private viewRingRadius(L: Layout): number {
        return (L.length / this.picker.pixelSize(L.pivot)) * 1.18;
    }

    // ---------------------------------------------------------------- drag

    begin(handle: Handle, x: number, y: number): boolean {
        const L = this.layout();
        if (!L) return false;
        const ids = this.store.selectionRoots();
        const items: DragItem[] = [];
        for (const id of ids) {
            const node = this.store.node(id);
            const world = this.picker.worldMatrix(id);
            if (!node || !world) continue;
            const parentWorld = node.parent ? this.picker.worldMatrix(node.parent) : null;
            const invParent = (parentWorld && invert(parentWorld)) || mat4();
            items.push({
                id,
                invParent,
                parentRot: parentWorld ? quatFromMatrix(parentWorld) : [0, 0, 0, 1],
                worldPos: [world[12], world[13], world[14]],
                worldRot: quatFromMatrix(world),
                scale: [...node.scale] as Vec3,
            });
        }
        if (!items.length) return false;

        const drag: Drag = {
            layout: L,
            handle,
            items,
            startX: x,
            startY: y,
            startHit: null,
            startParam: 0,
            startVec: null,
            rotAxis: [0, 1, 0],
            angle: 0,
            lastRaw: 0,
            tangent: null,
            changed: false,
            info: '',
        };

        const ray = this.picker.ray(x, y);
        if (L.mode === 'translate') {
            if (handle === 'x' || handle === 'y' || handle === 'z') {
                const axis = L.axes[AXIS_HANDLES.indexOf(handle)];
                const s = closestOnLine(ray, L.pivot, axis);
                if (s === null) return false;
                drag.startParam = s;
            } else {
                const n = this.planeNormal(L, handle);
                const t = rayPlane(ray, L.pivot, n) ?? rayPlane(ray, L.pivot, scale(n, -1));
                if (t === null) return false;
                drag.startHit = rayAt(ray, t);
            }
        } else if (L.mode === 'rotate') {
            const axis = handle === 'view' ? normalize(sub(L.pivot, this.picker.eye)) : L.axes[AXIS_HANDLES.indexOf(handle)];
            drag.rotAxis = axis;
            const edgeOn = Math.abs(dot(axis, normalize(sub(L.pivot, this.picker.eye)))) < 0.12;
            const t = edgeOn ? null : rayPlane(ray, L.pivot, axis) ?? rayPlane(ray, L.pivot, scale(axis, -1));
            if (t !== null) {
                drag.startVec = normalize(sub(rayAt(ray, t), L.pivot));
            } else {
                // Edge-on ring: rotate by dragging along the ring's screen tangent.
                const c = L.center;
                const r = normalize([x - c.x, y - c.y, 0]);
                drag.tangent = [-r[1], r[0]];
                if (!r[0] && !r[1]) drag.tangent = [1, 0];
            }
        }

        this.drag = drag;
        this.store.begin(LABELS[L.mode]);
        return true;
    }

    private planeNormal(L: Layout, handle: Handle): Vec3 {
        if (handle === 'view') return normalize(sub(this.picker.eye, L.pivot));
        const p = PLANES.find((q) => q.handle === handle)!;
        return L.axes[p.n];
    }

    move(x: number, y: number, snapToggle: boolean) {
        const d = this.drag;
        if (!d) return;
        const L = d.layout;
        const prefs = this.store.prefs;
        const snapping = prefs.snap !== snapToggle;
        const ray = this.picker.ray(x, y);
        const ids = d.items.map((i) => i.id);

        if (L.mode === 'translate') {
            let delta: Vec3 | null = null;
            if (d.handle === 'x' || d.handle === 'y' || d.handle === 'z') {
                const axis = L.axes[AXIS_HANDLES.indexOf(d.handle)];
                const s = closestOnLine(ray, L.pivot, axis);
                if (s === null) return;
                // Guard against runaway values when the ray grazes the axis.
                const limit = this.picker.pixelSize(L.pivot) * 20000;
                delta = scale(axis, Math.max(-limit, Math.min(limit, s - d.startParam)));
            } else {
                const n = this.planeNormal(L, d.handle);
                const t = rayPlane(ray, L.pivot, n) ?? rayPlane(ray, L.pivot, scale(n, -1));
                if (t === null) return;
                delta = sub(rayAt(ray, t), d.startHit!);
            }
            if (snapping) delta = this.snapDelta(L, d.handle, delta, prefs.snapMove);
            this.store.update((doc) => {
                for (const it of d.items) {
                    const node = doc.nodes.find((n) => n.id === it.id);
                    if (!node) continue;
                    node.position = tidy3(transformPoint(it.invParent, add(it.worldPos, delta!)));
                }
            }, { nodes: ids });
            d.info = `Δ ${fmt(delta[0])}, ${fmt(delta[1])}, ${fmt(delta[2])}`;
        } else if (L.mode === 'rotate') {
            let raw: number;
            if (d.startVec) {
                const t = rayPlane(ray, L.pivot, d.rotAxis) ?? rayPlane(ray, L.pivot, scale(d.rotAxis, -1));
                if (t === null) return;
                const cur = normalize(sub(rayAt(ray, t), L.pivot));
                raw = Math.atan2(dot(cross(d.startVec, cur), d.rotAxis), dot(d.startVec, cur));
                // Unwrap so continuous drags can pass +-180 degrees.
                let diff = raw - d.lastRaw;
                if (diff > Math.PI) diff -= Math.PI * 2;
                if (diff < -Math.PI) diff += Math.PI * 2;
                d.angle += diff;
                d.lastRaw = raw;
            } else {
                const [tx, ty] = d.tangent!;
                const px = (x - d.startX) * tx + (y - d.startY) * ty;
                d.angle = (px / GIZMO_PX) * Math.PI * 0.5;
            }
            let angle = d.angle;
            if (snapping) angle = snap(angle / DEG, prefs.snapRotate) * DEG;
            const dq = quatAxisAngle(d.rotAxis, angle);
            this.store.update((doc) => {
                for (const it of d.items) {
                    const node = doc.nodes.find((n) => n.id === it.id);
                    if (!node) continue;
                    const world = quatMul(dq, it.worldRot);
                    const local = quatMul(quatInvert(it.parentRot), world);
                    node.rotation = tidy3(eulerFromQuat(local), 4);
                }
            }, { nodes: ids });
            d.info = `${fmt(angle / DEG, 1)}°`;
        } else {
            let factors: Vec3;
            if (d.handle === 'uniform') {
                const f = Math.max(0.01, 1 + (x - d.startX - (y - d.startY)) / 120);
                factors = [f, f, f];
            } else {
                const i = AXIS_HANDLES.indexOf(d.handle);
                const end = this.picker.project(add(L.pivot, scale(L.axes[i], L.length)));
                const ux = end.x - L.center.x, uy = end.y - L.center.y;
                const l = Math.hypot(ux, uy) || 1;
                const f = Math.max(0.01, 1 + ((x - d.startX) * ux + (y - d.startY) * uy) / (l * l));
                factors = [1, 1, 1];
                factors[i] = f;
            }
            this.store.update((doc) => {
                for (const it of d.items) {
                    const node = doc.nodes.find((n) => n.id === it.id);
                    if (!node) continue;
                    let s: Vec3 = [it.scale[0] * factors[0], it.scale[1] * factors[1], it.scale[2] * factors[2]];
                    if (snapping) s = s.map((v, k) => (factors[k] !== 1 ? snap(v, prefs.snapScale) || prefs.snapScale : v)) as Vec3;
                    node.scale = tidy3(s, 4);
                }
            }, { nodes: ids });
            const shown = d.handle === 'uniform' ? factors[0] : factors[AXIS_HANDLES.indexOf(d.handle)];
            d.info = `×${fmt(shown, 3)}`;
        }
        d.changed = true;
    }

    private snapDelta(L: Layout, handle: Handle, delta: Vec3, step: number): Vec3 {
        const world = L.axes[0][0] === 1 && L.axes[1][1] === 1 && L.axes[2][2] === 1;
        const moving = handle === 'view' ? [0, 1, 2] : handle.split('').map((c) => 'xyz'.indexOf(c));
        if (world) {
            // Snap the resulting pivot position to the grid.
            const out: Vec3 = [...delta] as Vec3;
            for (const k of moving) out[k] = snap(L.pivot[k] + delta[k], step) - L.pivot[k];
            return out;
        }
        let out: Vec3 = [0, 0, 0];
        for (const k of moving) out = add(out, scale(L.axes[k], snap(dot(delta, L.axes[k]), step)));
        return out;
    }

    end() {
        if (!this.drag) return;
        this.drag = null;
        this.store.end();
    }

    cancel() {
        if (!this.drag) return;
        this.drag = null;
        this.store.cancel();
    }

    // ---------------------------------------------------------------- draw

    draw(ctx: CanvasRenderingContext2D) {
        // Follow the object while dragging; the drag math keeps the start layout.
        const L = this.computeLayout();
        if (!L) return;
        const active = this.drag?.handle ?? null;
        const colorOf = (h: Handle, base: string) => (h === active || (!active && h === this.hover) ? HOVER : base);
        const c = L.center;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (L.mode === 'translate' || L.mode === 'scale') {
            if (L.mode === 'translate') {
                for (const p of PLANES) {
                    if (active && active !== p.handle) continue;
                    const quad = this.planeQuad(L, p.a, p.b);
                    if (!quad) continue;
                    const col = colorOf(p.handle, AXIS_COLORS[p.n]);
                    ctx.beginPath();
                    quad.forEach(([qx, qy], k) => (k ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy)));
                    ctx.closePath();
                    ctx.globalAlpha = 0.28;
                    ctx.fillStyle = col;
                    ctx.fill();
                    ctx.globalAlpha = 0.9;
                    ctx.strokeStyle = col;
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    ctx.globalAlpha = 1;
                }
            }
            // Draw far axes first so near ones stay on top.
            const order = [0, 1, 2].sort((a, b) => {
                const da = this.picker.project(add(L.pivot, scale(L.axes[a], L.length))).depth;
                const db = this.picker.project(add(L.pivot, scale(L.axes[b], L.length))).depth;
                return db - da;
            });
            for (const i of order) {
                const h = AXIS_HANDLES[i];
                if (active && active !== h && !(active === 'uniform' || (active.length === 2 && active.includes(h)) || active === 'view')) continue;
                const end = this.axisEnd(L, i);
                if (!end) continue;
                const col = colorOf(h, AXIS_COLORS[i]);
                ctx.strokeStyle = col;
                ctx.fillStyle = col;
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(c.x, c.y);
                ctx.lineTo(end.x, end.y);
                ctx.stroke();
                const ang = Math.atan2(end.y - c.y, end.x - c.x);
                if (L.mode === 'translate') {
                    ctx.beginPath();
                    ctx.moveTo(end.x + Math.cos(ang) * 12, end.y + Math.sin(ang) * 12);
                    ctx.lineTo(end.x + Math.cos(ang + 2.6) * 7, end.y + Math.sin(ang + 2.6) * 7);
                    ctx.lineTo(end.x + Math.cos(ang - 2.6) * 7, end.y + Math.sin(ang - 2.6) * 7);
                    ctx.closePath();
                    ctx.fill();
                } else {
                    ctx.fillRect(end.x - 5, end.y - 5, 10, 10);
                }
                ctx.font = '600 11px Inter, system-ui, sans-serif';
                ctx.fillText('XYZ'[i], end.x + Math.cos(ang) * 22 - 4, end.y + Math.sin(ang) * 22 + 4);
            }
            if (L.mode === 'translate') {
                ctx.beginPath();
                ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
                ctx.fillStyle = colorOf('view', 'rgba(255,255,255,0.85)');
                ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.45)';
                ctx.lineWidth = 1;
                ctx.stroke();
            } else {
                ctx.fillStyle = colorOf('uniform', 'rgba(255,255,255,0.9)');
                ctx.fillRect(c.x - 6, c.y - 6, 12, 12);
                ctx.strokeStyle = 'rgba(0,0,0,0.45)';
                ctx.strokeRect(c.x - 6, c.y - 6, 12, 12);
            }
        } else {
            const r = this.viewRingRadius(L);
            if (!active || active === 'view') {
                ctx.beginPath();
                ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
                ctx.strokeStyle = colorOf('view', 'rgba(230,230,230,0.75)');
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            ctx.beginPath();
            ctx.arc(c.x, c.y, r / 1.18, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            ctx.fill();
            for (let i = 0; i < 3; i++) {
                const h = AXIS_HANDLES[i];
                if (active && active !== h) continue;
                const pts = this.ringPoints(L, i);
                const col = colorOf(h, AXIS_COLORS[i]);
                for (const front of [false, true]) {
                    ctx.beginPath();
                    let open = false;
                    for (let k = 0; k < pts.length - 1; k++) {
                        const a = pts[k], b = pts[k + 1];
                        if (a.front !== front || !a.p.visible || !b.p.visible) {
                            open = false;
                            continue;
                        }
                        if (!open) ctx.moveTo(a.p.x, a.p.y);
                        ctx.lineTo(b.p.x, b.p.y);
                        open = true;
                    }
                    ctx.strokeStyle = col;
                    ctx.globalAlpha = front ? 1 : 0.22;
                    ctx.lineWidth = front ? 2.5 : 1.5;
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
            }
            const d = this.drag;
            if (d && d.startVec && Math.abs(d.angle) > 1e-4) {
                // Swept angle wedge.
                const steps = Math.max(2, Math.ceil((Math.abs(d.angle) / (Math.PI * 2)) * 72));
                ctx.beginPath();
                ctx.moveTo(c.x, c.y);
                for (let k = 0; k <= steps; k++) {
                    const q = quatAxisAngle(d.rotAxis, (d.angle * k) / steps);
                    const v = rotate(q, d.startVec);
                    const p = this.picker.project(add(L.pivot, scale(v, L.length)));
                    if (p.visible) ctx.lineTo(p.x, p.y);
                }
                ctx.closePath();
                ctx.fillStyle = 'rgba(255,213,74,0.18)';
                ctx.fill();
            }
        }
        ctx.restore();
    }
}

function rotate(q: Quat, v: Vec3): Vec3 {
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

function fmt(v: number, digits = 2): string {
    return tidy(v, digits).toFixed(digits).replace(/\.?0+$/, '') || '0';
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function polyArea(poly: [number, number][]): number {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    return a / 2;
}


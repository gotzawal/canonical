import { add, normalize, scale, sub, transformDir } from '../core/math';
import type { Store } from '../core/store';
import type { NodeDoc, Vec3 } from '../core/types';
import type { Picker } from '../engine/picking';
import type { Runtime } from '../engine/runtime';
import type { SceneSync } from '../engine/sync';
import type { CameraController } from './cameraController';
import { AXIS_COLORS, Gizmo } from './gizmo';

type DragMode = 'none' | 'pending' | 'orbit' | 'pan' | 'gizmo' | 'pinch';

interface IconHit {
    id: string;
    x: number;
    y: number;
    r: number;
}

export interface ViewportHooks {
    onContextMenu(x: number, y: number, clientX: number, clientY: number, hitId: string | null): void;
    onDropFiles(files: File[], worldPoint: Vec3): void;
    onDropAsset(assetId: string, worldPoint: Vec3, hitId: string | null): void;
}

const SELECT_COLOR = '#ffa53d';
const HELPER_COLOR = 'rgba(255, 228, 150, 0.9)';

/**
 * The 3D viewport: an overlay canvas on top of the engine canvas that draws
 * helpers, selection and the gizmo, and turns pointer input into camera
 * moves, picking and gizmo drags.
 */
export class Viewport {
    readonly overlay: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private mode: DragMode = 'none';
    private downX = 0;
    private downY = 0;
    private lastX = 0;
    private lastY = 0;
    private downButton = 0;
    private icons: IconHit[] = [];
    private pointers = new Map<number, { x: number; y: number }>();
    private pinchDist = 0;
    private axisWidget: { x: number; y: number; r: number; yaw: number; pitch: number }[] = [];

    constructor(
        readonly el: HTMLElement,
        private runtime: Runtime,
        private store: Store,
        private sync: SceneSync,
        private picker: Picker,
        private camera: CameraController,
        readonly gizmo: Gizmo,
        private hooks: ViewportHooks,
    ) {
        this.overlay = document.createElement('canvas');
        this.overlay.className = 'viewport-overlay';
        this.overlay.tabIndex = 0;
        el.appendChild(this.overlay);
        this.ctx = this.overlay.getContext('2d')!;

        const o = this.overlay;
        o.addEventListener('pointerdown', (e) => this.onDown(e));
        o.addEventListener('pointermove', (e) => this.onMove(e));
        o.addEventListener('pointerup', (e) => this.onUp(e));
        o.addEventListener('pointercancel', (e) => this.onUp(e, true));
        o.addEventListener('lostpointercapture', (e) => {
            if (this.mode !== 'none') this.onUp(e as PointerEvent, true);
        });
        o.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        o.addEventListener('dblclick', (e) => this.onDoubleClick(e));
        o.addEventListener('contextmenu', (e) => e.preventDefault());
        o.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            el.classList.add('drop-target');
        });
        o.addEventListener('dragleave', () => el.classList.remove('drop-target'));
        o.addEventListener('drop', (e) => this.onDrop(e));

        runtime.onFrame(() => this.draw());
    }

    /** Pointer position in CSS pixels relative to the viewport. */
    private local(e: { clientX: number; clientY: number }): [number, number] {
        const r = this.overlay.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    // --------------------------------------------------------------- input

    private onDown(e: PointerEvent) {
        this.overlay.focus({ preventScroll: true });
        const [x, y] = this.local(e);
        this.pointers.set(e.pointerId, { x, y });
        this.overlay.setPointerCapture(e.pointerId);
        this.picker.update();

        if (this.pointers.size === 2) {
            // Second finger: switch to pinch / two-finger pan.
            if (this.mode === 'gizmo') this.gizmo.cancel();
            this.mode = 'pinch';
            const [a, b] = Array.from(this.pointers.values());
            this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
            this.lastX = (a.x + b.x) / 2;
            this.lastY = (a.y + b.y) / 2;
            return;
        }
        if (this.pointers.size > 2) return;

        this.downX = this.lastX = x;
        this.downY = this.lastY = y;
        this.downButton = e.button;
        if (e.button === 0 && !e.altKey) {
            const handle = this.gizmo.hitTest(x, y);
            if (handle && this.gizmo.begin(handle, x, y)) {
                this.mode = 'gizmo';
                return;
            }
            this.mode = 'pending';
        } else if (e.button === 0 && e.altKey) {
            this.mode = 'orbit';
        } else if (e.button === 1 || e.button === 2) {
            this.mode = 'pending';
        }
    }

    private onMove(e: PointerEvent) {
        const [x, y] = this.local(e);
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });

        if (this.mode === 'none') {
            this.picker.update();
            const hover = this.gizmo.hitTest(x, y);
            if (hover !== this.gizmo.hover) this.gizmo.hover = hover;
            this.overlay.style.cursor = hover ? 'pointer' : this.iconAt(x, y) ? 'pointer' : 'default';
            return;
        }
        if (this.mode === 'pinch') {
            if (this.pointers.size < 2) return;
            const [a, b] = Array.from(this.pointers.values());
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            this.camera.pan(this.lastX, this.lastY, mx, my);
            if (this.pinchDist > 0 && dist > 0) this.camera.dolly(Math.log(this.pinchDist / dist), mx, my);
            this.pinchDist = dist;
            this.lastX = mx;
            this.lastY = my;
            return;
        }
        if (this.mode === 'gizmo') {
            this.picker.update();
            this.gizmo.move(x, y, e.ctrlKey || e.metaKey);
            this.lastX = x;
            this.lastY = y;
            return;
        }
        if (this.mode === 'pending') {
            if (Math.hypot(x - this.downX, y - this.downY) < 4) return;
            const pan = this.downButton !== 0 || e.shiftKey;
            this.mode = pan ? 'pan' : 'orbit';
            this.overlay.style.cursor = pan ? 'move' : 'grabbing';
        }
        const dx = x - this.lastX, dy = y - this.lastY;
        if (this.mode === 'orbit') this.camera.orbit(dx, dy);
        else if (this.mode === 'pan') this.camera.pan(this.lastX, this.lastY, x, y);
        this.lastX = x;
        this.lastY = y;
    }

    private onUp(e: PointerEvent, cancelled = false) {
        const [x, y] = this.local(e);
        this.pointers.delete(e.pointerId);
        const mode = this.mode;
        // Leave the drag state before releasing capture, which may report lostpointercapture.
        if (mode !== 'pinch' || this.pointers.size === 0) this.mode = 'none';
        if (this.overlay.hasPointerCapture?.(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
        if (mode === 'pinch') return;
        this.overlay.style.cursor = 'default';
        if (mode === 'gizmo') {
            if (cancelled) this.gizmo.cancel();
            else this.gizmo.end();
            return;
        }
        if (mode === 'pending' && !cancelled) {
            this.picker.update();
            if (this.downButton === 0) this.clickSelect(x, y, e.shiftKey || e.ctrlKey || e.metaKey);
            else if (this.downButton === 2) {
                const id = this.hitId(x, y);
                if (id && !this.store.selection.includes(id)) this.store.select([id]);
                this.hooks.onContextMenu(x, y, e.clientX, e.clientY, id);
            }
        }
    }

    /** Escape during a drag restores the state from before the drag. */
    cancelInteraction(): boolean {
        if (this.mode === 'gizmo') {
            this.gizmo.cancel();
            this.mode = 'none';
            return true;
        }
        return false;
    }

    private onWheel(e: WheelEvent) {
        e.preventDefault();
        const [x, y] = this.local(e);
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= 400;
        this.camera.dolly(Math.max(-1, Math.min(1, dy * 0.0012)), x, y);
    }

    private onDoubleClick(e: MouseEvent) {
        const [x, y] = this.local(e);
        this.picker.update();
        const id = this.hitId(x, y);
        if (!id) return;
        this.store.select([id]);
        this.frameNodes([id]);
    }

    private hitId(x: number, y: number): string | null {
        const icon = this.iconAt(x, y);
        if (icon) return icon.id;
        return this.picker.pick(x, y)?.id ?? null;
    }

    private clickSelect(x: number, y: number, additive: boolean) {
        const axis = this.axisWidget.find((a) => Math.hypot(a.x - x, a.y - y) <= a.r + 2);
        if (axis) {
            this.camera.setView(axis.yaw, axis.pitch);
            return;
        }
        const id = this.hitId(x, y);
        if (id) this.store.select([id], additive ? 'toggle' : 'replace');
        else if (!additive) this.store.select([]);
    }

    private iconAt(x: number, y: number): IconHit | null {
        let best: IconHit | null = null;
        let bestD = Infinity;
        for (const icon of this.icons) {
            const d = Math.hypot(icon.x - x, icon.y - y);
            if (d <= icon.r && d < bestD) {
                best = icon;
                bestD = d;
            }
        }
        return best;
    }

    private onDrop(e: DragEvent) {
        e.preventDefault();
        this.el.classList.remove('drop-target');
        const [x, y] = this.local(e);
        this.picker.update();
        const point = this.groundPoint(x, y);
        const assetId = e.dataTransfer?.getData('application/x-canonical-asset');
        if (assetId) {
            this.hooks.onDropAsset(assetId, point, this.picker.pick(x, y)?.id ?? null);
            return;
        }
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length) this.hooks.onDropFiles(files, point);
    }

    /** Surface point under the cursor, else the ground plane, else in front of the camera. */
    groundPoint(x: number, y: number): Vec3 {
        const hit = this.picker.pick(x, y);
        if (hit) return hit.point;
        const ray = this.picker.ray(x, y);
        if (ray.dir[1] < -1e-4) {
            const t = -ray.origin[1] / ray.dir[1];
            if (t > 0 && t < 500) return add(ray.origin, scale(ray.dir, t));
        }
        return [...this.store.camera.target] as Vec3;
    }

    /** Where new objects go: the ground under the view center, else the orbit target. */
    spawnPoint(): Vec3 {
        const [w, h] = this.runtime.cssSize;
        this.picker.update();
        const ray = this.picker.ray(w / 2, h / 2);
        if (ray.dir[1] < -1e-4) {
            const t = -ray.origin[1] / ray.dir[1];
            if (t > 0 && t < this.store.camera.distance * 4) return add(ray.origin, scale(ray.dir, t));
        }
        const target = this.store.camera.target;
        return [target[0], 0, target[2]];
    }

    frameNodes(ids: string[]) {
        this.picker.update();
        let box: { min: Vec3; max: Vec3 } | null = null;
        let fallback: Vec3 | undefined;
        for (const id of ids) {
            const b = this.picker.bounds(id);
            const m = this.picker.worldMatrix(id);
            if (m && !fallback) fallback = [m[12], m[13], m[14]];
            if (!b) {
                if (m) {
                    const p: Vec3 = [m[12], m[13], m[14]];
                    box = merge(box, { min: sub(p, [0.5, 0.5, 0.5]), max: add(p, [0.5, 0.5, 0.5]) });
                }
                continue;
            }
            box = merge(box, b);
        }
        this.camera.frame(box, fallback);
    }

    frameAll() {
        this.frameNodes(this.store.doc.nodes.filter((n) => !n.parent).map((n) => n.id));
    }

    // ---------------------------------------------------------------- draw

    private draw() {
        const o = this.overlay;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const [w, h] = this.runtime.cssSize;
        if (!w || !h) return;
        if (o.width !== Math.round(w * dpr) || o.height !== Math.round(h * dpr)) {
            o.width = Math.round(w * dpr);
            o.height = Math.round(h * dpr);
        }
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        this.picker.update();

        const selected = new Set(this.store.selection);
        this.icons = [];
        for (const node of this.store.doc.nodes) {
            const entry = this.sync.entries.get(node.id);
            if (!entry) continue;
            const isSel = selected.has(node.id);
            if (this.store.prefs.helpers || isSel) this.drawHelper(node, isSel, entry.visible);
            if (isSel) this.drawSelection(node);
        }
        this.gizmo.draw(ctx);

        const info = this.gizmo.dragInfo;
        if (info) {
            ctx.font = '600 12px Inter, system-ui, sans-serif';
            const tw = ctx.measureText(info).width;
            const bx = this.lastX + 16, by = this.lastY + 14;
            ctx.fillStyle = 'rgba(20,22,27,0.85)';
            roundRect(ctx, bx, by, tw + 14, 22, 5);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.fillText(info, bx + 7, by + 15);
        }
        this.drawAxisWidget(w);
    }

    private drawSelection(node: NodeDoc) {
        const ctx = this.ctx;
        const boxes = this.picker.localBoxes(node.id);
        ctx.save();
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = 1.5;
        for (const corners of boxes) {
            const p = corners.map((c) => this.picker.project(c));
            ctx.beginPath();
            for (const [a, b] of BOX_EDGES) {
                if (!p[a].visible || !p[b].visible) continue;
                ctx.moveTo(p[a].x, p[a].y);
                ctx.lineTo(p[b].x, p[b].y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    private drawHelper(node: NodeDoc, selected: boolean, visible: boolean) {
        const m = this.picker.worldMatrix(node.id);
        if (!m) return;
        const pos: Vec3 = [m[12], m[13], m[14]];
        const sp = this.picker.project(pos);
        if (!sp.visible) return;
        const ctx = this.ctx;
        const color = selected ? SELECT_COLOR : HELPER_COLOR;
        ctx.save();
        ctx.globalAlpha = visible ? 1 : 0.35;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5;

        if (node.light) {
            const dir = normalize(transformDir(m, [0, 0, 1]));
            const type = node.light.type;
            if (type === 'directional') {
                drawSun(ctx, sp.x, sp.y);
                const end = this.picker.project(add(pos, scale(dir, this.picker.pixelSize(pos) * 60)));
                if (end.visible) dashed(ctx, sp.x, sp.y, end.x, end.y);
            } else if (type === 'point') {
                drawBulb(ctx, sp.x, sp.y);
                if (selected) this.drawSphere(pos, node.light.range);
            } else {
                drawSpot(ctx, sp.x, sp.y);
                if (selected) this.drawCone(pos, dir, node.light.range, node.light.outerAngle);
                else {
                    const end = this.picker.project(add(pos, scale(dir, this.picker.pixelSize(pos) * 50)));
                    if (end.visible) dashed(ctx, sp.x, sp.y, end.x, end.y);
                }
            }
            this.icons.push({ id: node.id, x: sp.x, y: sp.y, r: 13 });
        } else if (!node.mesh && !node.model) {
            ctx.beginPath();
            ctx.moveTo(sp.x - 6, sp.y);
            ctx.lineTo(sp.x, sp.y - 6);
            ctx.lineTo(sp.x + 6, sp.y);
            ctx.lineTo(sp.x, sp.y + 6);
            ctx.closePath();
            ctx.stroke();
            this.icons.push({ id: node.id, x: sp.x, y: sp.y, r: 9 });
        } else if (node.model && this.sync.modelState(node.id)?.status !== 'ready') {
            ctx.font = '600 11px Inter, system-ui, sans-serif';
            const state = this.sync.modelState(node.id);
            ctx.fillText(state?.status === 'error' ? 'model failed' : 'loading...', sp.x + 8, sp.y - 8);
            ctx.strokeRect(sp.x - 5, sp.y - 5, 10, 10);
            this.icons.push({ id: node.id, x: sp.x, y: sp.y, r: 10 });
        }
        ctx.restore();
    }

    private drawSphere(center: Vec3, radius: number) {
        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha *= 0.6;
        const rings: [Vec3, Vec3][] = [[[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]]];
        for (const [u, v] of rings) this.drawCircle3D(center, u, v, radius);
        ctx.restore();
    }

    private drawCone(apex: Vec3, dir: Vec3, range: number, angle: number) {
        const ctx = this.ctx;
        const half = (Math.min(179, Math.max(1, angle)) * Math.PI) / 360;
        const r = Math.tan(half) * range;
        const base = add(apex, scale(dir, range));
        const u = normalize(Math.abs(dir[1]) < 0.9 ? [dir[2], 0, -dir[0]] : [1, 0, 0]);
        const v = normalize([dir[1] * u[2] - dir[2] * u[1], dir[2] * u[0] - dir[0] * u[2], dir[0] * u[1] - dir[1] * u[0]]);
        ctx.save();
        ctx.globalAlpha *= 0.7;
        this.drawCircle3D(base, u, v, r);
        const a = this.picker.project(apex);
        for (let k = 0; k < 4; k++) {
            const t = (k / 4) * Math.PI * 2;
            const p = this.picker.project(add(base, add(scale(u, Math.cos(t) * r), scale(v, Math.sin(t) * r))));
            if (a.visible && p.visible) {
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    private drawCircle3D(center: Vec3, u: Vec3, v: Vec3, r: number) {
        const ctx = this.ctx;
        ctx.beginPath();
        let open = false;
        for (let k = 0; k <= 64; k++) {
            const t = (k / 64) * Math.PI * 2;
            const p = this.picker.project(add(center, add(scale(u, Math.cos(t) * r), scale(v, Math.sin(t) * r))));
            if (!p.visible) {
                open = false;
                continue;
            }
            if (open) ctx.lineTo(p.x, p.y);
            else ctx.moveTo(p.x, p.y);
            open = true;
        }
        ctx.stroke();
    }

    private drawAxisWidget(width: number) {
        const ctx = this.ctx;
        const cx = width - 52, cy = 52, len = 30;
        const target = this.store.camera.target;
        const unit = this.picker.pixelSize(target) * 40;
        const c = this.picker.project(target);
        const axes: { dir: [number, number]; depth: number; i: number; sign: number }[] = [];
        for (let i = 0; i < 3; i++) {
            for (const sign of [1, -1]) {
                const d: Vec3 = [0, 0, 0];
                d[i] = sign * unit;
                const p = this.picker.project(add(target, d));
                if (!c.visible || !p.visible) continue;
                axes.push({ dir: [(p.x - c.x) / 40, (p.y - c.y) / 40], depth: p.depth, i, sign });
            }
        }
        axes.sort((a, b) => b.depth - a.depth);
        this.axisWidget = [];
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, 44, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(15,17,21,0.35)';
        ctx.fill();
        for (const a of axes) {
            const x = cx + a.dir[0] * len, y = cy + a.dir[1] * len;
            const col = AXIS_COLORS[a.i];
            if (a.sign > 0) {
                ctx.strokeStyle = col;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(x, y);
                ctx.stroke();
            }
            ctx.beginPath();
            ctx.arc(x, y, a.sign > 0 ? 8 : 6, 0, Math.PI * 2);
            ctx.fillStyle = a.sign > 0 ? col : 'rgba(40,44,52,0.9)';
            ctx.fill();
            if (a.sign < 0) {
                ctx.strokeStyle = col;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            } else {
                ctx.fillStyle = '#0d0f12';
                ctx.font = '700 10px Inter, system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('XYZ'[a.i], x, y + 3.5);
                ctx.textAlign = 'start';
            }
            // Clicking a handle looks at the scene from that side.
            const views: [number, number][][] = [
                [[90, 0], [270, 0]],
                [[this.store.camera.yaw, 89.5], [this.store.camera.yaw, -89.5]],
                [[0, 0], [180, 0]],
            ];
            const [yaw, pitch] = views[a.i][a.sign > 0 ? 0 : 1];
            this.axisWidget.push({ x, y, r: 8, yaw, pitch });
        }
        ctx.restore();
    }
}

const BOX_EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
];

function merge(a: { min: Vec3; max: Vec3 } | null, b: { min: Vec3; max: Vec3 }) {
    if (!a) return { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
    return {
        min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])] as Vec3,
        max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] as Vec3,
    };
}

function dashed(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
}

function drawSun(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ctx.moveTo(x + Math.cos(a) * 8, y + Math.sin(a) * 8);
        ctx.lineTo(x + Math.cos(a) * 12, y + Math.sin(a) * 12);
    }
    ctx.stroke();
}

function drawBulb(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.beginPath();
    ctx.arc(x, y - 2, 6, Math.PI * 0.8, Math.PI * 2.2);
    ctx.lineTo(x + 3, y + 6);
    ctx.lineTo(x - 3, y + 6);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 3, y + 9);
    ctx.lineTo(x + 3, y + 9);
    ctx.stroke();
}

function drawSpot(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 7);
    ctx.lineTo(x + 4, y - 7);
    ctx.lineTo(x + 8, y + 5);
    ctx.lineTo(x - 8, y + 5);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y + 5, 3, 0, Math.PI);
    ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

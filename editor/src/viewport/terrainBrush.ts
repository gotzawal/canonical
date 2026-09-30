// The terrain brush in the viewport: while the inspector's brush has a tool,
// a left drag on the selected terrain sculpts or paints it, one undo step a
// stroke, and a ring on the ground shows where it works and how wide.

import { groundHeight } from '../core/terrain';
import type { BrushTool, TerrainStroke } from '../design/terrainEdit';
import type { Editor } from '../editor';
import { paintOf, type Paint } from '../engine/terrain';
import { toast } from '../ui/overlays';

const COLORS: Record<BrushTool, string> = {
    raise: '#8be28b',
    lower: '#ff8c7a',
    flatten: '#7cc4ff',
    smooth: '#d6b3ff',
    path: '#ffb86b',
    paint: '#f5d76e',
};

interface Stroke {
    id: string;
    pointer: number;
    tool: BrushTool;
    /** Shift turns raising into lowering and back. */
    invert: boolean;
    /** Flatten: the world height where the stroke started. */
    target: number;
    /** Where the last dab went (world x, z). */
    last: [number, number] | null;
    time: number;
    edit: TerrainStroke | null;
    paint: Paint | null;
}

export class TerrainBrush {
    /** Where the brush is on the terrain (world x, y, z), or null. */
    private at: [number, number, number] | null = null;
    private stroke: Stroke | null = null;
    /** The strokes' work in order: a stroke starts once the one before it is saved. */
    private chain: Promise<unknown> = Promise.resolve();
    private offFrame: (() => void) | null = null;

    constructor(private editor: Editor, private overlay: HTMLCanvasElement, viewportEl: HTMLElement) {
        // Ahead of the viewport's own handlers, which select and move the camera.
        viewportEl.addEventListener('pointerdown', (e) => this.down(e), true);
        viewportEl.addEventListener('pointermove', (e) => this.move(e), true);
        viewportEl.addEventListener('pointerup', (e) => this.up(e), true);
        viewportEl.addEventListener('pointercancel', (e) => this.up(e), true);
        overlay.addEventListener('lostpointercapture', (e) => this.up(e));
        overlay.addEventListener('pointerleave', () => {
            if (!this.stroke) this.at = null;
        });
        editor.store.on('selection', () => {
            if (editor.brush.tool && !this.terrainId()) editor.setBrush({ tool: null });
        });
    }

    /** The selected terrain, the only object selected. */
    private terrainId(): string | null {
        const store = this.editor.store;
        const n = store.primary;
        return n?.terrain && store.selection.length === 1 ? n.id : null;
    }

    /** The brush works while it has a tool, a terrain is selected and the view shows the scene to edit (the gizmo hides meanwhile). */
    get active(): boolean {
        const ed = this.editor;
        return !!ed.brush.tool && !!this.terrainId() && ed.view === 'scene' && ed.player.state === 'stopped' && !ed.isolated;
    }

    private local(e: PointerEvent): [number, number] {
        const r = this.overlay.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    /** Where the pointer meets the terrain. */
    private hit(e: PointerEvent, id: string): [number, number, number] | null {
        const picker = this.editor.picker;
        picker.update();
        const [x, y] = this.local(e);
        const h = picker.terrainHit(picker.ray(x, y), 1e5, (t) => t !== id);
        return h ? [h.point[0], h.point[1], h.point[2]] : null;
    }

    private queue(fn: () => unknown) {
        this.chain = this.chain.then(fn).catch((err) => console.error('[editor] terrain brush', err));
    }

    private down(e: PointerEvent) {
        if (e.target !== this.overlay || e.button !== 0 || e.altKey || this.stroke || !this.active) return;
        const id = this.terrainId()!;
        const at = this.hit(e, id);
        if (!at) return;
        const node = this.editor.store.node(id)!;
        const brush = this.editor.brush;
        const tool = brush.tool!;
        if (tool === 'paint' && !node.terrain!.layers.length) {
            toast('Give the terrain a layer to paint first.', 'info');
            return;
        }
        e.stopPropagation();
        e.preventDefault();
        this.overlay.focus({ preventScroll: true });
        this.overlay.setPointerCapture(e.pointerId);
        this.at = at;
        const stroke: Stroke = { id, pointer: e.pointerId, tool, invert: e.shiftKey, target: at[1], last: null, time: performance.now(), edit: null, paint: null };
        this.stroke = stroke;
        const splat = tool === 'paint' && node.terrain!.splatmap ? this.editor.store.doc.assets.find((a) => a.id === node.terrain!.splatmap) : undefined;
        this.queue(async () => {
            stroke.edit = this.editor.terrainStroke(id);
            if (splat) stroke.paint = await paintOf(splat);
        });
        this.offFrame = this.editor.runtime.onBeforeFrame(() => this.tick());
    }

    private move(e: PointerEvent) {
        const s = this.stroke;
        if (s) {
            if (e.pointerId !== s.pointer) return;
            e.stopPropagation();
            this.at = this.hit(e, s.id);
            // Off the terrain the stroke pauses, and goes on from where the pointer comes back.
            if (!this.at) s.last = null;
            return;
        }
        if (e.target !== this.overlay) return;
        this.at = this.active && !e.buttons ? this.hit(e, this.terrainId()!) : null;
    }

    private up(e: PointerEvent) {
        const s = this.stroke;
        if (!s || e.pointerId !== s.pointer) return;
        e.stopPropagation();
        this.stroke = null;
        this.offFrame?.();
        this.offFrame = null;
        if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
        const name = this.editor.store.node(s.id)?.name ?? 'Terrain';
        this.queue(() => s.edit?.end(`${s.tool === 'paint' ? 'Paint' : 'Sculpt'} ${name}`));
    }

    /** A dab where the brush is, each frame of a stroke: its change scaled by the time since the last one. */
    private tick() {
        const s = this.stroke;
        const at = this.at;
        if (!s || !at) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - s.time) / 1000);
        s.time = now;
        const b = this.editor.brush;
        const cur: [number, number] = [at[0], at[2]];
        // A fast drag covers the way from the last dab.
        const points = s.last ? [s.last, cur] : [cur];
        s.last = cur;
        const radius = b.radius;
        // A share of the way to the target per frame, the same each second at any frame rate.
        const rate = (k: number) => 1 - Math.pow(1 - Math.min(0.999, b.strength), dt * k);
        const height = this.editor.sync.terrainView(s.id)?.frame.height ?? 10;
        const tool = s.tool;
        const layer = b.layer;
        this.queue(() => {
            const edit = s.edit;
            if (!edit) return;
            if (tool === 'paint') return edit.paintLayer(layer, { points, radius, strength: rate(6) }, s.paint);
            if (tool === 'raise' || tool === 'lower') {
                const op = (tool === 'raise') !== s.invert ? 'raise' : 'lower';
                // Meters a second at full strength: a tenth of the terrain's height range, at least one.
                edit.sculpt(op, { points, radius, strength: 1 }, { amount: b.strength * Math.max(1, height * 0.1) * dt });
            } else edit.sculpt(tool, { points, radius, strength: rate(10) }, tool === 'flatten' ? { target: s.target } : {});
        });
    }

    /** The ring on the ground (an overlay drawer). */
    draw(ctx: CanvasRenderingContext2D) {
        const at = this.at;
        if (!at || !(this.stroke || this.active)) return;
        const id = this.stroke?.id ?? this.terrainId();
        const land = this.editor.sync.terrains().find((t) => t.id === id);
        if (!land) return;
        const picker = this.editor.picker;
        const tool = this.stroke?.tool ?? this.editor.brush.tool!;
        const ring = (radius: number) => {
            ctx.beginPath();
            let open = false;
            for (let i = 0; i <= 64; i++) {
                const a = (i / 64) * Math.PI * 2;
                const x = at[0] + Math.cos(a) * radius;
                const z = at[2] + Math.sin(a) * radius;
                const p = picker.project([x, groundHeight(land.surface, x, z) + 0.05, z]);
                if (!p.visible) {
                    open = false;
                    continue;
                }
                if (open) ctx.lineTo(p.x, p.y);
                else ctx.moveTo(p.x, p.y);
                open = true;
            }
        };
        const r = this.editor.brush.radius;
        ctx.save();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
        ring(r);
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = COLORS[tool];
        ring(r);
        ctx.stroke();
        // Where it works at full strength fades out toward the edge.
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ring(r * 0.5);
        ctx.stroke();
        ctx.restore();
    }
}

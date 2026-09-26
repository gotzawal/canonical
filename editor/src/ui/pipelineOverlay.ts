import type { Editor } from '../editor';
import type { Vec3 } from '../core/types';

const AREA = 'rgba(120, 180, 255, 0.75)';
const ROUTE = 'rgba(255, 200, 90, 0.95)';
const DONE = 'rgba(90, 210, 140, 0.95)';

/**
 * Viewport drawing for the plan: the areas' rough bounds on the ground with
 * their names, and the route points in order (green once reached with the
 * walk camera). Shown with the helpers, while the plan has them.
 */
export function pipelineOverlay(editor: Editor): (ctx: CanvasRenderingContext2D) => void {
    return (ctx) => {
        const store = editor.store;
        if (!store.prefs.helpers || store.playing || editor.walk?.active) return;
        const d = store.doc.design;
        const picker = editor.picker;
        ctx.save();
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        for (const a of d.areas) {
            if (!a.bounds) continue;
            const { center: c, size: s } = a.bounds;
            const y = c[1];
            const corners: Vec3[] = [
                [c[0] - s[0] / 2, y, c[2] - s[2] / 2],
                [c[0] + s[0] / 2, y, c[2] - s[2] / 2],
                [c[0] + s[0] / 2, y, c[2] + s[2] / 2],
                [c[0] - s[0] / 2, y, c[2] + s[2] / 2],
            ];
            const p = corners.map((v) => picker.project(v));
            if (p.some((q) => !q.visible)) continue;
            ctx.strokeStyle = AREA;
            ctx.lineWidth = 1.2;
            ctx.setLineDash([6, 5]);
            ctx.beginPath();
            p.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
            ctx.closePath();
            ctx.stroke();
            ctx.setLineDash([]);
            const label = picker.project([c[0], y, c[2]]);
            if (label.visible) {
                ctx.fillStyle = AREA;
                ctx.fillText(a.name, label.x - ctx.measureText(a.name).width / 2, label.y);
            }
        }
        const route = d.play.route.filter((r) => r.position);
        let prev: { x: number; y: number } | null = null;
        route.forEach((r, i) => {
            const q = picker.project(r.position!);
            if (!q.visible) {
                prev = null;
                return;
            }
            if (prev) {
                ctx.strokeStyle = ROUTE;
                ctx.setLineDash([3, 4]);
                ctx.beginPath();
                ctx.moveTo(prev.x, prev.y);
                ctx.lineTo(q.x, q.y);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.fillStyle = r.visited ? DONE : ROUTE;
            ctx.beginPath();
            ctx.arc(q.x, q.y, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#111';
            const n = String(i + 1);
            ctx.fillText(n, q.x - ctx.measureText(n).width / 2, q.y + 4);
            ctx.fillStyle = r.visited ? DONE : ROUTE;
            ctx.fillText(r.name, q.x + 11, q.y + 4);
            prev = { x: q.x, y: q.y };
        });
        ctx.restore();
    };
}

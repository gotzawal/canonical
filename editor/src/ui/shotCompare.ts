import type { Editor } from '../editor';
import { getAssetUrl } from '../core/assets';
import { describeComparison, type CompareMode, type CompareResult } from '../core/compare';
import { stageDef } from '../design/stages';
import { clear, h } from './dom';
import { icon } from './icons';
import { lightbox, toast } from './overlays';

/**
 * The comparison card of the shown shot: a fresh capture next to its target
 * paintover and a map of where it is darker or brighter, with a score
 * computed on a small grid (no model call). In gray mode both images are
 * shown without color, so only the value structure counts. The user judges
 * and marks the shot as matching for the current stage.
 */
export class ShotCompare {
    readonly el: HTMLElement;
    private body: HTMLElement;
    private modeSel: HTMLSelectElement;
    private shotId: string | null = null;
    private mode: CompareMode = 'gray';
    private last: { blob: Blob; url: string; result: CompareResult; against: 'target' | 'concept'; ref: string; at: number } | null = null;
    private busy = false;

    constructor(private editor: Editor) {
        this.modeSel = h('select', { class: 'select', title: 'Compare lightness only (value structure) or the whole color' });
        for (const [v, l] of [['gray', 'Grayscale'], ['color', 'Color']]) this.modeSel.appendChild(h('option', { text: l, attrs: { value: v } }));
        this.modeSel.addEventListener('change', () => {
            this.mode = this.modeSel.value as CompareMode;
            void this.run();
        });
        this.modeSel.addEventListener('keydown', (e) => e.stopPropagation());
        const again = h('button', { class: 'icon-btn', title: 'Capture again and compare', attrs: { type: 'button' } }, icon('refresh', 15));
        again.addEventListener('click', () => void this.run());
        const close = h('button', { class: 'icon-btn', title: 'Close', attrs: { type: 'button' } }, icon('close', 15));
        close.addEventListener('click', () => this.close());
        this.body = h('div', { class: 'shot-compare-body' });
        this.el = h(
            'div',
            { class: 'shot-compare', attrs: { hidden: true } },
            h('div', { class: 'shot-compare-head' }, icon('graph', 15), h('span', { class: 'shot-compare-title', text: 'Compare with the target' }), h('div', { class: 'spacer' }), this.modeSel, again, close),
            this.body,
        );
        editor.pipeline.on('shot', (id) => {
            if (id !== this.shotId) this.close();
        });
        editor.store.on('change', () => {
            if (!this.el.hidden && this.last) this.renderFooter();
        });
    }

    get open(): boolean {
        return !this.el.hidden;
    }

    toggle(shotId: string) {
        if (this.open && this.shotId === shotId) this.close();
        else this.show(shotId);
    }

    show(shotId: string) {
        this.shotId = shotId;
        this.mode = this.editor.pipeline.compareMode;
        this.modeSel.value = this.mode;
        this.el.hidden = false;
        void this.run();
    }

    close() {
        this.el.hidden = true;
        this.forget();
        this.shotId = null;
    }

    private forget() {
        if (this.last) URL.revokeObjectURL(this.last.url);
        this.last = null;
    }

    private async run() {
        const id = this.shotId;
        if (!id || this.busy) return;
        this.busy = true;
        clear(this.body);
        this.body.appendChild(h('div', { class: 'muted small pad', text: 'Capturing and comparing...' }));
        try {
            const res = await this.editor.pipeline.compareShot(id, this.mode);
            if (this.shotId !== id || this.el.hidden) return;
            this.forget();
            this.last = { ...res, url: URL.createObjectURL(res.blob), at: Date.now() };
            this.render();
        } catch (e: any) {
            clear(this.body);
            this.body.appendChild(h('div', { class: 'design-note warn' }, icon('alert', 14), h('span', { text: e?.message || String(e) })));
        } finally {
            this.busy = false;
        }
    }

    private render() {
        const last = this.last;
        if (!last) return;
        const r = last.result;
        clear(this.body);
        const gray = r.mode === 'gray' ? ' gray' : '';
        const capture = h('img', { class: 'shot-compare-img' + gray, attrs: { src: last.url, alt: 'Capture' } });
        capture.addEventListener('click', () => lightbox(last.url, 'Capture'));
        const target = h('img', { class: 'shot-compare-img' + gray, attrs: { alt: last.against } });
        const meta = this.editor.store.doc.assets.find((a) => a.id === last.ref);
        if (meta) {
            void getAssetUrl(meta).then((url) => {
                if (!url) return;
                target.src = url;
                target.addEventListener('click', () => lightbox(url, last.against === 'target' ? 'Target paintover' : 'Concept'));
            });
        }
        const heat = h('img', { class: 'shot-compare-img heat', attrs: { src: r.heat, alt: 'Difference' } });
        const aspect = String(this.editor.pipeline.shot(this.shotId)?.aspect ?? 16 / 9);
        for (const img of [capture, target, heat]) img.style.aspectRatio = aspect;
        heat.addEventListener('click', () => lightbox(r.heat, 'Blue: the capture is darker, red: brighter'));
        const fig = (img: HTMLElement, caption: string) => h('figure', null, img, h('figcaption', { text: caption }));
        this.body.append(
            h('div', { class: 'shot-compare-images' }, fig(capture, 'Capture now'), fig(target, last.against === 'target' ? 'Target paintover' : 'Concept (no target yet)'), fig(heat, 'Darker / brighter')),
            h(
                'div',
                { class: 'shot-compare-metrics' },
                metric('Score', String(r.score), 'Reference only: 100 minus twice the mean difference on a 64 pixel grid'),
                metric('Structure', String(r.structure), 'Correlation of the lightness maps (100: lights and darks in the same places, whatever the exposure)'),
                metric('Brightness', `${r.brightness[0]} / ${r.brightness[1]}`, 'Mean lightness L* of the capture / the target'),
                metric('Contrast', `${r.contrast[0]} / ${r.contrast[1]}`, 'Spread of lightness of the capture / the target'),
                r.mode === 'color' ? metric('Saturation', `${r.chroma[0]} / ${r.chroma[1]}`, 'Mean chroma of the capture / the target') : null,
            ),
            h('ul', { class: 'shot-compare-notes' }, describeComparison(r).map((t) => h('li', { text: t }))),
            h('div', { class: 'shot-compare-foot' }),
        );
        this.renderFooter();
    }

    /** The mark for the current stage (kept up to date with the document). */
    private renderFooter() {
        const foot = this.body.querySelector('.shot-compare-foot') as HTMLElement | null;
        const last = this.last;
        const shot = this.editor.pipeline.shot(this.shotId);
        if (!foot || !last || !shot) return;
        clear(foot);
        const stage = this.editor.pipeline.design.stage;
        const def = stageDef(stage);
        if (stage === 'finish' && shot.target) {
            // The final comparison: the user approves the shot.
            const box = h('input', { attrs: { type: 'checkbox' } });
            box.checked = !!shot.approved;
            box.addEventListener('change', () => {
                this.editor.pipeline.updateShot(shot.id, { approved: box.checked }, box.checked ? 'Approve Shot' : 'Withdraw Shot Approval');
                if (box.checked) toast(`${shot.name} approved.`, 'success');
            });
            foot.append(h('label', { class: 'checkbox' }, box, h('span', { text: 'Approved (final)' })));
        } else if (def.matchLabel && shot.target) {
            const box = h('input', { attrs: { type: 'checkbox' } });
            box.checked = !!shot.matched?.includes(stage);
            box.addEventListener('change', async () => {
                await this.editor.pipeline.markMatched(shot.id, box.checked, box.checked ? { blob: last.blob, score: last.result.score, mode: last.result.mode } : undefined);
                if (box.checked) toast(`${shot.name}: marked for ${def.title}.`, 'success');
            });
            foot.append(h('label', { class: 'checkbox' }, box, h('span', { text: def.matchLabel })));
        } else if (!shot.target) {
            foot.append(h('span', { class: 'muted small', text: 'Choose a target paintover for this shot to mark it as matching.' }));
        }
        foot.append(h('span', { class: 'muted small', text: 'The numbers are a reference; judge by eye.' }));
    }
}

function metric(label: string, value: string, title: string): HTMLElement {
    return h('div', { class: 'shot-metric', title }, h('span', { class: 'muted', text: label }), h('strong', { text: value }));
}

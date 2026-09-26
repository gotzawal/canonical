import type { Editor } from '../editor';
import { getAssetUrl } from '../core/assets';
import type { ShotDoc } from '../core/types';
import { FRAME_MARGIN, frameRect } from '../design/shotCamera';
import { h } from './dom';
import { icon } from './icons';
import { toast } from './overlays';
import { openPaintoverDialog } from './paintoverDialog';

export type ShotReference = 'concept' | 'target' | 'capture' | 'none';

/**
 * Viewport overlay while a shot is shown: the frame with the shot's aspect
 * ratio (the rest of the view dimmed), a reference image laid over it
 * (concept, target paintover or the last capture) and a bar with the shot's
 * actions. Grayscale turns both the view and the reference gray to compare
 * value structure.
 */
export class ShotView {
    readonly el: HTMLElement;
    private frame: HTMLElement;
    private ref: HTMLImageElement;
    private bar: HTMLElement;
    private title: HTMLElement;
    private refSelect: HTMLSelectElement;
    private opacity: HTMLInputElement;
    private grayBtn: HTMLButtonElement;
    reference: ShotReference = 'concept';
    grayscale = false;
    private refAsset = '';

    constructor(private editor: Editor, private viewportEl: HTMLElement) {
        this.ref = h('img', { class: 'shot-ref', attrs: { alt: '', draggable: 'false' } });
        this.frame = h('div', { class: 'shot-frame' }, this.ref);
        this.title = h('span', { class: 'shot-bar-title' });
        this.refSelect = h('select', { class: 'select shot-ref-select', title: 'Image laid over the frame' });
        for (const [v, l] of [['concept', 'Concept'], ['target', 'Paintover'], ['capture', 'Last capture'], ['none', 'No overlay']]) {
            this.refSelect.appendChild(h('option', { text: l, attrs: { value: v } }));
        }
        this.refSelect.addEventListener('change', () => {
            this.reference = this.refSelect.value as ShotReference;
            this.update();
        });
        this.refSelect.addEventListener('keydown', (e) => e.stopPropagation());
        this.opacity = h('input', { class: 'range shot-opacity', title: 'Overlay opacity', attrs: { type: 'range', min: 0, max: 1, step: 0.01 } });
        this.opacity.value = '0.5';
        this.opacity.addEventListener('input', () => (this.ref.style.opacity = this.opacity.value));
        this.grayBtn = h('button', { class: 'tool-btn wide', title: 'Grayscale: compare the value structure', attrs: { type: 'button' } }, icon('compare', 15), h('span', { text: 'Gray' }));
        this.grayBtn.addEventListener('click', () => this.setGrayscale(!this.grayscale));
        const pipeline = editor.pipeline;
        const update = h('button', { class: 'tool-btn wide', title: 'Store the current view as the shot', attrs: { type: 'button' } }, icon('focus', 15), h('span', { text: 'Update' }));
        update.addEventListener('click', () => {
            if (!pipeline.activeShot) return;
            pipeline.updateShotFromView(pipeline.activeShot);
            toast('Shot updated from the view.', 'success');
        });
        const capture = h('button', { class: 'tool-btn wide', title: 'Capture the shot as an image', attrs: { type: 'button' } }, icon('image', 15), h('span', { text: 'Capture' }));
        capture.addEventListener('click', async () => {
            if (!pipeline.activeShot) return;
            try {
                const meta = await pipeline.captureShotAsset(pipeline.activeShot, 'capture');
                toast(`Captured ${meta.name}.`, 'success');
                this.reference = 'capture';
                this.update();
            } catch (e: any) {
                toast(`Capture failed: ${e?.message || e}`, 'error');
            }
        });
        const paint = h('button', { class: 'tool-btn wide', title: 'Paintovers of this shot', attrs: { type: 'button' } }, icon('paint', 15), h('span', { text: 'Paintover' }));
        paint.addEventListener('click', () => pipeline.activeShot && openPaintoverDialog(editor, pipeline.activeShot));
        const back = h('button', { class: 'tool-btn', title: 'Back to the shot camera', attrs: { type: 'button' } }, icon('undo', 15));
        back.addEventListener('click', () => pipeline.activeShot && pipeline.showShot(pipeline.activeShot));
        const close = h('button', { class: 'tool-btn', title: 'Hide the frame', attrs: { type: 'button' } }, icon('close', 15));
        close.addEventListener('click', () => pipeline.showShot(null));
        this.bar = h('div', { class: 'shot-bar' }, icon('camera', 15), this.title, this.refSelect, this.opacity, this.grayBtn, back, update, capture, paint, close);
        this.el = h('div', { class: 'shot-view', attrs: { hidden: true } }, this.frame, this.bar);
        viewportEl.appendChild(this.el);

        pipeline.on('shot', () => this.update());
        editor.store.on('change', () => {
            if (pipeline.activeShot) this.update();
        });
        new ResizeObserver(() => {
            if (!pipeline.activeShot) return;
            this.layout();
            // Keep the frame's view: the camera field of view depends on the viewport size.
            const shot = pipeline.shot(pipeline.activeShot);
            if (shot && !editor.camera.animating) editor.camera.jump({ ...editor.store.camera, fov: pipeline.shotCamera(shot).fov });
        }).observe(viewportEl);
    }

    private get shot(): ShotDoc | undefined {
        return this.editor.pipeline.shot(this.editor.pipeline.activeShot);
    }

    setGrayscale(on: boolean) {
        this.grayscale = on;
        this.viewportEl.classList.toggle('grayscale', on);
        this.grayBtn.classList.toggle('active', on);
    }

    private layout() {
        const shot = this.shot;
        if (!shot) return;
        const [w, hh] = this.editor.runtime.cssSize;
        const r = frameRect(shot.aspect, w, hh, FRAME_MARGIN);
        Object.assign(this.frame.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    }

    update() {
        const shot = this.shot;
        this.el.hidden = !shot;
        this.viewportEl.classList.toggle('shot-mode', !!shot);
        if (!shot) {
            this.setGrayscale(false);
            return;
        }
        this.title.textContent = shot.name;
        const lastCapture = shot.history[shot.history.length - 1]?.asset;
        const pick = this.reference === 'concept' ? shot.concept : this.reference === 'target' ? shot.target : this.reference === 'capture' ? lastCapture : null;
        this.refSelect.value = this.reference;
        const asset = pick ?? '';
        if (asset !== this.refAsset) {
            this.refAsset = asset;
            this.ref.removeAttribute('src');
            const meta = this.editor.store.doc.assets.find((a) => a.id === asset);
            if (meta) void getAssetUrl(meta).then((url) => url && this.refAsset === asset && (this.ref.src = url));
        }
        this.ref.hidden = !asset;
        this.ref.style.opacity = this.opacity.value;
        this.layout();
    }
}

import type { Editor } from '../editor';
import { planStarted } from '../core/design';
import { stageDef, stepsProgress, type StepProgress } from '../design/stages';
import { onChanges, whenQuiet } from './batch';
import { clear, h } from './dom';
import { icon } from './icons';
import { mascotPose, type MascotPose } from './mascot';
import { popover } from './overlays';
import { button } from './widgets';

/**
 * Where the scene stands, in three steps: Layout, Look, Finish. The simple
 * view shows this instead of the pipeline bar: the assistant runs the stages
 * and their checklists, the user sees how far it got and what needs another
 * look. "Details" opens the full editor's Design tab.
 */
export class StepsBar {
    readonly el: HTMLElement;
    private key = '';

    constructor(private editor: Editor, private showDetails: () => void) {
        this.el = h('div', { class: 'steps-bar', attrs: { role: 'navigation', 'aria-label': 'Progress' } });
        const store = editor.store;
        // The layout's recheck mark follows every object: after a drag has ended is soon enough.
        const quiet = whenQuiet(250, () => this.render());
        onChanges(store, (hint) => (hint?.transform ? quiet() : this.render()));
        store.on('load', () => this.render());
        this.render();
    }

    private render() {
        const doc = this.editor.store.doc;
        const d = doc.design;
        const started = planStarted(d);
        const steps = stepsProgress(doc, d, this.editor.pipeline.layoutChanged);
        const key = JSON.stringify([started, d.stage, steps.map((s) => [s.state, s.recheck ?? ''])]);
        if (key === this.key) return;
        this.key = key;
        clear(this.el);
        // Nothing to show before the user said what to make.
        this.el.hidden = !started;
        if (!started) return;
        const list = h('ol', { class: 'steps' });
        steps.forEach((p, i) => {
            if (i) list.appendChild(h('li', { class: 'steps-sep', attrs: { 'aria-hidden': 'true' } }, icon('chevron', 11)));
            list.appendChild(h('li', null, this.step(p, i)));
        });
        this.el.append(list);
    }

    private step(p: StepProgress, i: number): HTMLElement {
        const d = this.editor.store.doc.design;
        const current = p.state === 'current';
        const mark = p.state === 'done' ? icon('check', 11) : String(i + 1);
        const b = h(
            'button',
            {
                class: `step ${p.state}${p.recheck ? ' recheck' : ''}`,
                attrs: { type: 'button', ...(current ? { 'aria-current': 'step' } : {}) },
                title: `${p.step.title}: ${p.step.hint}${p.recheck ? `. Needs another look: ${p.recheck}` : ''}`,
            },
            h('span', { class: 'step-num' }, mark),
            h('span', { class: 'step-title', text: p.step.title }),
            // The stage inside the current step, in a word ("Look · Materials").
            current && p.step.stages.length > 1 ? h('span', { class: 'step-sub', text: stageDef(d.stage).title }) : null,
            p.recheck ? h('span', { class: 'step-dot', attrs: { 'aria-label': 'needs another look' } }) : null,
        );
        b.addEventListener('click', () => this.explain(b, p));
        return b;
    }

    /** What a step is, how far it got and what needs another look, the heron beside it in the pose of that. */
    private explain(anchor: HTMLElement, p: StepProgress) {
        const d = this.editor.store.doc.design;
        const state = p.state === 'done' ? 'Done.' : p.state === 'current' ? `In progress: ${stageDef(d.stage).long}.` : 'Not started yet.';
        const pose: MascotPose = p.recheck ? 'ask' : p.state === 'done' ? 'celebrate' : p.state === 'current' ? 'peck' : 'rest';
        popover(
            anchor,
            h(
                'div',
                { class: 'steps-popover' },
                mascotPose(pose, 108, 'steps-heron'),
                h(
                    'div',
                    { class: 'steps-popover-body' },
                    h('div', { class: 'pipeline-popover-title', text: p.step.title }),
                    h('p', { class: 'muted', text: `${p.step.hint}. ${state}` }),
                    p.recheck ? h('div', { class: 'design-note warn' }, icon('alert', 14), h('span', { text: `${p.recheck}. The assistant checks it again when it works on the scene.` })) : null,
                    h('div', { class: 'design-actions' }, button('Details', () => this.showDetails(), 'small subtle', 'sliders')),
                ),
            ),
        );
    }
}

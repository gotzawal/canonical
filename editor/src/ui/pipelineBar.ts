import { STAGE_IDS, stageIndex } from '../core/design';
import type { StageId } from '../core/types';
import type { Editor } from '../editor';
import { onChanges, whenQuiet } from './batch';
import { stageDef, stepOf } from '../design/stages';
import { checklistView } from './checklist';
import { clear, h } from './dom';
import { icon } from './icons';
import { notices } from './notify';
import { popover, showMenu } from './overlays';

/**
 * The pipeline bar of the full editor, under the menu: the stages in order,
 * the current stage's checklist progress, the assistant's completion
 * proposal and the button that completes the stage. (The simple view shows
 * the three steps instead, ui/stepsBar.ts.)
 */
export class PipelineBar {
    readonly el: HTMLElement;
    private key = '';
    private closePopover: (() => void) | null = null;

    constructor(private editor: Editor, private show: { design: () => void; chatInView: () => boolean }) {
        this.el = h('div', { class: 'pipeline-bar', attrs: { role: 'navigation', 'aria-label': 'Pipeline stages' } });
        const store = editor.store;
        const rerender = () => this.render();
        // Its checklist looks at every object: moving them updates it once the drag has ended.
        const quiet = whenQuiet(250, rerender);
        onChanges(store, (hint) => (hint?.transform ? quiet() : this.render()));
        store.on('load', () => this.render(true));
        editor.pipeline.on('busy', () => this.render(true));
        // The chat holds the buttons that approve it, in both views: the card is for when the chat is out of sight.
        editor.pipeline.on('proposed', (summary) => {
            if (this.show.chatInView()) return;
            notices.show({
                kind: 'stage',
                key: 'stage-proposal',
                mascot: 'ask',
                title: `${stageDef(editor.pipeline.design.stage).title} is done. Happy with it?`,
                body: summary.slice(0, 240),
                actions: [{ label: 'Show', primary: true, run: () => editor.emit('show-ai', undefined) }],
            });
        });
        // Told when one of the three steps is done, not for every stage.
        editor.pipeline.on('completed', ({ stage, next }) => {
            const step = stepOf(stage);
            if (next && stepOf(next).id === step.id) return;
            notices.show({ kind: 'stage', key: 'stage-done', mascot: 'done', title: `${step.title} is done`, body: next ? `Next: ${stepOf(next).title}, ${stepOf(next).hint.toLowerCase()}.` : 'Every step is done.', timeout: 6000 });
        });
        // The frame rate item of the effects stage follows the editor's fps.
        setInterval(rerender, 2000);
        this.render(true);
    }

    private render(force = false) {
        const pipeline = this.editor.pipeline;
        const design = pipeline.design;
        const prog = pipeline.progress();
        const st = design.stages[design.stage];
        // Answered (in the chat, the Design tab or here) or withdrawn: its card goes.
        if (!st.proposal) notices.dismiss('stage-proposal');
        const key = JSON.stringify([
            design.stage,
            STAGE_IDS.map((id) => design.stages[id].status + (design.stages[id].recheck ?? '')),
            prog.done,
            prog.total,
            !!st.proposal,
            pipeline.layoutChanged,
            pipeline.busy,
        ]);
        if (!force && key === this.key) return;
        this.key = key;
        clear(this.el);

        const chips = h('div', { class: 'pipeline-stages' });
        STAGE_IDS.forEach((id, i) => {
            if (i) chips.appendChild(icon('chevron', 11, 'pipeline-sep'));
            chips.appendChild(this.chip(id, i));
        });
        this.el.appendChild(chips);
        this.el.appendChild(h('div', { class: 'spacer' }));

        const def = stageDef(design.stage);
        if (st.proposal) {
            const prop = h('button', { class: 'pipeline-btn accent', title: st.proposal.summary, attrs: { type: 'button' } }, icon('flag', 14), h('span', { text: 'AI proposes completion' }));
            prop.addEventListener('click', () => this.show.design());
            this.el.appendChild(prop);
        }

        const checks = h(
            'button',
            { class: 'pipeline-btn', title: 'Checklist of this stage', attrs: { type: 'button' } },
            icon('check', 14),
            h('span', { text: `Checklist ${prog.done}/${prog.total}` }),
        );
        checks.addEventListener('click', () => this.openChecklist(checks, design.stage));
        this.el.appendChild(checks);

        if (pipeline.busy) {
            this.el.appendChild(h('span', { class: 'pipeline-busy' }, h('span', { class: 'spinner small' }), h('span', { text: 'Saving the shots...' })));
        } else if (st.status === 'done') {
            this.el.appendChild(h('span', { class: 'pipeline-done' }, icon('check', 14), h('span', { text: 'All stages complete' })));
        } else {
            const ready = prog.open.length === 0;
            const complete = h(
                'button',
                {
                    class: 'btn small' + (ready ? ' primary' : ''),
                    title: ready ? `Every item is done: complete ${def.title} and capture the shots` : `${prog.open.length} checklist item(s) still open`,
                    attrs: { type: 'button' },
                },
                icon('flag', 13),
                h('span', { text: ready ? `Complete ${def.title}` : `Complete ${def.title} (${prog.open.length} open)` }),
            );
            complete.addEventListener('click', () => void pipeline.complete());
            this.el.appendChild(complete);
        }
    }

    private chip(id: StageId, i: number): HTMLElement {
        const pipeline = this.editor.pipeline;
        const design = pipeline.design;
        const st = design.stages[id];
        const current = design.stage === id;
        const def = stageDef(id);
        // A change after the stage was done marks it, without reopening it.
        const changed = id === 'level' && pipeline.layoutChanged;
        const recheck = st.recheck ?? (changed ? 'the layout changed after it was done' : '');
        const cls = ['pipeline-chip', changed ? 'recheck' : st.status, current ? 'current' : ''].filter(Boolean).join(' ');
        const chip = h(
            'button',
            { class: cls, title: `${def.long}${recheck ? ` - needs a recheck: ${recheck}` : ''}`, attrs: { type: 'button' } },
            h('span', { class: 'pipeline-num' }, changed || st.status === 'recheck' ? icon('alert', 11) : st.status === 'done' ? icon('check', 11) : String(i + 1)),
            h('span', { class: 'pipeline-title', text: def.title }),
        );
        chip.addEventListener('click', () => {
            if (current) {
                this.show.design();
                return;
            }
            const r = chip.getBoundingClientRect();
            const earlier = stageIndex(id) < stageIndex(design.stage) || design.stages[design.stage].status === 'done';
            showMenu(
                [
                    { label: `Checklist of ${def.title}`, icon: 'check', action: () => this.openChecklist(chip, id) },
                    ...(id === 'brief' ? [{ label: 'The brief', icon: 'open', action: () => this.show.design() }] : []),
                    { separator: true },
                    { label: `Reopen ${def.title}`, icon: 'undo', enabled: () => earlier && !pipeline.busy, action: () => void pipeline.reopen(id) },
                ],
                r.left,
                r.bottom + 4,
            );
        });
        return chip;
    }

    private openChecklist(anchor: HTMLElement, stage: StageId) {
        this.closePopover?.();
        const def = stageDef(stage);
        const body = h(
            'div',
            { class: 'pipeline-popover' },
            h('div', { class: 'pipeline-popover-title', text: def.long }),
            checklistView(this.editor, stage, { add: stage === this.editor.pipeline.design.stage }),
        );
        const changes = onChanges(this.editor.store, () => {
            const next = checklistView(this.editor, stage, { add: stage === this.editor.pipeline.design.stage });
            body.lastElementChild?.replaceWith(next);
        });
        this.closePopover = popover(anchor, body, '', () => {
            changes.off();
            this.closePopover = null;
        });
    }
}

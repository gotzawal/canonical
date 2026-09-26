import type { StageId } from '../core/types';
import type { Editor } from '../editor';
import { stageDef } from '../design/stages';
import { h } from './dom';
import { icon } from './icons';

/**
 * A stage's checklist. Automatic items show their state (they follow the
 * project); the others are ticked here. Items added by hand can be removed.
 */
export function checklistView(editor: Editor, stage: StageId, opts: { add?: boolean } = {}): HTMLElement {
    const pipeline = editor.pipeline;
    const prog = pipeline.progress(stage);
    const list = h('div', { class: 'checklist' });
    for (const item of prog.items) {
        const row = h('div', { class: 'check-row' + (item.done ? ' done' : '') + (item.auto ? ' auto' : '') });
        if (item.auto) {
            row.appendChild(h('span', { class: 'check-state', title: 'Checked automatically from the project' }, icon(item.done ? 'check' : 'circle', 14)));
        } else {
            const box = h('input', { class: 'check-box', attrs: { type: 'checkbox', 'aria-label': item.text } });
            box.checked = item.done;
            box.addEventListener('change', () => pipeline.setCheck(stage, item.id, box.checked, 'user'));
            row.appendChild(box);
        }
        const text = h('div', { class: 'check-text-block' }, h('span', { class: 'check-label', text: item.text }));
        const meta: string[] = [];
        if (item.detail) meta.push(item.detail);
        if (!item.auto && item.done && item.by === 'ai') meta.push('ticked by the assistant');
        if (meta.length) text.appendChild(h('span', { class: 'check-detail', text: meta.join(' · ') }));
        if (item.note) text.appendChild(h('span', { class: 'check-note', text: item.note }));
        if (!item.done && item.hint) text.appendChild(h('span', { class: 'check-detail', text: item.hint }));
        row.appendChild(text);
        if (item.custom) {
            const remove = h('button', { class: 'icon-btn check-remove', title: 'Remove item', attrs: { type: 'button', 'aria-label': 'Remove item' } }, icon('close', 12));
            remove.addEventListener('click', () => pipeline.removeCheck(stage, item.id));
            row.appendChild(remove);
        }
        list.appendChild(row);
    }
    if (!prog.items.length) list.appendChild(h('div', { class: 'muted small', text: `${stageDef(stage).title} has no checklist.` }));
    if (opts.add) {
        const input = h('input', { class: 'text check-add', attrs: { type: 'text', placeholder: 'Add an item...', spellcheck: 'true' } });
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && input.value.trim()) {
                pipeline.addCheck(stage, input.value);
                input.value = '';
            }
        });
        list.appendChild(input);
    }
    return list;
}

// File > Delete Planning Images: removes the planning records a built game
// never uses (shot captures, paintovers, versions) and keeps the concept
// images. One undo step; the files leave this browser's storage the next
// time the project is opened.

import type { Editor } from '../editor';
import { dropRecords, RECORD_KINDS, RECORD_LABELS, recordAssets, type RecordKind } from '../core/design';
import type { DesignDoc, SceneDoc } from '../core/types';
import { h } from './dom';
import { dialog, toast } from './overlays';
import { CheckboxField } from './widgets';

const mib = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** How many entries and bytes each kind of record holds now. */
export function recordSummary(doc: SceneDoc): Record<RecordKind, { count: number; files: number; bytes: number }> {
    const sizes = new Map(doc.assets.map((a) => [a.id, a.size ?? 0]));
    const ids = recordAssets(doc.design);
    const counts = dropRecords(JSON.parse(JSON.stringify(doc.design)) as DesignDoc, RECORD_KINDS);
    const out = {} as Record<RecordKind, { count: number; files: number; bytes: number }>;
    for (const k of RECORD_KINDS) {
        let bytes = 0;
        for (const id of ids[k]) bytes += sizes.get(id) ?? 0;
        out[k] = { count: counts[k], files: ids[k].size, bytes };
    }
    return out;
}

/** Deletes the chosen kinds of records as one undo step; returns what went. */
export function deleteRecords(editor: Editor, kinds: RecordKind[], label = 'Delete Planning Images'): Record<RecordKind, number> {
    let n: Record<RecordKind, number> = { captures: 0, paintovers: 0, targets: 0, snapshots: 0 };
    editor.store.commit(label, (d) => {
        n = dropRecords(d.design, kinds);
    }, { design: true });
    return n;
}

export async function openRecordsDialog(editor: Editor) {
    const summary = recordSummary(editor.store.doc);
    const chosen = new Set<RecordKind>(RECORD_KINDS.filter((k) => k !== 'targets' && summary[k].count > 0));
    const rows = RECORD_KINDS.map((k) => {
        const s = summary[k];
        const box = new CheckboxField(chosen.has(k), (v) => (v ? chosen.add(k) : chosen.delete(k)), `${RECORD_LABELS[k].title}: ${s.count} (${s.files ? mib(s.bytes) : 'no files'})`);
        return h('div', { class: 'records-row' }, box.el, h('div', { class: 'muted small', text: RECORD_LABELS[k].detail }));
    });
    const total = RECORD_KINDS.reduce((a, k) => a + summary[k].count, 0);
    if (!total) {
        toast('There are no planning images to delete: only the concept images are left.', 'info');
        return;
    }
    const body = h(
        'div',
        { class: 'records-dialog' },
        h('p', { text: 'Planning images the built game never uses. The concept images stay. You can undo this; the files leave this browser\'s storage the next time the project is opened.' }),
        ...rows,
        h('p', { class: 'muted small', text: 'To keep them here but leave them out of a download, use File > Save Project without History.' }),
    );
    const answer = await dialog('Delete Planning Images', body, [{ label: 'Cancel' }, { label: 'Delete', danger: true, value: 'delete' }]);
    if (answer !== 'delete' || !chosen.size) return;
    const n = deleteRecords(editor, [...chosen]);
    const parts = RECORD_KINDS.filter((k) => n[k]).map((k) => `${n[k]} ${RECORD_LABELS[k].title.toLowerCase()}`);
    toast(parts.length ? `Deleted ${parts.join(', ')}.` : 'Nothing was deleted.', 'success');
}

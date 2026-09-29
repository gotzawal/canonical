import type { Editor } from '../editor';
import { getAssetUrl } from '../core/assets';
import { download } from '../core/persistence';
import type { SnapshotDoc } from '../core/types';
import { onChanges, touches } from './batch';
import { clear, h } from './dom';
import { modal, showMenu, toast } from './overlays';
import { button, iconButton } from './widgets';

/**
 * The version history: versions of the scene saved by themselves after a
 * stretch of work, when a stage of the pipeline was completed (with its shots
 * as they were), or by hand. Each can be restored (one undo step) or
 * downloaded. They are kept in this browser with the project.
 */
export function versionList(editor: Editor, done?: () => void): HTMLElement {
    const pipeline = editor.pipeline;
    const d = editor.store.doc.design;
    const list = h('div', { class: 'version-list' });
    const versions = [...d.snapshots].reverse();
    if (!versions.length) {
        list.appendChild(h('div', { class: 'muted small pad', text: 'No versions yet. The editor saves one after the assistant changes the scene and whenever a step is done; you can save one yourself too.' }));
        return list;
    }
    for (const s of versions) {
        const img = h('img', { class: 'version-thumb', attrs: { alt: '', draggable: 'false' } });
        const meta = s.thumb ? editor.store.doc.assets.find((a) => a.id === s.thumb) : undefined;
        if (meta) void getAssetUrl(meta).then((url) => url && (img.src = url));
        else img.classList.add('missing');
        const menu = iconButton('dots', 'Version options', (e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showMenu(
                [
                    { label: 'Restore', icon: 'undo', action: () => void pipeline.restoreSnapshot(s.id).then((ok) => ok && done?.()) },
                    { label: 'Download Scene File', icon: 'save', action: () => void downloadVersion(editor, s) },
                    { separator: true },
                    { label: 'Delete', icon: 'trash', action: () => pipeline.deleteSnapshot(s.id) },
                ],
                r.left - 160,
                r.bottom + 4,
            );
        });
        const restore = button('Restore', () => void pipeline.restoreSnapshot(s.id).then((ok) => ok && done?.()), 'small subtle', 'undo');
        list.appendChild(
            h(
                'div',
                { class: 'version-item' + (s.auto ? ' auto' : '') },
                img,
                h(
                    'div',
                    { class: 'version-info' },
                    h('span', { class: 'version-name', text: s.name, title: s.name }),
                    h('span', { class: 'muted small', text: `${s.at.slice(0, 16).replace('T', ' ')}${s.auto ? ' · saved by itself' : ''}` }),
                ),
                restore,
                menu,
            ),
        );
    }
    return list;
}

async function downloadVersion(editor: Editor, s: SnapshotDoc) {
    const file = await editor.pipeline.readSnapshot(s);
    if (!file) {
        toast('This version is not stored in this browser.', 'error');
        return;
    }
    download(new Blob([JSON.stringify({ ...file.scene, camera: file.camera })], { type: 'application/json' }), `${s.name.replace(/[^\w-]+/g, '-')}.scene.json`);
}

/** The buttons under the list: save a version now, and download the whole project. */
export function versionActions(editor: Editor): HTMLElement {
    return h(
        'div',
        { class: 'design-actions' },
        button('Save a version', () => void editor.pipeline.saveVersion('Saved by hand').then(() => toast('Version saved.', 'success')), 'small', 'history'),
        button('Download project (.zip)', () => void editor.saveProjectFile(), 'small subtle', 'save'),
    );
}

/** The version history in a window (File > Version History). */
export function openVersionHistory(editor: Editor) {
    const body = h('div', { class: 'version-history' });
    const render = () => {
        clear(body);
        body.append(
            versionList(editor, () => m.close()),
            versionActions(editor),
            h('p', { class: 'muted small', text: 'Versions are kept in this browser with the project. Download the project to keep a copy elsewhere.' }),
        );
    };
    const changes = onChanges(editor.store, (hint) => touches(hint, 'design') && render());
    const loads = editor.store.on('load', () => m.close());
    const m = modal('Version History', body, {
        cls: 'version-dialog',
        onClose: () => {
            changes.off();
            loads();
        },
    });
    render();
    m.footer.append(h('div', { class: 'spacer' }), button('Close', () => m.close(), 'primary'));
}

import type { Editor } from '../editor';
import type { Tool } from '../core/store';
import { h, shortcutLabel } from './dom';
import { icon } from './icons';
import { MenuItem, showMenu } from './overlays';

const TOOLS: { tool: Tool; icon: string; label: string; key: string }[] = [
    { tool: 'select', icon: 'cursor', label: 'Select', key: 'Q' },
    { tool: 'translate', icon: 'move', label: 'Move', key: 'W' },
    { tool: 'rotate', icon: 'rotate', label: 'Rotate', key: 'E' },
    { tool: 'scale', icon: 'scale', label: 'Scale', key: 'R' },
];

function toolButton(iconName: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    return h('button', { class: 'tool-btn', title, attrs: { type: 'button', 'aria-label': title }, on: { click: onClick } }, icon(iconName, 17));
}

/** Viewport toolbar: tools, gizmo space, snapping, view helpers. */
export function toolbar(editor: Editor, createMenu: () => MenuItem[]): HTMLElement {
    const store = editor.store;
    const toolButtons = TOOLS.map((t) => {
        const b = toolButton(t.icon, `${t.label} (${t.key})`, () => editor.setTool(t.tool));
        b.dataset.tool = t.tool;
        return b;
    });
    const space = h('button', { class: 'tool-btn wide', attrs: { type: 'button' }, on: { click: () => editor.toggleSpace() } });
    const snap = toolButton('magnet', 'Snapping (hold Ctrl to toggle while dragging)', () => store.setPrefs({ snap: !store.prefs.snap }));
    const grid = toolButton('grid', 'Grid (G)', () => store.setPrefs({ grid: !store.prefs.grid }));
    const frame = toolButton('focus', 'Frame selection (F)', () => editor.frameSelection());
    const undo = toolButton('undo', `Undo (${shortcutLabel('Mod+Z')})`, () => store.undo());
    const redo = toolButton('redo', `Redo (${shortcutLabel('Mod+Shift+Z')})`, () => store.redo());
    const add = h('button', { class: 'tool-btn wide accent', attrs: { type: 'button' } }, icon('plus', 16), h('span', { text: 'Add' }));
    add.addEventListener('click', () => {
        const r = add.getBoundingClientRect();
        showMenu(createMenu(), r.left, r.bottom + 4);
    });

    const update = () => {
        const p = store.prefs;
        for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === p.tool);
        space.replaceChildren(icon(p.space === 'world' ? 'globe' : 'local', 16), h('span', { text: p.space === 'world' ? 'World' : 'Local' }));
        space.title = `Gizmo space: ${p.space} (X)`;
        snap.classList.toggle('active', p.snap);
        grid.classList.toggle('active', p.grid);
    };
    store.on('prefs', update);
    store.on('history', (hs) => {
        undo.disabled = !hs.canUndo;
        redo.disabled = !hs.canRedo;
        undo.title = hs.canUndo ? `Undo ${hs.undoLabel} (${shortcutLabel('Mod+Z')})` : 'Nothing to undo';
        redo.title = hs.canRedo ? `Redo ${hs.redoLabel} (${shortcutLabel('Mod+Shift+Z')})` : 'Nothing to redo';
    });
    undo.disabled = redo.disabled = true;
    update();

    return h(
        'div',
        { class: 'toolbar', attrs: { role: 'toolbar', 'aria-label': 'Viewport tools' } },
        h('div', { class: 'tool-group' }, toolButtons),
        h('div', { class: 'tool-group' }, space, snap),
        h('div', { class: 'tool-group' }, undo, redo),
        h('div', { class: 'tool-group' }, frame, grid),
        h('div', { class: 'spacer' }),
        add,
    );
}

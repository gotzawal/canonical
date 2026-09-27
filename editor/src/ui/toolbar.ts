import type { Editor } from '../editor';
import type { Tool } from '../core/store';
import { h } from './dom';
import { icon } from './icons';
import { MenuItem, showMenu } from './overlays';

const TOOLS: { tool: Tool; icon: string; command: string }[] = [
    { tool: 'select', icon: 'cursor', command: 'tool.select' },
    { tool: 'translate', icon: 'move', command: 'tool.move' },
    { tool: 'rotate', icon: 'rotate', command: 'tool.rotate' },
    { tool: 'scale', icon: 'scale', command: 'tool.scale' },
];

function toolButton(iconName: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    return h('button', { class: 'tool-btn', title, attrs: { type: 'button', 'aria-label': title }, on: { click: onClick } }, icon(iconName, 17));
}

/** Viewport toolbar: tools, gizmo space, snapping, view helpers, play controls. */
export function toolbar(editor: Editor, createMenu: () => MenuItem[], showAI: () => void): HTMLElement {
    const store = editor.store;
    const cmds = editor.commands;
    /** A button for a command: its tooltip names the key. */
    const command = (id: string, iconName: string, title = cmds.get(id).label) => toolButton(iconName, title + cmds.hint(id), () => cmds.get(id).run());
    const toolButtons = TOOLS.map((t) => {
        const b = command(t.command, t.icon);
        b.dataset.tool = t.tool;
        return b;
    });
    const space = h('button', { class: 'tool-btn wide', attrs: { type: 'button' }, on: { click: () => editor.toggleSpace() } });
    const snap = toolButton('magnet', 'Snapping (hold Ctrl to toggle while dragging)', () => store.setPrefs({ snap: !store.prefs.snap }));
    const grid = command('view.grid', 'grid');
    const frame = command('view.frame', 'focus');
    const walk = command('view.walk', 'walk', 'Walk at eye height: WASD and mouse, Esc to stop');
    editor.on('walk', (on) => walk.classList.toggle('active', on));
    const undo = command('edit.undo', 'undo');
    const redo = command('edit.redo', 'redo');
    const add = h('button', { class: 'tool-btn wide accent', attrs: { type: 'button' } }, icon('plus', 16), h('span', { text: 'Add' }));
    add.addEventListener('click', () => {
        const r = add.getBoundingClientRect();
        showMenu(createMenu(), r.left, r.bottom + 4);
    });

    const play = h('button', { class: 'tool-btn wide play-btn', attrs: { type: 'button' } });
    play.addEventListener('click', () => editor.togglePlay());
    // The keys go back to the game view (a focused button would take Space and Enter).
    const refocus = () => editor.viewport.overlay.focus({ preventScroll: true });
    const pause = toolButton('pause', 'Pause' + cmds.hint('play.pause'), () => {
        editor.pausePlay();
        refocus();
    });
    const step = toolButton('step', 'Next frame (while paused)', () => {
        editor.player.step();
        refocus();
    });
    const updatePlay = () => {
        const st = editor.player.state;
        play.classList.toggle('active', st !== 'stopped');
        play.replaceChildren(icon(st === 'stopped' ? 'play' : 'stop', 15), h('span', { text: st === 'stopped' ? 'Play' : 'Stop' }));
        play.title = (st === 'stopped' ? 'Play the scene and run scripts' : 'Stop and restore the scene') + cmds.hint('play.toggle');
        pause.disabled = st === 'stopped';
        pause.classList.toggle('active', st === 'paused');
        step.disabled = st !== 'paused';
    };
    editor.player.on('state', updatePlay);
    updatePlay();
    const build = command('file.build', 'rocket', 'Build & Deploy: run, download or publish the game');
    const dock = command('dock.toggle', 'panelBottom', 'Code and render graph panel');
    const ai = h('button', { class: 'tool-btn wide', title: 'AI assistant (OpenRouter)', attrs: { type: 'button' } }, icon('sparkle', 16), h('span', { text: 'AI' }));
    ai.addEventListener('click', showAI);

    const update = () => {
        const p = store.prefs;
        for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === p.tool);
        space.replaceChildren(icon(p.space === 'world' ? 'globe' : 'local', 16), h('span', { text: p.space === 'world' ? 'World' : 'Local' }));
        space.title = `Gizmo space: ${p.space}${cmds.hint('tool.space')}`;
        snap.classList.toggle('active', p.snap);
        grid.classList.toggle('active', p.grid);
    };
    store.on('prefs', update);
    store.on('history', (hs) => {
        undo.disabled = !hs.canUndo;
        redo.disabled = !hs.canRedo;
        undo.title = hs.canUndo ? `Undo ${hs.undoLabel}${cmds.hint('edit.undo')}` : 'Nothing to undo';
        redo.title = hs.canRedo ? `Redo ${hs.redoLabel}${cmds.hint('edit.redo')}` : 'Nothing to redo';
    });
    undo.disabled = redo.disabled = true;
    update();

    return h(
        'div',
        { class: 'toolbar', attrs: { role: 'toolbar', 'aria-label': 'Viewport tools' } },
        h('div', { class: 'tool-group' }, toolButtons),
        h('div', { class: 'tool-group space-group' }, space, snap),
        h('div', { class: 'tool-group history-group' }, undo, redo),
        h('div', { class: 'tool-group view-group' }, frame, grid, walk),
        h('div', { class: 'spacer' }),
        h('div', { class: 'tool-group play-group' }, play, pause, step),
        h('div', { class: 'spacer' }),
        h('div', { class: 'tool-group' }, build, dock, ai),
        add,
    );
}

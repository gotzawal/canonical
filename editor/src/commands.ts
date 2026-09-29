// Editor commands: one list for the keyboard shortcuts, the menus and the
// shortcuts dialog, so a key is defined once.

import type { Editor } from './editor';
import { h, isTyping, shortcutLabel } from './ui/dom';
import { showBuildDialog } from './ui/buildDialog';
import { closeMenus, dialog, modalOpen, type MenuItem } from './ui/overlays';

export interface Command {
    id: string;
    label: string;
    icon?: string;
    /** "Mod+Shift+Z", "Shift+1", "Delete": modifiers in the order Mod, Alt, Shift; letters in capitals. */
    keys?: string[];
    /** Also while typing in a field (it is left first, which commits it). */
    global?: boolean;
    /** Places that handle the key themselves when focused (a selector). */
    localIn?: string;
    /** Holding the key down does not repeat it (toggles). */
    once?: boolean;
    enabled?: () => boolean;
    run(): void;
}

/** What the commands need from the page around the editor. */
export interface CommandUI {
    rename(): void;
    toggleDock(): void;
    /** Between the simple view (the scene and the chat) and the full editor. */
    toggleEditMode(): void;
}

export function editorCommands(editor: Editor, ui: CommandUI): Command[] {
    const store = editor.store;
    const selected = () => store.selection.length > 0;
    const view = (id: string, label: string, key: string, yaw: () => number, pitch: number): Command => ({ id, label, keys: [key], run: () => editor.camera.setView(yaw(), pitch) });
    const list: Command[] = [
        { id: 'play.toggle', label: 'Play', icon: 'play', keys: ['Mod+P'], global: true, run: () => editor.togglePlay() },
        { id: 'play.pause', label: 'Pause', icon: 'pause', keys: ['Mod+Shift+P'], global: true, enabled: () => editor.player.state !== 'stopped', run: () => editor.pausePlay() },
        { id: 'dock.toggle', label: 'Toggle Code Panel', icon: 'panelBottom', keys: ['Mod+J', 'Mod+`'], global: true, run: () => ui.toggleDock() },
        { id: 'view.editMode', label: 'Edit Mode', icon: 'panels', keys: ['Mod+\\'], global: true, run: () => ui.toggleEditMode() },
        { id: 'file.open', label: 'Open Scene or Project...', icon: 'open', keys: ['Mod+O'], global: true, run: () => void editor.openSceneFile() },
        // Mod+S in the code editor applies the file (codeEditor.ts).
        { id: 'file.save', label: 'Save Scene File', icon: 'save', keys: ['Mod+S'], global: true, localIn: '.code-editor', run: () => void editor.saveSceneFile() },
        { id: 'file.saveProject', label: 'Save Project (.zip)', icon: 'save', keys: ['Mod+Shift+S'], global: true, run: () => void editor.saveProjectFile() },
        { id: 'file.build', label: 'Build & Deploy...', icon: 'rocket', keys: ['Mod+B'], run: () => showBuildDialog(editor) },
        { id: 'edit.undo', label: 'Undo', icon: 'undo', keys: ['Mod+Z'], run: () => store.undo() },
        { id: 'edit.redo', label: 'Redo', icon: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], run: () => store.redo() },
        { id: 'edit.rename', label: 'Rename', keys: ['F2'], enabled: () => !!store.primary, run: () => ui.rename() },
        { id: 'edit.duplicate', label: 'Duplicate', icon: 'copy', keys: ['Mod+D'], enabled: selected, run: () => editor.duplicateSelection() },
        { id: 'edit.delete', label: 'Delete', icon: 'trash', keys: ['Delete', 'Backspace'], enabled: selected, run: () => editor.deleteSelection() },
        { id: 'edit.group', label: 'Group', icon: 'layers', keys: ['Mod+G'], enabled: selected, run: () => editor.groupSelection() },
        { id: 'edit.selectAll', label: 'Select All', keys: ['Mod+A'], run: () => editor.selectAll() },
        { id: 'edit.hide', label: 'Hide / Show', icon: 'eyeOff', keys: ['H'], once: true, enabled: selected, run: () => editor.toggleVisibility(store.selection) },
        {
            id: 'edit.deselect',
            label: 'Deselect',
            keys: ['Escape'],
            run: () => {
                closeMenus();
                if (!editor.viewport.cancelInteraction()) store.select([]);
            },
        },
        { id: 'tool.select', label: 'Select Tool', keys: ['Q'], run: () => editor.setTool('select') },
        { id: 'tool.move', label: 'Move Tool', keys: ['W'], run: () => editor.setTool('translate') },
        { id: 'tool.rotate', label: 'Rotate Tool', keys: ['E'], run: () => editor.setTool('rotate') },
        { id: 'tool.scale', label: 'Scale Tool', keys: ['R'], run: () => editor.setTool('scale') },
        { id: 'tool.space', label: 'World / Local Gizmo', keys: ['X'], once: true, run: () => editor.toggleSpace() },
        { id: 'view.walk', label: 'Walk at Eye Height', icon: 'walk', keys: ['V'], once: true, run: () => editor.setView(editor.view === 'walk' ? 'scene' : 'walk') },
        { id: 'view.frame', label: 'Frame Selection', icon: 'focus', keys: ['F'], run: () => editor.frameSelection() },
        { id: 'view.frameAll', label: 'Frame All', keys: ['Home'], run: () => editor.viewport.frameAll() },
        { id: 'view.grid', label: 'Grid', icon: 'grid', keys: ['G'], once: true, run: () => store.setPrefs({ grid: !store.prefs.grid }) },
        view('view.front', 'Front', '1', () => 0, 0),
        view('view.back', 'Back', 'Shift+1', () => 180, 0),
        view('view.right', 'Right', '3', () => 90, 0),
        view('view.left', 'Left', 'Shift+3', () => 270, 0),
        view('view.top', 'Top', '7', () => store.camera.yaw, 89.5),
        view('view.bottom', 'Bottom', 'Shift+7', () => store.camera.yaw, -89.5),
        { id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', keys: ['?'], run: () => showShortcuts(list) },
    ];
    return list;
}

/** Keys that are not commands, for the shortcuts dialog. */
const MORE_KEYS: [string, string][] = [
    ['Left drag', 'Orbit camera'],
    ['Right / middle drag, Shift + left drag', 'Pan camera'],
    ['Wheel / pinch', 'Zoom toward cursor'],
    ['Click / Shift + click', 'Select / add to selection'],
    ['Double click', 'Frame object'],
    ['Ctrl while dragging', 'Toggle snapping'],
    ['WASD, mouse, Shift, Esc', 'Walk: move, look, run, stop'],
    ['Mod+S in the code editor', 'Apply the script or shader'],
    ['Mod+/ in the code editor', 'Comment or uncomment lines'],
];

/**
 * "Mod+Shift+Z" for a key event: digits by position (so Shift+1 is not
 * "!"), letters as typed, or by position when the layout types another
 * script (Korean, Cyrillic: W stays W), other symbols as typed.
 */
function comboOf(e: KeyboardEvent): string {
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1];
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
    const key = digit ?? (letter && !/^[a-z]$/i.test(e.key) ? letter : e.key.length === 1 ? e.key.toUpperCase() : e.key);
    // A typed symbol ("?") already says whether Shift was held.
    const shift = e.shiftKey && (digit !== undefined || key.length > 1 || /^[A-Z]$/.test(key));
    return `${e.ctrlKey || e.metaKey ? 'Mod+' : ''}${e.altKey ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`;
}

export class Commands {
    private byKey = new Map<string, Command>();
    private byId = new Map<string, Command>();

    constructor(readonly list: Command[]) {
        for (const c of list) {
            this.byId.set(c.id, c);
            for (const k of c.keys ?? []) this.byKey.set(k, c);
        }
    }

    get(id: string): Command {
        const c = this.byId.get(id);
        if (!c) throw new Error(`No command "${id}".`);
        return c;
    }

    /** A menu item that runs the command and shows its key; `patch` changes what it shows. */
    item(id: string, patch: Partial<MenuItem> = {}): MenuItem {
        const c = this.get(id);
        return { label: c.label, icon: c.icon, shortcut: c.keys?.[0], enabled: c.enabled, action: () => c.run(), ...patch };
    }

    /** " (Ctrl+Z)" for tooltips, or '' for a command without keys. */
    hint(id: string): string {
        const k = this.get(id).keys?.[0];
        return k ? ` (${shortcutLabel(k)})` : '';
    }

    /**
     * Runs commands from the keyboard. Global commands are taken in the
     * capture phase (fields and the code editor stop their keys); the others
     * only with no field focused. While playing, keys pressed on the game
     * view belong to the scripts, except with Ctrl / Cmd.
     */
    install(editor: Editor) {
        const player = editor.player;
        const match = (e: KeyboardEvent, global: boolean): Command | null => {
            if (e.defaultPrevented || modalOpen()) return null;
            const c = this.byKey.get(comboOf(e));
            if (!c || !!c.global !== global) return null;
            if (c.localIn && (e.target as Element | null)?.closest?.(c.localIn)) return null;
            return c;
        };
        const run = (e: KeyboardEvent, c: Command) => {
            e.preventDefault();
            e.stopPropagation();
            if (c.once && e.repeat) return;
            if (c.enabled && !c.enabled()) return;
            if (isTyping(e.target)) (e.target as HTMLElement).blur();
            c.run();
        };
        document.addEventListener(
            'keydown',
            (e) => {
                const c = match(e, true);
                if (c) run(e, c);
            },
            true,
        );
        document.addEventListener('keydown', (e) => {
            if (e.defaultPrevented || modalOpen()) return;
            if (player.state !== 'stopped' && !isTyping(e.target) && (e.target === editor.viewport.overlay || e.target === document.body)) {
                player.keyEvent(e, true);
                if (!(e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    return;
                }
            }
            if (isTyping(e.target)) return;
            const c = match(e, false);
            if (c) run(e, c);
        });
        document.addEventListener('keyup', (e) => {
            if (player.state !== 'stopped') player.keyEvent(e, false);
        });
    }
}

function showShortcuts(list: Command[]) {
    const keyed = list.filter((c) => c.keys?.length).map((c): [string, string] => [c.keys!.map(shortcutLabel).join(' / '), c.label]);
    const rows = [...keyed, ...MORE_KEYS.map(([k, v]): [string, string] => [shortcutLabel(k), v])];
    const table = h('table', { class: 'shortcuts' }, rows.map(([k, v]) => h('tr', null, h('td', null, h('kbd', { text: k })), h('td', { text: v }))));
    void dialog('Keyboard shortcuts', table);
}

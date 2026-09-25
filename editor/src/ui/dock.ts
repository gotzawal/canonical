import type { Editor } from '../editor';
import { CodePanel, type CodeKind } from './codePanel';
import { clear, h, shortcutLabel } from './dom';
import { icon } from './icons';
import { confirmDialog } from './overlays';
import { RenderGraphPanel } from './renderGraphPanel';

interface OpenDoc {
    key: string;
    kind: CodeKind;
    id: string;
    panel: CodePanel;
    tab: HTMLElement;
    title: HTMLElement;
}

const DOCK_KEY = 'canonical-editor/dock';

/**
 * Bottom panel under the viewport: the render graph and one tab per open
 * script or shader.
 */
export class Dock {
    readonly el: HTMLElement;
    readonly graph: RenderGraphPanel;
    private tabs: HTMLElement;
    private body: HTMLElement;
    private graphTab: HTMLElement;
    private docs: OpenDoc[] = [];
    private active = 'graph';

    constructor(private editor: Editor, private app: HTMLElement) {
        this.graph = new RenderGraphPanel(editor);
        this.graphTab = this.makeTab('graph', icon('graph', 13), 'Render Graph', null);
        this.tabs = h('div', { class: 'dock-tabs', attrs: { role: 'tablist' } }, this.graphTab);
        const collapse = h(
            'button',
            { class: 'icon-btn dock-collapse', title: `Collapse / expand (${shortcutLabel('Mod+J')})`, attrs: { type: 'button', 'aria-label': 'Collapse panel' } },
            icon('chevronDown', 15),
        );
        collapse.addEventListener('click', () => this.toggle());
        this.body = h('div', { class: 'dock-body' });
        this.el = h('div', { class: 'dock' }, h('div', { class: 'dock-bar' }, this.tabs, h('div', { class: 'spacer' }), collapse), this.body);

        editor.on('open-code', ({ kind, id }) => this.open(kind, id));
        editor.on('show-graph', () => this.show('graph'));
        editor.store.on('change', () => this.syncDocs());
        editor.store.on('load', () => this.syncDocs());
        this.restore();
    }

    get collapsed(): boolean {
        return this.app.classList.contains('dock-collapsed');
    }

    setCollapsed(v: boolean) {
        this.app.classList.toggle('dock-collapsed', v);
        this.graph.setVisible(!v && this.active === 'graph');
        this.save();
    }

    toggle() {
        this.setCollapsed(!this.collapsed);
    }

    /** Opens (or focuses) the code tab of a script or shader. */
    open(kind: CodeKind, id: string, focus = true): CodePanel | null {
        const exists = kind === 'script' ? this.editor.store.doc.scripts.some((s) => s.id === id) : this.editor.store.doc.shaders.some((s) => s.id === id);
        if (!exists) return null;
        const key = `${kind}:${id}`;
        let doc = this.docs.find((d) => d.key === key);
        if (!doc) {
            const panel = new CodePanel(this.editor, kind, id);
            const title = h('span', { class: 'dock-tab-title', text: panel.title });
            const tab = this.makeTab(key, icon(kind === 'script' ? 'script' : 'shader', 13), '', title);
            doc = { key, kind, id, panel, tab, title };
            panel.onDirty = (dirty) => tab.classList.toggle('dirty', dirty);
            this.docs.push(doc);
            this.tabs.appendChild(tab);
        }
        this.show(key, focus);
        if (focus) requestAnimationFrame(() => doc!.panel.focus());
        this.save();
        return doc.panel;
    }

    panel(kind: CodeKind, id: string): CodePanel | null {
        return this.docs.find((d) => d.key === `${kind}:${id}`)?.panel ?? null;
    }

    /** The script or shader in the visible tab. */
    activeDoc(): { kind: CodeKind; id: string; name: string } | null {
        const d = this.docs.find((x) => x.key === this.active);
        return d && !this.collapsed ? { kind: d.kind, id: d.id, name: d.panel.title } : null;
    }

    /** Code panels with edits that were not applied yet. */
    dirtyPanels(): CodePanel[] {
        return this.docs.filter((d) => d.panel.dirty).map((d) => d.panel);
    }

    show(key: string, reveal = true) {
        this.active = key;
        for (const t of [this.graphTab, ...this.docs.map((d) => d.tab)]) t.classList.toggle('active', t.dataset.key === key);
        clear(this.body);
        if (key === 'graph') this.body.appendChild(this.graph.el);
        else {
            const doc = this.docs.find((d) => d.key === key);
            if (doc) this.body.appendChild(doc.panel.el);
        }
        this.graph.setVisible(key === 'graph' && !this.collapsed);
        if (reveal && this.collapsed) this.setCollapsed(false);
        this.save();
    }

    async close(key: string, force = false) {
        const i = this.docs.findIndex((d) => d.key === key);
        if (i < 0) return;
        const doc = this.docs[i];
        if (!force && doc.panel.dirty && !(await confirmDialog('Unsaved changes', `Discard the changes to ${doc.panel.title}?`, 'Discard', true))) return;
        doc.panel.dispose();
        doc.tab.remove();
        this.docs.splice(i, 1);
        if (this.active === key) this.show(this.docs[Math.min(i, this.docs.length - 1)]?.key ?? 'graph');
        this.save();
    }

    private makeTab(key: string, ic: Element, label: string, title: HTMLElement | null): HTMLElement {
        const tab = h('div', { class: 'dock-tab', dataset: { key }, attrs: { role: 'tab', tabindex: 0 } }, ic, title ?? h('span', { class: 'dock-tab-title', text: label }));
        tab.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.dock-tab-close')) return;
            if (this.active === key && !this.collapsed) {
                if (key === 'graph') this.setCollapsed(true);
                return;
            }
            this.show(key);
        });
        tab.addEventListener('auxclick', (e) => {
            if (e.button === 1 && key !== 'graph') void this.close(key);
        });
        if (key !== 'graph') {
            const close = h('button', { class: 'dock-tab-close', title: 'Close', attrs: { type: 'button', 'aria-label': 'Close tab' } }, icon('close', 11));
            close.addEventListener('click', () => void this.close(key));
            tab.appendChild(close);
        }
        return tab;
    }

    /** Keeps tab titles current and closes tabs of deleted files. */
    private syncDocs() {
        for (const doc of this.docs.slice()) {
            const d = doc.panel.doc;
            if (!d) void this.close(doc.key, true);
            else doc.title.textContent = d.name;
        }
    }

    private save() {
        try {
            localStorage.setItem(
                DOCK_KEY,
                JSON.stringify({ open: this.docs.map((d) => ({ kind: d.kind, id: d.id })), active: this.active, collapsed: this.collapsed }),
            );
        } catch { /* ignore */ }
    }

    private restore() {
        let state: any = null;
        try {
            state = JSON.parse(localStorage.getItem(DOCK_KEY) || 'null');
        } catch { /* ignore */ }
        this.app.classList.toggle('dock-collapsed', state ? !!state.collapsed : true);
        for (const d of Array.isArray(state?.open) ? state.open : []) {
            if (d && (d.kind === 'script' || d.kind === 'shader') && typeof d.id === 'string') this.open(d.kind, d.id, false);
        }
        const active = typeof state?.active === 'string' && (state.active === 'graph' || this.docs.some((d) => d.key === state.active)) ? state.active : 'graph';
        this.show(active, false);
    }
}

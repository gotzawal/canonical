import type { Editor } from '../editor';
import { BehaviorPanel } from './behavior/behaviorPanel';
import { onChanges, touches } from './batch';
import { CodePanel, type CodeKind } from './codePanel';
import { DecisionLogPanel } from './decisionLogPanel';
import { ProfilerPanel } from './profilerPanel';
import { clear, h, shortcutLabel } from './dom';
import { icon } from './icons';
import { confirmDialog, toast } from './overlays';
import { RenderGraphPanel } from './renderGraphPanel';
import { readLocal, writeLocal } from '../core/local';

interface OpenDoc {
    key: string;
    kind: CodeKind;
    id: string;
    panel: CodePanel;
    tab: HTMLElement;
    title: HTMLElement;
}

const DOCK_KEY = 'canonical-editor/dock';

/** Tabs that are always there, before the file tabs. */
type FixedKey = 'graph' | 'behavior' | 'decisions' | 'profiler';

/**
 * Bottom panel under the viewport: the render graph, the behavior trees, the
 * decision log, the profiler and one tab per open script, shader or tree JSON.
 */
export class Dock {
    readonly el: HTMLElement;
    readonly graph: RenderGraphPanel;
    readonly behavior: BehaviorPanel;
    readonly decisions: DecisionLogPanel;
    readonly profiler: ProfilerPanel;
    private tabs: HTMLElement;
    private body: HTMLElement;
    private graphTab: HTMLElement;
    private fixed: Record<FixedKey, { tab: HTMLElement; el: HTMLElement; setVisible(v: boolean): void }>;
    private docs: OpenDoc[] = [];
    private active = 'graph';

    constructor(private editor: Editor, private app: HTMLElement) {
        this.graph = new RenderGraphPanel(editor);
        this.behavior = new BehaviorPanel(editor);
        this.decisions = new DecisionLogPanel(editor);
        this.profiler = new ProfilerPanel(editor);
        this.graphTab = this.makeTab('graph', icon('graph', 13), 'Render Graph', null);
        this.fixed = {
            graph: { tab: this.graphTab, el: this.graph.el, setVisible: (v) => this.graph.setVisible(v) },
            behavior: { tab: this.makeTab('behavior', icon('behavior', 13), 'Behavior', null), el: this.behavior.el, setVisible: (v) => this.behavior.setVisible(v) },
            decisions: { tab: this.makeTab('decisions', icon('list', 13), 'Decisions', null), el: this.decisions.el, setVisible: (v) => this.decisions.setVisible(v) },
            profiler: { tab: this.makeTab('profiler', icon('gauge', 13), 'Profiler', null), el: this.profiler.el, setVisible: (v) => this.profiler.setVisible(v) },
        };
        this.tabs = h('div', { class: 'dock-tabs', attrs: { role: 'tablist' } }, this.graphTab, this.fixed.behavior.tab, this.fixed.decisions.tab, this.fixed.profiler.tab);
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
        editor.on('show-behavior', () => this.show('behavior'));
        editor.on('show-profiler', () => this.show('profiler'));
        editor.on('flush-edits', () => this.applyEdits());
        // Scripts and shaders change without a hint, behavior trees with a behavior hint.
        onChanges(editor.store, (hint) => touches(hint, 'behavior') && this.syncDocs());
        editor.store.on('load', () => this.syncDocs());
        this.restore();
    }

    get collapsed(): boolean {
        return this.app.classList.contains('dock-collapsed');
    }

    setCollapsed(v: boolean) {
        this.app.classList.toggle('dock-collapsed', v);
        for (const [key, f] of Object.entries(this.fixed)) f.setVisible(!v && this.active === key);
        this.save();
    }

    toggle() {
        this.setCollapsed(!this.collapsed);
    }

    /** Opens (or focuses) the code tab of a script or shader. */
    open(kind: CodeKind, id: string, focus = true): CodePanel | null {
        const d = this.editor.store.doc;
        const exists = kind === 'script' ? d.scripts.some((s) => s.id === id) : kind === 'behavior' ? d.behaviors.some((t) => t.id === id) : d.shaders.some((s) => s.id === id);
        if (!exists) return null;
        const key = `${kind}:${id}`;
        let doc = this.docs.find((d) => d.key === key);
        if (!doc) {
            const panel = new CodePanel(this.editor, kind, id);
            const title = h('span', { class: 'dock-tab-title', text: panel.title });
            const tab = this.makeTab(key, icon(kind === 'script' ? 'script' : kind === 'behavior' ? 'behavior' : 'shader', 13), '', title);
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

    /** Applies the code edited in the panels but not applied yet (before Play or a build). */
    private applyEdits() {
        const dirty = this.docs.filter((d) => d.panel.dirty);
        for (const d of dirty) d.panel.apply();
        if (dirty.length) toast(`Applied ${dirty.length} edited file(s) first.`, 'info');
    }

    show(key: string, reveal = true) {
        this.active = key;
        for (const t of [...Object.values(this.fixed).map((f) => f.tab), ...this.docs.map((d) => d.tab)]) t.classList.toggle('active', t.dataset.key === key);
        clear(this.body);
        const fixed = this.fixed[key as FixedKey];
        if (fixed) this.body.appendChild(fixed.el);
        else {
            const doc = this.docs.find((d) => d.key === key);
            if (doc) this.body.appendChild(doc.panel.el);
        }
        if (reveal && this.collapsed) this.setCollapsed(false);
        for (const [k, f] of Object.entries(this.fixed)) f.setVisible(k === key && !this.collapsed);
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
        if (this.active === key) this.show(this.docs[Math.min(i, this.docs.length - 1)]?.key ?? 'behavior');
        this.save();
    }

    private makeTab(key: string, ic: Element, label: string, title: HTMLElement | null): HTMLElement {
        const tab = h('div', { class: 'dock-tab', dataset: { key }, attrs: { role: 'tab', tabindex: 0 } }, ic, title ?? h('span', { class: 'dock-tab-title', text: label }));
        const fixed = key === 'graph' || key === 'behavior' || key === 'decisions' || key === 'profiler';
        tab.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.dock-tab-close')) return;
            if (this.active === key && !this.collapsed) {
                if (fixed) this.setCollapsed(true);
                return;
            }
            this.show(key);
        });
        tab.addEventListener('auxclick', (e) => {
            if (e.button === 1 && !fixed) void this.close(key);
        });
        if (!fixed) {
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
        writeLocal(DOCK_KEY, { open: this.docs.map((d) => ({ kind: d.kind, id: d.id })), active: this.active, collapsed: this.collapsed });
    }

    private restore() {
        const state = readLocal<any>(DOCK_KEY, null);
        this.app.classList.toggle('dock-collapsed', state ? !!state.collapsed : true);
        for (const d of Array.isArray(state?.open) ? state.open : []) {
            if (d && (d.kind === 'script' || d.kind === 'shader' || d.kind === 'behavior') && typeof d.id === 'string') this.open(d.kind, d.id, false);
        }
        const active = typeof state?.active === 'string' && (state.active in this.fixed || this.docs.some((d) => d.key === state.active)) ? state.active : 'graph';
        this.show(active, false);
    }
}

import type { Editor } from '../editor';
import { SHADER_TEMPLATES } from '../core/templates';
import type { ParamValue, PostDoc } from '../core/types';
import type { GraphInfo, PassInfo } from '../engine/renderGraph';
import { clear, h } from './dom';
import { icon } from './icons';
import { showMenu, type MenuItem } from './overlays';
import { shaderParamRows } from './paramFields';
import { CheckboxField, EditHooks, button, iconButton } from './widgets';

const NODE_W = 170;
const NODE_H = 46;
const GAP_X = 58;
const GAP_Y = 14;
const PAD = 24;
const SVG_NS = 'http://www.w3.org/2000/svg';

const BUILTIN_POSTS: Record<string, { label: string; toggle?: (e: any, v: boolean) => void; get?: (e: any) => boolean }> = {
    GTAOPost: { label: 'Ambient Occlusion', toggle: (e, v) => (e.ao.enable = v), get: (e) => e.ao.enable },
    BloomPost: { label: 'Bloom', toggle: (e, v) => (e.bloom.enable = v), get: (e) => e.bloom.enable },
    GlobalFog: { label: 'Fog', toggle: (e, v) => (e.fog.enable = v), get: (e) => e.fog.enable },
    FXAAPost: { label: 'FXAA (anti-aliasing)', toggle: (e, v) => (e.fxaa = v), get: (e) => e.fxaa },
    TonemapPost: { label: 'Tone Mapping' },
};

function disable(b: HTMLButtonElement, off: boolean): HTMLButtonElement {
    b.disabled = off;
    return b;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
}

/**
 * Shows the engine's render graph as a node graph (passes and the resources
 * flowing between them), lets passes be switched off and on, and manages
 * the custom post effects in the post chain.
 */
export class RenderGraphPanel {
    readonly el: HTMLElement;
    private canvas: HTMLElement;
    private side: HTMLElement;
    private errorBar: HTMLElement;
    private summary: HTMLElement;
    private selected: string | null = null;
    private resource: string | null = null;
    private info: GraphInfo = { passes: [], edges: [], error: '' };
    private open = 0;
    private expanded = new Set<string>();
    private visible = false;

    constructor(private editor: Editor) {
        this.canvas = h('div', { class: 'graph-canvas' });
        this.side = h('div', { class: 'graph-side' });
        this.errorBar = h('div', { class: 'graph-error', attrs: { hidden: true } });
        this.summary = h('span', { class: 'graph-summary' });
        this.el = h(
            'div',
            { class: 'graph-panel' },
            h(
                'div',
                { class: 'graph-toolbar' },
                icon('graph', 15),
                h('span', { class: 'graph-title', text: 'Render Graph' }),
                this.summary,
                h('div', { class: 'spacer' }),
                button('Add Post Effect', (e) => this.addMenu(e), 'small', 'plus'),
                iconButton('refresh', 'Refresh', () => this.refresh()),
            ),
            this.errorBar,
            h('div', { class: 'graph-main' }, this.canvas, this.side),
        );
        editor.graph.on('changed', () => this.refresh());
        editor.store.on('change', (hint) => {
            if (hint?.nodes) return;
            this.renderSide();
        });
        editor.shaders.on('status', () => this.renderSide());
    }

    /** The dock calls this when the tab is shown or hidden. */
    setVisible(v: boolean) {
        this.visible = v;
        if (v) this.refresh();
    }

    refresh() {
        if (!this.visible) return;
        this.info = this.editor.graph.info();
        const enabled = this.info.passes.filter((p) => p.enabled).length;
        this.summary.textContent = `${enabled} of ${this.info.passes.length} passes active · ${this.editor.store.doc.renderGraph.posts.length} custom effect(s)`;
        this.errorBar.hidden = !this.info.error;
        this.errorBar.textContent = this.info.error;
        this.renderGraph();
        this.renderSide();
    }

    // ----------------------------------------------------------------- graph

    private renderGraph() {
        const { passes, edges } = this.info;
        const active = passes.filter((p) => p.order >= 0).sort((a, b) => a.order - b.order);
        const disabled = passes.filter((p) => p.order < 0);
        const rank = new Map<string, number>();
        for (const p of active) {
            let r = 0;
            for (const e of edges) if (e.to === p.name && rank.has(e.from)) r = Math.max(r, rank.get(e.from)! + 1);
            rank.set(p.name, r);
        }
        const columns: PassInfo[][] = [];
        for (const p of active) (columns[rank.get(p.name)!] ??= []).push(p);
        const pos = new Map<string, { x: number; y: number }>();
        let height = 0;
        columns.forEach((col, ci) => {
            col.forEach((p, ri) => {
                const x = PAD + ci * (NODE_W + GAP_X);
                const y = PAD + ri * (NODE_H + GAP_Y);
                pos.set(p.name, { x, y });
                height = Math.max(height, y + NODE_H);
            });
        });
        let width = PAD * 2 + Math.max(1, columns.length) * (NODE_W + GAP_X) - GAP_X;
        const disabledY = height + (disabled.length ? 46 : 0);
        disabled.forEach((p, i) => {
            pos.set(p.name, { x: PAD + i * (NODE_W + 16), y: disabledY });
        });
        if (disabled.length) {
            width = Math.max(width, PAD * 2 + disabled.length * (NODE_W + 16));
            height = disabledY + NODE_H;
        }
        height += PAD;

        const root = svg('svg', { width, height, class: 'graph-svg' });
        const defs = svg('defs');
        for (const kind of ['data', 'mutate', 'dep', 'hot']) {
            const m = svg('marker', { id: `arrow-${kind}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
            m.appendChild(svg('path', { d: 'M0 0 8 4 0 8Z', class: `arrow ${kind}` }));
            defs.appendChild(m);
        }
        root.appendChild(defs);
        if (disabled.length) {
            const t = svg('text', { x: PAD, y: disabledY - 12, class: 'graph-label' });
            t.textContent = 'Switched off';
            root.appendChild(t);
        }

        const hot = (e: { from: string; to: string; label: string }) =>
            (this.selected && (e.from === this.selected || e.to === this.selected)) || (this.resource && e.label === this.resource);
        for (const e of edges) {
            const a = pos.get(e.from), b = pos.get(e.to);
            if (!a || !b) continue;
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
            const x2 = b.x, y2 = b.y + NODE_H / 2;
            const dx = Math.max(24, (x2 - x1) / 2);
            const isHot = hot(e);
            const path = svg('path', {
                d: `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 2} ${y2}`,
                class: `edge ${e.kind}${isHot ? ' hot' : ''}`,
                'marker-end': `url(#arrow-${isHot ? 'hot' : e.kind})`,
            });
            const title = svg('title');
            title.textContent = e.kind === 'dep' ? `${e.from} runs before ${e.to}` : `${e.from} → ${e.to}: ${e.label}${e.kind === 'mutate' ? ' (modified in place)' : ''}`;
            path.appendChild(title);
            root.appendChild(path);
        }

        const postCount = this.editor.graph.chain().length;
        for (const p of [...active, ...disabled]) {
            const at = pos.get(p.name)!;
            const g = svg('g', {
                class: 'gnode' + (p.enabled ? '' : ' off') + (p.name === this.selected ? ' selected' : '') + (this.resource && (p.reads.includes(this.resource) || p.writes.includes(this.resource)) ? ' touched' : ''),
                transform: `translate(${at.x} ${at.y})`,
                tabindex: 0,
            });
            g.appendChild(svg('rect', { width: NODE_W, height: NODE_H, rx: 7 }));
            const name = svg('text', { x: 12, y: 19, class: 'gname' });
            name.textContent = p.name.replace(/Pass$/, '');
            g.appendChild(name);
            const sub = svg('text', { x: 12, y: 35, class: 'gsub' });
            sub.textContent =
                p.name === 'PostPass'
                    ? `${postCount} effect${postCount === 1 ? '' : 's'}`
                    : p.order >= 0
                      ? `#${p.order + 1} · in ${p.reads.length} · out ${p.writes.length}`
                      : 'disabled';
            g.appendChild(sub);
            if (p.essential) {
                const lock = svg('circle', { cx: NODE_W - 12, cy: 12, r: 3.5, class: 'gessential' });
                g.appendChild(lock);
            }
            const title = svg('title');
            title.textContent = `${p.name}\nreads: ${p.reads.join(', ') || '-'}\nwrites: ${p.writes.join(', ') || '-'}`;
            g.appendChild(title);
            g.addEventListener('click', () => {
                this.selected = this.selected === p.name ? null : p.name;
                this.resource = null;
                this.renderGraph();
                this.renderSide();
            });
            g.addEventListener('dblclick', () => this.toggle(p));
            root.appendChild(g);
        }
        clear(this.canvas);
        this.canvas.appendChild(root);
    }

    private toggle(p: PassInfo) {
        if (p.essential && p.enabled) return;
        this.editor.setPassEnabled(p.name, !p.enabled);
    }

    // ------------------------------------------------------------------ side

    private renderSide() {
        while (this.open > 0) {
            this.open--;
            this.editor.store.end();
        }
        clear(this.side);
        const pass = this.info.passes.find((p) => p.name === this.selected);
        if (pass) this.side.appendChild(this.passDetails(pass));
        else {
            this.side.appendChild(
                h('div', { class: 'graph-hint' }, h('p', { text: 'Click a pass to see what it reads and writes. Double click switches it off or on; changes the graph cannot run with are refused.' })),
            );
        }
        this.side.appendChild(this.chainSection());
    }

    private passDetails(p: PassInfo): HTMLElement {
        const enabled = new CheckboxField(p.enabled, (v) => this.editor.setPassEnabled(p.name, v), p.essential ? 'Enabled (required)' : 'Enabled');
        if (p.essential) (enabled.el.querySelector('input') as HTMLInputElement).disabled = true;
        const chips = (list: string[], created: string[] = []) =>
            list.length
                ? h(
                      'div',
                      { class: 'chips' },
                      list.map((r) => {
                          const c = h('button', {
                              class: 'chip' + (r === this.resource ? ' active' : '') + (created.includes(r) ? ' created' : ''),
                              text: r,
                              title: created.includes(r) ? 'Created by this pass' : 'Click to highlight who writes and reads it',
                              attrs: { type: 'button' },
                          });
                          c.addEventListener('click', () => {
                              this.resource = this.resource === r ? null : r;
                              this.renderGraph();
                              this.renderSide();
                          });
                          return c;
                      }),
                  )
                : h('div', { class: 'muted', text: 'none' });
        return h(
            'section',
            { class: 'graph-details' },
            h('div', { class: 'graph-details-head' }, h('strong', { text: p.name }), h('span', { class: 'muted', text: p.order >= 0 ? `runs #${p.order + 1}` : 'not running' })),
            enabled.el,
            h('div', { class: 'group-label', text: 'Reads' }),
            chips(p.reads),
            h('div', { class: 'group-label', text: 'Writes' }),
            chips(p.writes, p.creates),
            p.deps.length ? h('div', { class: 'group-label', text: 'Runs after' }) : null,
            p.deps.length ? chips(p.deps) : null,
        );
    }

    private chainSection(): HTMLElement {
        const env = this.editor.store.doc.environment;
        const chain = this.editor.graph.chain();
        const docs = this.editor.store.doc.renderGraph.posts;
        const list = h('div', { class: 'chain' });
        const missing = docs.filter((d) => !chain.some((c) => c.custom === d.id));
        for (const c of chain) {
            if (c.custom) {
                const d = docs.find((x) => x.id === c.custom);
                if (d) list.appendChild(this.customItem(d, docs.indexOf(d), docs.length));
                continue;
            }
            const b = BUILTIN_POSTS[c.name];
            const item = h('div', { class: 'chain-item builtin' }, icon('sliders', 13), h('span', { class: 'chain-name', text: b?.label ?? c.name }));
            if (b?.toggle && b.get) {
                const cb = new CheckboxField(b.get(env), (v) => {
                    this.editor.store.commit(`${v ? 'Enable' : 'Disable'} ${b.label}`, (d) => b.toggle!(d.environment, v), { env: true });
                });
                item.appendChild(cb.el);
            } else {
                item.appendChild(h('span', { class: 'muted', text: c.final ? 'final' : '' }));
            }
            list.appendChild(item);
        }
        // Effects whose shader has no valid version yet are not in the chain.
        for (const d of missing) list.appendChild(this.customItem(d, docs.indexOf(d), docs.length, true));
        return h(
            'section',
            { class: 'graph-chain' },
            h('div', { class: 'graph-details-head' }, h('strong', { text: 'Post Chain' }), h('span', { class: 'muted', text: 'runs top to bottom' })),
            list,
            docs.length ? null : h('p', { class: 'muted small', text: 'Add a post effect to run your own WGSL on the whole screen.' }),
        );
    }

    private customItem(d: PostDoc, index: number, count: number, broken = false): HTMLElement {
        const shader = this.editor.store.doc.shaders.find((s) => s.id === d.shader);
        const status = this.editor.shaders.status(d.shader);
        const open = this.expanded.has(d.id);
        const enabled = new CheckboxField(d.enabled, (v) => this.editor.updatePostEffect(d.id, { enabled: v }, v ? 'Enable Effect' : 'Disable Effect'));
        const head = h(
            'div',
            { class: 'chain-item custom' + (broken ? ' broken' : '') },
            h('button', { class: 'chain-caret' + (open ? ' open' : ''), attrs: { type: 'button', 'aria-label': 'Properties' } }, icon('chevron', 12)),
            icon('shader', 13),
            h('span', { class: 'chain-name', text: shader?.name ?? 'Missing shader', title: broken ? status.messages[0]?.message ?? 'Not compiled yet' : '' }),
            broken ? h('span', { class: 'tree-badge error', text: status.state === 'compiling' ? 'compiling' : 'error' }) : null,
            disable(iconButton('arrowUp', 'Move up', () => this.editor.movePostEffect(d.id, -1)), index === 0),
            disable(iconButton('arrowDown', 'Move down', () => this.editor.movePostEffect(d.id, 1)), index === count - 1),
            iconButton('code', 'Edit shader', () => shader && this.editor.emit('open-code', { kind: 'shader', id: shader.id })),
            iconButton('trash', 'Remove', () => this.editor.removePostEffect(d.id)),
            enabled.el,
        );
        head.querySelector('.chain-caret')!.addEventListener('click', () => {
            if (open) this.expanded.delete(d.id);
            else this.expanded.add(d.id);
            this.renderSide();
        });
        const wrap = h('div', { class: 'chain-entry' }, head);
        if (open) {
            const props = this.editor.shaders.props(d.shader);
            const textures = this.editor.store.doc.assets.filter((a) => a.kind === 'texture');
            const rows = shaderParamRows(props, d.params, (name, label) => this.paramHooks(d.id, name, label), textures);
            wrap.appendChild(h('div', { class: 'chain-params' }, rows.length ? rows : h('div', { class: 'muted small', text: 'This shader declares no properties.' })));
        }
        return wrap;
    }

    private paramHooks(postId: string, name: string, label: string): EditHooks<ParamValue> {
        const store = this.editor.store;
        const write = (v: ParamValue) => {
            store.update((doc) => {
                const p = doc.renderGraph.posts.find((x) => x.id === postId);
                if (p) p.params = { ...p.params, [name]: v };
            }, { env: true });
            this.editor.graph.apply();
        };
        return {
            begin: () => {
                this.open++;
                store.begin(label);
            },
            input: write,
            end: () => {
                if (this.open <= 0) return;
                this.open--;
                store.end();
            },
            commit: (v) => {
                store.begin(label);
                try {
                    write(v);
                } finally {
                    store.end();
                }
            },
        };
    }

    private addMenu(e: MouseEvent) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const posts = this.editor.store.doc.shaders.filter((s) => s.kind === 'post');
        const items: MenuItem[] = posts.map((s) => ({ label: s.name, icon: 'shader', action: () => this.editor.addPostEffect(s.id) }));
        if (items.length) items.push({ separator: true });
        items.push({
            label: 'New Post Shader',
            icon: 'plus',
            submenu: SHADER_TEMPLATES.filter((t) => t.kind === 'post').map((t) => ({
                label: t.label,
                action: () => {
                    const doc = this.editor.createShader({ template: t.id });
                    this.editor.addPostEffect(doc.id);
                },
            })),
        });
        showMenu(items, r.left, r.bottom + 4);
    }
}

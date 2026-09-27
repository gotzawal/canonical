// The Decisions tab of the dock: the decision log of the last Play session.
// One row per Ask request: when, who (object, Ask node, request number), the
// answers and what became of them; a row opens the facts and context the
// model saw and the probability of every option.

import { formatValue } from '../core/behavior/nodeTypes';
import type { AskOutcome, DecisionLogEntry } from '../core/types';
import type { Editor } from '../editor';
import { clear, h } from './dom';
import { icon } from './icons';
import { SelectField, button } from './widgets';

const OUTCOMES: AskOutcome[] = ['written', 'low_confidence', 'superseded', 'held', 'timeout', 'unavailable'];

export class DecisionLogPanel {
    readonly el: HTMLElement;
    private list: HTMLElement;
    private summary: HTMLElement;
    private filters: HTMLElement;
    private visible = false;
    private node = '';
    private agent = '';
    private outcome = '';
    private open = new Set<string>();
    private dirty = true;

    constructor(private editor: Editor) {
        this.list = h('div', { class: 'bt-log-list' });
        this.summary = h('span', { class: 'graph-summary' });
        this.filters = h('div', { class: 'inline' });
        this.el = h(
            'div',
            { class: 'graph-panel bt-log' },
            h(
                'div',
                { class: 'graph-toolbar' },
                icon('list', 15),
                h('span', { class: 'graph-title', text: 'Decisions' }),
                this.summary,
                h('div', { class: 'spacer' }),
                this.filters,
                button('Clear', () => editor.player.agents.log.clear(), 'small subtle'),
            ),
            this.list,
        );
        const log = editor.player.agents.log;
        const later = () => {
            this.dirty = true;
            if (this.visible) requestAnimationFrame(() => this.render());
        };
        log.on('entry', later);
        log.on('clear', later);
    }

    setVisible(v: boolean) {
        this.visible = v;
        if (v) this.render();
    }

    private render() {
        if (!this.visible || !this.dirty) return;
        this.dirty = false;
        const log = this.editor.player.agents.log;
        const all = log.entries;
        const nodes = Array.from(new Set(all.map((e) => e.node))).sort();
        const agents = Array.from(new Map(all.map((e) => [e.agent, e.agentName])).entries());
        clear(this.filters);
        const nodePick = new SelectField([{ value: '', label: 'All Ask nodes' }, ...nodes.map((n) => ({ value: n, label: n }))], this.node, (v) => {
            this.node = v;
            this.dirty = true;
            this.render();
        });
        const agentPick = new SelectField([{ value: '', label: 'All objects' }, ...agents.map(([id, name]) => ({ value: id, label: name }))], this.agent, (v) => {
            this.agent = v;
            this.dirty = true;
            this.render();
        });
        const outcomePick = new SelectField([{ value: '', label: 'Any outcome' }, ...OUTCOMES.map((o) => ({ value: o, label: o.replace('_', ' ') }))], this.outcome, (v) => {
            this.outcome = v;
            this.dirty = true;
            this.render();
        });
        this.filters.append(nodePick.el, agentPick.el, outcomePick.el);
        const shown = log.query({ node: this.node || undefined, agent: this.agent || undefined, outcome: (this.outcome || undefined) as AskOutcome | undefined });
        const counts = log.outcomes(shown);
        this.summary.textContent = `${shown.length} of ${all.length} requests · ${OUTCOMES.filter((o) => counts[o]).map((o) => `${counts[o]} ${o.replace('_', ' ')}`).join(', ') || 'none yet'}`;
        const scroll = this.list.scrollTop;
        clear(this.list);
        if (!all.length) {
            this.list.appendChild(h('div', { class: 'empty-hint', text: 'Ask requests of the last Play session show up here: the facts the model saw, the probabilities, and whether the answer was written, too uncertain, held, replaced by a newer request, too late, or not possible without a model.' }));
            return;
        }
        for (const e of shown.slice(-300).reverse()) this.list.appendChild(this.row(e));
        this.list.scrollTop = scroll;
    }

    private row(e: DecisionLogEntry): HTMLElement {
        const key = `${e.agent}/${e.node}/${e.seq}`;
        const open = this.open.has(key);
        const head = h(
            'div',
            { class: 'bt-log-row' + (open ? ' open' : '') },
            icon('chevron', 11, 'slot-caret'),
            h('span', { class: 'bt-log-time mono', text: `${e.time.toFixed(2)}s` }),
            h('span', { class: 'bt-log-who', text: e.agentName }),
            h('span', { class: 'mono', text: `${e.node}#${e.seq}` }),
            h(
                'span',
                { class: 'bt-log-answers' },
                e.questions.map((q) => h('span', { class: 'bt-log-answer' }, h('span', { class: 'mono', text: `${q.key}=${formatValue(q.value)}` }), q.confidence !== null ? h('span', { class: 'muted', text: `${Math.round(q.confidence * 100)}%` }) : null, h('span', { class: 'bt-outcome ' + q.outcome, text: q.outcome.replace('_', ' ') }))),
            ),
            h('span', { class: 'muted small', text: `${e.cache !== 'none' ? `${e.cache} cache · ` : ''}${e.latency} ms` }),
        );
        head.addEventListener('click', () => {
            if (open) this.open.delete(key);
            else this.open.add(key);
            this.dirty = true;
            this.render();
        });
        const item = h('div', { class: 'bt-log-item' }, head);
        if (!open) return item;
        const facts = Object.entries(e.facts).map(([k, v]) => `${k} = ${formatValue(v)}`).join(', ') || 'none';
        const details = h(
            'div',
            { class: 'bt-log-details' },
            h('div', null, h('b', { text: 'Facts: ' }), h('span', { class: 'mono', text: facts })),
            h('div', null, h('b', { text: 'Context: ' }), h('span', { class: 'mono', text: e.context.join(', ') || 'none' })),
            e.questions.map((q) =>
                h(
                    'div',
                    { class: 'bt-log-q' },
                    h('div', null, h('b', { text: `${q.key} (${q.format}): ` }), h('span', { text: q.text })),
                    q.probabilities
                        ? h(
                              'div',
                              { class: 'bt-probs' },
                              (q.options ?? (q.format === 'noul' ? [{ value: 'false', text: '' }, { value: 'true', text: '' }] : [])).map((o, i) =>
                                  h(
                                      'div',
                                      { class: 'bt-prob' + (o.value === String(q.value) || (q.format === 'noul' && i === 1) ? ' chosen' : '') },
                                      h('span', { class: 'mono bt-prob-label', text: o.value, title: o.text }),
                                      h('span', { class: 'bt-prob-bar' }, h('span', { style: { width: `${Math.round((q.probabilities![i] ?? 0) * 100)}%` } })),
                                      h('span', { class: 'mono', text: (q.probabilities![i] ?? 0).toFixed(3) }),
                                  ),
                              ),
                          )
                        : h('div', { class: 'muted', text: 'No answer.' }),
                ),
            ),
            h('div', { class: 'muted small', text: `${e.provider} · ${e.model || 'no model'} · tree ${e.tree} v${e.treeVersion} · frame ${e.frame} · ${e.at}` }),
        );
        item.appendChild(details);
        return item;
    }
}

// The project's token usage, per piece of work (ai/usage.ts): totals, what
// kind of work and which stage spent it, per model, the costliest pieces
// and the latest ones, with a CSV download. The chat's token count opens it.

import { download } from '../core/persistence';
import type { Editor } from '../editor';
import { groupTotals, modelTotals, tokensOf, usageCsv, USAGE_KINDS, type UsageEntry, type UsageKind, type UsageTotals } from '../ai/usage';
import type { StageId } from '../core/types';
import { stageDef } from '../design/stages';
import { QUALITY_NAMES } from '../openrouter/imageQuality';
import { clear, h } from './dom';
import { confirmDialog, modal, type Modal } from './overlays';
import { button } from './widgets';

/** Rows the list of recent work shows. */
const RECENT = 60;

let open: Modal | null = null;

export function openUsageDialog(editor: Editor) {
    if (open && !open.closed) return;
    const log = editor.usage;
    const body = h('div', { class: 'usage' });
    let frame = 0;
    const render = () => {
        frame = 0;
        clear(body);
        body.append(...content(log.entries, log.totals()));
    };
    const off = log.on('change', () => {
        frame ||= requestAnimationFrame(render);
    });
    const m = modal(`Token Usage: ${editor.store.doc.name}`, body, {
        cls: 'usage-modal',
        onClose: () => {
            off();
            cancelAnimationFrame(frame);
            open = null;
        },
    });
    open = m;
    const csv = button('Download CSV', () => {
        const stem = editor.store.doc.name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scene';
        download(new Blob([usageCsv(log.entries)], { type: 'text/csv' }), `${stem}-token-usage.csv`);
    }, 'subtle', 'save');
    const reset = button('Clear', async () => {
        if (await confirmDialog('Clear Token Usage', 'Forget what this project has spent so far? The numbers start again from zero.', 'Clear', true)) log.clear();
    }, 'subtle', 'trash');
    m.footer.append(csv, reset, h('div', { class: 'spacer' }), button('Close', () => m.close(), 'primary'));
    void log.loading.then(() => !m.closed && render());
    render();
}

function content(entries: readonly UsageEntry[], all: UsageTotals): Node[] {
    if (!all.count) {
        return [h('p', { class: 'muted', text: 'Nothing spent on this project yet. Each request of the assistant, conversation summary, memo, image generation and this.chat() call of a script shows up here with its tokens and credits.' })];
    }
    const listed = entries.length < all.count ? ` (older work only in the totals: ${all.count - entries.length})` : '';
    const recent = [...entries].sort((a, b) => b.at - a.at).slice(0, RECENT);
    const costliest = [...entries].filter((e) => tokensOf(e) || e.cost + e.imageCost).sort((a, b) => tokensOf(b) - tokensOf(a) || b.cost + b.imageCost - (a.cost + a.imageCost)).slice(0, 5);
    return [
        summary(all),
        h('p', { class: 'muted small', text: `Credits are what OpenRouter reported. Prompt tokens include the images sent; cached ones cost a fraction of the input price.${listed}` }),
        section('By kind of work', groupTable('Work', groupTotals(entries, (e) => e.kind), (k) => USAGE_KINDS[k as UsageKind] ?? k)),
        section('By stage', groupTable('Stage', groupTotals(entries, (e) => e.stage ?? '-'), (k) => (k === '-' ? 'Outside the pipeline' : stageDef(k as StageId).title))),
        section('By model', groupTable('Model', modelTotals(entries), (k) => k)),
        costliest.length ? section('Costliest work', entryTable(costliest)) : null,
        section(`Latest work${entries.length > RECENT ? ` (${RECENT} of ${entries.length})` : ''}`, entryTable(recent)),
    ].filter((n): n is HTMLElement => !!n);
}

function summary(t: UsageTotals): HTMLElement {
    const stat = (label: string, value: string, title = '') => h('div', { class: 'usage-stat', title }, h('div', { class: 'usage-stat-value', text: value }), h('div', { class: 'usage-stat-label', text: label }));
    return h(
        'div',
        { class: 'usage-stats' },
        stat('tokens', tokens(tokensOf(t)), `${t.prompt.toLocaleString()} prompt + ${t.completion.toLocaleString()} completion tokens`),
        stat('read from the cache', t.prompt ? `${Math.round((t.cached / t.prompt) * 100)}%` : '-', `${t.cached.toLocaleString()} of ${t.prompt.toLocaleString()} prompt tokens`),
        stat('credits', credits(t.cost)),
        stat('model calls', t.calls.toLocaleString(), `in ${t.count.toLocaleString()} pieces of work`),
        stat('images sent / made', `${t.sent} / ${t.made}`),
    );
}

function section(title: string, table: HTMLElement): HTMLElement {
    return h('section', { class: 'usage-section' }, h('div', { class: 'group-label', text: title }), h('div', { class: 'usage-scroll' }, table));
}

function groupTable(what: string, rows: [string, UsageTotals][], name: (key: string) => string): HTMLElement {
    const all = rows.reduce((n, [, t]) => n + tokensOf(t), 0);
    return table(
        1,
        [what, 'Count', 'Calls', 'Prompt', 'Cached', 'Completion', 'Share', 'Images', 'Credits'],
        rows.map(([k, t]) => [
            name(k),
            t.count.toLocaleString(),
            t.calls.toLocaleString(),
            tokens(t.prompt),
            t.prompt ? `${Math.round((t.cached / t.prompt) * 100)}%` : '-',
            tokens(t.completion),
            all ? `${Math.round((tokensOf(t) / all) * 100)}%` : '-',
            t.sent || t.made ? `${t.sent} / ${t.made}` : '-',
            credits(t.cost),
        ]),
    );
}

function entryTable(entries: UsageEntry[]): HTMLElement {
    return table(
        3,
        ['When', 'Work', 'Stage', 'Calls', 'Prompt', 'Cached', 'Completion', 'Images', 'Credits', 'Time'],
        entries.map((e) => [
            when(e.at),
            h('span', { class: 'usage-work', text: e.label, title: `${USAGE_KINDS[e.kind]}: ${e.label}${e.model ? `\n${e.model}` : ''}${e.imageModel ? `\n${e.imageModel}` : ''}${e.tools ? `\n${e.tools} tool calls` : ''}` }),
            e.stage ? stageDef(e.stage).title : '-',
            e.calls ? e.calls.toLocaleString() : '-',
            tokens(e.prompt),
            e.prompt ? `${Math.round((e.cached / e.prompt) * 100)}%` : '-',
            tokens(e.completion),
            images(e),
            credits(e.cost + e.imageCost),
            e.running ? 'running' : `${Math.max(0.1, e.ms / 1000).toFixed(1)} s`,
        ]),
    );
}

/** A table whose first `words` columns are text, the rest numbers. */
function table(words: number, head: string[], rows: (string | HTMLElement)[][]): HTMLElement {
    const cls = (i: number) => (i < words ? 'word' : '');
    return h(
        'table',
        { class: 'usage-table' },
        h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: cls(i), text: c })))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: cls(i) }, c))))),
    );
}

/** Images sent and made, with the quality they went at. */
function images(e: UsageEntry): string {
    const bits: string[] = [];
    if (e.sent) bits.push(`${e.sent} sent${e.seeQuality ? ` (${QUALITY_NAMES[e.seeQuality].toLowerCase()})` : ''}`);
    if (e.made) bits.push(`${e.made} made${e.drawQuality ? ` (${QUALITY_NAMES[e.drawQuality].toLowerCase()})` : ''}`);
    return bits.join(', ') || '-';
}

export function tokens(n: number): string {
    if (!n) return '-';
    return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

function credits(v: number): string {
    return v > 0 ? `$${v.toFixed(v < 0.1 ? 4 : 2)}` : '-';
}

function when(at: number): string {
    const d = new Date(at);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

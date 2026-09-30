// The project's token usage, per piece of work (ai/usage.ts): totals, what
// kind of work (the assistant's requests split by what their model calls
// worked on) and which stage spent it, per model, the costliest pieces and
// the latest ones, with a CSV download. Input tokens are shown as text and
// images, apart from the output. The chat's token count opens it.

import { download } from '../core/persistence';
import type { Editor } from '../editor';
import {
    groupTotals, modelTotals, tokensOf, usageCsv, USAGE_KINDS, WORK_KINDS, workTotals, type UsageEntry, type UsageKind, type UsageTotals, type WorkKind,
} from '../ai/usage';
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
        h('p', {
            class: 'muted small',
            text: 'Credits are what OpenRouter reported. Input is split into text and images: the images\' share is estimated from their sizes and the provider\'s rules '
                + '(reported where a provider does), and cached input costs a fraction of the input price. The assistant\'s requests are split by what each model call '
                + `worked on: the tools it called, or an answer.${listed}`,
        }),
        section('By kind of work', kindTable(entries)),
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
        stat('tokens', tokens(tokensOf(t)), `${t.prompt.toLocaleString()} input + ${t.completion.toLocaleString()} output tokens`),
        stat('text input', tokens(t.prompt - t.imageTokens), `${(t.prompt - t.imageTokens).toLocaleString()} input tokens of text (the conversation, tool results, the editor's context)`),
        stat('image input', tokens(t.imageTokens), `About ${t.imageTokens.toLocaleString()} input tokens of the ${t.sent} images sent, counted each time a model call carried them (estimated from their sizes)`),
        stat('output', tokens(t.completion), `${t.completion.toLocaleString()} output tokens (answers, tool calls and reasoning)`),
        stat('read from the cache', t.prompt ? `${Math.round((t.cached / t.prompt) * 100)}%` : '-', `${t.cached.toLocaleString()} of ${t.prompt.toLocaleString()} input tokens`),
        stat('credits', credits(t.cost)),
        stat('model calls', t.calls.toLocaleString(), `in ${t.count.toLocaleString()} pieces of work`),
        stat('images sent / made', `${t.sent} / ${t.made}`),
    );
}

function section(title: string, table: HTMLElement): HTMLElement {
    return h('section', { class: 'usage-section' }, h('div', { class: 'group-label', text: title }), h('div', { class: 'usage-scroll' }, table));
}

const GROUP_HEAD = ['Count', 'Calls', 'Text in', 'Image in', 'Cached', 'Output', 'Share', 'Images', 'Credits'];

/** The numbers of a group's row; `all` is the tokens of every row, for the share. */
function groupCells(t: UsageTotals, all: number): string[] {
    return [
        t.count.toLocaleString(),
        t.calls.toLocaleString(),
        tokens(t.prompt - t.imageTokens),
        tokens(t.imageTokens),
        t.prompt ? `${Math.round((t.cached / t.prompt) * 100)}%` : '-',
        tokens(t.completion),
        all ? `${Math.round((tokensOf(t) / all) * 100)}%` : '-',
        t.sent || t.made ? `${t.sent} / ${t.made}` : '-',
        credits(t.cost),
    ];
}

function groupTable(what: string, rows: [string, UsageTotals][], name: (key: string) => string): HTMLElement {
    const all = rows.reduce((n, [, t]) => n + tokensOf(t), 0);
    return table(1, [what, ...GROUP_HEAD], rows.map(([k, t]) => [name(k), ...groupCells(t, all)]));
}

/** The kinds of work, the assistant's requests with a row under them for each thing their model calls worked on. */
function kindTable(entries: readonly UsageEntry[]): HTMLElement {
    const kinds = groupTotals(entries, (e) => e.kind);
    const all = kinds.reduce((n, [, t]) => n + tokensOf(t), 0);
    const rows: (string | HTMLElement)[][] = [];
    const sub: number[] = [];
    for (const [k, t] of kinds) {
        rows.push([USAGE_KINDS[k as UsageKind] ?? k, ...groupCells(t, all)]);
        if (k !== 'request') continue;
        for (const [w, wt] of workTotals(entries)) {
            sub.push(rows.length);
            const name = w ? WORK_KINDS[w as WorkKind] ?? w : 'Not split (earlier requests)';
            // Count: the requests that did some of it.
            rows.push([h('span', { class: 'usage-sub-name', text: name, title: w ? `Model calls of the assistant's requests that worked on this (${w})` : '' }), ...groupCells(wt, all)]);
        }
    }
    const el = table(1, ['Work', ...GROUP_HEAD], rows);
    const trs = el.querySelectorAll('tbody tr');
    for (const i of sub) trs[i]?.classList.add('usage-sub');
    return el;
}

function entryTable(entries: UsageEntry[]): HTMLElement {
    return table(
        3,
        ['When', 'Work', 'Stage', 'Calls', 'Text in', 'Image in', 'Cached', 'Output', 'Images', 'Credits', 'Time'],
        entries.map((e) => [
            when(e.at),
            h('span', { class: 'usage-work', text: e.label, title: `${USAGE_KINDS[e.kind]}: ${e.label}${e.model ? `\n${e.model}` : ''}${e.imageModel ? `\n${e.imageModel}` : ''}${e.tools ? `\n${e.tools} tool calls` : ''}${workLines(e)}` }),
            e.stage ? stageDef(e.stage).title : '-',
            e.calls ? e.calls.toLocaleString() : '-',
            tokens(e.prompt - (e.imageTokens ?? 0)),
            tokens(e.imageTokens ?? 0),
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

/** A request's tokens by what its model calls worked on, for its tooltip. */
function workLines(e: UsageEntry): string {
    const parts = Object.entries(e.work ?? {}).sort((a, b) => tokensOf(b[1]!) - tokensOf(a[1]!));
    return parts.map(([k, p]) => `\n${WORK_KINDS[k as WorkKind] ?? k}: ${tokens(tokensOf(p!))} tokens in ${p!.calls} call${p!.calls === 1 ? '' : 's'}`).join('');
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

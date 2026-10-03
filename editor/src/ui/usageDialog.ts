// The project's usage, per piece of work (ai/usage.ts), in two views side by
// side. Tokens and credits: totals, what kind of work (the assistant's
// requests split by what their model calls worked on) and which stage spent
// it, per model, the costliest pieces and the latest ones; input tokens are
// shown as text and images, apart from the output. Work time: how long the
// work took, waiting for the models and running tools, by stage, kind of
// work and day, and the longest pieces. A CSV download has both. The chat's
// token count and its work time open it.

import { download } from '../core/persistence';
import type { Editor } from '../editor';
import {
    addTotals, emptyTotals, groupTotals, modelTotals, timed, tokensOf, usageCsv, USAGE_KINDS, WORK_KINDS, workTotals, type UsageEntry, type UsageKind, type UsageTotals, type WorkKind,
} from '../ai/usage';
import type { StageId } from '../core/types';
import { stageDef } from '../design/stages';
import { QUALITY_NAMES } from '../openrouter/imageQuality';
import { clear, h } from './dom';
import { confirmDialog, modal, type Modal } from './overlays';
import { button } from './widgets';

/** Rows the list of recent work shows. */
const RECENT = 60;

export type UsageView = 'tokens' | 'time';

let open: { modal: Modal; show: (view: UsageView) => void } | null = null;
/** The view shown last: the dialog opens on it again. */
let lastView: UsageView = 'tokens';

export function openUsageDialog(editor: Editor, view: UsageView = lastView) {
    if (open && !open.modal.closed) return open.show(view);
    const log = editor.usage;
    const body = h('div', { class: 'usage' });
    let frame = 0;
    const views: [UsageView, string][] = [['tokens', 'Tokens and credits'], ['time', 'Work time']];
    const render = () => {
        frame = 0;
        clear(body);
        const tabs = h('div', { class: 'seg usage-views', attrs: { role: 'tablist' } });
        for (const [v, label] of views) {
            const b = h('button', { class: 'seg-btn' + (v === view ? ' on' : ''), text: label, attrs: { type: 'button', role: 'tab', 'aria-selected': String(v === view) } });
            b.addEventListener('click', () => show(v));
            tabs.appendChild(b);
        }
        body.append(tabs, ...(view === 'tokens' ? content(log.entries, log.totals()) : timeContent(log.entries, !!log.older?.count)));
    };
    const show = (v: UsageView) => {
        view = lastView = v;
        render();
    };
    const off = log.on('change', () => {
        frame ||= requestAnimationFrame(render);
    });
    const m = modal(`Usage: ${editor.store.doc.name}`, body, {
        cls: 'usage-modal',
        onClose: () => {
            off();
            cancelAnimationFrame(frame);
            open = null;
        },
    });
    open = { modal: m, show };
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

const stat = (label: string, value: string, title = '') => h('div', { class: 'usage-stat', title }, h('div', { class: 'usage-stat-value', text: value }), h('div', { class: 'usage-stat-label', text: label }));

function summary(t: UsageTotals): HTMLElement {
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
            workCell(e),
            e.stage ? stageDef(e.stage).title : '-',
            e.calls ? e.calls.toLocaleString() : '-',
            tokens(e.prompt - (e.imageTokens ?? 0)),
            tokens(e.imageTokens ?? 0),
            e.prompt ? `${Math.round((e.cached / e.prompt) * 100)}%` : '-',
            tokens(e.completion),
            images(e),
            credits(e.cost + e.imageCost),
            e.running ? 'running' : duration(e.ms),
        ]),
    );
}

/** What a piece of work was, with its models, tool calls and parts in the tooltip. */
function workCell(e: UsageEntry): HTMLElement {
    return h('span', { class: 'usage-work', text: e.label, title: `${USAGE_KINDS[e.kind]}: ${e.label}${e.model ? `\n${e.model}` : ''}${e.imageModel ? `\n${e.imageModel}` : ''}${e.tools ? `\n${e.tools} tool calls` : ''}${workLines(e)}` });
}

// ---------------------------------------------------------------- work time

/**
 * How long the work of the project took: the summary, by stage, by kind of
 * work (the assistant's requests by what they worked on), by day, and the
 * longest pieces. Scripts calling a model in Play are left out: their time
 * is a game being played. `older`: some work is only in the token totals.
 */
function timeContent(entries: readonly UsageEntry[], older: boolean): Node[] {
    const work = entries.filter((e) => timed(e) && !e.running);
    const t = work.reduce(addTotals, emptyTotals());
    if (!t.count) {
        return [h('p', { class: 'muted', text: 'No work timed on this project yet. Each request of the assistant, conversation summary, memo and image made by hand shows up here with how long it took.' })];
    }
    const longest = [...work].sort((a, b) => b.ms - a.ms).slice(0, 5);
    const days = groupTotals(work, (e) => dayKey(e.at)).sort((a, b) => b[0].localeCompare(a[0]));
    return [
        timeSummary(t, work),
        h('p', {
            class: 'muted small',
            text: 'Each request counts from the message to the end of its answer: waiting for the model (writing its answer and tool calls) and running the editor\'s tools '
                + '(building, checking, capturing, drawing images), with the editor\'s own steps between them. Requests from before this was measured have no parts. '
                + `Scripts calling a model in Play are left out.${older ? ' So is the oldest work, which only the token totals keep.' : ''}`,
        }),
        section('By stage', timeTable('Stage', byTime(groupTotals(work, (e) => e.stage ?? '-')), t.ms, (k) => (k === '-' ? 'Outside the pipeline' : stageDef(k as StageId).title))),
        section('By kind of work', timeKindTable(work, t.ms)),
        section('By day', timeTable('Day', days, t.ms, dayName)),
        section('Longest work', longestTable(longest)),
    ];
}

function timeSummary(t: UsageTotals, work: readonly UsageEntry[]): HTMLElement {
    const requests = work.filter((e) => e.kind === 'request');
    const today = new Date().toDateString();
    const share = (ms: number) => (t.splitMs ? ` (${Math.round((ms / t.splitMs) * 100)}%)` : '');
    return h(
        'div',
        { class: 'usage-stats' },
        stat('work time', duration(t.ms), `${t.count.toLocaleString()} pieces of work`),
        stat(`waiting for models${share(t.modelMs)}`, t.splitMs ? duration(t.modelMs) : '-', 'The language models writing their answers and tool calls (of the work timed in parts)'),
        stat(`running tools${share(t.toolMs)}`, t.splitMs ? duration(t.toolMs) : '-', 'The editor running the tools the assistant called (of the work timed in parts)'),
        stat('per request', requests.length ? duration(requests.reduce((n, e) => n + e.ms, 0) / requests.length) : '-', `${requests.length.toLocaleString()} requests`),
        stat('longest request', requests.length ? duration(Math.max(...requests.map((e) => e.ms))) : '-'),
        stat('today', duration(work.filter((e) => new Date(e.at).toDateString() === today).reduce((n, e) => n + e.ms, 0))),
    );
}

const TIME_HEAD = ['Count', 'Time', 'Share', 'Models', 'Tools', 'Average'];

/** A group's time, its share of `all`, its parts where measured, and the average piece. */
function timeCells(t: UsageTotals, all: number): string[] {
    return [
        t.count.toLocaleString(),
        duration(t.ms),
        all ? `${Math.round((t.ms / all) * 100)}%` : '-',
        t.modelMs ? duration(t.modelMs) : '-',
        t.toolMs ? duration(t.toolMs) : '-',
        t.count ? duration(t.ms / t.count) : '-',
    ];
}

const byTime = <K>(rows: [K, UsageTotals][]) => [...rows].sort((a, b) => b[1].ms - a[1].ms);

function timeTable(what: string, rows: [string, UsageTotals][], all: number, name: (key: string) => string): HTMLElement {
    return table(1, [what, ...TIME_HEAD], rows.map(([k, t]) => [name(k), ...timeCells(t, all)]));
}

/** The kinds of work by time, the assistant's requests with a row for each thing their model calls and tools worked on. */
function timeKindTable(work: readonly UsageEntry[], all: number): HTMLElement {
    const rows: (string | HTMLElement)[][] = [];
    const sub: number[] = [];
    for (const [k, t] of byTime(groupTotals(work, (e) => e.kind))) {
        rows.push([USAGE_KINDS[k as UsageKind] ?? k, ...timeCells(t, all)]);
        if (k !== 'request') continue;
        for (const [w, wt] of byTime(workTotals(work))) {
            if (!wt.ms) continue;
            sub.push(rows.length);
            rows.push([h('span', { class: 'usage-sub-name', text: w ? WORK_KINDS[w] ?? w : 'Not split (earlier requests)' }), ...timeCells(wt, all)]);
        }
    }
    const el = table(1, ['Work', ...TIME_HEAD], rows);
    const trs = el.querySelectorAll('tbody tr');
    for (const i of sub) trs[i]?.classList.add('usage-sub');
    return el;
}

function longestTable(entries: UsageEntry[]): HTMLElement {
    return table(
        3,
        ['When', 'Work', 'Stage', 'Time', 'Models', 'Tools', 'Tool calls'],
        entries.map((e) => [
            when(e.at),
            workCell(e),
            e.stage ? stageDef(e.stage).title : '-',
            duration(e.ms),
            e.modelMs ? duration(e.modelMs) : '-',
            e.toolMs ? duration(e.toolMs) : '-',
            e.tools ? e.tools.toLocaleString() : '-',
        ]),
    );
}

/** A time span: "0.4 s", "42 s", "4 min 05 s", "1 h 12 min". */
export function duration(ms: number): string {
    const s = Math.max(0, ms) / 1000;
    if (s < 10) return `${s.toFixed(1)} s`;
    if (s < 60) return `${Math.floor(s)} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** A time span in short, for the chat's header: "42 s", "25 min", "1 h 12 min". */
export function shortDuration(ms: number): string {
    const s = Math.max(0, ms) / 1000;
    if (s < 60) return `${Math.max(1, Math.round(s))} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** The local day of a time, as it sorts: "2026-10-03". */
function dayKey(at: number): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayName(key: string): string {
    const [y, m, d] = key.split('-').map(Number);
    const day = new Date(y, m - 1, d);
    if (day.toDateString() === new Date().toDateString()) return 'Today';
    return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
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

export function credits(v: number): string {
    return v > 0 ? `$${v.toFixed(v < 0.1 ? 4 : 2)}` : '-';
}

function when(at: number): string {
    const d = new Date(at);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

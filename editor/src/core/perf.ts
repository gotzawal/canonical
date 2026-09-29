// A development aid: how long every listener of the editor's events takes,
// and the page's long tasks (over 50 ms) with the listeners that ran in
// them. On in development builds, and in others with localStorage
// "canonical-editor/perf" set to true. Its messages go to the browser's
// console only (not the editor's log); in the console,
//
//   __perf.report()   listeners by time spent, most first
//   __perf.reset()    starts counting again

import { probeListeners } from './events';
import { readLocal } from './local';

const PERF_KEY = 'canonical-editor/perf';
/** A listener slower than this (half a frame at 60 fps) is reported. */
const SLOW_MS = 8;
/** Listener calls kept to explain long tasks. */
const RECENT = 2048;

interface Total {
    event: string;
    site: string;
    calls: number;
    ms: number;
    max: number;
}

interface Call {
    event: string;
    site: string;
    start: number;
    ms: number;
}

export function perfMonitorWanted(): boolean {
    return import.meta.env.DEV || readLocal<boolean>(PERF_KEY, false) === true;
}

/**
 * Starts timing listeners. Call it before the store and the views are made
 * (and before the console is captured), so every listener is known by
 * where it was added.
 */
export function startPerfMonitor() {
    // The page's own console: warnings here do not go through the editor's log (and its listeners).
    const warn = console.warn.bind(console);
    const log = console.log.bind(console);
    const totals = new Map<string, Total>();
    const recent: (Call | undefined)[] = new Array(RECENT);
    let head = 0;
    const warned = new Map<string, number>();

    probeListeners({
        site: () => callSite(new Error().stack ?? ''),
        record(event, site, start, ms) {
            const key = `${event} ${site}`;
            let t = totals.get(key);
            if (!t) totals.set(key, (t = { event, site, calls: 0, ms: 0, max: 0 }));
            t.calls++;
            t.ms += ms;
            if (ms > t.max) t.max = ms;
            if (ms >= 0.5) {
                recent[head] = { event, site, start, ms };
                head = (head + 1) % RECENT;
            }
            if (ms > SLOW_MS) {
                const now = performance.now();
                if (now - (warned.get(key) ?? -Infinity) > 5000) {
                    warned.set(key, now);
                    warn(`[perf] A "${event}" listener took ${ms.toFixed(1)} ms: ${site}`);
                }
            }
        },
    });

    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                const end = e.startTime + e.duration;
                const by = new Map<string, number>();
                for (const c of recent) {
                    if (!c || c.start < e.startTime - 1 || c.start + c.ms > end + 1) continue;
                    const key = `${c.event} → ${c.site}`;
                    by.set(key, (by.get(key) ?? 0) + c.ms);
                }
                const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 5);
                warn(`[perf] Long task: ${e.duration.toFixed(0)} ms` + (top.length ? `, listeners: ${top.map(([k, ms]) => `${k} ${ms.toFixed(1)} ms`).join('; ')}` : ' (no listener of the editor took long in it)'));
            }
        }).observe({ type: 'longtask', buffered: true });
    }

    (window as unknown as { __perf: unknown }).__perf = {
        report() {
            const rows = [...totals.values()].sort((a, b) => b.ms - a.ms).slice(0, 40);
            console.table(rows.map((t) => ({ event: t.event, listener: t.site, calls: t.calls, 'total ms': +t.ms.toFixed(1), 'mean ms': +(t.ms / t.calls).toFixed(3), 'max ms': +t.max.toFixed(1) })));
        },
        reset() {
            totals.clear();
            recent.fill(undefined);
            log('[perf] Counting again.');
        },
        /** The totals, for tests. */
        totals: () => [...totals.values()].map((t) => ({ ...t })),
    };
    log(`[perf] Timing the editor's listeners (__perf.report() lists them). Long tasks are reported${PerformanceObserver.supportedEntryTypes?.includes('longtask') ? '' : ' where the browser supports it (not this one)'}.`);
}

/** "Function (file:line)" of the first caller outside this module, events.ts and ui/batch.ts, from a stack trace. */
export function callSite(stack: string): string {
    for (const line of stack.split('\n').slice(1)) {
        // Chrome: "    at fn (url:line:col)" or "    at url:line:col"; Firefox and Safari: "fn@url:line:col".
        const m = /^\s*at (?:(.*?) \()?(.+?):(\d+):\d+\)?$/.exec(line) ?? /^(.*?)@(.+?):(\d+):\d+$/.exec(line);
        if (!m) continue;
        const url = m[2];
        const fn = (m[1] ?? '').replace(/^(new |async |Object\.)/, '');
        // In a build every module is in one file: the functions that add listeners tell them apart.
        if (/\/(core\/events|core\/perf|ui\/batch)\.ts/.test(url) || /^(site|callSite|listenerSite|timed|onChanges|on)$|\.on$/.test(fn)) continue;
        const file = /\/src\/(.+?)(\?|$)/.exec(url)?.[1] ?? url.split('/').pop()!.split('?')[0];
        return `${fn ? fn + ' ' : ''}(${file}:${m[3]})`;
    }
    return 'unknown';
}

// The decision log: one entry per Ask request (see DecisionLogEntry in
// core/types.ts). It is kept for the last Play session, so the assistant and
// the log panel can read it after Stop.

import { Emitter } from '../../core/events';
import type { AskOutcome, DecisionLogEntry } from '../../core/types';

const MAX_ENTRIES = 2000;

export interface LogQuery {
    /** Ask node or service id. */
    node?: string;
    /** Object (node id or name). */
    agent?: string;
    tree?: string;
    /** Only entries with an answer that had this outcome. */
    outcome?: AskOutcome;
    /** Newest entries, at most this many. */
    limit?: number;
}

export class DecisionLog extends Emitter<{ entry: DecisionLogEntry; clear: void }> {
    private list: DecisionLogEntry[] = [];

    get entries(): readonly DecisionLogEntry[] {
        return this.list;
    }

    add(entry: DecisionLogEntry) {
        this.list.push(entry);
        if (this.list.length > MAX_ENTRIES) this.list.splice(0, this.list.length - MAX_ENTRIES);
        this.emit('entry', entry);
    }

    clear() {
        this.list = [];
        this.emit('clear', undefined);
    }

    query(q: LogQuery = {}): DecisionLogEntry[] {
        const out = this.list.filter(
            (e) =>
                (!q.node || e.node === q.node) &&
                (!q.agent || e.agent === q.agent || e.agentName === q.agent) &&
                (!q.tree || e.tree === q.tree) &&
                (!q.outcome || e.questions.some((x) => x.outcome === q.outcome)),
        );
        return q.limit ? out.slice(-q.limit) : out;
    }

    /** Counts per outcome, for summaries. */
    outcomes(entries: readonly DecisionLogEntry[] = this.list): Record<AskOutcome, number> {
        const out: Record<AskOutcome, number> = { written: 0, low_confidence: 0, superseded: 0, held: 0, timeout: 0, unavailable: 0 };
        for (const e of entries) for (const q of e.questions) out[q.outcome]++;
        return out;
    }
}

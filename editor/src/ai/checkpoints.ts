// Checkpoints: whenever the work has moved on (the assistant finished a
// request that changed the project, a stage was completed, or a good number
// of edits were made by hand), the scene memo is refreshed and a version of
// the scene goes into the version history (a completed stage saves its own).

import { stageDef } from '../design/stages';
import type { Editor } from '../editor';
import type { Agent, AgentDone } from './agent';

/** Hand edits that make a checkpoint... */
const EDIT_COUNT = 30;
/** ...once this much time has passed since the last one. */
const EDIT_INTERVAL = 10 * 60_000;

export type CheckpointReason = 'ai' | 'stage' | 'edits';

export class Checkpoints {
    private edits: string[] = [];
    private lastAt = Date.now();

    constructor(private editor: Editor, private agent: Agent) {
        const store = editor.store;
        store.on('commit', (label) => {
            // The assistant's edits make their own checkpoint when its request ends.
            if (store.playing || store.batch || /^(Undo |Redo |Patch$)/.test(label)) return;
            this.edits.push(label);
            if (this.edits.length >= EDIT_COUNT && Date.now() - this.lastAt >= EDIT_INTERVAL) this.run('edits');
        });
        store.on('load', () => {
            this.edits = [];
            this.lastAt = Date.now();
        });
        agent.on('done', (d) => {
            if (d.changed && !d.error) this.run('ai', recentFromRequest(d), versionName(d.prompt));
        });
        editor.pipeline.on('completed', ({ stage, next }) => {
            this.run('stage', `Completed the ${stageDef(stage).title} stage${next ? ` and moved on to ${stageDef(next).title}` : ' (the last stage)'}.`);
        });
    }

    /** Refreshes the memo and saves a version of the scene (a completed stage saved one already). */
    run(reason: CheckpointReason, recent = '', name = '') {
        const labels = this.edits.splice(0);
        this.lastAt = Date.now();
        const work = [recent, labels.length ? `Edits by hand: ${summarize(labels)}` : ''].filter(Boolean).join('\n');
        void this.agent.refreshMemo(work);
        if (reason === 'stage') return;
        void this.editor.pipeline.saveVersion(name || (reason === 'edits' ? `${labels.length} edits by hand` : 'After the assistant\'s work'), true).catch((e) => console.warn('[checkpoint] saving a version failed', e));
    }
}

/** A version's name from the user's words: "After: a cabin by the lake". */
function versionName(prompt: string): string {
    const words = prompt.replace(/\s+/g, ' ').trim();
    if (!words) return '';
    return `After: ${words.length > 48 ? words.slice(0, 45) + '...' : words}`;
}

function recentFromRequest(d: AgentDone): string {
    const lines = [`User asked: ${d.prompt.slice(0, 1500)}`];
    if (d.tools.length) lines.push(`Tools used: ${d.tools.slice(-40).join('; ').slice(0, 4000)}`);
    if (d.answer) lines.push(`Assistant answered: ${d.answer.slice(0, 3000)}`);
    return lines.join('\n');
}

/** "Move x12, Create Cube x3, ..." */
function summarize(labels: string[]): string {
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    return Array.from(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([l, n]) => (n > 1 ? `${l} x${n}` : l))
        .join(', ');
}

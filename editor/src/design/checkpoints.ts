// Checkpoints: whenever the work has moved on (the assistant finished a
// request that changed the project, a stage was completed, or a good number
// of edits were made by hand), the scene memo is refreshed and the user is
// asked whether to save: yes downloads the project file.

import type { Agent, AgentDone } from '../ai/agent';
import type { Editor } from '../editor';
import { notices, type Notice } from '../ui/notify';

/** Hand edits that make a checkpoint... */
const EDIT_COUNT = 30;
/** ...once this much time has passed since the last one. */
const EDIT_INTERVAL = 10 * 60_000;
/** Save prompts are not repeated more often than this (stage completions always ask). */
const PROMPT_INTERVAL = 4 * 60_000;

export type CheckpointReason = 'ai' | 'stage' | 'edits';

export class Checkpoints {
    private edits: string[] = [];
    private lastAt = Date.now();
    private lastPrompt = 0;
    private memoJob: Promise<boolean> | null = null;
    private notice: Notice | null = null;

    constructor(private editor: Editor, private agent: Agent) {
        const store = editor.store;
        store.on('commit', (label) => {
            if (store.playing || /^(AI[: ]|Undo |Redo |Patch$)/.test(label)) return;
            this.edits.push(label);
            if (this.edits.length >= EDIT_COUNT && Date.now() - this.lastAt >= EDIT_INTERVAL) this.run('edits');
        });
        store.on('load', () => {
            this.edits = [];
            this.lastAt = Date.now();
            this.notice?.close();
        });
        editor.on('saved', (kind) => {
            if (kind !== 'project') return;
            this.notice?.close();
            this.edits = [];
            this.lastAt = Date.now();
        });
        agent.on('done', (d) => {
            if (d.changed && !d.error) this.run('ai', recentFromRequest(d));
        });
    }

    /** A stage was completed (called by the pipeline). */
    stageCompleted(title: string, next: string | null) {
        this.run('stage', `Completed the ${title} stage${next ? ` and moved on to ${next}` : ' (the last stage)'}.`);
    }

    /** Refreshes the memo and asks to save. */
    run(reason: CheckpointReason, recent = '') {
        const labels = this.edits.splice(0);
        this.lastAt = Date.now();
        const work = [recent, labels.length ? `Edits by hand: ${summarize(labels)}` : ''].filter(Boolean).join('\n');
        this.memoJob = this.agent.refreshMemo(work);
        if (reason !== 'stage' && Date.now() - this.lastPrompt < PROMPT_INTERVAL) return;
        this.lastPrompt = Date.now();
        const body =
            reason === 'ai'
                ? 'The assistant finished a change. Download the project file (.zip) with everything so far?'
                : reason === 'stage'
                  ? `${recent} Download the project file (.zip) with everything so far?`
                  : `${labels.length} edits since the last checkpoint. Download the project file (.zip) with everything so far?`;
        this.notice = notices.show({
            kind: 'checkpoint',
            key: 'checkpoint',
            icon: 'save',
            title: 'Save the project?',
            body,
            actions: [
                {
                    label: 'Save project',
                    primary: true,
                    run: async () => {
                        // The saved file should carry the refreshed memo.
                        await this.memoJob?.catch(() => false);
                        await this.editor.saveProjectFile();
                    },
                },
                { label: 'Not now', run: () => {} },
            ],
        });
    }
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

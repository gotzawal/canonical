import type { Agent } from '../ai/agent';
import { activityLabel } from './activity';
import { h } from './dom';
import { icon } from './icons';
import { mascotAvatar } from './mascot';

/**
 * What the assistant is doing, over the view while it works, with the
 * button that stops it: there whichever panel is open, in the simple view
 * and the full editor alike.
 */
export class AIStatus {
    readonly el: HTMLElement;
    private text: HTMLButtonElement;
    private stopBtn: HTMLButtonElement;
    /** Stop was pressed and the request is winding down. */
    private stopping = false;

    constructor(private agent: Agent, show: () => void) {
        this.text = h('button', { class: 'ai-status-text', title: 'Show the chat', attrs: { type: 'button' } });
        this.text.addEventListener('click', show);
        this.stopBtn = h('button', { class: 'btn small ai-status-stop', title: 'Stop the assistant (Esc in the chat)', attrs: { type: 'button' } }, icon('stop', 12), h('span', { text: 'Stop' }));
        this.stopBtn.addEventListener('click', () => {
            this.stopping = true;
            this.agent.stop();
            this.render();
        });
        this.el = h('div', { class: 'ai-status', attrs: { role: 'status', 'aria-live': 'polite', hidden: true } }, mascotAvatar('think', 18, 'ai-status-heron'), this.text, this.stopBtn);
        agent.on('busy', () => {
            if (!agent.running) this.stopping = false;
            this.render();
        });
        agent.on('activity', () => this.render());
        this.render();
    }

    private render() {
        const a = this.agent;
        this.el.hidden = !a.running;
        if (!a.running) return;
        this.text.textContent = this.stopping
            ? 'Stopping...'
            : a.working && !a.busy
              ? 'Tidying up the conversation...'
              : a.activity
                ? `${activityLabel(a.activity)}...`
                : 'Thinking...';
        this.stopBtn.disabled = this.stopping;
    }
}

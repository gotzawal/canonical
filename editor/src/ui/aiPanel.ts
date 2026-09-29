import type { Editor } from '../editor';
import { Agent, type AgentDone, type AgentTurn, type Attachment, type SendOptions } from '../ai/agent';
import { getAssetUrl, putDesignImage } from '../core/assets';
import { planStarted, STAGE_IDS } from '../core/design';
import { pickFiles } from '../core/persistence';
import {
    finishOAuth, listModels, pickDefaultModel, startOAuth, supportsImages, supportsTools, type OpenRouterModel,
} from '../openrouter/client';
import { aiSettings } from '../openrouter/settings';
import { continuePrompt, startPrompt } from '../design/prompts';
import { nextStage, stageDef, stepOf } from '../design/stages';
import { activityLabel } from './activity';
import { onChanges, touches } from './batch';
import { describeCache } from '../openrouter/caching';
import { DEFAULT_IMAGE_MODEL, listImageModels, modelParams, OWN_PARAMS, takesImages, type ImageModel } from '../openrouter/images';
import { highlight } from './codeEditor';
import { clear, h } from './dom';
import { icon } from './icons';
import { mascotAvatar, mascotPose, setMascotMood, type MascotMood } from './mascot';
import { dialog, toast } from './overlays';
import { CheckboxField, NumberField, SliderField, button, iconButton, row, suggestions } from './widgets';

const SUGGESTIONS = [
    'Build a small park: grass ground, a few trees, benches and a warm sunset.',
    'Build a small two-room house with a door and windows, and let me walk through it.',
    'Write a script that makes the selected object orbit around the origin, and attach it.',
    'Create a glowing hologram shader and use it on the sphere.',
    'Run the scene, read the errors and fix the scripts.',
];

/** What the chat's buttons need from the rest of the editor. */
export interface AIPanelHooks {
    /** The step and the stage behind the chat's approvals, in the full editor's Design tab. */
    showDetails(): void;
    /** File > Build & Deploy. */
    build(): void;
}

const PLACEHOLDER = 'Ask for a change, a script, a shader... (Enter to send, Shift+Enter for a new line)';
/** How long the heron looks pleased after a request. */
const DONE_MOOD_MS = 6000;

/** Chat with an OpenRouter model that edits the project through tools. */
export class AIPanel {
    readonly el: HTMLElement;
    readonly agent: Agent;
    private list: HTMLElement;
    private input: HTMLTextAreaElement;
    private sendBtn: HTMLButtonElement;
    private modelLabel: HTMLElement;
    private usageLabel: HTMLElement;
    private views = new Map<number, HTMLElement>();
    private models: OpenRouterModel[] = [];
    private modelsLoad: Promise<void> | null = null;
    /** Images waiting to be sent with the next message. */
    private attachments: Attachment[] = [];
    private attachStrip: HTMLElement;
    private compactBtn: HTMLButtonElement;
    /** The heron in the header: its mood follows the assistant. */
    private avatar: HTMLImageElement;
    /** What to do next, under the last answer (see followUp). */
    private next: HTMLElement;
    /** How the last request ended, while this page shows it. */
    private lastEnd: 'answer' | 'limited' | 'stopped' | 'error' | null = null;
    private lastEndAt = 0;
    private moodTimer = 0;

    constructor(private editor: Editor, context: () => string, private hooks: AIPanelHooks) {
        this.agent = new Agent(editor, context);
        this.list = h('div', { class: 'ai-list' });
        this.next = h('div', { class: 'ai-next', attrs: { hidden: true } });
        this.input = h('textarea', {
            class: 'ai-input',
            attrs: { rows: 3, placeholder: PLACEHOLDER, spellcheck: 'true' },
        });
        this.sendBtn = h('button', { class: 'btn primary ai-send', attrs: { type: 'button' } });
        this.modelLabel = h('button', { class: 'ai-model', attrs: { type: 'button' }, title: 'Model (click to change)' });
        this.usageLabel = h('span', { class: 'ai-usage' });
        this.modelLabel.addEventListener('click', () => void this.openSettings());
        this.attachStrip = h('div', { class: 'ai-attachments', attrs: { hidden: true } });
        this.compactBtn = iconButton('history', 'Compact the conversation: summarize the earlier messages', () => void this.agent.compact());
        const attachBtn = iconButton('attach', 'Attach images (or paste / drop them here)', async () => {
            const files = await pickFiles('image/*,.md,.txt,text/plain,text/markdown', true);
            await this.addFiles(files);
        });
        this.avatar = mascotAvatar('idle', 22, 'ai-heron');

        this.el = h(
            'div',
            { class: 'panel ai-panel' },
            h(
                'div',
                { class: 'ai-header' },
                this.avatar,
                this.modelLabel,
                h('div', { class: 'spacer' }),
                this.usageLabel,
                this.compactBtn,
                iconButton('plus', 'New conversation (the assistant still knows the scene)', () => {
                    this.agent.reset();
                    this.render();
                }),
                iconButton('gear', 'AI settings', () => void this.openSettings()),
            ),
            this.list,
            h(
                'div',
                { class: 'ai-composer' },
                this.attachStrip,
                this.input,
                h('div', { class: 'ai-composer-row' }, attachBtn, h('span', { class: 'ai-hint', text: 'Edits of one request undo together.' }), h('div', { class: 'spacer' }), this.sendBtn),
            ),
        );
        this.input.addEventListener('paste', (e) => {
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
            if (!files.length) return;
            e.preventDefault();
            void this.addFiles(files);
        });
        this.el.addEventListener('dragover', (e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            this.el.classList.add('drop-target');
        });
        this.el.addEventListener('dragleave', (e) => {
            if (!this.el.contains(e.relatedTarget as Node)) this.el.classList.remove('drop-target');
        });
        this.el.addEventListener('drop', (e) => {
            if (!e.dataTransfer?.files.length) return;
            e.preventDefault();
            this.el.classList.remove('drop-target');
            void this.addFiles(Array.from(e.dataTransfer.files));
        });

        this.input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.submit();
            } else if (e.key === 'Escape' && this.agent.running) {
                e.preventDefault();
                this.agent.stop();
            }
        });
        this.input.addEventListener('blur', () => (this.input.placeholder = PLACEHOLDER));
        this.sendBtn.addEventListener('click', () => (this.agent.running ? this.agent.stop() : this.submit()));
        this.agent.on('update', (turn) => this.update(turn));
        this.agent.on('busy', () => {
            this.renderControls();
            this.renderNext();
        });
        this.agent.on('done', (d) => this.finished(d));
        // Approvals in the chat follow the plan, also when decided in the Design tab.
        onChanges(editor.store, (hint) => {
            if (!touches(hint, 'design')) return;
            this.refreshApprovals();
            this.renderNext();
        });
        editor.pipeline.on('busy', () => this.refreshApprovals());
        aiSettings.on('change', () => {
            this.renderControls();
            this.render();
        });
        editor.on('ai-prompt', ({ text, send }) => {
            this.input.value = text;
            if (send) this.submit();
            else {
                this.input.focus();
                this.input.setSelectionRange(text.length, text.length);
            }
        });
        this.renderControls();
        this.render();
        void this.completeOAuth();
    }

    focus() {
        void this.ensureModels();
        this.input.focus();
    }

    /** Fetches the model list the first time the panel is used, not on every page load. */
    private ensureModels(): Promise<void> {
        return (this.modelsLoad ??= this.loadModels());
    }

    private submit() {
        const text = this.input.value.trim();
        if ((!text && !this.attachments.length) || this.agent.running) return;
        if (!aiSettings.apiKey) {
            void this.openSettings();
            return;
        }
        this.input.value = '';
        const attachments = this.attachments;
        this.attachments = [];
        this.renderAttachments();
        void this.agent.send(text, attachments).then((started) => {
            // Nothing was sent (no model picked yet): the text comes back to be sent again.
            if (started || this.input.value) return;
            this.input.value = text;
            this.attachments = attachments;
            this.renderAttachments();
        });
    }

    /** Sends a prompt as if typed (the pipeline's buttons); `opts.show` is what the chat shows of it. */
    send(text: string, attachments: Attachment[] = [], opts: SendOptions = {}) {
        if (this.agent.running) {
            toast('The assistant is still working on the last request.', 'info');
            return;
        }
        if (!aiSettings.apiKey) {
            void this.openSettings();
            return;
        }
        void this.agent.send(text, attachments, opts);
    }

    /**
     * Starts the assistant on a new project (the start screen saved its
     * brief). Without a key the chat asks to connect first and offers to
     * start once it is connected.
     */
    start(request: string, images: Attachment[], fresh: boolean) {
        if (!aiSettings.apiKey) {
            this.render();
            return;
        }
        this.send(startPrompt(request, images.length, fresh), images, { show: request });
    }

    /**
     * Asks the assistant to go on: with the current stage once the pipeline
     * runs (`liked`: the user likes the result so far), else with what it
     * was asked before it stopped.
     */
    private keepGoing(liked: boolean) {
        const design = this.editor.store.doc.design;
        const show = liked ? 'Looks good, keep going.' : 'Keep going.';
        if (planStarted(design)) this.send(continuePrompt(design.stage, liked), [], { show });
        else this.send('Keep going where you stopped and finish what I asked.', [], { show });
    }

    /**
     * Images become planning assets of the project and wait under the input;
     * text files (.md / .txt) are pasted into the message.
     */
    async addFiles(files: File[]) {
        for (const file of files) {
            if (/\.(md|markdown|txt)$/i.test(file.name) || file.type.startsWith('text/')) {
                const text = await file.text();
                const sep = this.input.value.trim() ? '\n\n' : '';
                this.input.value += `${sep}${file.name}:\n${text}`;
                continue;
            }
            if (!file.type.startsWith('image/')) {
                toast(`${file.name} is not an image or a text file.`, 'error');
                continue;
            }
            try {
                const name = file.name && file.name !== 'image.png' ? file.name : `attachment-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
                const meta = await putDesignImage(file, name);
                this.editor.store.patch((d) => {
                    d.assets.push(meta);
                }, { design: true });
                this.attachments.push({ asset: meta.id, name: meta.name });
            } catch (e: any) {
                toast(`Could not attach ${file.name}: ${e?.message || e}`, 'error');
            }
        }
        this.renderAttachments();
        this.input.focus();
    }

    private renderAttachments() {
        clear(this.attachStrip);
        this.attachStrip.hidden = !this.attachments.length;
        for (const a of this.attachments) {
            const img = h('img', { attrs: { alt: a.name } });
            const meta = this.editor.store.doc.assets.find((x) => x.id === a.asset);
            if (meta) void getAssetUrl(meta).then((url) => url && (img.src = url));
            const remove = h('button', { class: 'ai-attachment-remove', title: 'Remove', attrs: { type: 'button', 'aria-label': 'Remove image' } }, icon('close', 11));
            remove.addEventListener('click', () => {
                this.attachments = this.attachments.filter((x) => x !== a);
                this.renderAttachments();
            });
            this.attachStrip.appendChild(h('div', { class: 'ai-attachment', title: a.name }, img, remove));
        }
    }

    private async loadModels(force = false) {
        try {
            this.models = await listModels(force);
            const pick = aiSettings.value.model ? '' : pickDefaultModel(this.models);
            if (pick) aiSettings.set({ model: pick });
        } catch (e) {
            console.warn('[ai] could not list OpenRouter models', e);
        }
        this.renderControls();
    }

    private async completeOAuth() {
        try {
            const key = await finishOAuth();
            if (key) {
                aiSettings.setKey(key);
                toast('Connected to OpenRouter.', 'success');
            }
        } catch (e: any) {
            toast(`OpenRouter sign-in failed: ${e?.message || e}`, 'error');
        }
    }

    private renderControls() {
        const s = aiSettings.value;
        const model = this.models.find((m) => m.id === s.model);
        this.modelLabel.textContent = s.model ? model?.name ?? s.model : 'Choose a model';
        this.modelLabel.title = s.model ? `${s.model}${model && !supportsTools(model) ? ' (does not support tools)' : ''}` : 'Choose a model';
        const u = this.agent.usage;
        const hit = u.prompt ? Math.round((u.cached / u.prompt) * 100) : 0;
        this.usageLabel.textContent = u.requests ? `${((u.prompt + u.completion) / 1000).toFixed(1)}k tok${u.cached ? ` · ${hit}% cached` : ''}${u.cost ? ` · $${u.cost.toFixed(4)}` : ''}` : '';
        this.usageLabel.title = u.requests
            ? `${u.requests} requests, ${u.prompt} prompt + ${u.completion} completion tokens${u.cached ? `, ${u.cached} prompt tokens read from the cache (${hit}%)` : ', no prompt tokens read from a cache yet'}${u.written ? `, ${u.written} written to it` : ''}`
            : '';
        const running = this.agent.running;
        this.sendBtn.replaceChildren(icon(running ? 'stop' : 'send', 14), h('span', { text: running ? 'Stop' : 'Send' }));
        this.sendBtn.title = running ? 'Stop the assistant (Esc)' : 'Send (Enter)';
        this.compactBtn.disabled = running || !this.agent.hasHistory;
        this.input.disabled = false;
        this.renderMood();
    }

    /** The heron's mood: asleep without a key, thinking while it works, pleased or troubled for a moment after. */
    private renderMood() {
        const recent = Date.now() - this.lastEndAt < DONE_MOOD_MS;
        const waiting = this.agent.turns.some((t) => t.approval && this.approvalOpen(t));
        const mood: MascotMood = !aiSettings.apiKey
            ? 'sleep'
            : this.agent.running
              ? 'think'
              : this.lastEnd === 'error'
                ? 'error'
                : waiting
                  ? 'ask'
                  : recent && this.lastEnd === 'answer'
                    ? 'done'
                    : 'idle';
        setMascotMood(this.avatar, mood);
    }

    private finished(d: AgentDone) {
        this.lastEnd = d.error ? 'error' : d.stopped ? 'stopped' : d.limited ? 'limited' : 'answer';
        this.lastEndAt = Date.now();
        clearTimeout(this.moodTimer);
        this.moodTimer = window.setTimeout(() => this.renderMood(), DONE_MOOD_MS + 50);
        this.renderControls();
        this.renderNext();
    }

    // ------------------------------------------------------------ messages

    private render() {
        clear(this.list);
        this.views.clear();
        if (!aiSettings.apiKey) {
            this.list.appendChild(this.onboarding());
            this.renderMood();
            return;
        }
        if (!this.agent.turns.length) {
            this.list.appendChild(this.welcome());
            this.renderMood();
            return;
        }
        for (const t of this.agent.turns) this.place(this.turnView(t));
        this.list.appendChild(this.next);
        this.renderNext();
        this.list.scrollTop = this.list.scrollHeight;
    }

    /** Adds a turn's view at the end: tool steps go into the group of steps before them. */
    private place(el: HTMLElement) {
        if (el.classList.contains('tool')) {
            const last = this.lastView();
            let group = last?.classList.contains('ai-steps') ? last : null;
            if (!group) {
                group = stepsGroup();
                this.list.insertBefore(group, this.next.parentElement === this.list ? this.next : null);
            }
            group.querySelector('.ai-steps-body')!.appendChild(el);
            refreshGroup(group);
            return;
        }
        this.list.insertBefore(el, this.next.parentElement === this.list ? this.next : null);
    }

    /** The last view in the list, before the follow-up. */
    private lastView(): HTMLElement | null {
        let el = this.list.lastElementChild as HTMLElement | null;
        if (el === this.next) el = el.previousElementSibling as HTMLElement | null;
        return el;
    }

    /** Redraws one turn (null: the whole conversation changed). */
    private update(turn: AgentTurn | null) {
        // Another conversation (a new one, or another project's): how the last request ended is not its.
        if (!turn) this.lastEnd = null;
        this.renderControls();
        const old = turn && this.views.get(turn.id);
        // Gone from the conversation: a dropped bubble, or a turn of a conversation left behind.
        if (turn && !this.agent.turns.includes(turn)) {
            const group = old?.closest<HTMLElement>('.ai-steps');
            old?.remove();
            this.views.delete(turn.id);
            if (group) {
                if (!group.querySelector('.ai-msg')) group.remove();
                else refreshGroup(group);
            }
            return;
        }
        // The first turn takes the place of the welcome text.
        if (!turn || (!old && !this.views.size)) {
            this.render();
            return;
        }
        // The list follows new content only when the reader is at its end.
        const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
        const next = this.turnView(turn);
        if (old) {
            // What the user opened stays open.
            const open = [...old.querySelectorAll('details')].map((d) => d.open);
            next.querySelectorAll('details').forEach((d, i) => (d.open = !!open[i]));
            old.replaceWith(next);
            const group = next.closest<HTMLElement>('.ai-steps');
            if (group) refreshGroup(group);
        } else this.place(next);
        this.renderNext();
        if (nearBottom) this.list.scrollTop = this.list.scrollHeight;
    }

    private turnView(t: AgentTurn): HTMLElement {
        let el: HTMLElement;
        if (t.role === 'user') {
            el = h('div', { class: 'ai-msg user' });
            if (t.images?.length) {
                const strip = h('div', { class: 'ai-msg-images' });
                for (const a of t.images) {
                    const img = h('img', { class: 'ai-msg-image', title: a.name, attrs: { alt: a.name } });
                    const meta = this.editor.store.doc.assets.find((x) => x.id === a.asset);
                    if (meta) void getAssetUrl(meta).then((url) => url && (img.src = url));
                    strip.appendChild(img);
                }
                el.appendChild(strip);
            }
            if (t.text) el.appendChild(h('div', { class: 'ai-bubble', text: t.text }));
        } else if (t.role === 'assistant') {
            const body = h('div', { class: 'ai-bubble md' });
            body.innerHTML = t.text ? markdown(t.text) : '<span class="ai-typing"><i></i><i></i><i></i></span>';
            el = h('div', { class: 'ai-msg assistant' }, body);
        } else if (t.role === 'tool') {
            const tool = t.tool!;
            const details = h('details', { class: 'ai-tool ' + tool.state });
            const summary = h(
                'summary',
                null,
                tool.state === 'running' ? h('span', { class: 'spinner small' }) : icon(tool.state === 'error' ? 'alert' : 'check', 13),
                h('span', { class: 'ai-tool-name', text: activityLabel(tool.name) }),
                tool.summary ? h('span', { class: 'ai-tool-summary', text: tool.summary }) : null,
            );
            details.appendChild(summary);
            details.appendChild(h('div', { class: 'ai-tool-label', text: `${tool.name} · arguments` }));
            details.appendChild(h('pre', { class: 'ai-tool-pre', text: prettyJson(tool.args) }));
            if (tool.result) {
                details.appendChild(h('div', { class: 'ai-tool-label', text: 'Result' }));
                details.appendChild(h('pre', { class: 'ai-tool-pre', text: prettyJson(tool.result).slice(0, 6000) }));
            }
            el = h('div', { class: 'ai-msg tool' }, details, tool.image ? h('img', { class: 'ai-shot', attrs: { src: tool.image, alt: 'What the assistant looked at' } }) : null);
            el.dataset.state = tool.state;
            el.dataset.label = activityLabel(tool.name);
        } else if (t.detail) {
            const details = h('details', { class: 'ai-note-details' }, h('summary', null, icon('history', 13), h('span', { text: t.text })), h('div', { class: 'ai-note-detail', text: t.detail }));
            el = h('div', { class: 'ai-msg note' + (t.error ? ' error' : '') }, details);
        } else if (t.approval) {
            el = this.approvalView(t);
        } else {
            el = h('div', { class: 'ai-msg note' + (t.error ? ' error' : '') }, icon(t.error ? 'alert' : 'info', 13), h('span', { text: t.text }));
        }
        if (t.undoLabel) {
            const undo = button('Undo these changes', () => {
                if (this.editor.store.undoLabel === t.undoLabel) {
                    this.editor.store.undo();
                    t.undoLabel = undefined;
                    this.update(t);
                } else toast('Other changes were made after this request; use Edit > Undo.', 'info');
            }, 'small subtle ai-undo', 'undo');
            el.appendChild(undo);
        }
        this.views.set(t.id, el);
        return el;
    }

    private refreshApprovals() {
        for (const t of this.agent.turns) if (t.approval && this.views.has(t.id)) this.update(t);
        this.renderMood();
    }

    /** An approval still waits for the user (a stage to complete, images to keep or drop). */
    private approvalOpen(t: AgentTurn): boolean {
        const a = t.approval!;
        const design = this.editor.store.doc.design;
        if (a.kind === 'stage') return !!design.stages[a.stage].proposal && design.stage === a.stage && design.stages[a.stage].status !== 'done';
        return a.assets.some((asset) => design.concepts.find((c) => c.asset === asset)?.review === 'proposed');
    }

    /**
     * What the assistant proposed, with the buttons that decide it as in the
     * Design tab (which they share): completing a stage, or keeping the
     * reference images it drew. Once decided, here or there, it says how.
     */
    private approvalView(t: AgentTurn): HTMLElement {
        const a = t.approval!;
        const pipeline = this.editor.pipeline;
        const design = this.editor.store.doc.design;
        const el = h('div', { class: 'ai-msg choice approval' });
        if (a.kind === 'stage') {
            const def = stageDef(a.stage);
            const st = design.stages[a.stage];
            el.appendChild(h('div', { class: 'ai-choice-question' }, icon('flag', 14), h('span', { text: `${def.title} is done. Happy with it?` })));
            if (st.status === 'done') {
                const next = nextStage(a.stage);
                el.appendChild(h('div', { class: 'ai-approval-state ok' }, icon('check', 13), h('span', { text: `${def.title} is complete.${next ? ` Next: ${stageDef(next).long}.` : ''}` })));
            } else if (st.proposal && design.stage === a.stage) {
                el.appendChild(h('div', { class: 'ai-approval-text', text: st.proposal.summary }));
                const complete = button(pipeline.busy ? 'Saving the shots...' : 'Looks good', () => void pipeline.complete(), 'small primary', 'check');
                complete.disabled = pipeline.busy;
                el.appendChild(
                    h(
                        'div',
                        { class: 'ai-choice-options' },
                        complete,
                        button('Not yet', () => {
                            pipeline.dismissProposal();
                            this.askForChange();
                        }, 'small subtle'),
                        button('Details', () => this.hooks.showDetails(), 'small subtle', 'sliders'),
                    ),
                );
            } else {
                el.appendChild(h('div', { class: 'ai-approval-state', text: 'Not yet: the assistant keeps working on it.' }));
            }
            return el;
        }
        const concepts = a.assets.map((asset) => ({ asset, concept: design.concepts.find((c) => c.asset === asset) }));
        const waiting = concepts.filter((c) => c.concept?.review === 'proposed').map((c) => c.asset);
        el.appendChild(h('div', { class: 'ai-choice-question' }, icon('image', 14), h('span', { text: `Reference images${t.text ? `: ${t.text}` : ''}` })));
        const grid = h('div', { class: 'ai-approval-grid' });
        for (const { asset, concept } of concepts) {
            const img = h('img', { class: 'ai-approval-img', attrs: { alt: 'Reference image' } });
            const meta = this.editor.store.doc.assets.find((x) => x.id === asset);
            if (meta) void getAssetUrl(meta).then((url) => url && (img.src = url));
            const tile = h('div', { class: 'ai-approval-tile' }, img);
            // A click shows it as wide as the chat.
            img.addEventListener('click', () => tile.classList.toggle('large'));
            if (concept?.review === 'proposed') {
                tile.appendChild(
                    h(
                        'div',
                        { class: 'ai-choice-options' },
                        button('Keep', () => pipeline.reviewConcepts([asset], true), 'small primary', 'check'),
                        button('Drop', () => pipeline.reviewConcepts([asset], false), 'small', 'close'),
                    ),
                );
            } else tile.appendChild(h('div', { class: 'ai-approval-state' + (concept ? ' ok' : '') }, icon(concept ? 'check' : 'close', 13), h('span', { text: concept ? 'Kept' : 'Dropped' })));
            grid.appendChild(tile);
        }
        el.appendChild(grid);
        if (waiting.length > 1) el.appendChild(h('div', { class: 'ai-choice-options' }, button(`Keep all ${waiting.length}`, () => pipeline.reviewConcepts(waiting, true), 'small', 'check')));
        return el;
    }

    /** Puts the cursor in the chat, asking what should change. */
    private askForChange() {
        this.input.placeholder = 'What should change? (Enter to send)';
        this.input.focus();
    }

    /**
     * What the user can say next under the last answer, when the assistant
     * is not working: whether they like the result (and it goes on), or what
     * to change. Only the latest request's end shows it.
     */
    private renderNext() {
        const el = this.next;
        clear(el);
        const design = this.editor.store.doc.design;
        const turns = this.agent.turns;
        const lastTurn = turns[turns.length - 1];
        const pending = turns.some((t) => t.approval?.kind === 'stage' && this.approvalOpen(t));
        const allDone = design.stage === STAGE_IDS[STAGE_IDS.length - 1] && design.stages[design.stage].status === 'done';
        const started = planStarted(design);
        const unfinished = this.lastEnd === 'limited' || this.lastEnd === 'stopped' || this.lastEnd === 'error';
        // A request that did not finish can go on in any project; whether the user likes it is asked once the pipeline runs.
        const show = !!aiSettings.apiKey && !this.agent.running && !!lastTurn && lastTurn.role !== 'user' && !pending && (started || unfinished);
        el.hidden = !show;
        if (!show) return;
        if (allDone && !unfinished) {
            el.append(
                h('div', { class: 'ai-next-head' }, mascotPose('celebrate', 44, 'ai-next-heron'), h('span', { text: 'Every step is done. Ask for any change, or turn the scene into a game you can share.' })),
                h('div', { class: 'ai-choice-options' }, button('Build & Deploy', () => this.hooks.build(), 'small primary', 'rocket'), button('Change something', () => this.askForChange(), 'small subtle')),
            );
            return;
        }
        const step = stepOf(design.stage);
        if (unfinished) {
            const text = this.lastEnd === 'limited' ? 'The assistant paused to let you look.' : this.lastEnd === 'stopped' ? 'Stopped.' : 'The request did not finish.';
            el.append(
                h('div', { class: 'ai-next-head' }, h('span', { text: started && !allDone ? `${text} ${step.title} is not finished yet.` : text })),
                h('div', { class: 'ai-choice-options' }, button('Keep going', () => this.keepGoing(false), 'small primary', 'play'), button('Change something', () => this.askForChange(), 'small subtle')),
            );
            return;
        }
        el.append(
            h('div', { class: 'ai-next-head' }, h('span', { text: 'Like how it looks?' })),
            h(
                'div',
                { class: 'ai-choice-options' },
                button('Looks good, keep going', () => this.keepGoing(true), 'small primary', 'check'),
                button('Change something', () => this.askForChange(), 'small subtle'),
            ),
        );
    }

    private welcome(): HTMLElement {
        const d = this.editor.store.doc.design;
        // Started on the start screen before the assistant was connected: the brief waits.
        const waiting = !!d.brief.text.trim() && !d.brief.structuredAt;
        if (waiting) {
            const brief = d.brief.text.trim();
            return h(
                'div',
                { class: 'ai-welcome' },
                h('div', { class: 'ai-welcome-head' }, mascotAvatar('ask', 34), h('h3', { text: 'Ready when you are' })),
                h('p', { text: 'Your idea is saved. The assistant plans it, builds the layout and shows it to you.' }),
                h('blockquote', { class: 'ai-welcome-brief', text: brief.length > 280 ? brief.slice(0, 277) + '...' : brief }),
                h(
                    'div',
                    { class: 'ai-onboard-actions' },
                    button('Start building', () => {
                        const images = d.concepts.slice(0, 8).map((c) => ({ asset: c.asset, name: this.editor.store.doc.assets.find((a) => a.id === c.asset)?.name ?? c.asset }));
                        const doc = this.editor.store.doc;
                        const fresh = ['Cube', 'Sphere'].every((name) => doc.nodes.some((n) => n.name === name && n.mesh));
                        this.start(brief.split('\n')[0].slice(0, 400), images, fresh);
                    }, 'primary', 'sparkle'),
                ),
            );
        }
        return h(
            'div',
            { class: 'ai-welcome' },
            h('div', { class: 'ai-welcome-head' }, mascotAvatar('idle', 34), h('h3', { text: 'Ask for anything' })),
            h('p', { text: 'A whole scene or one change: the assistant builds it, writes scripts and shaders and plays the scene to test its work. You say what you like and what to change.' }),
            h(
                'div',
                { class: 'ai-suggestions' },
                SUGGESTIONS.map((s) => {
                    const b = h('button', { class: 'ai-suggestion', text: s, attrs: { type: 'button' } });
                    b.addEventListener('click', () => {
                        this.input.value = s;
                        this.submit();
                    });
                    return b;
                }),
            ),
        );
    }

    private onboarding(): HTMLElement {
        const waiting = !!this.editor.store.doc.design.brief.text.trim() && !this.editor.store.doc.design.brief.structuredAt;
        return h(
            'div',
            { class: 'ai-welcome' },
            h('div', { class: 'ai-welcome-head' }, mascotAvatar('sleep', 34), h('h3', { text: 'Connect OpenRouter' })),
            waiting ? h('p', { class: 'ai-welcome-note', text: 'Your idea is saved. Connect, and the assistant starts on it.' }) : null,
            h('p', { text: 'The assistant runs on models from OpenRouter with your own account. Your key stays in this browser and requests go directly to openrouter.ai.' }),
            h(
                'div',
                { class: 'ai-onboard-actions' },
                button('Connect with OpenRouter', () => void startOAuth(), 'primary', 'link'),
                button('Paste an API key', () => void this.openSettings(), '', 'gear'),
            ),
            h('p', { class: 'muted small' }, 'Keys are created at ', h('a', { text: 'openrouter.ai/keys', attrs: { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener' } }), '.'),
        );
    }

    // ------------------------------------------------------------ settings

    private async openSettings() {
        const s = aiSettings.value;
        const key = h('input', { class: 'text', attrs: { type: 'password', placeholder: 'sk-or-...', spellcheck: 'false', autocomplete: 'off' } });
        key.value = aiSettings.apiKey;
        key.addEventListener('keydown', (e) => e.stopPropagation());
        const show = iconButton('eye', 'Show key', () => (key.type = key.type === 'password' ? 'text' : 'password'));
        const remember = new CheckboxField(s.remember, () => {}, 'Remember on this device');
        const modelInput = h('input', { class: 'text', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'provider/model' } });
        modelInput.value = s.model;
        modelInput.addEventListener('keydown', (e) => e.stopPropagation());
        const usable = () => this.models.filter(supportsTools).sort((a, b) => a.id.localeCompare(b.id));
        const modelList = suggestions(modelInput, () => usable().map((m) => ({ value: m.id, label: m.name })));
        const modelInfo = h('div', { class: 'muted small' });
        const describeModel = () => {
            const cur = this.models.find((m) => m.id === modelInput.value.trim());
            modelInfo.textContent = !this.models.length
                ? 'Model list unavailable (offline?). Type a model id.'
                : cur
                  ? `${cur.name}${cur.context_length ? ` · ${Math.round(cur.context_length / 1000)}k context` : ''}${supportsImages(cur) ? ' · sees images' : ''}${supportsTools(cur) ? '' : ' · no tool support, pick another'}${cur.pricing?.prompt ? ` · $${(Number(cur.pricing.prompt) * 1e6).toFixed(2)} / $${(Number(cur.pricing.completion) * 1e6).toFixed(2)} per M tokens` : ''} · ${describeCache(cur.id, cur.pricing)}${Number(cur.pricing?.input_cache_read) > 0 ? ` ($${(Number(cur.pricing!.input_cache_read) * 1e6).toFixed(2)} per M cached)` : ''}`
                  : `${usable().length} models with tool support. Type to search.`;
        };
        modelInput.addEventListener('input', describeModel);
        modelInput.addEventListener('change', describeModel);
        describeModel();
        void this.ensureModels().then(describeModel);
        const refresh = iconButton('refresh', 'Reload the model list', async () => {
            await this.loadModels(true);
            describeModel();
        });
        const temperature = new SliderField({ value: s.temperature, min: 0, max: 1.5, step: 0.05, precision: 2 });
        const steps = new NumberField({ value: s.maxSteps, min: 1, max: 60, step: 0.25, precision: 0 });
        const allowPlay = new CheckboxField(s.allowPlay, () => {}, 'Let the assistant run Play tests');
        const shots = new CheckboxField(s.screenshots, () => {}, 'Send viewport screenshots to vision models');
        const memo = new CheckboxField(s.memo, () => {}, 'Remember where the work stands between sessions');
        const limitTools = new CheckboxField(s.limitTools, () => {}, 'Limit the assistant to the tools of the current pipeline stage');
        const cacheLong = new CheckboxField(s.cacheLong, () => {}, 'Keep the prompt cache for an hour (Claude)');
        const images = new CheckboxField(s.allowImages, () => {}, 'Let the assistant generate images (concepts, paintovers, swatches)');
        const imageModel = h('input', { class: 'text', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: DEFAULT_IMAGE_MODEL } });
        imageModel.value = s.imageModel;
        imageModel.addEventListener('keydown', (e) => e.stopPropagation());
        const imageInfo = h('div', { class: 'muted small', text: 'Used for concepts, paintovers and swatches, by you and the assistant.' });
        let imageModels: ImageModel[] = [];
        const imageList = suggestions(imageModel, () => imageModels.map((m) => ({ value: m.id, label: m.name })));
        const describeImageModel = () => {
            const id = imageModel.value.trim() || DEFAULT_IMAGE_MODEL;
            const m = imageModels.find((x) => x.id === id);
            if (!imageModels.length) return;
            imageInfo.textContent = m
                ? `${m.name}${takesImages(m) ? ' · takes reference images' : ' · no reference images (cannot paint over)'}${m.supports_streaming ? ' · streams' : ''} · options: ${Object.keys(modelParams(m)).filter((k) => !OWN_PARAMS.has(k)).join(', ') || 'none'}`
                : `"${id}" is not in the list of ${imageModels.length} image models.`;
        };
        imageModel.addEventListener('input', describeImageModel);
        imageModel.addEventListener('change', describeImageModel);
        void listImageModels()
            .then((list) => {
                imageModels = list.filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('image'));
                describeImageModel();
            })
            .catch(() => (imageInfo.textContent = 'Image model list unavailable (offline?). Type a model id.'));
        const body = h(
            'div',
            { class: 'ai-settings' },
            row('API key', h('div', { class: 'inline' }, key, show)),
            row('', remember.el),
            row('', h('div', { class: 'inline' }, button('Connect with OpenRouter', () => void startOAuth(), 'small', 'link'), h('a', { class: 'small', text: 'Get a key', attrs: { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener' } }))),
            row('Model', h('div', null, h('div', { class: 'inline' }, modelInput, refresh), modelList)),
            row('', modelInfo),
            row('', cacheLong.el, 'Claude keeps cached prompts for five minutes; an hour keeps the conversation cached while you look at the result between requests. Writing the cache costs 2x the input price instead of 1.25x, reading it 0.1x either way.'),
            row('Temperature', temperature.el),
            row('Max steps', steps.el, 'Model calls per request'),
            row('', allowPlay.el),
            row('', shots.el),
            row('', images.el),
            row('Image model', h('div', null, imageModel, imageList)),
            row('', imageInfo),
            row('', limitTools.el, 'Off, the assistant does what you ask in any stage and marks a finished step for a recheck when it changes it. On, it only says what belongs to another stage.'),
            row('', memo.el, 'The assistant keeps a few lines about the scene in the project (one small extra request after changes), so a new conversation or another session knows where the work stands.'),
            h('p', { class: 'muted small', text: 'Messages, tool results (scene data, code), images and screenshots are sent to OpenRouter and the model provider you choose. Each project keeps its conversation in this browser; long conversations are compacted into a summary. Requests carry a session id (random, per conversation) so OpenRouter keeps a conversation with one provider and its prompt cache. The key is stored in this browser only.' }),
        );
        const result = await dialog('AI Assistant Settings', body, [
            { label: 'Remove key', value: 'remove', danger: true },
            { label: 'Cancel', value: 'cancel' },
            { label: 'Save', value: 'save', primary: true },
        ]);
        if (result === 'remove') {
            aiSettings.setKey('');
            return;
        }
        if (result !== 'save') return;
        const box = (f: CheckboxField) => (f.el.querySelector('input') as HTMLInputElement).checked;
        aiSettings.set({
            model: modelInput.value.trim(),
            temperature: temperature.get(),
            maxSteps: Math.round(steps.get()),
            remember: box(remember),
            allowPlay: box(allowPlay),
            screenshots: box(shots),
            allowImages: box(images),
            cacheLong: box(cacheLong),
            imageModel: imageModel.value.trim(),
            limitTools: box(limitTools),
            memo: box(memo),
        });
        aiSettings.setKey(key.value);
    }
}

/** A group of the assistant's steps (tool calls in a row): one line with the latest, open for all. */
function stepsGroup(): HTMLElement {
    const summary = h('summary', { class: 'ai-steps-summary' });
    return h('details', { class: 'ai-steps' }, summary, h('div', { class: 'ai-steps-body' }));
}

/** The group's line: the step running or the last one, and how many there were. */
function refreshGroup(group: HTMLElement) {
    const rows = Array.from(group.querySelectorAll<HTMLElement>('.ai-steps-body > .ai-msg.tool'));
    const running = rows.find((r) => r.dataset.state === 'running');
    const last = running ?? rows[rows.length - 1];
    const errors = rows.filter((r) => r.dataset.state === 'error').length;
    const summary = group.querySelector('summary')!;
    summary.replaceChildren(
        running ? h('span', { class: 'spinner small' }) : icon(errors && rows.every((r) => r.dataset.state === 'error') ? 'alert' : 'check', 13),
        h('span', { class: 'ai-steps-label', text: last ? `${last.dataset.label ?? ''}${running ? '...' : ''}` : '' }),
        h('span', { class: 'ai-steps-count', text: `${rows.length} step${rows.length === 1 ? '' : 's'}${errors ? `, ${errors} with a problem` : ''}` }),
    );
    group.classList.toggle('running', !!running);
}

function prettyJson(s: string): string {
    try {
        return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
        return s;
    }
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string): string {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out;
}

/** Small, safe Markdown subset: code blocks, headings, lists, bold, code, links. */
export function markdown(src: string): string {
    const out: string[] = [];
    const parts = src.split(/```/);
    parts.forEach((part, i) => {
        if (i % 2 === 1) {
            const nl = part.indexOf('\n');
            const lang = nl >= 0 ? part.slice(0, nl).trim().toLowerCase() : '';
            const code = nl >= 0 ? part.slice(nl + 1) : part;
            const hl = lang === 'wgsl' ? highlight(code, 'wgsl') : /^(js|javascript|ts|typescript)$/.test(lang) ? highlight(code, 'js') : esc(code);
            out.push(`<pre class="md-code"><code>${hl}</code></pre>`);
            return;
        }
        let list: 'ul' | 'ol' | null = null;
        let para: string[] = [];
        const flush = () => {
            if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
            para = [];
        };
        const closeList = () => {
            if (list) out.push(`</${list}>`);
            list = null;
        };
        for (const line of part.split('\n')) {
            const t = line.trim();
            const heading = /^(#{1,4})\s+(.*)$/.exec(t);
            const ul = /^[-*]\s+(.*)$/.exec(t);
            const ol = /^\d+[.)]\s+(.*)$/.exec(t);
            if (!t) {
                flush();
                closeList();
            } else if (heading) {
                flush();
                closeList();
                out.push(`<h4>${inline(heading[2])}</h4>`);
            } else if (ul || ol) {
                flush();
                const kind = ul ? 'ul' : 'ol';
                if (list !== kind) {
                    closeList();
                    out.push(`<${kind}>`);
                    list = kind;
                }
                out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
            } else {
                closeList();
                para.push(t);
            }
        }
        flush();
        closeList();
    });
    return out.join('');
}

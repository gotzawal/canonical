import type { Editor } from '../editor';
import { Agent, type AgentDone, type AgentTurn, type Attachment, type SendOptions } from '../ai/agent';
import { getAssetUrl, putDesignImage } from '../core/assets';
import { planStarted, STAGE_IDS } from '../core/design';
import type { StageId } from '../core/types';
import { pickFiles } from '../core/persistence';
import {
    finishOAuth, listModels, pickDefaultModel, startOAuth, supportsImages, supportsTools, type OpenRouterModel,
} from '../openrouter/client';
import { DRAW_HINTS, IMAGE_QUALITIES, QUALITY_NAMES, SEE_HINTS, type ImageQuality } from '../openrouter/imageQuality';
import { aiSettings, AUTO_APPROVE_CHOICES } from '../openrouter/settings';
import { continuePrompt, startPrompt } from '../design/prompts';
import { nextStage, stageDef, stepOf } from '../design/stages';
import { activityLabel } from './activity';
import { onChanges, touches } from './batch';
import { describeCache } from '../openrouter/caching';
import { DEFAULT_IMAGE_MODEL, listImageModels, modelParams, OWN_PARAMS, takesImages, type ImageModel } from '../openrouter/images';
import { highlight } from './codeEditor';
import { clear, h } from './dom';
import { icon } from './icons';
import { mascotAvatar, mascotPose, setMascotMood, type MascotMood, type MascotPose } from './mascot';
import { dialog, popover, toast } from './overlays';
import { credits, duration, openUsageDialog, shortDuration, tokens } from './usageDialog';
import { CheckboxField, NumberField, SelectField, SliderField, button, iconButton, row, suggestions } from './widgets';

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
    /** Closes the chat where it is a drawer over the view (narrow windows). */
    close(): void;
}

const PLACEHOLDER = 'Ask for a change, a script, a shader... (Enter to send, Shift+Enter for a new line)';
/** How long the heron looks pleased after a request. */
const DONE_MOOD_MS = 6000;
/** Times the chat goes on by itself in one stage before it waits for the user (a stage the assistant never finishes). */
const MAX_AUTO_RUNS = 8;

/** Chat with an OpenRouter model that edits the project through tools. */
export class AIPanel {
    readonly el: HTMLElement;
    readonly agent: Agent;
    private list: HTMLElement;
    private input: HTMLTextAreaElement;
    private sendBtn: HTMLButtonElement;
    private modelLabel: HTMLElement;
    /** The project's tokens, credits and work time; opens their statistics. */
    private usageLabel: HTMLButtonElement;
    /** How sharp the images are that go to the models and come from them. */
    private qualityBtn: HTMLButtonElement;
    private views = new Map<number, HTMLElement>();
    private models: OpenRouterModel[] = [];
    private modelsLoad: Promise<void> | null = null;
    /** Images waiting to be sent with the next message. */
    private attachments: Attachment[] = [];
    private attachStrip: HTMLElement;
    private compactBtn: HTMLButtonElement;
    /** The heron in the header: its mood follows the assistant. */
    private avatar: SVGSVGElement;
    /** What to do next, under the last answer (see followUp). */
    private next: HTMLElement;
    /** How the last request ended, while this page shows it. */
    private lastEnd: 'answer' | 'limited' | 'stopped' | 'error' | null = null;
    private lastEndAt = 0;
    private moodTimer = 0;
    /** The countdown of going on by itself while nobody answers (AI settings, Auto-approve): on what, in which stage, until when. */
    private auto: { kind: 'stage' | 'next'; stage: StageId; at: number; timer: number } | null = null;
    /** The user held the countdown (Wait, or an answer begun): none until the next request. */
    private autoHeld = false;
    /** A request of this page ended and none runs: what it ended in waits for the user. */
    private ended = false;
    /** Times it went on by itself in a stage since the user last asked for something. */
    private autoRuns: { stage: StageId | null; count: number } = { stage: null, count: 0 };
    /** What going on is under the last answer, when its card offers it. */
    private goOn: ((auto: boolean) => void) | null = null;

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
        this.usageLabel = h('button', { class: 'ai-usage', attrs: { type: 'button' } });
        this.usageLabel.addEventListener('click', () => openUsageDialog(editor));
        this.qualityBtn = h('button', { class: 'ai-quality', attrs: { type: 'button' } });
        this.qualityBtn.addEventListener('click', () => this.openQuality());
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
                iconButton('close', 'Close the chat', () => this.hooks.close(), 'drawer-close'),
            ),
            this.list,
            h(
                'div',
                { class: 'ai-composer' },
                this.attachStrip,
                this.input,
                h('div', { class: 'ai-composer-row' }, attachBtn, this.qualityBtn, h('span', { class: 'ai-hint', text: 'Edits of one request undo together.', title: 'Edits of one request undo together.' }), h('div', { class: 'spacer' }), this.sendBtn),
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
        // An answer begun holds the countdown of going on by itself; anything else done in the editor starts it over.
        this.input.addEventListener('focus', () => this.holdAuto());
        this.input.addEventListener('input', () => this.holdAuto());
        for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, () => this.restartAuto(), { capture: true, passive: true });
        this.sendBtn.addEventListener('click', () => (this.agent.running ? this.agent.stop() : this.submit()));
        this.agent.on('update', (turn) => this.update(turn));
        this.agent.on('busy', () => {
            // A new request: the wait it ends in may go on by itself again.
            if (this.agent.running) this.autoHeld = this.ended = false;
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
        editor.usage.on('change', () => this.renderUsage());
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
        this.autoRuns.count = 0;
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
        // The user asked for something: it may go on by itself again.
        this.autoRuns.count = 0;
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
     * was asked before it stopped. `auto`: nobody answered (Auto-approve).
     */
    private keepGoing(liked: boolean, auto = false) {
        const design = this.editor.store.doc.design;
        const show = auto ? `No answer for ${waitText(aiSettings.value.autoApprove)}: keep going.` : liked ? 'Looks good, keep going.' : 'Keep going.';
        if (planStarted(design)) this.send(continuePrompt(design.stage, liked, auto), [], { show });
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
        this.renderUsage();
        const see = s.seeQuality, draw = s.drawQuality;
        this.qualityBtn.replaceChildren(icon('image', 13), h('span', { text: see === draw ? QUALITY_NAMES[see] : `${QUALITY_NAMES[see]} / ${QUALITY_NAMES[draw]}` }));
        this.qualityBtn.title = `Image quality: ${QUALITY_NAMES[see].toLowerCase()} for the images the assistant sees, ${QUALITY_NAMES[draw].toLowerCase()} for the images it draws. Lower spends fewer tokens and credits.`;
        const running = this.agent.running;
        this.sendBtn.replaceChildren(icon(running ? 'stop' : 'send', 14), h('span', { text: running ? 'Stop' : 'Send' }));
        this.sendBtn.title = running ? 'Stop the assistant (Esc)' : 'Send (Enter)';
        this.compactBtn.disabled = running || !this.agent.hasHistory;
        this.input.disabled = false;
        this.renderMood();
    }

    /** The project's tokens (and credits) in the header, from its usage log. */
    private renderUsage() {
        const t = this.editor.usage.totals();
        const all = t.prompt + t.completion;
        const hit = t.prompt ? Math.round((t.cached / t.prompt) * 100) : 0;
        const ms = this.editor.usage.workTime();
        // A narrow header cuts the end off: the cache's share goes first.
        const parts = [all ? `${tokens(all)} tok` : '', t.cost ? credits(t.cost) : '', ms ? shortDuration(ms) : '', t.cached ? `${hit}% cached` : ''].filter(Boolean);
        this.usageLabel.textContent = parts.join(' · ') || 'Usage';
        this.usageLabel.title = t.count
            ? `This project: ${t.calls} model calls, ${(t.prompt - t.imageTokens).toLocaleString()} text + about ${t.imageTokens.toLocaleString()} image input tokens, ${t.completion.toLocaleString()} output tokens${t.cached ? `, ${t.cached.toLocaleString()} input tokens read from the cache (${hit}%)` : ''}${t.made ? `, ${t.made} images made` : ''}, ${duration(ms)} of work. Click for the statistics per piece of work: tokens and credits, and work time.`
            : 'Token usage and work time of this project, per piece of work';
    }

    /** Picks how sharp the images are that the assistant sees and has drawn, for the next ones. */
    private openQuality() {
        const body = h('div', { class: 'ai-quality-pop' });
        const choice = (title: string, what: string, key: 'seeQuality' | 'drawQuality', hints: Record<ImageQuality, string>) => {
            const cur = aiSettings.value[key];
            const seg = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': title } });
            for (const q of IMAGE_QUALITIES) {
                const b = h('button', { class: 'seg-btn' + (q === cur ? ' on' : ''), text: QUALITY_NAMES[q], attrs: { type: 'button', role: 'radio', 'aria-checked': String(q === cur) } });
                b.addEventListener('click', () => {
                    aiSettings.set({ [key]: q });
                    render();
                });
                seg.appendChild(b);
            }
            return h('div', { class: 'ai-quality-row' }, h('div', { class: 'ai-quality-title', text: title }), h('div', { class: 'muted small', text: what }), seg, h('div', { class: 'muted small', text: hints[cur] }));
        };
        const render = () => {
            clear(body);
            body.append(
                h('div', { class: 'pipeline-popover-title', text: 'Image quality' }),
                choice('Images the assistant sees', 'Screenshots, captures and the images you attach', 'seeQuality', SEE_HINTS),
                choice('Images it draws', 'Reference images, paintovers and swatches', 'drawQuality', DRAW_HINTS),
                h('p', { class: 'muted small', text: 'Lower quality spends fewer tokens and credits. A change applies from the next image, also while a request runs.' }),
                button('Token usage...', () => {
                    close();
                    openUsageDialog(this.editor);
                }, 'small subtle', 'list'),
            );
        };
        render();
        const close = popover(this.qualityBtn, body, 'ai-quality-popover');
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
        this.ended = true;
        clearTimeout(this.moodTimer);
        this.moodTimer = window.setTimeout(() => this.renderMood(), DONE_MOOD_MS + 50);
        this.renderControls();
        this.renderNext();
    }

    // ------------------------------------------------------------ messages

    private render() {
        this.stopAuto();
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
            el.appendChild(h('div', { class: 'ai-choice-question' }, mascotAvatar(st.status === 'done' ? 'done' : 'ask', 18), h('span', { text: `${def.title} is done. Happy with it?` })));
            if (st.status === 'done') {
                const next = nextStage(a.stage);
                el.appendChild(h('div', { class: 'ai-approval-state ok' }, icon('check', 13), h('span', { text: `${def.title} is complete.${next ? ` Next: ${stageDef(next).long}.` : ''}` })));
            } else if (st.proposal && design.stage === a.stage) {
                el.appendChild(h('div', { class: 'ai-approval-text', text: st.proposal.summary }));
                // Completed, it goes on as it would by itself; a dialog the user cancels holds it.
                const complete = button(pipeline.busy ? 'Saving the shots...' : 'Looks good', () => void pipeline.complete().then((ok) => ok || this.holdAuto()), 'small primary', 'check');
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
                        button('Details', () => {
                            this.holdAuto();
                            this.hooks.showDetails();
                        }, 'small subtle', 'sliders'),
                    ),
                );
                if (t === this.openStageApproval()) {
                    const line = this.autoLine('stage');
                    if (line) el.appendChild(line);
                }
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
        this.holdAuto();
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
        // What going on is under the answer, which goes on by itself when nobody answers: not after a stop or an error, nor at the end.
        this.goOn = !show || (allDone && !unfinished) || this.lastEnd === 'stopped' || this.lastEnd === 'error'
            ? null
            : this.lastEnd === 'limited' ? (auto) => this.keepGoing(false, auto) : (auto) => this.keepGoing(true, auto);
        this.syncAuto();
        if (!show) return;
        // The heron stands at the card's side, in the pose of how things are.
        const card = (pose: MascotPose, text: string, ...options: HTMLElement[]) =>
            el.append(mascotPose(pose, 96, 'ai-next-heron'), h('div', { class: 'ai-next-body' }, h('div', { class: 'ai-next-head', text }), h('div', { class: 'ai-choice-options' }, ...options), this.autoLine('next')));
        if (allDone && !unfinished) {
            card(
                'celebrate',
                'Every step is done. Ask for any change, or turn the scene into a game you can share.',
                button('Build & Deploy', () => this.hooks.build(), 'small primary', 'rocket'),
                button('Change something', () => this.askForChange(), 'small subtle'),
            );
            return;
        }
        const step = stepOf(design.stage);
        if (unfinished) {
            const text = this.lastEnd === 'limited' ? 'The assistant paused to let you look.' : this.lastEnd === 'stopped' ? 'Stopped.' : 'The request did not finish.';
            card(
                this.lastEnd === 'error' ? 'ask' : 'rest',
                started && !allDone ? `${text} ${step.title} is not finished yet.` : text,
                button('Keep going', () => this.keepGoing(false), 'small primary', 'play'),
                button('Change something', () => this.askForChange(), 'small subtle'),
            );
            return;
        }
        card(
            'ask',
            'Like how it looks?',
            button('Looks good, keep going', () => this.keepGoing(true), 'small primary', 'check'),
            button('Change something', () => this.askForChange(), 'small subtle'),
        );
    }

    // ------------------------------------------------------------ auto-approve

    /** The latest card of a stage to approve that still waits for the user. */
    private openStageApproval(): AgentTurn | undefined {
        return [...this.agent.turns].reverse().find((t) => t.approval?.kind === 'stage' && this.approvalOpen(t));
    }

    /**
     * What the chat waits on that goes on by itself when nobody answers (AI
     * settings, Auto-approve): a stage to approve, which it completes, or
     * the card under the last answer, which goes on. Only where a request of
     * this page ended, by answering or at its step limit: not after a stop
     * or an error, nor in a conversation a reload shows.
     */
    private autoFor(): 'stage' | 'next' | null {
        if (!aiSettings.value.autoApprove || !aiSettings.apiKey || this.agent.running || this.editor.pipeline.busy) return null;
        if (!this.ended || (this.lastEnd !== 'answer' && this.lastEnd !== 'limited')) return null;
        return this.openStageApproval() ? 'stage' : this.goOn ? 'next' : null;
    }

    /** It went on by itself as often as it may in this stage (a stage the assistant never finishes): it waits for the user. */
    private autoCapped(): boolean {
        return this.autoRuns.stage === this.editor.store.doc.design.stage && this.autoRuns.count >= MAX_AUTO_RUNS;
    }

    /** Starts the countdown when the chat comes to wait on something, and ends it when that is gone. */
    private syncAuto() {
        const was = this.auto;
        const design = this.editor.store.doc.design;
        // "Not yet" in the Design tab: the user answered.
        if (was?.kind === 'stage' && !this.openStageApproval() && design.stages[was.stage].status !== 'done') this.autoHeld = true;
        const kind = this.autoHeld || this.autoCapped() ? null : this.autoFor();
        if (kind === (was?.kind ?? null) && (!was || was.stage === design.stage)) return;
        this.stopAuto();
        if (!kind) return;
        this.auto = { kind, stage: design.stage, at: Date.now() + aiSettings.value.autoApprove * 1000, timer: window.setInterval(() => this.tickAuto(), 1000) };
        // The card under the answer draws its countdown (renderNext); the stage's card gets it here.
        const t = kind === 'stage' ? this.openStageApproval() : undefined;
        const line = t && this.autoLine('stage');
        if (t && line) this.views.get(t.id)?.appendChild(line);
    }

    private stopAuto() {
        if (!this.auto) return;
        clearInterval(this.auto.timer);
        this.auto = null;
        for (const el of this.el.querySelectorAll('.ai-auto')) el.remove();
    }

    /** The user answers, or asked it to wait: it does not go on by itself until the next request. */
    private holdAuto() {
        this.autoHeld = true;
        this.stopAuto();
    }

    /** Someone is at the editor: the countdown starts over. */
    private restartAuto() {
        if (!this.auto) return;
        this.auto.at = Date.now() + aiSettings.value.autoApprove * 1000;
        this.tickAuto();
    }

    private tickAuto() {
        const a = this.auto;
        if (!a) return;
        // Playing the scene is being there.
        if (this.editor.player.state !== 'stopped') a.at = Date.now() + aiSettings.value.autoApprove * 1000;
        const left = Math.ceil((a.at - Date.now()) / 1000);
        if (left > 0) {
            for (const el of this.el.querySelectorAll('.ai-auto-time')) el.textContent = `${left} s`;
            return;
        }
        // A dialog open: the user is deciding something there.
        if (document.querySelector('.dialog-backdrop')) this.holdAuto();
        else void this.fireAuto(a.kind);
    }

    /** Nobody answered: completes the stage and goes on, or goes on. */
    private async fireAuto(kind: 'stage' | 'next') {
        this.stopAuto();
        if (this.agent.running || this.editor.pipeline.busy) return;
        const stage = this.editor.store.doc.design.stage;
        const runs = this.autoRuns.stage === stage ? this.autoRuns.count : 0;
        if (kind === 'stage') {
            // Nobody looks at what is still open: completed as Complete Anyway would.
            if (!(await this.editor.pipeline.complete(true))) {
                this.holdAuto();
                return;
            }
            this.keepGoing(true, true);
        } else if (this.goOn) this.goOn(true);
        else return;
        this.autoRuns = { stage, count: runs + 1 };
    }

    /** The countdown on a card, with the button that holds it; or why it waits for the user instead. */
    private autoLine(kind: 'stage' | 'next'): HTMLElement | null {
        const a = this.auto;
        if (a?.kind === kind) {
            const left = Math.max(1, Math.ceil((a.at - Date.now()) / 1000));
            return h(
                'div',
                { class: 'ai-auto', title: 'Auto-approve (AI settings): with no answer it goes on by itself. Anything you do in the editor starts the countdown over.' },
                icon('clock', 13),
                h('span', null, kind === 'stage' ? 'Approves and goes on in ' : 'Goes on in ', h('span', { class: 'ai-auto-time', text: `${left} s` })),
                button('Wait', () => this.holdAuto(), 'small subtle'),
            );
        }
        if (!this.autoHeld && this.autoCapped() && this.autoFor() === kind) {
            return h('div', { class: 'ai-auto' }, icon('clock', 13), h('span', { text: `It went on by itself ${MAX_AUTO_RUNS} times in this stage, so it waits for you now.` }));
        }
        return null;
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
                mascotPose('ask', 132, 'ai-welcome-heron'),
                h('h3', { text: 'Ready when you are' }),
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
            mascotPose('stand', 132, 'ai-welcome-heron'),
            h('h3', { text: 'Ask for anything' }),
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
            mascotPose('rest', 132, 'ai-welcome-heron'),
            h('h3', { text: 'Connect OpenRouter' }),
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
        const waits = AUTO_APPROVE_CHOICES.includes(s.autoApprove) ? AUTO_APPROVE_CHOICES : [...AUTO_APPROVE_CHOICES, s.autoApprove];
        const autoApprove = new SelectField(waits.map((n) => ({ value: String(n), label: n ? `After ${waitText(n)}` : 'Off' })), String(s.autoApprove), () => {});
        autoApprove.el.setAttribute('aria-label', 'Auto-approve');
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
            row('Auto-approve', autoApprove.el, 'When the assistant stops for you (a finished stage to approve, whether to go on) and nobody answers, it approves and goes on by itself after this long. The card counts down; Wait holds it, and anything you do in the editor starts it over.'),
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
            autoApprove: Number(autoApprove.el.value),
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

/** A wait of Auto-approve in words: "20 s", "1 min". */
function waitText(seconds: number): string {
    return seconds % 60 ? `${seconds} s` : `${seconds / 60} min`;
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

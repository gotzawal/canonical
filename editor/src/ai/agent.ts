import type { Editor } from '../editor';
import { kvDelete, kvGet, kvSet } from '../core/db';
import { assetImageDataUrl, capImage } from '../core/images';
import { Emitter } from '../core/events';
import { designSummary, pipelineSummary } from '../design/context';
import { uid } from '../core/ids';
import { cacheStyle } from '../openrouter/caching';
import { chat, listModels, OpenRouterError, supportsImages, type ChatMessage, type ContentPart } from '../openrouter/client';
import { COMPACT_PROMPT, MEMO_PROMPT, SYSTEM_PROMPT } from './prompt';
import { SEE_DETAIL, SEE_PIXELS, type ImageQuality } from '../openrouter/imageQuality';
import { dataUrlSize, imageTokens } from '../openrouter/imageTokens';
import { aiSettings } from '../openrouter/settings';
import { runTool, toolDefs, toolWork } from './registry';
import type { Approval, ToolEnv } from './toolUtil';
import type { UsageTask, WorkKind } from './usage';

export interface ToolTurn {
    name: string;
    args: string;
    state: 'running' | 'done' | 'error';
    summary?: string;
    result?: string;
    image?: string;
}

/** An image the user attached to a message (a planning image asset). */
export interface Attachment {
    asset: string;
    name: string;
}

export interface AgentTurn {
    id: number;
    role: 'user' | 'assistant' | 'tool' | 'note';
    text: string;
    tool?: ToolTurn;
    error?: boolean;
    /** Undo label of the edits this request made, on the request's last turn. */
    undoLabel?: string;
    /** Images attached to a user message. */
    images?: Attachment[];
    /** Longer text a note can expand to (the summary of compacted messages). */
    detail?: string;
    /** A note with buttons that approve what the assistant proposed (see Approval). */
    approval?: Approval;
}

/** What one finished request did, for notifications and checkpoints. */
export interface AgentDone {
    prompt: string;
    /** The assistant's last answer. */
    answer: string;
    /** Short lines for the tools it ran. */
    tools: string[];
    /** The request changed the project. */
    changed: boolean;
    stopped: boolean;
    /** It ran out of model calls (AI settings, Max steps) before the model finished. */
    limited?: boolean;
    error?: string;
}

/** How a request is shown in the chat when that differs from what the model is sent. */
export interface SendOptions {
    /** The user's words for the chat (and the undo step's name); the model gets the full text. */
    show?: string;
}

interface AgentEvents {
    /** A turn came, changed (streamed text, tool state) or went (it is no longer in turns); null: the whole conversation. */
    update: AgentTurn | null;
    busy: boolean;
    /** The tool the assistant runs now ('' while it thinks or writes). */
    activity: string;
    done: AgentDone;
}

interface SessionData {
    version: 1;
    turns: AgentTurn[];
    history: ChatMessage[];
    savedAt: string;
    /** Key of the conversation for OpenRouter's sticky routing (a new conversation gets a new one). */
    conversation?: string;
}

/** Hard limit: older requests are dropped when the history grows past it mid-request. */
const MAX_HISTORY_CHARS = 200_000;
/** Before a new request the older part of a history this long is compacted into a summary. */
const COMPACT_CHARS = 90_000;
/** Requests kept word for word when compacting. */
const KEEP_REQUESTS = 2;
const MAX_TOOL_RESULT = 30_000;
/** What an image in the history counts for in historySize (about the text of its tokens), whatever the size of its data. */
const IMAGE_CHARS = 4_000;
/** Images a request keeps sending, for models with a prompt cache, before they are replaced by notes. */
const MAX_KEPT_IMAGES = 8;
/** User messages that only carry images a tool asked for start with this. */
const TOOL_IMAGES = '[tool images]';
const SESSION_PREFIX = 'ai-session:';

let turnId = 0;

/**
 * Runs the conversation: sends the history to OpenRouter, executes the tool
 * calls the model makes against the editor, and loops until the model
 * answers without tools. All edits of one request form one undo step.
 *
 * The conversation of each project is kept in this browser (IndexedDB) so a
 * reload continues it; long conversations are compacted into a summary, and
 * a short scene memo in the project itself carries the context between
 * conversations (see refreshMemo).
 */
export class Agent extends Emitter<AgentEvents> {
    turns: AgentTurn[] = [];
    private history: ChatMessage[] = [];
    /** Text that replaces an image message once the model has seen it. */
    private placeholders = new Map<ChatMessage, string>();
    private abort: AbortController | null = null;
    busy = false;
    /** Compaction running (the Send button stops it). */
    working = false;
    /** Stops the compaction started by hand (a request's compaction stops with the request). */
    private compacting: AbortController | null = null;
    /** What the assistant is doing now, for the status the UI shows: the tool running, or '' while it thinks or writes. */
    activity = '';
    private sessionKey = '';
    /** Sent as OpenRouter's session_id, so the requests of a conversation stay with the provider holding its prompt cache. */
    private conversation = uid('c');
    /** Pending saves, per conversation (a switch must not cancel the save of the one before). */
    private saveTimers = new Map<string, number>();
    /** A conversation being read: empty for a moment, which must not be saved (that deletes it). */
    private loadingKey = '';
    private loading: Promise<void> = Promise.resolve();
    /** Counts conversation switches (New conversation, another project): a request of an earlier one stops writing. */
    private generation = 0;
    /** The memo refresh running, and the work it takes in (see refreshMemo). */
    private refreshing: { session: string; recent: string; abort: AbortController } | null = null;
    /** Where the running request's tokens and credits are counted (the project's usage log). */
    private task: UsageTask | null = null;

    constructor(private editor: Editor, private context: () => string) {
        super();
        this.loading = this.loadSession();
        editor.store.on('load', () => {
            if (SESSION_PREFIX + editor.store.doc.design.id === this.sessionKey) return;
            if (this.busy) {
                // The request stops as if by hand, and the project left behind keeps it in its conversation.
                this.stop();
                this.push({ role: 'note', text: 'Stopped.' });
                this.settle(true);
                this.saveSession();
            }
            this.loading = this.loadSession();
        });
    }

    private get env(): ToolEnv {
        return {
            editor: this.editor,
            allowPlay: () => aiSettings.value.allowPlay,
            screenshots: () => aiSettings.value.screenshots,
            limitTools: () => aiSettings.value.limitTools,
            allowImages: () => aiSettings.value.allowImages,
            imageSize: () => SEE_PIXELS[aiSettings.value.seeQuality],
            signal: this.abort?.signal,
            usage: this.task ?? undefined,
        };
    }

    // ------------------------------------------------------------ session

    private async loadSession() {
        const key = SESSION_PREFIX + this.editor.store.doc.design.id;
        this.generation++;
        this.sessionKey = key;
        this.turns = [];
        this.history = [];
        this.placeholders.clear();
        this.conversation = uid('c');
        this.emit('update', null);
        this.loadingKey = key;
        const data = await kvGet<SessionData>(key).catch(() => undefined);
        if (this.loadingKey === key) this.loadingKey = '';
        if (this.sessionKey !== key || !data || data.version !== 1) return;
        if (typeof data.conversation === 'string' && data.conversation) this.conversation = data.conversation;
        this.turns = Array.isArray(data.turns) ? data.turns : [];
        this.history = Array.isArray(data.history) ? data.history : [];
        for (const t of this.turns) {
            turnId = Math.max(turnId, t.id);
            // A reload in the middle of a tool call leaves it running forever otherwise.
            if (t.tool?.state === 'running') t.tool.state = 'error';
        }
        this.repairHistory();
        this.emit('update', null);
    }

    /** Stores the conversation of this project (debounced). */
    private saveSession() {
        // This conversation, even if another one is loaded before the timer fires.
        const key = this.sessionKey;
        if (key === this.loadingKey) return;
        clearTimeout(this.saveTimers.get(key));
        const { history, conversation } = this;
        const all = this.turns;
        this.saveTimers.set(key, window.setTimeout(() => {
            this.saveTimers.delete(key);
            if (!all.length && !history.length) {
                void kvDelete(key);
                return;
            }
            // Screenshots are the bulk of a conversation: keep the latest ones.
            let images = 0;
            const turns = all
                .slice(-400)
                .reverse()
                .map((t) => {
                    if (!t.tool?.image) return t;
                    if (++images <= 8) return t;
                    return { ...t, tool: { ...t.tool, image: undefined } };
                })
                .reverse()
                .map((t) => (t.tool?.result && t.tool.result.length > 6000 ? { ...t, tool: { ...t.tool, result: t.tool.result.slice(0, 6000) + '...' } } : t));
            const data: SessionData = { version: 1, turns, history, savedAt: new Date().toISOString(), conversation };
            void kvSet(key, data);
        }, 600));
    }

    /** Starts a new conversation (the scene memo stays). */
    reset() {
        if (this.busy) this.stop();
        this.generation++;
        this.turns = [];
        this.history = [];
        this.placeholders.clear();
        this.conversation = uid('c');
        this.emit('update', null);
        this.saveSession();
    }

    /** Stops the running request, or the compaction started by hand. */
    stop() {
        this.abort?.abort();
        this.compacting?.abort();
    }

    /** Something is running that stop() ends. */
    get running(): boolean {
        return this.busy || this.working;
    }

    private push(turn: Omit<AgentTurn, 'id'>): AgentTurn {
        const t = { ...turn, id: ++turnId };
        this.turns.push(t);
        this.emit('update', t);
        return t;
    }

    private setActivity(tool: string) {
        if (this.activity === tool) return;
        this.activity = tool;
        this.emit('activity', tool);
    }

    /** Characters in the history, roughly proportional to its tokens (an image counts as IMAGE_CHARS, not its data). */
    historySize(): number {
        return this.history.reduce((n, m) => n + contentChars(m) + JSON.stringify(m.tool_calls ?? '').length, 0);
    }

    get hasHistory(): boolean {
        return this.history.length > 0;
    }

    private credentials(): { key: string; model: string } | null {
        const key = aiSettings.apiKey;
        const model = aiSettings.value.model;
        return key && model ? { key, model } : null;
    }

    /** The cache fields every request of this conversation carries (see caching.ts). */
    private get cacheRequest(): { sessionId: string; longCache: boolean } {
        return { sessionId: `morglay-${this.editor.store.doc.design.id}-${this.conversation}`, longCache: aiSettings.value.cacheLong };
    }

    // ------------------------------------------------------------ requests

    /**
     * Runs a request; false when it could not start (busy, no key or no
     * model). `opts.show` is what the chat shows of it, when the model is
     * sent more than the user's words (the start of a project, a step).
     */
    async send(text: string, attachments: Attachment[] = [], opts: SendOptions = {}): Promise<boolean> {
        const prompt = text.trim();
        if ((!prompt && !attachments.length) || this.busy) return false;
        const shown = opts.show?.trim() || prompt;
        await this.loading;
        const gen = this.generation;
        // False once the conversation was switched: then nothing more is written to it.
        const live = () => this.generation === gen;
        const cut = () => {
            if (!live()) throw new DOMException('Aborted', 'AbortError');
        };
        const cred = this.credentials();
        if (!aiSettings.apiKey) {
            this.push({ role: 'note', text: 'Add your OpenRouter API key in the AI settings first.', error: true });
            return false;
        }
        if (!cred) {
            this.push({ role: 'note', text: 'Pick a model in the AI settings first.', error: true });
            return false;
        }
        const { key, model } = cred;

        this.busy = true;
        this.activity = '';
        this.emit('busy', true);
        this.push({ role: 'user', text: shown, images: attachments.length ? attachments : undefined });
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const task = (this.task = this.editor.usage.begin('request', shown || 'Images'));
        const store = this.editor.store;
        const label = `AI: ${(shown || 'images').replace(/\s+/g, ' ').slice(0, 40)}${shown.length > 40 ? '...' : ''}`;
        // The tools' edits undo as one step (store.squash); edits by hand meanwhile stay apart.
        const batch = uid('r');
        let committed = false;
        let last: AgentTurn | null = null;
        let answer = '';
        const toolLines: string[] = [];
        let error = '';
        let stopped = false;
        let limited = false;
        let vision = false;
        let caches = false;
        try {
            const models = await listModels().catch(() => []);
            const info = models.find((m) => m.id === model);
            vision = supportsImages(info);
            caches = cacheStyle(model, info?.pricing) !== 'unknown';
            if (this.historySize() > COMPACT_CHARS) await this.compact(signal, true);
            cut();

            const ctx = this.context();
            const body = ctx ? `<editor-context>\n${ctx}\n</editor-context>\n\n${prompt || 'Look at the attached images.'}` : prompt;
            const message = await this.userMessage(body, attachments, vision);
            cut();
            this.history.push(message);

            const maxSteps = Math.max(1, Math.min(60, aiSettings.value.maxSteps || 24));
            let step = 0;
            for (; step < maxSteps; step++) {
                const turn = this.push({ role: 'assistant', text: '' });
                last = turn;
                this.setActivity('');
                const imagesIn = imageTokensOf(this.history, model);
                const res = await chat(
                    key,
                    {
                        model,
                        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history],
                        tools: toolDefs(this.env),
                        temperature: aiSettings.value.temperature,
                        ...this.cacheRequest,
                    },
                    {
                        signal,
                        onText: (d) => {
                            turn.text += d;
                            this.emit('update', turn);
                        },
                    },
                );
                task.chat(model, res.usage, { imageTokens: imagesIn, work: workOf(res.message.tool_calls ?? []) });
                cut();
                this.history.push(res.message);
                // Images are sent once; later requests only mention them. With a
                // prompt cache they stay until the request ends (up to
                // MAX_KEPT_IMAGES): replacing them now would change the start of
                // the next step and miss the cache.
                if (!caches || this.imageCount() > MAX_KEPT_IMAGES) this.retireImages();
                if (turn.text.trim()) answer = turn.text;
                else {
                    // Only tool calls: drop the empty bubble.
                    this.turns.splice(this.turns.indexOf(turn), 1);
                    last = null;
                    this.emit('update', turn);
                }
                const calls = res.message.tool_calls ?? [];
                if (!calls.length) {
                    const empty = !res.message.content;
                    // Providers refuse an assistant message without content in later requests.
                    if (empty) res.message.content = '(empty answer)';
                    if (res.finishReason === 'length') this.push({ role: 'note', text: 'The answer was cut off by the length limit.' });
                    else if (empty) this.push({ role: 'note', text: 'The model sent an empty answer. Send the request again, or try another model.' });
                    break;
                }
                const images: string[] = [];
                for (const call of calls) {
                    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                    const toolTurn = this.push({ role: 'tool', text: '', tool: { name: call.function.name, args: call.function.arguments || '{}', state: 'running' } });
                    this.setActivity(call.function.name);
                    task.tool(toolWork(call.function.name) ?? undefined);
                    let args: Record<string, any> = {};
                    let content: string;
                    try {
                        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                    } catch {
                        args = { __invalid: true };
                    }
                    if (args.__invalid) {
                        content = JSON.stringify({ error: 'The arguments were not valid JSON. Send a JSON object.' });
                        toolTurn.tool!.state = 'error';
                        toolTurn.tool!.summary = 'invalid arguments';
                    } else {
                        const result = await store.inBatch(batch, () => runTool(this.env, call.function.name, args));
                        cut();
                        content = JSON.stringify(result.data ?? null);
                        const failed = !!(result.data && typeof result.data === 'object' && 'error' in (result.data as any));
                        toolTurn.tool!.state = failed ? 'error' : 'done';
                        toolTurn.tool!.summary = failed ? String((result.data as any).error) : result.summary;
                        // No image is sharper than the chat's image quality asks for.
                        const size = SEE_PIXELS[aiSettings.value.seeQuality];
                        const shown = await Promise.all([...(result.image ? [result.image] : []), ...(result.images ?? [])].map((url) => capImage(url, size)));
                        cut();
                        if (shown.length) {
                            toolTurn.tool!.image = shown[0];
                            images.push(...shown);
                        }
                        if (result.approval) this.push({ role: 'note', text: toolTurn.tool!.summary ?? '', approval: structuredClone(result.approval) });
                    }
                    toolLines.push(`${call.function.name.replace(/_/g, ' ')}${toolTurn.tool!.summary ? `: ${toolTurn.tool!.summary}` : ''}`);
                    if (content.length > MAX_TOOL_RESULT) content = content.slice(0, MAX_TOOL_RESULT) + '... (truncated)';
                    toolTurn.tool!.result = content;
                    this.history.push({ role: 'tool', tool_call_id: call.id, content });
                    this.emit('update', toolTurn);
                }
                if (images.length) {
                    if (vision) {
                        const quality = aiSettings.value.seeQuality;
                        const parts: ContentPart[] = [{ type: 'text', text: `${TOOL_IMAGES} Images from the tool calls above:` }];
                        for (const url of images) parts.push(imagePart(url, quality));
                        task.sent(images.length, quality);
                        const msg: ChatMessage = { role: 'user', content: parts };
                        this.placeholders.set(msg, `${TOOL_IMAGES} (${images.length} image${images.length === 1 ? ' was' : 's were'} shown here.)`);
                        this.history.push(msg);
                    } else {
                        this.history.push({ role: 'user', content: `${TOOL_IMAGES} This model cannot see images, so the images from the tool calls were not sent.` });
                    }
                }
                this.trimHistory();
            }
            if (step >= maxSteps) {
                limited = true;
                this.push({ role: 'note', text: `Paused after ${maxSteps} steps (AI settings, Max steps). Keep going to continue.` });
            }
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                stopped = true;
                if (live()) this.push({ role: 'note', text: 'Stopped.' });
            } else {
                error = e instanceof OpenRouterError ? e.message : `${e?.message || e}`;
                if (live()) this.push({ role: 'note', text: error, error: true });
                console.warn('[ai] request failed', e);
            }
        } finally {
            task.end();
            this.task = null;
            committed = store.squash(batch, label);
            // A conversation left for another project was settled when it was left (see the constructor).
            if (live()) this.settle(stopped);
            this.busy = false;
            this.abort = null;
            this.activity = '';
            if (committed && live()) {
                const turn = [...this.turns].reverse().find((t) => t.role === 'assistant' || t.role === 'note') ?? last;
                if (turn) {
                    turn.undoLabel = label;
                    this.emit('update', turn);
                }
            }
            this.emit('busy', false);
            if (live()) this.saveSession();
            this.emit('done', { prompt: shown, answer, tools: toolLines, changed: committed, stopped, limited, error: error || undefined });
        }
        return true;
    }

    /**
     * Tidies up after a request: a step stopped or failed before its first
     * word leaves an empty bubble (it would show the typing dots for good),
     * a tool cut off leaves its row spinning, every tool call needs a result
     * in the history, and images the model has seen are not sent again.
     */
    private settle(stopped: boolean) {
        for (let i = this.turns.length - 1; i >= 0; i--) {
            const t = this.turns[i];
            if (t.role === 'assistant' && !t.text.trim()) this.turns.splice(i, 1);
            else if (t.tool?.state === 'running') {
                t.tool.state = 'error';
                t.tool.summary = stopped ? 'stopped' : 'did not finish';
            } else continue;
            this.emit('update', t);
        }
        this.repairHistory();
        this.retireImages();
    }

    /** The request message, with the attached images for models that see them. */
    private async userMessage(text: string, attachments: Attachment[], vision: boolean): Promise<ChatMessage> {
        if (!attachments.length) return { role: 'user', content: text };
        const list = attachments.map((a) => `${a.name} (asset ${a.asset})`).join(', ');
        if (!vision) {
            return { role: 'user', content: `${text}\n\n(The user attached ${attachments.length} image${attachments.length === 1 ? '' : 's'}: ${list}. This model cannot see images.)` };
        }
        const quality = aiSettings.value.seeQuality;
        const parts: ContentPart[] = [{ type: 'text', text: `${text}\n\nAttached images: ${list}` }];
        for (const a of attachments) {
            const url = await assetImageDataUrl(a.asset, SEE_PIXELS[quality]).catch(() => null);
            if (url) parts.push(imagePart(url, quality));
        }
        this.task?.sent(parts.length - 1, quality);
        const msg: ChatMessage = { role: 'user', content: parts };
        this.placeholders.set(msg, `${text}\n\n(The user attached ${list} here. Call view_images with their asset ids to look at them again.)`);
        return msg;
    }

    private imageCount(): number {
        let n = 0;
        for (const m of this.history) if (Array.isArray(m.content)) for (const p of m.content) if (p.type === 'image_url') n++;
        return n;
    }

    /** Replaces images the model has seen by short notes, so they are not sent again. */
    private retireImages() {
        for (const m of this.history) {
            if (m.role !== 'user' || !Array.isArray(m.content)) continue;
            m.content = this.placeholders.get(m) ?? '(Images were shown here.)';
            this.placeholders.delete(m);
        }
    }

    // ---------------------------------------------------------- compaction

    /** Start indices of the user's requests in the history. */
    private requestStarts(): number[] {
        const out: number[] = [];
        this.history.forEach((m, i) => {
            if (m.role === 'user' && !firstText(m).startsWith(TOOL_IMAGES)) out.push(i);
        });
        return out;
    }

    /**
     * Replaces the older part of the conversation with a summary written by
     * the model, keeping the latest requests word for word. Returns false
     * when there was nothing to compact or the summary failed.
     */
    async compact(signal?: AbortSignal, auto = false): Promise<boolean> {
        const cred = this.credentials();
        const starts = this.requestStarts();
        if (!cred || starts.length <= KEEP_REQUESTS) {
            if (!auto) this.push({ role: 'note', text: 'There is not enough conversation to compact yet.' });
            return false;
        }
        const cut = starts[starts.length - KEEP_REQUESTS];
        const older = this.history.slice(0, cut);
        const note = this.push({ role: 'note', text: auto ? 'The conversation is long: compacting the earlier messages...' : 'Compacting the earlier messages...' });
        // Another conversation can be opened while the model summarizes: this one is not about it.
        const gen = this.generation;
        // By hand it has no request to stop with: Stop ends it on its own.
        const own = signal ? null : new AbortController();
        if (own) this.compacting = own;
        signal ??= own?.signal;
        this.working = true;
        this.emit('busy', this.busy);
        const task = this.editor.usage.begin('summary', auto ? 'Summary of a long conversation' : 'Summary of the conversation');
        try {
            const res = await chat(
                cred.key,
                {
                    model: cred.model,
                    messages: [
                        { role: 'system', content: COMPACT_PROMPT },
                        { role: 'user', content: transcript(older) },
                    ],
                    temperature: 0.2,
                    max_tokens: 1500,
                    ...this.cacheRequest,
                    cacheable: false,
                },
                { signal },
            );
            task.chat(cred.model, res.usage);
            if (this.generation !== gen) return false;
            const summary = typeof res.message.content === 'string' ? res.message.content.trim() : '';
            if (!summary) throw new Error('The model returned an empty summary.');
            const recent = this.history.slice(cut);
            const first = recent[0];
            const wrap = `<conversation-summary>\n${summary}\n</conversation-summary>\n\n`;
            if (typeof first.content === 'string') first.content = wrap + first.content;
            else if (Array.isArray(first.content)) first.content = [{ type: 'text', text: wrap.trim() }, ...first.content];
            this.history = recent;
            note.text = `Compacted ${older.length} earlier messages into a summary.`;
            note.detail = summary;
            this.emit('update', note);
            this.saveSession();
            return true;
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                if (!own) throw e;
                // Stopped by hand: the conversation stays as it was.
                note.text = 'Compacting stopped.';
                this.emit('update', note);
                return false;
            }
            if (this.generation !== gen) return false;
            note.text = `Compacting failed (${e?.message || e}); the oldest messages were dropped instead.`;
            note.error = true;
            this.emit('update', note);
            this.trimHistory(COMPACT_CHARS);
            return false;
        } finally {
            task.end();
            if (own && this.compacting === own) this.compacting = null;
            this.working = false;
            this.emit('busy', this.busy);
        }
    }

    /** Drops old requests when the history gets long, cutting only before a user message. */
    private trimHistory(limit = MAX_HISTORY_CHARS) {
        while (this.historySize() > limit) {
            const starts = this.requestStarts().filter((i) => i > 0);
            if (!starts.length) break;
            this.history.splice(0, starts[0]);
        }
    }

    private repairHistory() {
        const answered = new Set(this.history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
        for (let i = 0; i < this.history.length; i++) {
            const m = this.history[i];
            if (m.role !== 'assistant' || !m.tool_calls) continue;
            const missing = m.tool_calls.filter((c) => !answered.has(c.id));
            let at = i + 1;
            while (at < this.history.length && this.history[at].role === 'tool') at++;
            for (const c of missing) {
                this.history.splice(at++, 0, { role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: 'Cancelled.' }) });
                answered.add(c.id);
            }
        }
    }

    // ---------------------------------------------------------------- memo

    /**
     * Rewrites the scene memo (DesignDoc.memo) from the old memo, the state
     * of the project and what happened since: the assistant's long-term
     * context for this scene. Returns false when it could not run.
     *
     * It runs in the background: requests do not wait for it. A refresh
     * still running when the next one starts is stopped, and the next one
     * takes over its work, so an older answer never replaces a newer memo.
     */
    async refreshMemo(recent: string): Promise<boolean> {
        const cred = this.credentials();
        if (!cred || !aiSettings.value.memo) return false;
        const store = this.editor.store;
        const doc = store.doc;
        // The project the memo is for: another one can be opened while the model writes.
        const session = this.sessionKey;
        const before = this.refreshing;
        before?.abort.abort();
        if (before?.session === session) recent = `${before.recent}\n${recent}`;
        const job = (this.refreshing = { session, recent, abort: new AbortController() });
        const task = this.editor.usage.begin('memo', 'Scene memo');
        const state = [
            `Scene "${doc.name}": ${doc.nodes.length} objects, ${doc.prefabs.length} prefabs, ${doc.scripts.length} scripts, ${doc.shaders.length} shaders.`,
            ...pipelineSummary(doc),
            ...designSummary(doc),
        ].join('\n');
        try {
            const res = await chat(cred.key, {
                model: cred.model,
                messages: [
                    { role: 'system', content: MEMO_PROMPT },
                    { role: 'user', content: `Current memo:\n${doc.design.memo.text.trim() || '(empty)'}\n\nProject state:\n${state}\n\nRecent work:\n${recent.slice(-12000) || '(no details)'}` },
                ],
                temperature: 0.2,
                max_tokens: 800,
                ...this.cacheRequest,
                cacheable: false,
            }, { signal: job.abort.signal });
            task.chat(cred.model, res.usage);
            if (this.sessionKey !== session) return false;
            const text = typeof res.message.content === 'string' ? res.message.content.trim() : '';
            if (!text) return false;
            store.patch((d) => {
                d.design.memo = { text: text.slice(0, 6000), at: new Date().toISOString() };
            }, { design: true });
            return true;
        } catch (e: any) {
            if (e?.name !== 'AbortError') console.warn('[ai] memo refresh failed', e);
            return false;
        } finally {
            task.end();
            if (this.refreshing === job) this.refreshing = null;
        }
    }
}

/** The pixel sizes of the images in the history, read once from their data. */
const imageSizes = new WeakMap<ContentPart, { w: number; h: number } | null>();

/** Prompt tokens of the images in these messages for a model, estimated from their sizes. */
function imageTokensOf(messages: readonly ChatMessage[], model: string): number {
    let n = 0;
    for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content) {
            if (p.type !== 'image_url') continue;
            let size = imageSizes.get(p);
            if (size === undefined) imageSizes.set(p, (size = dataUrlSize(p.image_url.url)));
            if (size) n += imageTokens(model, size.w, size.h, p.image_url.detail);
        }
    }
    return n;
}

/** What a model call worked on: the group most of its tool calls belong to, or an answer without any. */
function workOf(calls: readonly { function: { name: string } }[]): WorkKind {
    const counts = new Map<WorkKind, number>();
    let best: WorkKind = 'answer';
    let most = 0;
    for (const c of calls) {
        const k = toolWork(c.function.name);
        if (!k) continue;
        const n = (counts.get(k) ?? 0) + 1;
        counts.set(k, n);
        if (n > most) {
            most = n;
            best = k;
        }
    }
    return best;
}

/** An image for the model, with OpenAI's detail hint for the quality (other providers go by its pixels). */
function imagePart(url: string, quality: ImageQuality): ContentPart {
    const detail = SEE_DETAIL[quality];
    return { type: 'image_url', image_url: detail ? { url, detail } : { url } };
}

function contentChars(m: ChatMessage): number {
    if (typeof m.content === 'string') return m.content.length;
    let n = 0;
    for (const p of m.content ?? []) n += p.type === 'text' ? p.text.length : IMAGE_CHARS;
    return n;
}

function firstText(m: ChatMessage): string {
    if (typeof m.content === 'string') return m.content;
    for (const p of m.content ?? []) if (p.type === 'text') return p.text;
    return '';
}

/** The older messages as plain text for the summarizer. */
function transcript(messages: ChatMessage[]): string {
    const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' ...' : s);
    const lines: string[] = [];
    for (const m of messages) {
        const text = typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
        if (m.role === 'user') lines.push(`USER: ${cap(text.replace(/<editor-context>[\s\S]*?<\/editor-context>\s*/, ''), 3000)}`);
        else if (m.role === 'assistant') {
            if (text) lines.push(`ASSISTANT: ${cap(text, 3000)}`);
            for (const c of m.tool_calls ?? []) lines.push(`TOOL CALL ${c.function.name}: ${cap(c.function.arguments, 600)}`);
        } else if (m.role === 'tool') lines.push(`TOOL RESULT: ${cap(text, 800)}`);
    }
    let out = lines.join('\n');
    // Keep the end when it is still too long: recent turns matter more.
    if (out.length > 80_000) out = '...\n' + out.slice(-80_000);
    return out;
}

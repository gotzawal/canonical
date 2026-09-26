import type { Editor } from '../editor';
import { kvDelete, kvGet, kvSet } from '../core/db';
import { assetImageDataUrl } from '../core/images';
import { Emitter } from '../core/events';
import { designSummary, pipelineSummary } from '../design/context';
import { chat, listModels, OpenRouterError, supportsImages, type ChatMessage, type ContentPart, type Usage } from './openrouter';
import { COMPACT_PROMPT, MEMO_PROMPT, SYSTEM_PROMPT } from './prompt';
import { aiSettings } from './settings';
import { runTool, toolDefs, type ToolEnv } from './tools';

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
    error?: string;
}

interface AgentEvents {
    /** Turns changed (new turn, streamed text, tool state). */
    update: AgentTurn | null;
    busy: boolean;
    done: AgentDone;
}

interface SessionData {
    version: 1;
    turns: AgentTurn[];
    history: ChatMessage[];
    usage: Agent['usage'];
    savedAt: string;
}

/** Hard limit: older requests are dropped when the history grows past it mid-request. */
const MAX_HISTORY_CHARS = 200_000;
/** Before a new request the older part of a history this long is compacted into a summary. */
const COMPACT_CHARS = 90_000;
/** Requests kept word for word when compacting. */
const KEEP_REQUESTS = 2;
const MAX_TOOL_RESULT = 30_000;
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
    /** Compaction or memo refresh running (the Send button waits). */
    working = false;
    usage = { prompt: 0, completion: 0, cached: 0, cost: 0, requests: 0 };
    lastModel = '';
    private sessionKey = '';
    private saveTimer = 0;
    private loading: Promise<void> = Promise.resolve();

    constructor(private editor: Editor, private context: () => string) {
        super();
        this.loading = this.loadSession();
        editor.store.on('load', () => {
            if (SESSION_PREFIX + editor.store.doc.design.id === this.sessionKey) return;
            if (this.busy) this.stop();
            this.loading = this.loadSession();
        });
    }

    private get env(): ToolEnv {
        return {
            editor: this.editor,
            allowPlay: () => aiSettings.value.allowPlay,
            screenshots: () => aiSettings.value.screenshots,
            stageTools: () => aiSettings.value.stageTools,
            allowImages: () => aiSettings.value.allowImages,
            signal: this.abort?.signal,
        };
    }

    // ------------------------------------------------------------ session

    private async loadSession() {
        const key = SESSION_PREFIX + this.editor.store.doc.design.id;
        this.sessionKey = key;
        this.turns = [];
        this.history = [];
        this.placeholders.clear();
        this.usage = { prompt: 0, completion: 0, cached: 0, cost: 0, requests: 0 };
        this.emit('update', null);
        const data = await kvGet<SessionData>(key).catch(() => undefined);
        if (this.sessionKey !== key || !data || data.version !== 1) return;
        this.turns = Array.isArray(data.turns) ? data.turns : [];
        this.history = Array.isArray(data.history) ? data.history : [];
        if (data.usage) this.usage = { ...this.usage, ...data.usage };
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
        clearTimeout(this.saveTimer);
        const key = this.sessionKey;
        this.saveTimer = window.setTimeout(() => {
            if (!this.turns.length && !this.history.length) {
                void kvDelete(key);
                return;
            }
            // Screenshots are the bulk of a conversation: keep the latest ones.
            let images = 0;
            const turns = this.turns
                .slice(-400)
                .reverse()
                .map((t) => {
                    if (!t.tool?.image) return t;
                    if (++images <= 8) return t;
                    return { ...t, tool: { ...t.tool, image: undefined } };
                })
                .reverse()
                .map((t) => (t.tool?.result && t.tool.result.length > 6000 ? { ...t, tool: { ...t.tool, result: t.tool.result.slice(0, 6000) + '...' } } : t));
            const data: SessionData = { version: 1, turns, history: this.history, usage: this.usage, savedAt: new Date().toISOString() };
            void kvSet(key, data);
        }, 600);
    }

    /** Starts a new conversation (the scene memo stays). */
    reset() {
        if (this.busy) this.stop();
        this.turns = [];
        this.history = [];
        this.placeholders.clear();
        this.emit('update', null);
        this.saveSession();
    }

    stop() {
        this.abort?.abort();
    }

    private push(turn: Omit<AgentTurn, 'id'>): AgentTurn {
        const t = { ...turn, id: ++turnId };
        this.turns.push(t);
        this.emit('update', t);
        return t;
    }

    /** Characters in the history, roughly proportional to its tokens. */
    historySize(): number {
        return this.history.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) + JSON.stringify(m.tool_calls ?? '').length, 0);
    }

    get hasHistory(): boolean {
        return this.history.length > 0;
    }

    private credentials(): { key: string; model: string } | null {
        const key = aiSettings.apiKey;
        const model = aiSettings.value.model;
        return key && model ? { key, model } : null;
    }

    private addUsage(u: Usage | null | undefined) {
        this.usage.requests++;
        this.usage.prompt += u?.prompt_tokens ?? 0;
        this.usage.completion += u?.completion_tokens ?? 0;
        this.usage.cached += u?.prompt_tokens_details?.cached_tokens ?? 0;
        this.usage.cost += u?.cost ?? 0;
    }

    // ------------------------------------------------------------ requests

    async send(text: string, attachments: Attachment[] = []) {
        const prompt = text.trim();
        if ((!prompt && !attachments.length) || this.busy) return;
        await this.loading;
        const cred = this.credentials();
        if (!aiSettings.apiKey) {
            this.push({ role: 'note', text: 'Add your OpenRouter API key in the AI settings first.', error: true });
            return;
        }
        if (!cred) {
            this.push({ role: 'note', text: 'Pick a model in the AI settings first.', error: true });
            return;
        }
        const { key, model } = cred;

        this.busy = true;
        this.emit('busy', true);
        this.push({ role: 'user', text: prompt, images: attachments.length ? attachments : undefined });
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const store = this.editor.store;
        const label = `AI: ${(prompt || 'images').replace(/\s+/g, ' ').slice(0, 40)}${prompt.length > 40 ? '...' : ''}`;
        let committed = false;
        const offCommit = store.on('commit', (l) => {
            if (l === label) committed = true;
        });
        let last: AgentTurn | null = null;
        let answer = '';
        const toolLines: string[] = [];
        let error = '';
        let stopped = false;
        let vision = false;
        let begun = false;
        try {
            const models = await listModels().catch(() => []);
            vision = supportsImages(models.find((m) => m.id === model));
            if (this.historySize() > COMPACT_CHARS) await this.compact(signal, true);

            const ctx = this.context();
            const body = ctx ? `<editor-context>\n${ctx}\n</editor-context>\n\n${prompt || 'Look at the attached images.'}` : prompt;
            this.history.push(await this.userMessage(body, attachments, vision));

            // One undo step for everything this request changes.
            store.begin(label);
            begun = true;
            const maxSteps = Math.max(1, Math.min(60, aiSettings.value.maxSteps || 24));
            let step = 0;
            for (; step < maxSteps; step++) {
                const turn = this.push({ role: 'assistant', text: '' });
                last = turn;
                const res = await chat(
                    key,
                    {
                        model,
                        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history],
                        tools: toolDefs(this.env),
                        temperature: aiSettings.value.temperature,
                    },
                    {
                        signal,
                        onText: (d) => {
                            turn.text += d;
                            this.emit('update', turn);
                        },
                    },
                );
                this.lastModel = res.model;
                this.addUsage(res.usage);
                this.history.push(res.message);
                // Images are sent once; later requests only mention them.
                this.retireImages();
                if (turn.text.trim()) answer = turn.text;
                else {
                    // Only tool calls: drop the empty bubble.
                    this.turns.splice(this.turns.indexOf(turn), 1);
                    last = null;
                    this.emit('update', null);
                }
                const calls = res.message.tool_calls ?? [];
                if (!calls.length) {
                    if (res.finishReason === 'length') this.push({ role: 'note', text: 'The answer was cut off by the length limit.' });
                    break;
                }
                const images: string[] = [];
                for (const call of calls) {
                    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                    const toolTurn = this.push({ role: 'tool', text: '', tool: { name: call.function.name, args: call.function.arguments || '{}', state: 'running' } });
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
                        const result = await runTool(this.env, call.function.name, args);
                        content = JSON.stringify(result.data ?? null);
                        const failed = !!(result.data && typeof result.data === 'object' && 'error' in (result.data as any));
                        toolTurn.tool!.state = failed ? 'error' : 'done';
                        toolTurn.tool!.summary = failed ? String((result.data as any).error) : result.summary;
                        const shown = [...(result.image ? [result.image] : []), ...(result.images ?? [])];
                        if (shown.length) {
                            toolTurn.tool!.image = shown[0];
                            images.push(...shown);
                        }
                    }
                    toolLines.push(`${call.function.name.replace(/_/g, ' ')}${toolTurn.tool!.summary ? `: ${toolTurn.tool!.summary}` : ''}`);
                    if (content.length > MAX_TOOL_RESULT) content = content.slice(0, MAX_TOOL_RESULT) + '... (truncated)';
                    toolTurn.tool!.result = content;
                    this.history.push({ role: 'tool', tool_call_id: call.id, content });
                    this.emit('update', toolTurn);
                }
                if (images.length) {
                    if (vision) {
                        const parts: ContentPart[] = [{ type: 'text', text: `${TOOL_IMAGES} Images from the tool calls above:` }];
                        for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
                        const msg: ChatMessage = { role: 'user', content: parts };
                        this.placeholders.set(msg, `${TOOL_IMAGES} (${images.length} image${images.length === 1 ? ' was' : 's were'} shown here.)`);
                        this.history.push(msg);
                    } else {
                        this.history.push({ role: 'user', content: `${TOOL_IMAGES} This model cannot see images, so the images from the tool calls were not sent.` });
                    }
                }
                this.trimHistory();
            }
            if (step >= maxSteps) this.push({ role: 'note', text: `Stopped after ${maxSteps} steps. Send another message to continue.` });
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                stopped = true;
                this.push({ role: 'note', text: 'Stopped.' });
            } else {
                error = e instanceof OpenRouterError ? e.message : `${e?.message || e}`;
                this.push({ role: 'note', text: error, error: true });
                console.warn('[ai] request failed', e);
            }
            // Leave the history consistent: every tool call needs a result.
            this.repairHistory();
        } finally {
            if (begun) store.end();
            offCommit();
            this.retireImages();
            this.busy = false;
            this.abort = null;
            if (committed) {
                const turn = [...this.turns].reverse().find((t) => t.role === 'assistant' || t.role === 'note') ?? last;
                if (turn) turn.undoLabel = label;
            }
            this.emit('busy', false);
            this.emit('update', null);
            this.saveSession();
            this.emit('done', { prompt, answer, tools: toolLines, changed: committed, stopped, error: error || undefined });
        }
    }

    /** The request message, with the attached images for models that see them. */
    private async userMessage(text: string, attachments: Attachment[], vision: boolean): Promise<ChatMessage> {
        if (!attachments.length) return { role: 'user', content: text };
        const list = attachments.map((a) => `${a.name} (asset ${a.asset})`).join(', ');
        if (!vision) {
            return { role: 'user', content: `${text}\n\n(The user attached ${attachments.length} image${attachments.length === 1 ? '' : 's'}: ${list}. This model cannot see images.)` };
        }
        const parts: ContentPart[] = [{ type: 'text', text: `${text}\n\nAttached images: ${list}` }];
        for (const a of attachments) {
            const url = await assetImageDataUrl(a.asset).catch(() => null);
            if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
        const msg: ChatMessage = { role: 'user', content: parts };
        this.placeholders.set(msg, `${text}\n\n(The user attached ${list} here. Call view_images with their asset ids to look at them again.)`);
        return msg;
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
        const wasWorking = this.working;
        this.working = true;
        this.emit('busy', this.busy);
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
                },
                { signal },
            );
            this.addUsage(res.usage);
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
            if (e?.name === 'AbortError') throw e;
            note.text = `Compacting failed (${e?.message || e}); the oldest messages were dropped instead.`;
            note.error = true;
            this.emit('update', note);
            this.trimHistory(COMPACT_CHARS);
            return false;
        } finally {
            this.working = wasWorking;
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
     */
    async refreshMemo(recent: string): Promise<boolean> {
        const cred = this.credentials();
        if (!cred || !aiSettings.value.memo) return false;
        const store = this.editor.store;
        const doc = store.doc;
        const state = [
            `Scene "${doc.name}": ${doc.nodes.length} objects, ${doc.prefabs.length} prefabs, ${doc.scripts.length} scripts, ${doc.shaders.length} shaders.`,
            ...pipelineSummary(doc),
            ...designSummary(doc),
        ].join('\n');
        this.working = true;
        this.emit('busy', this.busy);
        try {
            const res = await chat(cred.key, {
                model: cred.model,
                messages: [
                    { role: 'system', content: MEMO_PROMPT },
                    { role: 'user', content: `Current memo:\n${doc.design.memo.text.trim() || '(empty)'}\n\nProject state:\n${state}\n\nRecent work:\n${recent.slice(0, 12000) || '(no details)'}` },
                ],
                temperature: 0.2,
                max_tokens: 800,
            });
            this.addUsage(res.usage);
            this.saveSession();
            const text = typeof res.message.content === 'string' ? res.message.content.trim() : '';
            if (!text) return false;
            store.patch((d) => {
                d.design.memo = { text: text.slice(0, 6000), at: new Date().toISOString() };
            }, { design: true });
            return true;
        } catch (e) {
            console.warn('[ai] memo refresh failed', e);
            return false;
        } finally {
            this.working = false;
            this.emit('busy', this.busy);
        }
    }
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

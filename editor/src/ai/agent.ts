import type { Editor } from '../editor';
import { Emitter } from '../core/events';
import { chat, listModels, OpenRouterError, supportsImages, type ChatMessage, type ContentPart } from './openrouter';
import { SYSTEM_PROMPT } from './prompt';
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

export interface AgentTurn {
    id: number;
    role: 'user' | 'assistant' | 'tool' | 'note';
    text: string;
    tool?: ToolTurn;
    error?: boolean;
    /** Undo label of the edits this request made, on the request's last turn. */
    undoLabel?: string;
}

interface AgentEvents {
    /** Turns changed (new turn, streamed text, tool state). */
    update: AgentTurn | null;
    busy: boolean;
}

const MAX_HISTORY_CHARS = 150_000;
const MAX_TOOL_RESULT = 30_000;

let turnId = 0;

/**
 * Runs the conversation: sends the history to OpenRouter, executes the tool
 * calls the model makes against the editor, and loops until the model
 * answers without tools. All edits of one request form one undo step.
 */
export class Agent extends Emitter<AgentEvents> {
    readonly turns: AgentTurn[] = [];
    private history: ChatMessage[] = [];
    private abort: AbortController | null = null;
    busy = false;
    readonly usage = { prompt: 0, completion: 0, cost: 0, requests: 0 };
    lastModel = '';

    constructor(private editor: Editor, private context: () => string) {
        super();
    }

    private get env(): ToolEnv {
        return {
            editor: this.editor,
            allowPlay: () => aiSettings.value.allowPlay,
            screenshots: () => aiSettings.value.screenshots,
        };
    }

    reset() {
        if (this.busy) this.stop();
        this.turns.length = 0;
        this.history = [];
        this.emit('update', null);
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

    async send(text: string) {
        const prompt = text.trim();
        if (!prompt || this.busy) return;
        const key = aiSettings.apiKey;
        if (!key) {
            this.push({ role: 'note', text: 'Add your OpenRouter API key in the AI settings first.', error: true });
            return;
        }
        const model = aiSettings.value.model;
        if (!model) {
            this.push({ role: 'note', text: 'Pick a model in the AI settings first.', error: true });
            return;
        }

        this.push({ role: 'user', text: prompt });
        const ctx = this.context();
        this.history.push({ role: 'user', content: ctx ? `<editor-context>\n${ctx}\n</editor-context>\n\n${prompt}` : prompt });

        this.busy = true;
        this.emit('busy', true);
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const store = this.editor.store;
        const label = `AI: ${prompt.replace(/\s+/g, ' ').slice(0, 40)}${prompt.length > 40 ? '...' : ''}`;
        let committed = false;
        const offCommit = store.on('commit', (l) => {
            if (l === label) committed = true;
        });
        // One undo step for everything this request changes.
        store.begin(label);
        let last: AgentTurn | null = null;
        let vision = false;
        try {
            const models = await listModels().catch(() => []);
            vision = supportsImages(models.find((m) => m.id === model));
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
                this.usage.requests++;
                this.usage.prompt += res.usage?.prompt_tokens ?? 0;
                this.usage.completion += res.usage?.completion_tokens ?? 0;
                this.usage.cost += res.usage?.cost ?? 0;
                this.history.push(res.message);
                // Screenshots are sent once; later requests only mention them.
                for (const m of this.history) {
                    if (m.role === 'user' && Array.isArray(m.content)) m.content = '(A viewport screenshot was shown here.)';
                }
                if (!turn.text.trim()) {
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
                        if (result.image) {
                            toolTurn.tool!.image = result.image;
                            images.push(result.image);
                        }
                    }
                    if (content.length > MAX_TOOL_RESULT) content = content.slice(0, MAX_TOOL_RESULT) + '... (truncated)';
                    toolTurn.tool!.result = content;
                    this.history.push({ role: 'tool', tool_call_id: call.id, content });
                    this.emit('update', toolTurn);
                }
                if (images.length) {
                    if (vision) {
                        const parts: ContentPart[] = [{ type: 'text', text: 'Viewport screenshot requested with capture_viewport:' }];
                        for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
                        this.history.push({ role: 'user', content: parts });
                    } else {
                        this.history.push({ role: 'user', content: 'capture_viewport: this model cannot see images, so the screenshot was not sent.' });
                    }
                }
                this.trimHistory();
            }
            if (step >= maxSteps) this.push({ role: 'note', text: `Stopped after ${maxSteps} steps. Send another message to continue.` });
        } catch (e: any) {
            if (e?.name === 'AbortError') this.push({ role: 'note', text: 'Stopped.' });
            else {
                const msg = e instanceof OpenRouterError ? e.message : `${e?.message || e}`;
                this.push({ role: 'note', text: msg, error: true });
                console.warn('[ai] request failed', e);
            }
            // Leave the history consistent: every tool call needs a result.
            this.repairHistory();
        } finally {
            store.end();
            offCommit();
            this.busy = false;
            this.abort = null;
            if (committed) {
                const turn = [...this.turns].reverse().find((t) => t.role === 'assistant' || t.role === 'note') ?? last;
                if (turn) turn.undoLabel = label;
            }
            this.emit('busy', false);
            this.emit('update', null);
        }
    }

    /** Drops old requests when the history gets long, cutting only before a user message. */
    private trimHistory() {
        const size = () => this.history.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) + JSON.stringify(m.tool_calls ?? '').length, 0);
        while (size() > MAX_HISTORY_CHARS) {
            const next = this.history.findIndex((m, i) => i > 0 && m.role === 'user' && typeof m.content === 'string');
            if (next <= 0) break;
            this.history.splice(0, next);
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
}

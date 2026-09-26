// Minimal OpenRouter client (OpenAI compatible chat completions with tool
// calling and streaming). Requests go straight from the browser to
// openrouter.ai with the user's own key; nothing passes through a server of
// ours.

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterModel {
    id: string;
    name: string;
    created?: number;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string };
    supported_parameters?: string[];
    architecture?: { input_modalities?: string[] };
}

/** Anthropic style prompt cache breakpoint (OpenRouter passes it to providers that support it). */
export interface CacheControl {
    type: 'ephemeral';
}

export type ContentPart =
    | { type: 'text'; text: string; cache_control?: CacheControl }
    | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

/** Explicit prompt caching: models that only cache at cache_control breakpoints. */
export function usesCacheBreakpoints(model: string): boolean {
    return model.startsWith('anthropic/');
}

/**
 * Adds cache breakpoints for models that need them: one after the system
 * prompt (with the tool definitions it covers the fixed prefix of every
 * request) and one on the last user message, so the next steps of a request
 * read the conversation so far from the cache. Returns a new array; the
 * history itself is left untouched.
 */
export function withCacheBreakpoints(messages: ChatMessage[]): ChatMessage[] {
    const out = messages.map((m) => ({ ...m }));
    const mark = (m: ChatMessage) => {
        if (typeof m.content === 'string') {
            if (!m.content) return;
            m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
            return;
        }
        if (!Array.isArray(m.content)) return;
        const parts = m.content.map((p) => ({ ...p })) as ContentPart[];
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.type === 'text') {
                parts[i] = { ...p, cache_control: { type: 'ephemeral' } };
                break;
            }
        }
        m.content = parts;
    };
    const system = out.find((m) => m.role === 'system');
    if (system) mark(system);
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === 'user') {
            mark(out[i]);
            break;
        }
    }
    return out;
}

export interface ToolDef {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Credits spent, when OpenRouter reports it. */
    cost?: number;
    /** Prompt tokens read from the provider's cache. */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    temperature?: number;
    max_tokens?: number;
}

export interface ChatResult {
    message: ChatMessage;
    finishReason: string;
    usage: Usage | null;
    model: string;
}

export class OpenRouterError extends Error {
    constructor(message: string, readonly status = 0) {
        super(message);
        this.name = 'OpenRouterError';
    }
}

function headers(key: string): Record<string, string> {
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Optional attribution headers OpenRouter uses for its app rankings.
        'HTTP-Referer': location.origin + location.pathname,
        'X-Title': 'Canonical Editor',
    };
}

function errorText(body: string, status: number): string {
    try {
        const json = JSON.parse(body);
        const msg = json?.error?.message || json?.message;
        const raw = json?.error?.metadata?.raw;
        if (msg) return raw && typeof raw === 'string' ? `${msg} (${raw.slice(0, 300)})` : msg;
    } catch { /* not json */ }
    if (status === 401) return 'The API key was rejected (401). Check it in the AI settings.';
    if (status === 402) return 'Your OpenRouter account is out of credits (402).';
    if (status === 429) return 'Rate limited by OpenRouter (429). Wait a moment and try again.';
    return body.slice(0, 300) || `HTTP ${status}`;
}

let modelCache: { at: number; list: OpenRouterModel[] } | null = null;

/** Lists the models available on OpenRouter (public endpoint, cached for 10 minutes). */
export async function listModels(force = false): Promise<OpenRouterModel[]> {
    if (!force && modelCache && Date.now() - modelCache.at < 600_000) return modelCache.list;
    const res = await fetch(`${OPENROUTER_URL}/models`);
    if (!res.ok) throw new OpenRouterError(errorText(await res.text(), res.status), res.status);
    const json = await res.json();
    const list: OpenRouterModel[] = Array.isArray(json?.data) ? json.data : [];
    modelCache = { at: Date.now(), list };
    return list;
}

export function supportsTools(m: OpenRouterModel | undefined): boolean {
    return !m?.supported_parameters || m.supported_parameters.includes('tools');
}

export function supportsImages(m: OpenRouterModel | undefined): boolean {
    return !!m?.architecture?.input_modalities?.includes('image');
}

/** A sensible default: the newest Claude Sonnet that supports tools, else the newest tool-capable model ('' when none). */
export function pickDefaultModel(models: OpenRouterModel[]): string {
    const tools = models.filter(supportsTools);
    const newest = (list: OpenRouterModel[]) => list.slice().sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]?.id;
    return (
        newest(tools.filter((m) => m.id.startsWith('anthropic/claude') && m.id.includes('sonnet'))) ??
        newest(tools.filter((m) => m.id.startsWith('anthropic/'))) ??
        newest(tools) ??
        ''
    );
}

/**
 * Sends a chat completion request with streaming. `onText` receives content
 * as it arrives; tool calls are assembled from their streamed fragments.
 */
export async function chat(key: string, req: ChatRequest, opts: { signal?: AbortSignal; onText?: (delta: string) => void } = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
        model: req.model,
        messages: usesCacheBreakpoints(req.model) ? withCacheBreakpoints(req.messages) : req.messages,
        stream: true,
        usage: { include: true },
    };
    if (req.tools?.length) {
        body.tools = req.tools;
        body.tool_choice = 'auto';
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.max_tokens) body.max_tokens = req.max_tokens;

    const res = await fetch(`${OPENROUTER_URL}/chat/completions`, {
        method: 'POST',
        headers: headers(key),
        body: JSON.stringify(body),
        signal: opts.signal,
    });
    if (!res.ok) throw new OpenRouterError(errorText(await res.text(), res.status), res.status);

    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/event-stream') || !res.body) {
        // Some routes answer without streaming.
        const json = await res.json();
        if (json?.error) throw new OpenRouterError(json.error.message || 'Request failed');
        const choice = json?.choices?.[0];
        const message: ChatMessage = { role: 'assistant', content: choice?.message?.content ?? '', tool_calls: choice?.message?.tool_calls };
        if (message.content) opts.onText?.(String(message.content));
        return { message, finishReason: choice?.finish_reason ?? 'stop', usage: json?.usage ?? null, model: json?.model ?? req.model };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const calls: ToolCall[] = [];
    let finishReason = '';
    let usage: Usage | null = null;
    let model = req.model;

    const handle = (data: string) => {
        if (data === '[DONE]') return;
        let json: any;
        try {
            json = JSON.parse(data);
        } catch {
            return;
        }
        if (json.error) throw new OpenRouterError(json.error.message || 'The model returned an error.', json.error.code || 0);
        if (json.model) model = json.model;
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) return;
        const delta = choice.delta ?? choice.message ?? {};
        if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            opts.onText?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
            let i: number = typeof tc.index === 'number' ? tc.index : -1;
            if (i < 0) {
                // No index: a new id starts a new call, otherwise continue the last one.
                const last = calls[calls.length - 1];
                i = !last || (tc.id && last.id && tc.id !== last.id) ? calls.length : calls.length - 1;
            }
            const call = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.function.name = call.function.name && call.function.name !== tc.function.name ? call.function.name + tc.function.name : tc.function.name;
            if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            // Lines starting with ':' are keep-alive comments ("OPENROUTER PROCESSING").
            if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
            handle(line.slice(5).trim());
        }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) handle(tail.slice(5).trim());

    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
    const message: ChatMessage = { role: 'assistant', content: content || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'), usage, model };
}

// --------------------------------------------------------------- OAuth PKCE

const PKCE_KEY = 'canonical-editor/openrouter-pkce';

function base64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sends the browser to OpenRouter to create a key for this app (it comes back with ?code=). */
export async function startOAuth() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = base64url(digest);
    sessionStorage.setItem(PKCE_KEY, verifier);
    const callback = location.origin + location.pathname;
    location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
}

/** Completes the OAuth flow when the page was opened with ?code=; returns the new key. */
export async function finishOAuth(): Promise<string | null> {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const verifier = sessionStorage.getItem(PKCE_KEY);
    if (!code || !verifier) return null;
    sessionStorage.removeItem(PKCE_KEY);
    params.delete('code');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    const res = await fetch(`${OPENROUTER_URL}/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    if (!res.ok) throw new OpenRouterError(errorText(await res.text(), res.status), res.status);
    const json = await res.json();
    if (!json?.key) throw new OpenRouterError('OpenRouter did not return a key.');
    return String(json.key);
}

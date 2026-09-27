// Minimal OpenRouter client (OpenAI compatible chat completions with tool
// calling and streaming; prompt caching is in caching.ts). Requests go
// straight from the browser to openrouter.ai with the user's own key;
// nothing passes through a server of ours.

import { cacheFields, refusedField } from './caching';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterModel {
    id: string;
    name: string;
    created?: number;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
    supported_parameters?: string[];
    architecture?: { input_modalities?: string[] };
}

/** Prompt cache breakpoint (OpenRouter passes it to the providers that take it; see caching.ts). */
export interface CacheControl {
    type: 'ephemeral';
    /** Claude only: '1h' keeps the entry for an hour instead of five minutes. */
    ttl?: '1h';
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
    /** Prompt tokens read from (cached_tokens) and written to (cache_write_tokens) the provider's cache. */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    /** The same in Anthropic's shape, when a route reports it that way. */
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

/** Prompt tokens read from the cache and written to it in a usage report. */
export function cacheTokens(u: Usage | null | undefined): { read: number; written: number } {
    return {
        read: u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0,
        written: u?.prompt_tokens_details?.cache_write_tokens ?? u?.cache_creation_input_tokens ?? 0,
    };
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDef[];
    temperature?: number;
    max_tokens?: number;
    /** Key of the conversation for OpenRouter's sticky routing, so its requests reach the provider holding its cache. */
    sessionId?: string;
    /** Claude: keep prompt cache entries for an hour instead of five minutes. */
    longCache?: boolean;
    /** False for one-off requests (summaries): nothing is marked, since no later request would read it back. */
    cacheable?: boolean;
}

/** Cache fields providers refused in this session, per model: they are left out from then on. */
const refused = new Map<string, { topLevel?: boolean; markers?: boolean; session?: boolean }>();

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

export function headers(key: string): Record<string, string> {
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Optional attribution headers OpenRouter uses for its app rankings.
        'HTTP-Referer': location.origin + location.pathname,
        'X-Title': 'Canonical Editor',
    };
}

export function errorText(body: string, status: number): string {
    const hint =
        status === 401 ? 'The API key was rejected (401). Check it in the AI settings.'
        : status === 402 ? 'Your OpenRouter account is out of credits (402).'
        : status === 429 ? 'Rate limited by OpenRouter (429). Wait a moment and try again.'
        : '';
    try {
        const json = JSON.parse(body);
        const msg = json?.error?.message || json?.message;
        const raw = json?.error?.metadata?.raw;
        // The server's words (e.g. "User not found.") and what to do about them.
        if (msg) return [hint, raw && typeof raw === 'string' ? `${msg} (${raw.slice(0, 300)})` : msg].filter(Boolean).join(' ');
    } catch { /* not json */ }
    if (hint) return hint;
    // An error page of a proxy or gateway is not worth showing as it is.
    if (/^\s*</.test(body)) return `OpenRouter returned HTTP ${status}. Try again in a moment.`;
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

/** Statuses worth one more try: timeouts, rate limits and gateway errors. */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1500, 4000];

/** Waits, or rejects with an AbortError once the request is stopped. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const t = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener('abort', stop);
            resolve();
        }
        function stop() {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
        }
        signal?.addEventListener('abort', stop, { once: true });
    });
}

/**
 * Sends a chat completion request with streaming. `onText` receives content
 * as it arrives; tool calls are assembled from their streamed fragments.
 */
export async function chat(key: string, req: ChatRequest, opts: { signal?: AbortSignal; onText?: (delta: string) => void } = {}): Promise<ChatResult> {
    let res: Response;
    let retries = 0;
    // A provider that refuses a cache field gets the request again without it (see caching.ts).
    for (let attempt = 0; ; attempt++) {
        const r = refused.get(req.model) ?? {};
        const once = req.cacheable === false;
        const cache = cacheFields(req.model, req.messages, { longTtl: req.longCache, noTopLevel: r.topLevel || once, noMarkers: r.markers || once });
        const body: Record<string, unknown> = {
            model: req.model,
            messages: cache.messages,
            stream: true,
            usage: { include: true },
        };
        if (cache.cache_control) body.cache_control = cache.cache_control;
        if (req.sessionId && !r.session) body.session_id = req.sessionId.slice(0, 256);
        if (req.tools?.length) {
            body.tools = req.tools;
            body.tool_choice = 'auto';
        }
        if (req.temperature !== undefined) body.temperature = req.temperature;
        if (req.max_tokens) body.max_tokens = req.max_tokens;

        try {
            res = await fetch(`${OPENROUTER_URL}/chat/completions`, {
                method: 'POST',
                headers: headers(key),
                body: JSON.stringify(body),
                signal: opts.signal,
            });
        } catch (e: any) {
            // A dropped connection is tried again a few times; nothing was streamed yet.
            if (e?.name === 'AbortError' || retries >= MAX_RETRIES) throw e;
            await pause(RETRY_DELAYS[retries++], opts.signal);
            continue;
        }
        if (res.ok) break;
        const text = errorText(await res.text(), res.status);
        // Busy or failing for a moment (rate limit, gateway errors): wait and try again.
        if (TRANSIENT.has(res.status) && retries < MAX_RETRIES) {
            const after = Number(res.headers.get('retry-after'));
            await pause(after > 0 ? Math.min(after, 20) * 1000 : RETRY_DELAYS[retries], opts.signal);
            retries++;
            continue;
        }
        const field = attempt < 3 ? refusedField(res.status, text) : null;
        if (field === 'session' && body.session_id) {
            refused.set(req.model, { ...r, session: true });
            continue;
        }
        // Without the top-level field first (Claude), then without the markers.
        if (field === 'cache' && body.cache_control) {
            refused.set(req.model, { ...r, topLevel: true });
            continue;
        }
        if (field === 'cache' && cache.marked) {
            refused.set(req.model, { ...r, markers: true });
            continue;
        }
        throw new OpenRouterError(text, res.status);
    }

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

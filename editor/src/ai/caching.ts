// Prompt caching through OpenRouter. Providers cache the unchanged start of
// a request (tools, system prompt, earlier messages) in one of two ways:
//
// - By themselves: OpenAI, xAI, DeepSeek, Moonshot (Kimi), Z.ai (GLM),
//   MiniMax, Gemini's implicit cache and others. Nothing is marked; the
//   start of the request only has to stay the same and reach the same
//   provider.
// - Up to cache_control markers: Anthropic (Claude), and Alibaba, which
//   serves the Qwen models and DeepSeek V3.2. The system prompt and the
//   latest user message are marked; Claude also gets OpenRouter's top-level
//   cache_control, whose mark moves to the end of the conversation, so every
//   step of a tool loop reads what the step before it wrote. One-off
//   requests (summaries) are not marked: a cache write nobody reads back
//   only costs more. A field a provider refuses is left out for that model
//   from then on (see chat in openrouter.ts).
//
// Every request of a conversation carries the same session_id. OpenRouter
// uses it as the key for sticky routing: the conversation stays on one
// provider from its first request, so the cache that provider built is the
// one that is read (otherwise stickiness starts only after a cache hit).

import type { CacheControl, ChatMessage, ContentPart } from './openrouter';

export type CacheStyle = 'markers' | 'automatic' | 'unknown';

/** Model ids whose providers cache only up to cache_control markers. */
const MARKER_FAMILIES = [/^anthropic\//, /^qwen\//, /^alibaba\//, /^deepseek\/deepseek-v3\.2/];

/** Model ids whose providers cache repeated prefixes by themselves. */
const AUTOMATIC_FAMILIES = [
    /^deepseek\//,
    /^moonshotai\//,
    /^z-ai\//,
    /^thudm\//,
    /^minimax\//,
    /^openai\//,
    /^x-ai\//,
    /^google\/gemini/,
];

/** Pricing fields of the model list that tell whether cached reads are billed (and so supported). */
export interface CachePricing {
    input_cache_read?: string;
    input_cache_write?: string;
}

/** How a model's providers cache prompts; unknown families count as caching when their pricing lists cached reads. */
export function cacheStyle(model: string, pricing?: CachePricing): CacheStyle {
    const id = model.toLowerCase();
    if (MARKER_FAMILIES.some((r) => r.test(id))) return 'markers';
    if (AUTOMATIC_FAMILIES.some((r) => r.test(id))) return 'automatic';
    const read = Number(pricing?.input_cache_read);
    return Number.isFinite(read) && read > 0 ? 'automatic' : 'unknown';
}

/** True for Claude: OpenRouter's top-level cache_control and the one hour TTL apply. */
export function isClaude(model: string): boolean {
    return /^anthropic\//.test(model.toLowerCase());
}

/** Short words for the settings. */
export function describeCache(model: string, pricing?: CachePricing): string {
    const style = cacheStyle(model, pricing);
    if (style === 'markers') return isClaude(model) ? 'prompt cache: marked (Claude)' : 'prompt cache: marked (Alibaba)';
    if (style === 'automatic') return 'prompt cache: automatic';
    return 'no prompt cache reported';
}

export interface CacheOptions {
    /** Keep Claude's cache entries for an hour instead of five minutes. */
    longTtl?: boolean;
    /** Leave out the top-level cache_control (a provider refused it). */
    noTopLevel?: boolean;
    /** Leave out every marker (a provider refused them). */
    noMarkers?: boolean;
}

export interface CacheFields {
    messages: ChatMessage[];
    /** OpenRouter's top-level field (Claude). */
    cache_control?: CacheControl;
    /** True when the messages carry cache_control markers. */
    marked: boolean;
}

/** The cache fields of a chat request body for `model`: marked messages and top-level cache_control. */
export function cacheFields(model: string, messages: ChatMessage[], opts: CacheOptions = {}): CacheFields {
    if (opts.noMarkers || cacheStyle(model) !== 'markers') return { messages, marked: false };
    const control: CacheControl = isClaude(model) && opts.longTtl ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    const out: CacheFields = { messages: withCacheBreakpoints(messages, control), marked: true };
    if (isClaude(model) && !opts.noTopLevel) out.cache_control = control;
    return out;
}

/**
 * Marks the end of the system prompt (with the tool definitions before it,
 * the fixed start of every request) and the last user message, so the next
 * steps of a request read the conversation so far from the cache. Returns
 * new messages; the history itself is left untouched.
 */
export function withCacheBreakpoints(messages: ChatMessage[], control: CacheControl = { type: 'ephemeral' }): ChatMessage[] {
    const out = messages.map((m) => ({ ...m }));
    const mark = (m: ChatMessage) => {
        if (typeof m.content === 'string') {
            if (!m.content) return;
            m.content = [{ type: 'text', text: m.content, cache_control: control }];
            return;
        }
        if (!Array.isArray(m.content)) return;
        const parts = m.content.map((p) => ({ ...p })) as ContentPart[];
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.type === 'text') {
                parts[i] = { ...p, cache_control: control };
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

/** The field an error from a request says a provider refused: session_id or the cache markers. */
export function refusedField(status: number, message: string): 'session' | 'cache' | null {
    if (status !== 400 && status !== 404 && status !== 422) return null;
    if (/session_id/i.test(message)) return 'session';
    if (/cache[_ ]control|prompt cach/i.test(message)) return 'cache';
    return null;
}

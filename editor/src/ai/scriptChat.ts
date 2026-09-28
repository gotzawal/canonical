// this.chat() of scripts in the editor: one OpenRouter completion with the
// key of the assistant and, unless the script names one, its model. Built
// games carry no key, so there the call fails and scripts fall back to
// their own lines.

import type { ChatRequest as ScriptChatRequest } from '../play/script';
import { chat, type ChatMessage } from '../openrouter/client';
import { aiSettings } from '../openrouter/settings';

export async function scriptChat(req: ScriptChatRequest): Promise<string> {
    const key = aiSettings.apiKey;
    if (!key) throw new Error('this.chat() needs an OpenRouter key: add one in the AI panel.');
    const model = (typeof req.model === 'string' && req.model.trim()) || aiSettings.value.model;
    if (!model) throw new Error('this.chat() needs a model: pick one in the AI panel settings or pass { model }.');
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: String(req.system) });
    if (typeof req.prompt === 'string') messages.push({ role: 'user', content: req.prompt });
    else if (Array.isArray(req.prompt)) {
        for (const m of req.prompt) {
            if (m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant')) messages.push({ role: m.role, content: String(m.content ?? '') });
        }
    }
    if (!messages.some((m) => m.role === 'user')) throw new Error('this.chat() needs a prompt.');
    const r = await chat(
        key,
        {
            model,
            messages,
            temperature: typeof req.temperature === 'number' ? req.temperature : undefined,
            max_tokens: typeof req.maxTokens === 'number' ? Math.max(1, Math.round(req.maxTokens)) : undefined,
            cacheable: false,
        },
        { signal: req.signal },
    );
    const c = r.message.content;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
}

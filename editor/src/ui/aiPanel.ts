import type { Editor } from '../editor';
import { Agent, type AgentTurn } from '../ai/agent';
import {
    finishOAuth, listModels, pickDefaultModel, startOAuth, supportsImages, supportsTools, type OpenRouterModel,
} from '../ai/openrouter';
import { aiSettings } from '../ai/settings';
import { highlight } from './codeEditor';
import { clear, h } from './dom';
import { icon } from './icons';
import { dialog, toast } from './overlays';
import { CheckboxField, NumberField, SliderField, button, iconButton, row } from './widgets';

const SUGGESTIONS = [
    'Build a small park: grass ground, a few trees made of primitives, benches and a warm sunset.',
    'Write a script that makes the selected object orbit around the origin, and attach it.',
    'Create a glowing hologram shader and use it on the sphere.',
    'Add a vignette and a subtle color grade post effect.',
    'Make a player cube that moves with WASD and jumps with Space, and a camera that follows it. Test it.',
    'Run the scene, read the errors and fix the scripts.',
];

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

    constructor(private editor: Editor, context: () => string) {
        this.agent = new Agent(editor, context);
        this.list = h('div', { class: 'ai-list' });
        this.input = h('textarea', {
            class: 'ai-input',
            attrs: { rows: 3, placeholder: 'Ask for a change, a script, a shader... (Enter to send, Shift+Enter for a new line)', spellcheck: 'true' },
        });
        this.sendBtn = h('button', { class: 'btn primary ai-send', attrs: { type: 'button' } });
        this.modelLabel = h('button', { class: 'ai-model', attrs: { type: 'button' }, title: 'Model (click to change)' });
        this.usageLabel = h('span', { class: 'ai-usage' });
        this.modelLabel.addEventListener('click', () => void this.openSettings());

        this.el = h(
            'div',
            { class: 'panel ai-panel' },
            h(
                'div',
                { class: 'ai-header' },
                icon('sparkle', 15),
                this.modelLabel,
                h('div', { class: 'spacer' }),
                this.usageLabel,
                iconButton('plus', 'New conversation', () => {
                    this.agent.reset();
                    this.render();
                }),
                iconButton('gear', 'AI settings', () => void this.openSettings()),
            ),
            this.list,
            h('div', { class: 'ai-composer' }, this.input, h('div', { class: 'ai-composer-row' }, h('span', { class: 'ai-hint', text: 'Edits of one request undo together.' }), h('div', { class: 'spacer' }), this.sendBtn)),
        );

        this.input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.submit();
            }
        });
        this.sendBtn.addEventListener('click', () => (this.agent.busy ? this.agent.stop() : this.submit()));
        this.agent.on('update', (turn) => this.update(turn));
        this.agent.on('busy', () => this.renderControls());
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
        if (!text || this.agent.busy) return;
        if (!aiSettings.apiKey) {
            void this.openSettings();
            return;
        }
        this.input.value = '';
        void this.agent.send(text);
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
        this.usageLabel.textContent = u.requests ? `${((u.prompt + u.completion) / 1000).toFixed(1)}k tok${u.cost ? ` · $${u.cost.toFixed(4)}` : ''}` : '';
        this.usageLabel.title = u.requests ? `${u.requests} requests, ${u.prompt} prompt + ${u.completion} completion tokens` : '';
        this.sendBtn.replaceChildren(icon(this.agent.busy ? 'stop' : 'send', 14), h('span', { text: this.agent.busy ? 'Stop' : 'Send' }));
        this.input.disabled = false;
    }

    // ------------------------------------------------------------ messages

    private render() {
        clear(this.list);
        this.views.clear();
        if (!aiSettings.apiKey) {
            this.list.appendChild(this.onboarding());
            return;
        }
        if (!this.agent.turns.length) {
            this.list.appendChild(this.welcome());
            return;
        }
        for (const t of this.agent.turns) this.list.appendChild(this.turnView(t));
        this.list.scrollTop = this.list.scrollHeight;
    }

    private update(turn: AgentTurn | null) {
        this.renderControls();
        if (!turn || !this.views.size || !this.agent.turns.includes(turn)) {
            this.render();
            return;
        }
        const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
        const next = this.turnView(turn);
        const old = this.views.get(turn.id);
        if (old) old.replaceWith(next);
        else this.list.appendChild(next);
        if (nearBottom) this.list.scrollTop = this.list.scrollHeight;
    }

    private turnView(t: AgentTurn): HTMLElement {
        let el: HTMLElement;
        if (t.role === 'user') {
            el = h('div', { class: 'ai-msg user' }, h('div', { class: 'ai-bubble', text: t.text }));
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
                h('span', { class: 'ai-tool-name', text: tool.name.replace(/_/g, ' ') }),
                tool.summary ? h('span', { class: 'ai-tool-summary', text: tool.summary }) : null,
            );
            details.appendChild(summary);
            details.appendChild(h('div', { class: 'ai-tool-label', text: 'Arguments' }));
            details.appendChild(h('pre', { class: 'ai-tool-pre', text: prettyJson(tool.args) }));
            if (tool.result) {
                details.appendChild(h('div', { class: 'ai-tool-label', text: 'Result' }));
                details.appendChild(h('pre', { class: 'ai-tool-pre', text: prettyJson(tool.result).slice(0, 6000) }));
            }
            el = h('div', { class: 'ai-msg tool' }, details, tool.image ? h('img', { class: 'ai-shot', attrs: { src: tool.image, alt: 'Viewport screenshot' } }) : null);
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

    private welcome(): HTMLElement {
        return h(
            'div',
            { class: 'ai-welcome' },
            h('p', { text: 'Describe what you want. The assistant edits the scene, writes scripts and shaders, changes the render graph and can play the scene to test its work.' }),
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
        return h(
            'div',
            { class: 'ai-welcome' },
            h('h3', { text: 'Connect OpenRouter' }),
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
        const modelInput = h('input', { class: 'text', attrs: { type: 'text', list: 'ai-models', spellcheck: 'false', placeholder: 'provider/model' } });
        modelInput.value = s.model;
        modelInput.addEventListener('keydown', (e) => e.stopPropagation());
        const datalist = h('datalist', { attrs: { id: 'ai-models' } });
        const modelInfo = h('div', { class: 'muted small' });
        const fillModels = () => {
            clear(datalist);
            const usable = this.models.filter(supportsTools).sort((a, b) => a.id.localeCompare(b.id));
            for (const m of usable) datalist.appendChild(h('option', { attrs: { value: m.id }, text: m.name }));
            const cur = this.models.find((m) => m.id === modelInput.value.trim());
            modelInfo.textContent = !this.models.length
                ? 'Model list unavailable (offline?). Type a model id.'
                : cur
                  ? `${cur.name}${cur.context_length ? ` · ${Math.round(cur.context_length / 1000)}k context` : ''}${supportsImages(cur) ? ' · sees images' : ''}${supportsTools(cur) ? '' : ' · no tool support, pick another'}${cur.pricing?.prompt ? ` · $${(Number(cur.pricing.prompt) * 1e6).toFixed(2)} / $${(Number(cur.pricing.completion) * 1e6).toFixed(2)} per M tokens` : ''}`
                  : `${usable.length} models with tool support. Type to search.`;
        };
        modelInput.addEventListener('input', fillModels);
        fillModels();
        void this.ensureModels().then(fillModels);
        const refresh = iconButton('refresh', 'Reload the model list', async () => {
            await this.loadModels(true);
            fillModels();
        });
        const temperature = new SliderField({ value: s.temperature, min: 0, max: 1.5, step: 0.05, precision: 2 });
        const steps = new NumberField({ value: s.maxSteps, min: 1, max: 60, step: 0.25, precision: 0 });
        const allowPlay = new CheckboxField(s.allowPlay, () => {}, 'Let the assistant run Play tests');
        const shots = new CheckboxField(s.screenshots, () => {}, 'Send viewport screenshots to vision models');
        const body = h(
            'div',
            { class: 'ai-settings' },
            row('API key', h('div', { class: 'inline' }, key, show)),
            row('', remember.el),
            row('', h('div', { class: 'inline' }, button('Connect with OpenRouter', () => void startOAuth(), 'small', 'link'), h('a', { class: 'small', text: 'Get a key', attrs: { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener' } }))),
            row('Model', h('div', { class: 'inline' }, modelInput, refresh)),
            row('', modelInfo),
            datalist,
            row('Temperature', temperature.el),
            row('Max steps', steps.el, 'Model calls per request'),
            row('', allowPlay.el),
            row('', shots.el),
            h('p', { class: 'muted small', text: 'Messages, tool results (scene data, code) and screenshots are sent to OpenRouter and the model provider you choose. The key is stored in this browser only.' }),
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
        });
        aiSettings.setKey(key.value);
    }
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

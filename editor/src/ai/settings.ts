import { Emitter } from '../core/events';

export interface AISettings {
    model: string;
    temperature: number;
    /** Upper bound of model calls per request. */
    maxSteps: number;
    /** Keep the key in localStorage (otherwise only for this tab). */
    remember: boolean;
    /** The assistant may run the scene in Play mode to test scripts. */
    allowPlay: boolean;
    /** Send viewport screenshots to models that accept images. */
    screenshots: boolean;
}

const SETTINGS_KEY = 'canonical-editor/ai';
const API_KEY = 'canonical-editor/openrouter-key';

function defaults(): AISettings {
    return { model: '', temperature: 0.3, maxSteps: 24, remember: true, allowPlay: true, screenshots: true };
}

/** AI settings and the OpenRouter key, kept in this browser only. */
class SettingsStore extends Emitter<{ change: AISettings }> {
    value: AISettings = defaults();
    private key = '';

    constructor() {
        super();
        try {
            this.value = { ...defaults(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
        } catch { /* ignore */ }
        try {
            this.key = localStorage.getItem(API_KEY) || sessionStorage.getItem(API_KEY) || '';
        } catch { /* ignore */ }
    }

    get apiKey(): string {
        return this.key;
    }

    set(patch: Partial<AISettings>) {
        this.value = { ...this.value, ...patch };
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.value));
        } catch { /* ignore */ }
        if (patch.remember !== undefined) this.storeKey();
        this.emit('change', this.value);
    }

    setKey(key: string) {
        this.key = key.trim();
        this.storeKey();
        this.emit('change', this.value);
    }

    private storeKey() {
        try {
            localStorage.removeItem(API_KEY);
            sessionStorage.removeItem(API_KEY);
            if (this.key) (this.value.remember ? localStorage : sessionStorage).setItem(API_KEY, this.key);
        } catch { /* ignore */ }
    }
}

export const aiSettings = new SettingsStore();

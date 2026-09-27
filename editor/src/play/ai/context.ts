// An agent's context pool: named slots of text its models see. Recall
// services fill the slot named after them with the memory items they found;
// Model tasks with History add their lines ("Guard: Halt!"); scripts add what
// the player said (blackboard.context.add('dialogue', 'Player: Hello')). An
// Ask with Use Context sees the whole pool; a template takes {context} (every
// slot) or {context:slot} (one).

export interface ContextSlot {
    text: string;
    /** Memory item ids (Recall slots). */
    ids: string[];
    /** Vector of the recalled items, for the semantic cache (Recall slots). */
    vector: Float32Array | null;
    /** Who wrote it last: a service or node id, or "script". */
    by: string;
    /** Play time of the last write. */
    at: number;
}

/** What a slot keeps: lines added beyond it push the oldest ones out (models see a few hundred tokens). */
const SLOT_CHARS = 1200;
const SLOT_LINES = 12;
const MAX_SLOTS = 32;

export class ContextPool {
    private slots = new Map<string, ContextSlot>();
    /** Raised by every change (an Ask with Use Context treats it like a fact change). */
    version = 0;

    /** Replaces a slot's text (a Recall's items, or a script's). Returns true when it changed. */
    set(slot: string, text: string, by: string, at: number, extra: { ids?: string[]; vector?: Float32Array | null } = {}): boolean {
        const cur = this.slots.get(slot);
        const ids = extra.ids ?? [];
        if (cur && cur.text === text && cur.ids.join('\u0000') === ids.join('\u0000')) {
            cur.at = at;
            return false;
        }
        if (!cur && this.slots.size >= MAX_SLOTS) return false;
        this.slots.set(slot, { text, ids, vector: extra.vector ?? null, by, at });
        this.version++;
        return true;
    }

    /** Adds a line to a slot (a dialogue); the oldest lines go when it gets long. */
    add(slot: string, line: string, by: string, at: number) {
        const clean = line.replace(/\s+/g, ' ').trim();
        if (!clean) return;
        const lines = [...(this.slots.get(slot)?.text.split('\n').filter(Boolean) ?? []), clean].slice(-SLOT_LINES);
        while (lines.length > 1 && lines.join('\n').length > SLOT_CHARS) lines.shift();
        this.set(slot, lines.join('\n').slice(-SLOT_CHARS), by, at);
    }

    /** Empties one slot, or every slot. */
    clear(slot?: string) {
        const had = slot === undefined ? this.slots.size > 0 : this.slots.has(slot);
        if (slot === undefined) this.slots.clear();
        else this.slots.delete(slot);
        if (had) this.version++;
    }

    get(slot: string): ContextSlot | undefined {
        return this.slots.get(slot);
    }

    get names(): string[] {
        return Array.from(this.slots.keys());
    }

    /** The whole pool, or one slot, as the models see it; `max`: only its newest characters (whole lines). */
    text(slot?: string, max = Infinity): string {
        const text = slot !== undefined ? this.slots.get(slot)?.text ?? '' : Array.from(this.slots.values(), (s) => s.text).filter(Boolean).join('\n');
        if (text.length <= max) return text;
        const cut = text.indexOf('\n', text.length - max);
        return cut < 0 ? text.slice(-max) : text.slice(cut + 1);
    }

    /** What the pool (or some slots of it) held, for the decision log: memory item ids, and the names of other slots. */
    sources(only?: string[]): string[] {
        const out: string[] = [];
        for (const [name, s] of this.slots) if (s.text && (!only || only.includes(name))) out.push(...(s.ids.length ? s.ids : [name]));
        return out;
    }

    /** A vector for the semantic cache: only when the pool is one Recall's items (other text has none). */
    vector(): Float32Array | null {
        const filled = Array.from(this.slots.values()).filter((s) => s.text);
        return filled.length === 1 ? filled[0].vector : null;
    }
}

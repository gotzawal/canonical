// The memory index behind Recall and Ask's memory choices. Items of the scene
// (planning notes and lore, embedded in the editor and stored as int8
// vectors) plus memories scripts add while playing, which go into saves.
//
// A search filters by tags, takes the top k by cosine similarity, and a
// context is assembled from the hits in id order within a token budget, so
// the same hits always give the same text (and the same cache key). Without
// vectors (no embedding model yet) it ranks by shared words instead.

import type { MemoryDoc, MemoryItemDoc } from '../../core/types';

export interface MemoryEntry {
    id: string;
    text: string;
    tags: string[];
    /** Embedding (int8 from the scene, float for play memories), or null. */
    vector: Int8Array | Float32Array | null;
    norm: number;
    /** Added while playing (saveMemories() puts it into a game save). */
    play: boolean;
}

export interface MemoryHit {
    entry: MemoryEntry;
    score: number;
}

/** A context for Ask: memory item ids, their text and a vector for the semantic cache. */
export interface RecallContext {
    ids: string[];
    text: string;
    vector: Float32Array | null;
    /** Play time it was made. */
    at: number;
    /** The Recall service that made it. */
    by: string;
}

// ---------------------------------------------------------------- vectors

export function decodeVector(b64: string): Int8Array {
    const bin = atob(b64);
    const out = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
    return out;
}

/** int8 with the vector's largest component at 127 (cosine does not depend on the scale). */
export function encodeVector(v: ArrayLike<number>): string {
    let max = 0;
    for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
    const k = max > 0 ? 127 / max : 0;
    let bin = '';
    for (let i = 0; i < v.length; i++) bin += String.fromCharCode(Math.round(v[i] * k) & 0xff);
    return btoa(bin);
}

export function norm(v: ArrayLike<number>): number {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>, na = norm(a), nb = norm(b)): number {
    if (!na || !nb || a.length !== b.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s / (na * nb);
}

/** Rough token count (about 4 characters per token for words, one per CJK or Hangul character). */
export function estimateTokens(text: string): number {
    let n = 0;
    for (const w of text.split(/\s+/)) {
        if (!w) continue;
        const wide = (w.match(/[ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
        n += wide + Math.ceil((w.length - wide) / 4);
    }
    return n;
}

function words(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter((w) => w.length > 1),
    );
}

// ------------------------------------------------------------------ index

export class MemoryIndex {
    readonly entries: MemoryEntry[] = [];
    private wordCache = new Map<MemoryEntry, Set<string>>();

    constructor(readonly doc: MemoryDoc) {
        for (const it of doc.items) {
            const vector = it.vector ? decodeVector(it.vector) : null;
            this.entries.push({ id: it.id, text: it.text, tags: it.tags, vector, norm: vector ? norm(vector) : 0, play: false });
        }
    }

    get embedder(): string {
        return this.doc.embedder;
    }

    /** True when at least one item has a vector. */
    get embedded(): boolean {
        return this.entries.some((e) => e.vector);
    }

    get(id: string): MemoryEntry | undefined {
        return this.entries.find((e) => e.id === id);
    }

    /** Adds a memory while playing; `vector` comes from the embedding model when it is loaded (or from a save). */
    add(item: { id?: string; text: string; tags?: string[] }, vector: Int8Array | Float32Array | null): MemoryEntry {
        const base = item.id || `memory_${this.entries.length + 1}`;
        let id = base;
        for (let i = 2; this.get(id); i++) id = `${base}_${i}`;
        const entry: MemoryEntry = { id, text: item.text, tags: item.tags ?? [], vector, norm: vector ? norm(vector) : 0, play: true };
        this.entries.push(entry);
        this.wordCache.delete(entry);
        return entry;
    }

    /** Memories added while playing, as items for a save (vectors as int8, like the scene's). */
    playItems(): MemoryItemDoc[] {
        return this.entries.filter((e) => e.play).map((e) => ({ id: e.id, text: e.text, tags: e.tags.slice(), ...(e.vector ? { vector: encodeVector(e.vector) } : {}) }));
    }

    /** Drops the memories added while playing (before a save is loaded). */
    clearPlay() {
        for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].play) this.entries.splice(i, 1);
    }

    /** Items with one of the tags (all without tags), best matches first. */
    search(query: { vector: Float32Array | null; text: string }, tags: string[], count: number): MemoryHit[] {
        const pool = tags.length ? this.entries.filter((e) => e.tags.some((t) => tags.includes(t))) : this.entries;
        const qn = query.vector ? norm(query.vector) : 0;
        const qw = words(query.text);
        const hits: MemoryHit[] = [];
        for (const e of pool) {
            let score: number;
            if (query.vector && e.vector && e.vector.length === query.vector.length) score = cosine(query.vector, e.vector, qn, e.norm);
            else {
                let ew = this.wordCache.get(e);
                if (!ew) this.wordCache.set(e, (ew = words(e.text)));
                let shared = 0;
                for (const w of qw) if (ew.has(w)) shared++;
                score = qw.size && ew.size ? shared / Math.sqrt(qw.size * ew.size) : 0;
                // Without vectors a vectorless match ranks below any vector match.
                if (query.vector) score -= 1;
            }
            hits.push({ entry: e, score });
        }
        hits.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1));
        return hits.slice(0, Math.max(0, count));
    }

    /** The best hits that fit the budget, joined in id order, with their mean vector. */
    assemble(hits: MemoryHit[], tokenBudget: number, at: number, by: string): RecallContext {
        const chosen: MemoryEntry[] = [];
        let used = 0;
        for (const h of hits) {
            const cost = estimateTokens(h.entry.text) + 2;
            if (used + cost > tokenBudget) continue;
            chosen.push(h.entry);
            used += cost;
        }
        chosen.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        let vector: Float32Array | null = null;
        const withVec = chosen.filter((e) => e.vector);
        if (withVec.length) {
            vector = new Float32Array(withVec[0].vector!.length);
            for (const e of withVec) {
                if (e.vector!.length !== vector.length) continue;
                for (let i = 0; i < vector.length; i++) vector[i] += e.vector![i] / (e.norm || 1);
            }
        }
        return { ids: chosen.map((e) => e.id), text: chosen.map((e) => e.text).join('\n'), vector, at, by };
    }
}

// Keeps the compressed copies (KTX2) of the textures a scene uses. The
// scene shows a copy as soon as it exists (SceneSync asks through
// TextureSource); missing copies are made in the background while editing
// (Prefs.backgroundCompression) and by builds; changed options or a
// replaced file make them again. Copies never enter the document, only
// the user's options do (AssetMeta.compress).

import { getAssetBlob } from '../core/assets';
import { derivedKey, derivedOptions, ENCODER_VERSION, getDerived, isFresh, putDerived, type DerivedRecord } from '../core/derived';
import { Emitter } from '../core/events';
import type { Store } from '../core/store';
import type { AssetMeta, TextureRole } from '../core/types';
import type { TextureSource } from '../engine/sync';
import { DeriveQueue, PRIORITY, type WorkerLike } from './queue';

export type DerivedState = 'off' | 'none' | 'queued' | 'encoding' | 'ready' | 'failed';

/** Where a texture's copy for one role stands. */
export interface DerivedStatus {
    state: DerivedState;
    /** The copy, when ready. */
    copy?: Pick<DerivedRecord, 'bytes' | 'width' | 'height' | 'levels' | 'alpha' | 'opts'>;
    error?: string;
}

const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];

async function isKTX2File(blob: Blob): Promise<boolean> {
    const head = new Uint8Array(await blob.slice(0, KTX2_MAGIC.length).arrayBuffer());
    return KTX2_MAGIC.every((b, i) => head[i] === b);
}

const copyOf = (r: DerivedRecord): DerivedStatus['copy'] => ({ bytes: r.bytes, width: r.width, height: r.height, levels: r.levels, alpha: r.alpha, opts: r.opts });

export class DerivedAssets extends Emitter<{ status: string }> implements TextureSource {
    readonly queue: DeriveQueue;
    private states = new Map<string, DerivedStatus>();
    private options = new Map<string, string>();
    private refresh: ((asset: string, role?: TextureRole) => void) | null = null;

    constructor(private store: Store, makeWorker: () => WorkerLike, wasmUrl: string, workers = 1) {
        super();
        this.queue = new DeriveQueue(makeWorker, wasmUrl, { workers });
        // Play gets the CPU; encoding goes on after Stop.
        this.queue.pause(store.playing);
        store.on('playing', (p) => this.queue.pause(p));
        store.on('change', (hint) => {
            if (hint && (hint.nodes || hint.env || hint.behavior)) return;
            this.optionsChanged();
        });
        store.on('load', () => {
            this.states.clear();
            this.options.clear();
            this.optionsChanged();
        });
        this.queue.on('change', () => this.queueChanged());
        this.optionsChanged();
    }

    /** SceneSync.refreshTexture: shows a texture again when its copy comes or goes. */
    onRefresh(fn: (asset: string, role?: TextureRole) => void) {
        this.refresh = fn;
    }

    /** Copies being made or waiting. */
    get pending(): number {
        return this.queue.size;
    }

    async resolve(meta: AssetMeta, role: TextureRole): Promise<Blob | null> {
        const opts = derivedOptions(role, meta.compress);
        if (!opts) return null;
        const rec = await getDerived(derivedKey(meta.id, role));
        if (!isFresh(rec, meta, opts)) return null;
        this.set(meta.id, role, { state: 'ready', copy: copyOf(rec) });
        return rec.blob;
    }

    used(meta: AssetMeta, role: TextureRole) {
        if (!this.store.prefs.backgroundCompression) return;
        this.make(meta, role, PRIORITY.view).catch(() => {});
    }

    /** The copy of a texture for a role, made now if missing (builds); null when it ships as it is or failed. */
    ensure(meta: AssetMeta, role: TextureRole, signal?: AbortSignal): Promise<DerivedRecord | null> {
        return this.make(meta, role, PRIORITY.build, signal);
    }

    /** Where a texture's copy for a role stands, as far as this session knows. */
    statusOf(meta: AssetMeta, role: TextureRole): DerivedStatus {
        if (!derivedOptions(role, meta.compress)) return { state: 'off' };
        return this.states.get(derivedKey(meta.id, role)) ?? { state: 'none' };
    }

    /** Looks the copy up in storage (for a panel opening), then reports it with statusOf. */
    async check(meta: AssetMeta, role: TextureRole): Promise<DerivedStatus> {
        const known = this.statusOf(meta, role);
        if (known.state !== 'none') return known;
        await this.resolve(meta, role);
        return this.statusOf(meta, role);
    }

    /** Forgets what this session knew about an asset's copies (its file was replaced). */
    forget(asset: string) {
        for (const key of Array.from(this.states.keys())) if (key.startsWith(asset + '|')) this.states.delete(key);
        this.emit('status', asset);
    }

    dispose() {
        this.queue.dispose();
    }

    private async make(meta: AssetMeta, role: TextureRole, priority: number, signal?: AbortSignal): Promise<DerivedRecord | null> {
        const opts = derivedOptions(role, meta.compress);
        if (!opts || meta.kind !== 'texture') return null;
        const key = derivedKey(meta.id, role);
        const have = await getDerived(key);
        if (isFresh(have, meta, opts)) {
            this.set(meta.id, role, { state: 'ready', copy: copyOf(have) });
            return have;
        }
        const blob = await getAssetBlob(meta.id);
        // Not in this browser, or already a KTX2 file: it ships as it is.
        if (!blob || (await isKTX2File(blob))) return null;
        const current = this.states.get(key)?.state;
        if (current !== 'queued' && current !== 'encoding') this.set(meta.id, role, { state: 'queued' });
        try {
            const out = await this.queue.run(key, { blob, role, opts }, priority, signal);
            const now = Date.now();
            const rec: DerivedRecord = {
                key,
                asset: meta.id,
                role,
                encoder: ENCODER_VERSION,
                src: { size: blob.size, ...(meta.hash ? { hash: meta.hash } : {}) },
                opts,
                blob: new Blob([out.data], { type: 'image/ktx2' }),
                bytes: out.data.byteLength,
                width: out.width,
                height: out.height,
                levels: out.levels,
                alpha: out.alpha,
                made: now,
                used: now,
            };
            await putDerived(rec);
            // Options changed while it was made: this copy is not the one wanted.
            const latest = this.store.doc.assets.find((a) => a.id === meta.id);
            if (!latest || !isFresh(rec, latest, derivedOptions(role, latest.compress) ?? opts)) {
                this.set(meta.id, role, { state: 'none' });
                return null;
            }
            this.set(meta.id, role, { state: 'ready', copy: copyOf(rec) });
            this.refresh?.(meta.id, role);
            return rec;
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                this.set(meta.id, role, { state: 'none' });
                throw e;
            }
            console.warn(`[editor] could not compress "${meta.name}"`, e);
            this.set(meta.id, role, { state: 'failed', error: String(e?.message || e) });
            return null;
        }
    }

    private set(asset: string, role: TextureRole, status: DerivedStatus) {
        this.states.set(derivedKey(asset, role), status);
        this.emit('status', asset);
    }

    /** Waiting copies that started encoding. */
    private queueChanged() {
        for (const [key, s] of this.states) {
            if (s.state === 'queued' && this.queue.running(key)) {
                this.states.set(key, { state: 'encoding' });
                this.emit('status', key.split('|')[0]);
            }
        }
    }

    /** Textures whose options changed are shown again: with their copy for the new options, or the original until it is made. */
    private optionsChanged() {
        const seen = new Set<string>();
        for (const a of this.store.doc.assets) {
            if (a.kind !== 'texture') continue;
            seen.add(a.id);
            const json = JSON.stringify(a.compress ?? {});
            const before = this.options.get(a.id);
            this.options.set(a.id, json);
            if (before === undefined || before === json) continue;
            this.forget(a.id);
            this.refresh?.(a.id);
        }
        for (const id of Array.from(this.options.keys())) if (!seen.has(id)) this.options.delete(id);
    }
}

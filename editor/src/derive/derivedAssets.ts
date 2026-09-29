// Keeps the compressed copies of the textures (KTX2) and models (GLB with
// KTX2 textures and meshopt geometry) a scene uses. The editor's view shows
// a texture's copy as soon as it exists (SceneSync asks through
// TextureSource); models show their file, their copies are for games.
// Missing copies are made in the background while editing
// (Prefs.backgroundCompression) and by builds; changed options or a
// replaced file make them again. Copies never enter the document, only
// the user's options do (AssetMeta.compress).

import { getAssetBlob } from '../core/assets';
import {
    derivedKey, derivedOptions, ENCODER_VERSION, getDerived, isFresh, putDerived, shipsAsIs, type DerivedOptions, type DerivedRecord, type DerivedRole,
} from '../core/derived';
import { Emitter } from '../core/events';
import type { Store } from '../core/store';
import type { AssetMeta, TextureRole } from '../core/types';
import { gltfExtensions } from '../build/modelInfo';
import type { TextureSource } from '../engine/sync';
import { DeriveQueue, PRIORITY, type WorkerLike } from './queue';

export type DerivedState = 'off' | 'none' | 'queued' | 'encoding' | 'ready' | 'failed';

/** Where a texture's copy for one role (or a model's copy) stands. */
export interface DerivedStatus {
    state: DerivedState;
    /** The copy, when ready. */
    copy?: Pick<DerivedRecord, 'bytes' | 'width' | 'height' | 'levels' | 'alpha' | 'opts' | 'textures'>;
    error?: string;
}

const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];

async function isKTX2File(blob: Blob): Promise<boolean> {
    const head = new Uint8Array(await blob.slice(0, KTX2_MAGIC.length).arrayBuffer());
    return KTX2_MAGIC.every((b, i) => head[i] === b);
}

/** Draco models are small already; packing them would mean decoding them. */
async function isDracoModel(blob: Blob): Promise<boolean> {
    return !!(await gltfExtensions(blob))?.includes('KHR_draco_mesh_compression');
}

const copyOf = (r: DerivedRecord): DerivedStatus['copy'] => ({ bytes: r.bytes, width: r.width, height: r.height, levels: r.levels, alpha: r.alpha, opts: r.opts, textures: r.textures });

/** The asset kind a copy for a role is made from. */
const kindFor = (role: DerivedRole) => (role === 'model' ? 'model' : 'texture');

/**
 * The encoding job of a copy: one per file and options, so a job for other
 * options or for a replaced file is never shared (its copy is not the one
 * wanted).
 */
function jobKey(key: string, src: DerivedRecord['src'], opts: DerivedOptions): string {
    return `${key}|${opts.codec}|${opts.maxSize}|${src.size}|${src.hash ?? ''}`;
}

export class DerivedAssets extends Emitter<{ status: string }> implements TextureSource {
    readonly queue: DeriveQueue;
    private states = new Map<string, DerivedStatus>();
    private options = new Map<string, string>();
    private refresh: ((asset: string, role?: TextureRole) => void) | null = null;
    /** Stops the background jobs of an asset once it leaves the document (removed, or another project opened). */
    private stops = new Map<string, AbortController>();

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
        // Assets kept under the same id whose options differ in the new document show again.
        store.on('load', () => {
            this.states.clear();
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

    /** Model copies among them. */
    get pendingModels(): number {
        return this.queue.keys().filter((key) => key.split('|')[1] === 'model').length;
    }

    async resolve(meta: AssetMeta, role: TextureRole): Promise<Blob | null> {
        const opts = derivedOptions(role, meta.compress);
        if (!opts) return null;
        const rec = await getDerived(derivedKey(meta.id, role));
        if (!isFresh(rec, meta, opts)) return null;
        this.set(meta.id, role, { state: 'ready', copy: copyOf(rec) });
        return rec.blob;
    }

    /** A texture (for a role) or model is shown: its copy is made in the background when missing. */
    used(meta: AssetMeta, role: DerivedRole) {
        if (!this.store.prefs.backgroundCompression) return;
        // Models come after the textures the view shows.
        this.make(meta, role, role === 'model' ? PRIORITY.background : PRIORITY.view).catch(() => {});
    }

    /** The copy of a texture for a role (or of a model), made now if missing (builds); null when it ships as it is or failed. */
    ensure(meta: AssetMeta, role: DerivedRole, signal?: AbortSignal): Promise<DerivedRecord | null> {
        return this.make(meta, role, PRIORITY.build, signal);
    }

    /** Where a copy stands, as far as this session knows ('off' also for KTX2 files, which ship as they are). */
    statusOf(meta: AssetMeta, role: DerivedRole): DerivedStatus {
        if (!derivedOptions(role, meta.compress) || shipsAsIs(meta)) return { state: 'off' };
        return this.states.get(derivedKey(meta.id, role)) ?? { state: 'none' };
    }

    /** Looks the copy up in storage (for a panel opening), then reports it with statusOf. */
    async check(meta: AssetMeta, role: DerivedRole): Promise<DerivedStatus> {
        const known = this.statusOf(meta, role);
        if (known.state !== 'none') return known;
        const opts = derivedOptions(role, meta.compress);
        const rec = opts && (await getDerived(derivedKey(meta.id, role)));
        if (opts && isFresh(rec, meta, opts)) this.set(meta.id, role, { state: 'ready', copy: copyOf(rec) });
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

    private async make(meta: AssetMeta, role: DerivedRole, priority: number, signal?: AbortSignal): Promise<DerivedRecord | null> {
        const opts = derivedOptions(role, meta.compress);
        if (!opts || meta.kind !== kindFor(role) || shipsAsIs(meta)) return null;
        const key = derivedKey(meta.id, role);
        const have = await getDerived(key);
        if (isFresh(have, meta, opts)) {
            this.set(meta.id, role, { state: 'ready', copy: copyOf(have) });
            return have;
        }
        const blob = await getAssetBlob(meta.id);
        // Not in this browser, or compressed already (a KTX2 file, a Draco model): it ships as it is.
        if (!blob || (role === 'model' ? await isDracoModel(blob) : await isKTX2File(blob))) return null;
        const src = { size: blob.size, ...(meta.hash ? { hash: meta.hash } : {}) };
        const current = this.states.get(key)?.state;
        if (current !== 'queued' && current !== 'encoding') this.set(meta.id, role, { state: 'queued' });
        // Builds wait with their own signal; the view's and background jobs go with the asset.
        const stop = signal ?? (priority === PRIORITY.build ? undefined : this.stopOf(meta.id));
        try {
            const out = await this.queue.run(jobKey(key, src, opts), { blob, role, opts }, priority, stop);
            const now = Date.now();
            const rec: DerivedRecord = {
                key,
                asset: meta.id,
                role,
                encoder: ENCODER_VERSION,
                src,
                opts,
                blob: new Blob([out.data], { type: role === 'model' ? 'model/gltf-binary' : 'image/ktx2' }),
                bytes: out.data.byteLength,
                width: out.width,
                height: out.height,
                levels: out.levels,
                alpha: out.alpha,
                ...(out.textures === undefined ? {} : { textures: out.textures }),
                made: now,
                used: now,
            };
            // The asset as it is now: options changed, the file replaced or the asset gone while it was made.
            const latest = this.store.doc.assets.find((a) => a.id === meta.id);
            const wanted = latest && derivedOptions(role, latest.compress);
            if (!latest || !wanted || !isFresh(rec, latest, wanted)) {
                // Not the copy wanted: it replaces nothing stored.
                await this.settle(latest ?? null, role);
                return null;
            }
            await putDerived(rec);
            this.set(meta.id, role, { state: 'ready', copy: copyOf(rec) });
            // The view shows models from their files.
            if (role !== 'model') this.refresh?.(meta.id, role);
            return rec;
        } catch (e: any) {
            const latest = this.store.doc.assets.find((a) => a.id === meta.id) ?? null;
            const wanted = latest && derivedOptions(role, latest.compress);
            const stale = !latest || !wanted || jobKey(key, { size: latest.size, ...(latest.hash ? { hash: latest.hash } : {}) }, wanted) !== jobKey(key, src, opts);
            if (e?.name === 'AbortError' || stale) {
                await this.settle(latest, role);
                if (e?.name === 'AbortError') throw e;
                return null;
            }
            console.warn(`[editor] could not compress "${meta.name}"`, e);
            this.set(meta.id, role, { state: 'failed', error: String(e?.message || e) });
            return null;
        }
    }

    /** The signal that stops an asset's background jobs. */
    private stopOf(asset: string): AbortSignal {
        let c = this.stops.get(asset);
        if (!c) {
            c = new AbortController();
            this.stops.set(asset, c);
        }
        return c.signal;
    }

    /**
     * The state of a copy after a job ended that was not for the asset as it
     * is now: ready when the stored copy fits it, waiting while a job for it
     * is queued, else none.
     */
    private async settle(meta: AssetMeta | null, role: DerivedRole) {
        if (!meta) return;
        const key = derivedKey(meta.id, role);
        const opts = derivedOptions(role, meta.compress);
        const rec = opts ? await getDerived(key) : null;
        if (opts && isFresh(rec, meta, opts)) return this.set(meta.id, role, { state: 'ready', copy: copyOf(rec) });
        const jobs = this.queue.keys().filter((k) => k.startsWith(key + '|'));
        if (jobs.length) return this.set(meta.id, role, { state: jobs.some((k) => this.queue.running(k)) ? 'encoding' : 'queued' });
        this.set(meta.id, role, { state: 'none' });
    }

    private set(asset: string, role: DerivedRole, status: DerivedStatus) {
        this.states.set(derivedKey(asset, role), status);
        this.emit('status', asset);
    }

    /** Waiting copies that started encoding. */
    private queueChanged() {
        const running = this.queue.keys().filter((k) => this.queue.running(k));
        for (const [key, s] of this.states) {
            if (s.state === 'queued' && running.some((k) => k.startsWith(key + '|'))) {
                this.states.set(key, { state: 'encoding' });
                this.emit('status', key.split('|')[0]);
            }
        }
    }

    /**
     * Assets whose options changed forget their copies' state; textures are
     * shown again, with their copy for the new options or the file until it
     * is made.
     */
    private optionsChanged() {
        const seen = new Set<string>();
        for (const a of this.store.doc.assets) {
            if (a.kind !== 'texture' && a.kind !== 'model') continue;
            seen.add(a.id);
            const json = JSON.stringify(a.compress ?? {});
            const before = this.options.get(a.id);
            this.options.set(a.id, json);
            if (before === undefined || before === json) continue;
            this.forget(a.id);
            this.refresh?.(a.id);
        }
        for (const id of Array.from(this.options.keys())) if (!seen.has(id)) this.options.delete(id);
        // Background jobs of assets that left the document stop (a build waiting on one keeps it).
        for (const [id, c] of Array.from(this.stops)) {
            if (seen.has(id)) continue;
            c.abort();
            this.stops.delete(id);
        }
    }
}

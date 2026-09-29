// Compressed copies of texture assets (KTX2), made in the background by the
// encoder (derive/) and shipped with games in place of the originals. They
// can always be made again, so they live apart from the imported files, in
// a database of their own the browser may clear, and never in the document
// (which only holds the user's options, AssetMeta.compress).

import type { AssetMeta, TextureCompression, TextureRole } from './types';

/** The encoder and how options map to it: a new value makes every copy again. */
export const ENCODER_VERSION = 'basisu-2.5.1';

/** Longest side of a compressed copy unless the asset asks for another. */
export const DEFAULT_MAX_SIZE = 2048;

/** Longest sides the options offer. */
export const MAX_SIZES = [4096, 2048, 1024, 512, 256] as const;

/** What a copy is encoded with. */
export interface DerivedOptions {
    /** ETC1S: small, for colors. UASTC (with Zstandard): larger, near the original, for normal and data maps. */
    codec: 'etc1s' | 'uastc';
    maxSize: number;
}

export interface DerivedRecord {
    /** `${asset}|${role}|${encoder}` (derivedKey). */
    key: string;
    asset: string;
    role: TextureRole;
    encoder: string;
    /** The file it was made from (a replaced file makes it stale). */
    src: { size: number; hash?: string };
    opts: DerivedOptions;
    /** The KTX2 file. */
    blob: Blob;
    bytes: number;
    width: number;
    height: number;
    levels: number;
    alpha: boolean;
    /** When it was made and last used (ms since epoch), for evicting old copies. */
    made: number;
    used: number;
}

export function derivedKey(asset: string, role: TextureRole): string {
    return `${asset}|${role}|${ENCODER_VERSION}`;
}

/** The encoding a texture of this role gets with these options; null when it ships as it is. */
export function derivedOptions(role: TextureRole, c?: TextureCompression | null): DerivedOptions | null {
    const mode = c?.mode ?? 'auto';
    if (mode === 'off') return null;
    const maxSize = c?.maxSize && c.maxSize > 0 ? Math.round(c.maxSize) : DEFAULT_MAX_SIZE;
    return { codec: mode === 'high' || role !== 'color' ? 'uastc' : 'etc1s', maxSize };
}

/** True when a copy was made from this file (its size, and fingerprint where both have one) with these options by this encoder. */
export function isFresh(rec: DerivedRecord | null | undefined, meta: Pick<AssetMeta, 'size' | 'hash'>, opts: DerivedOptions): rec is DerivedRecord {
    if (!rec || rec.encoder !== ENCODER_VERSION || rec.src.size !== meta.size) return false;
    if (rec.src.hash && meta.hash && rec.src.hash !== meta.hash) return false;
    return rec.opts.codec === opts.codec && rec.opts.maxSize === opts.maxSize;
}

// ------------------------------------------------------------------ storage

const DB_NAME = 'canonical-editor-derived';
const STORE = 'derived';

let dbPromise: Promise<IDBDatabase> | null = null;
/** Copies IndexedDB could not keep (unavailable, or full), for this session. */
const memory = new Map<string, DerivedRecord>();
/** Keys whose last use was already written this session. */
const touched = new Set<string>();

function openDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no IndexedDB'));
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('asset', 'asset');
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                resolve(db);
            };
            req.onerror = () => reject(req.error);
        });
        dbPromise.catch(() => (dbPromise = null));
    }
    return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    return openDb().then(
        (db) =>
            new Promise<T | undefined>((resolve, reject) => {
                const t = db.transaction(STORE, mode);
                const req = fn(t.objectStore(STORE));
                t.oncomplete = () => resolve(req ? req.result : undefined);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            }),
    );
}

export async function getDerived(key: string): Promise<DerivedRecord | null> {
    const kept = memory.get(key);
    if (kept) return kept;
    try {
        const rec = (await run<DerivedRecord>('readonly', (s) => s.get(key))) ?? null;
        if (rec && !touched.has(key)) {
            touched.add(key);
            rec.used = Date.now();
            void run('readwrite', (s) => s.put(rec)).catch(() => {});
        }
        return rec;
    } catch {
        return null;
    }
}

/** Keeps a copy; false when the browser refused to store it (it stays in memory this session). */
export async function putDerived(rec: DerivedRecord): Promise<boolean> {
    try {
        await run('readwrite', (s) => s.put(rec));
        memory.delete(rec.key);
        return true;
    } catch (e: any) {
        // Full: make room from the oldest copies once, then give up.
        if (e?.name === 'QuotaExceededError' && (await evictDerived(rec.bytes)) > 0) {
            try {
                await run('readwrite', (s) => s.put(rec));
                return true;
            } catch { /* kept in memory below */ }
        }
        memory.set(rec.key, rec);
        return false;
    }
}

async function all(): Promise<DerivedRecord[]> {
    try {
        return ((await run<DerivedRecord[]>('readonly', (s) => s.getAll())) ?? []).concat(Array.from(memory.values()));
    } catch {
        return Array.from(memory.values());
    }
}

async function remove(keys: string[]): Promise<void> {
    for (const k of keys) memory.delete(k);
    if (!keys.length) return;
    try {
        await run('readwrite', (s) => {
            for (const k of keys) s.delete(k);
        });
    } catch { /* nothing kept to remove */ }
}

/** Drops the copies of these assets (their files were replaced or deleted). */
export async function deleteDerivedOf(assets: string[]): Promise<void> {
    await remove(assets.flatMap((a) => (['color', 'normal', 'data'] as const).map((r) => derivedKey(a, r))));
}

/** Drops copies of assets not in `keep`, and those of other encoders. Resolves with how many went. */
export async function gcDerived(keep: Set<string>): Promise<number> {
    const stale = (await all()).filter((r) => !keep.has(r.asset) || r.encoder !== ENCODER_VERSION).map((r) => r.key);
    await remove(stale);
    return stale.length;
}

/** Frees at least `bytes` by dropping the copies used longest ago. Resolves with the bytes freed. */
export async function evictDerived(bytes: number): Promise<number> {
    let freed = 0;
    const drop: string[] = [];
    for (const r of (await all()).sort((a, b) => a.used - b.used)) {
        if (freed >= bytes) break;
        drop.push(r.key);
        freed += r.bytes;
    }
    await remove(drop);
    return freed;
}

/** The copy of a texture already made in this browser for its options, if any (previews of the editor's scene). */
export async function storedCopy(meta: AssetMeta, role: TextureRole): Promise<Blob | null> {
    const opts = derivedOptions(role, meta.compress);
    if (!opts) return null;
    const rec = await getDerived(derivedKey(meta.id, role));
    return isFresh(rec, meta, opts) ? rec.blob : null;
}

/** How many copies there are and their size. */
export async function derivedUsage(): Promise<{ count: number; bytes: number }> {
    const list = await all();
    return { count: list.length, bytes: list.reduce((n, r) => n + r.bytes, 0) };
}

// Imported files (models, textures) live in IndexedDB so a project survives
// reloads without any server. Scenes reference them by asset id.

import { uid } from './defaults';
import type { AssetKind, AssetMeta } from './types';

const DB_NAME = 'canonical-editor';
const STORE = 'assets';

interface AssetRecord extends AssetMeta {
    blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        dbPromise.catch(() => (dbPromise = null));
    }
    return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const t = db.transaction(STORE, mode);
                const req = run(t.objectStore(STORE));
                t.oncomplete = () => resolve(req.result);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            }),
    );
}

/** In-memory fallback when IndexedDB is unavailable (private windows etc). */
const memory = new Map<string, AssetRecord>();
const urls = new Map<string, string>();

/**
 * Where asset files come from when not from this browser's IndexedDB: a
 * built game (see player/main.ts) serves them as files next to the page.
 */
let resolver: ((meta: AssetMeta) => string | null) | null = null;

export function setAssetResolver(fn: ((meta: AssetMeta) => string | null) | null) {
    resolver = fn;
}

export function kindOf(file: { name: string; type: string }): AssetKind | null {
    const name = file.name.toLowerCase();
    if (name.endsWith('.glb') || name.endsWith('.gltf')) return 'model';
    if (/\.(png|jpe?g|webp|gif|bmp|avif)$/.test(name) || file.type.startsWith('image/')) return 'texture';
    return null;
}

export async function putAsset(blob: Blob, name: string, kind: AssetKind, id = uid('a')): Promise<AssetMeta> {
    const meta: AssetMeta = { id, name, kind, mime: blob.type || guessMime(name), size: blob.size };
    const record: AssetRecord = { ...meta, blob };
    memory.set(id, record);
    try {
        await tx('readwrite', (s) => s.put(record));
    } catch (e) {
        console.warn('[editor] IndexedDB unavailable, asset kept in memory only', e);
    }
    return meta;
}

export async function getAssetBlob(id: string): Promise<Blob | null> {
    const cached = memory.get(id);
    if (cached) return cached.blob;
    try {
        const rec = (await tx('readonly', (s) => s.get(id))) as AssetRecord | undefined;
        if (rec) {
            memory.set(id, rec);
            return rec.blob;
        }
    } catch (e) {
        console.warn('[editor] failed to read asset', id, e);
    }
    return null;
}

/**
 * Object URL for an asset. The engine picks the glTF parser from the URL's
 * extension, so the file name is kept in the fragment.
 */
export async function getAssetUrl(meta: AssetMeta): Promise<string | null> {
    if (resolver) return resolver(meta);
    const existing = urls.get(meta.id);
    if (existing) return existing;
    const blob = await getAssetBlob(meta.id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob) + '#' + encodeURIComponent(meta.name);
    urls.set(meta.id, url);
    return url;
}

export async function deleteAssets(keep: Set<string>): Promise<number> {
    let removed = 0;
    try {
        const keys = (await tx('readonly', (s) => s.getAllKeys())) as string[];
        for (const key of keys) {
            if (!keep.has(key)) {
                await tx('readwrite', (s) => s.delete(key));
                memory.delete(key);
                removed++;
            }
        }
    } catch (e) {
        console.warn('[editor] asset cleanup skipped', e);
    }
    return removed;
}

function guessMime(name: string): string {
    const n = name.toLowerCase();
    if (n.endsWith('.glb')) return 'model/gltf-binary';
    if (n.endsWith('.gltf')) return 'model/gltf+json';
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
}

export async function blobToBase64(blob: Blob): Promise<string> {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk) as unknown as number[]);
    }
    return btoa(bin);
}

export function base64ToBlob(b64: string, mime: string): Blob {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

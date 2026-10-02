// Imported files (models, textures) live in IndexedDB so a project survives
// reloads without any server. Scenes reference them by asset id.

import { tx } from './db';
import { uid } from './ids';
import type { AssetKind, AssetMeta } from './types';

interface AssetRecord extends AssetMeta {
    blob: Blob;
}

/** In-memory fallback when IndexedDB is unavailable (private windows etc). */
const memory = new Map<string, AssetRecord>();
const urls = new Map<string, string>();
/** Assets IndexedDB refused (full, or unavailable): in memory only, gone after a reload. */
const unstored = new Set<string>();

/** How many of these assets are in memory only. */
export function unstoredCount(ids: Iterable<string>): number {
    let n = 0;
    for (const id of ids) if (unstored.has(id)) n++;
    return n;
}

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
    if (/\.(png|jpe?g|webp|gif|bmp|avif|ktx2)$/.test(name) || file.type.startsWith('image/')) return 'texture';
    if (/\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|weba)$/.test(name) || file.type.startsWith('audio/')) return 'audio';
    return null;
}

/** A short fingerprint of a file's bytes (SHA-256), where the browser can make one (secure pages). */
export async function fingerprint(blob: Blob): Promise<string | undefined> {
    if (typeof crypto === 'undefined' || !crypto.subtle) return undefined;
    try {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
        return Array.from(digest.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return undefined;
    }
}

/**
 * Stores a file. Storing under an existing id replaces that asset's data
 * everywhere it is used (the scene reloads it, see SceneSync.reloadAsset).
 */
export async function putAsset(blob: Blob, name: string, kind: AssetKind, id = uid('a'), extra: Partial<AssetMeta> = {}): Promise<AssetMeta> {
    const meta: AssetMeta = { ...extra, id, name, kind, mime: blob.type || guessMime(name), size: blob.size };
    // Textures and models get a fingerprint: a compressed copy made from other bytes under this id is stale (core/derived.ts).
    if (kind === 'texture' || kind === 'model') {
        const hash = await fingerprint(blob);
        if (hash) meta.hash = hash;
    }
    // A texture's pixel size, for what it ships at and takes on the GPU.
    if (kind === 'texture' && !meta.width) {
        const size = await textureSize(blob, name).catch(() => null);
        if (size) Object.assign(meta, size);
    }
    const record: AssetRecord = { ...meta, blob };
    memory.set(id, record);
    forgetUrl(id);
    try {
        await tx('assets', 'readwrite', (s) => s.put(record));
        unstored.delete(id);
    } catch (e) {
        unstored.add(id);
        console.warn('[editor] IndexedDB unavailable, asset kept in memory only', e);
    }
    return meta;
}

/**
 * Stores a planning image (concept, paintover, capture, attachment): an
 * 'image' asset with purpose 'design' and its pixel size.
 */
export async function putDesignImage(blob: Blob, name: string, id = uid('a')): Promise<AssetMeta> {
    const size = await imageSize(blob).catch(() => null);
    return putAsset(blob, name, 'image', id, { purpose: 'design', ...(size ? { width: size.width, height: size.height } : {}) });
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
    const bmp = await createImageBitmap(blob);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
}

/** A texture file's pixel size: from the header of a KTX2 or Radiance HDR file, else by decoding the image. */
export async function textureSize(blob: Blob, name: string): Promise<{ width: number; height: number } | null> {
    if (/\.ktx2$/i.test(name)) {
        const head = new DataView(await blob.slice(0, 28).arrayBuffer());
        return head.byteLength === 28 ? { width: head.getUint32(20, true), height: Math.max(1, head.getUint32(24, true)) } : null;
    }
    if (/\.hdr$/i.test(name)) {
        // The resolution line ends the header, e.g. "-Y 512 +X 1024".
        const m = /[-+]Y (\d+) [-+]X (\d+)/.exec(await blob.slice(0, 4096).text());
        return m ? { width: Number(m[2]), height: Number(m[1]) } : null;
    }
    return imageSize(blob);
}

function forgetUrl(id: string) {
    const url = urls.get(id);
    if (!url) return;
    urls.delete(id);
    // Late enough for loads that already started from it.
    setTimeout(() => URL.revokeObjectURL(url.split('#')[0]), 30000);
}

/** data: URL of an asset (to send it to a model). */
export async function getAssetDataUrl(id: string): Promise<string | null> {
    const blob = await getAssetBlob(id);
    if (!blob) return null;
    return `data:${blob.type || 'application/octet-stream'};base64,${await blobToBase64(blob)}`;
}

export async function getAssetBlob(id: string): Promise<Blob | null> {
    const cached = memory.get(id);
    if (cached) return cached.blob;
    try {
        const rec = (await tx('assets', 'readonly', (s) => s.get(id))) as AssetRecord | undefined;
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

/** Drops the stored files not in `keep` (or what it gives right before each: files added meanwhile stay). */
export async function deleteAssets(keep: Set<string> | (() => Set<string>)): Promise<number> {
    const kept = typeof keep === 'function' ? keep : () => keep;
    let removed = 0;
    try {
        const keys = (await tx('assets', 'readonly', (s) => s.getAllKeys())) as string[];
        for (const key of keys) {
            if (!kept().has(key)) {
                await tx('assets', 'readwrite', (s) => s.delete(key));
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
    if (n.endsWith('.ktx2')) return 'image/ktx2';
    if (n.endsWith('.mp3')) return 'audio/mpeg';
    if (/\.(ogg|oga|opus)$/.test(n)) return 'audio/ogg';
    if (n.endsWith('.wav')) return 'audio/wav';
    if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4';
    if (n.endsWith('.flac')) return 'audio/flac';
    if (n.endsWith('.weba')) return 'audio/webm';
    if (n.endsWith('.json')) return 'application/json';
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

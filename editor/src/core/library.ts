// The asset library: catalogs of open-source files (models, sounds, images,
// realistic PBR materials and HDRI skies) that a project copies in when one
// is picked, so a scene never depends on a link that may go away. The editor's own catalog is library/catalog.json
// next to it: CC0 packs mirrored into the repository (editor/library, made
// by scripts/mirror-library.mjs). Other catalogs of the same format can be
// added by URL (prefs.libraryCatalogs), e.g. a mirror of one's own on GitHub.

import { kindOf } from './assets';
import type { AssetKind, AssetSource } from './types';

/**
 * model, texture (an image) and audio are copied in as assets; a material
 * (color, normal and ARM maps with its real tile size) becomes a swatch for
 * material slots; an hdri (.hdr) a sky that lights the scene.
 */
export type LibraryKind = 'model' | 'texture' | 'audio' | 'material' | 'hdri';

export const LIBRARY_KINDS: LibraryKind[] = ['model', 'material', 'hdri', 'audio', 'texture'];

export interface LibrarySource {
    id: string;
    name: string;
    author: string;
    license: string;
    licenseNote?: string;
    /** The pack's page. */
    url: string;
    /** The upstream commit the mirror copied. */
    commit?: string;
}

/** An entry of catalog.json; its paths are relative to the catalog. */
export interface LibraryItemDoc {
    id: string;
    name: string;
    kind: LibraryKind;
    file: string;
    bytes: number;
    source: string;
    tags: string[];
    /** Models: triangles, size in meters (x, y, z) as authored, animation clips, thumbnail. */
    tris?: number;
    extent?: [number, number, number];
    animations?: string[];
    thumb?: string;
    /** Sounds: length in seconds. */
    seconds?: number;
    /** Images, materials and HDRIs: width and height. */
    pixels?: [number, number];
    /** Materials: the normal (OpenGL), ARM (occlusion, roughness, metallic) and height (displacement) maps, next to the color file. */
    maps?: { normal?: string; arm?: string; height?: string };
    /** Materials: meters one tile of the texture covers in the world. */
    tile?: number;
    /** Who made it, and its page (when the pack credits each asset). */
    author?: string;
    origin?: string;
}

export interface LibraryItem extends LibraryItemDoc {
    /** The file, and its thumbnail (images are their own). */
    url: string;
    thumbUrl?: string;
    /** Materials: where their other maps are. */
    mapUrls?: { normal?: string; arm?: string; height?: string };
    /** The catalog it is from. */
    catalog: string;
    sourceInfo?: LibrarySource;
}

export interface LibraryCatalog {
    url: string;
    name: string;
    sources: LibrarySource[];
    items: LibraryItem[];
}

/** The editor's own catalog, relative to the page. */
export const BUILTIN_CATALOG = 'library/catalog.json';

/** A catalog reference (relative to the page, or a full URL) as a full URL. */
export function catalogUrl(ref: string): string {
    return new URL(ref, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/').href;
}

/** The editor's catalog first, then the ones added by URL, without repeats. */
export function catalogList(extra: readonly string[]): string[] {
    const out: string[] = [];
    for (const ref of [BUILTIN_CATALOG, ...extra]) {
        const url = catalogUrl(ref);
        if (!out.includes(url)) out.push(url);
    }
    return out;
}

const loaded = new Map<string, Promise<LibraryCatalog>>();

/** Reads a catalog (once per URL; a failed read is tried again next time). */
export function loadCatalog(ref: string): Promise<LibraryCatalog> {
    const url = catalogUrl(ref);
    let p = loaded.get(url);
    if (!p) {
        p = fetchCatalog(url);
        loaded.set(url, p);
        p.catch(() => loaded.delete(url));
    }
    return p;
}

async function fetchCatalog(url: string): Promise<LibraryCatalog> {
    let res: Response;
    try {
        res = await fetch(url, { cache: 'no-cache' });
    } catch {
        throw new Error(`The catalog ${url} could not be reached (offline, or the server does not allow other sites to read it).`);
    }
    if (!res.ok) throw new Error(`The catalog ${url} could not be read (${res.status} ${res.statusText}).`);
    const raw = (await res.json().catch(() => null)) as { name?: unknown; sources?: unknown; items?: unknown } | null;
    if (!raw || !Array.isArray(raw.items)) throw new Error(`${url} is not an asset catalog: it has no items.`);
    const sources = (Array.isArray(raw.sources) ? raw.sources : []).filter((s): s is LibrarySource => !!s && typeof s.id === 'string');
    const byId = new Map(sources.map((s) => [s.id, s]));
    const items: LibraryItem[] = [];
    for (const it of raw.items as LibraryItemDoc[]) {
        if (!it || typeof it.id !== 'string' || typeof it.file !== 'string' || !LIBRARY_KINDS.includes(it.kind)) continue;
        const file = new URL(it.file, url).href;
        const maps = it.maps && typeof it.maps === 'object' ? it.maps : undefined;
        items.push({
            ...it,
            name: typeof it.name === 'string' && it.name ? it.name : it.id,
            tags: Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === 'string') : [],
            url: file,
            thumbUrl: it.thumb ? new URL(it.thumb, url).href : it.kind === 'texture' || it.kind === 'material' ? file : undefined,
            ...(maps ? { mapUrls: { ...(maps.normal ? { normal: new URL(maps.normal, url).href } : {}), ...(maps.arm ? { arm: new URL(maps.arm, url).href } : {}), ...(maps.height ? { height: new URL(maps.height, url).href } : {}) } } : {}),
            catalog: url,
            sourceInfo: byId.get(it.source),
        });
    }
    return { url, name: typeof raw.name === 'string' ? raw.name : new URL(url).host, sources, items };
}

/**
 * Items matching every word of the query (in the name, id, tags or pack
 * name), best first: whole-word matches of the name before the rest.
 */
export function searchLibrary(items: readonly LibraryItem[], query: string, kind?: LibraryKind | null): LibraryItem[] {
    const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const scored: { item: LibraryItem; score: number }[] = [];
    for (const item of items) {
        if (kind && item.kind !== kind) continue;
        const name = item.name.toLowerCase();
        const hay = [name, item.id.toLowerCase(), ...item.tags.map((t) => t.toLowerCase()), (item.sourceInfo?.name ?? '').toLowerCase()].join(' ');
        let score = 0;
        let all = true;
        for (const w of words) {
            if (!hay.includes(w)) {
                all = false;
                break;
            }
            score += new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name) ? 2 : 1;
        }
        if (all) scored.push({ item, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}

/** Where an asset from the library came from, kept on the asset (credits, and reusing it instead of downloading again). */
export function librarySource(item: LibraryItem): AssetSource {
    const s = item.sourceInfo;
    return {
        url: item.url,
        item: item.id,
        ...(s ? { license: s.license, author: s.author, origin: s.url } : {}),
        // The asset's own credit, where the pack gives one.
        ...(item.author ? { author: item.author } : {}),
        ...(item.origin ? { origin: item.origin } : {}),
    };
}

/** The asset kind of a download by its file name or type. */
export function kindOfUrl(name: string, type = ''): AssetKind | null {
    return type.startsWith('model/') ? 'model' : kindOf({ name: name.replace(/[?#].*$/, ''), type });
}

/**
 * Downloads a file, reporting bytes as they arrive. Network errors (also
 * a server that does not let other sites read its files) become readable
 * messages.
 */
export async function download(url: string, opts: { signal?: AbortSignal; onProgress?: (loaded: number, total?: number) => void } = {}): Promise<Blob> {
    let res: Response;
    try {
        res = await fetch(url, { signal: opts.signal });
    } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        throw new Error(`${url} could not be downloaded: the site is unreachable or does not let other sites read its files (CORS). Download it and drop the file in instead.`);
    }
    if (!res.ok) throw new Error(`${url} could not be downloaded (${res.status} ${res.statusText}).`);
    const total = Number(res.headers.get('content-length')) || undefined;
    const type = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (!res.body || !opts.onProgress) return new Blob([await res.arrayBuffer()], { type });
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    opts.onProgress(0, total);
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        opts.onProgress(loaded, total);
    }
    return new Blob(chunks as BlobPart[], { type });
}

/** The file name of a URL, without query or fragment ("file" when it has none). */
export function urlFileName(url: string): string {
    try {
        const path = new URL(url, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/').pathname;
        return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '') || 'file';
    } catch {
        return 'file';
    }
}

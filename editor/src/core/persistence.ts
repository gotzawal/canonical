import { createZip, readZip, type ZipEntry } from '../build/zip';
import { base64ToBlob, blobToBase64, deleteAssets, getAssetBlob, putAsset } from './assets';
import { designAssetIds } from './design';
import { sanitize, Store } from './store';
import type { AssetMeta, CameraState, ParamValue, SceneDoc, SceneFile } from './types';

const AUTOSAVE_KEY = 'canonical-editor/autosave';

export interface Autosave {
    doc: SceneDoc;
    camera?: CameraState;
    savedAt: string;
    /** The scene's scripts came from an opened file and were not enabled yet. */
    scriptsPaused?: boolean;
}

export function readAutosave(): Autosave | null {
    try {
        const raw = localStorage.getItem(AUTOSAVE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.doc) return null;
        return { doc: sanitize(parsed.doc), camera: parsed.camera, savedAt: parsed.savedAt, scriptsPaused: parsed.scriptsPaused === true };
    } catch {
        return null;
    }
}

/** Keeps the current scene in localStorage (assets are already in IndexedDB). */
export class AutoSaver {
    private timer = 0;
    lastSaved = '';
    onSaved: (time: Date) => void = () => {};
    /** Saved with the scene so a reload keeps untrusted scripts paused. */
    scriptsPaused = false;

    constructor(private store: Store) {
        store.on('commit', () => this.schedule());
        store.on('load', () => this.schedule());
        store.on('camera', () => this.schedule(1500));
        // Play mode edits are thrown away on Stop, so they are never saved.
        store.on('playing', (playing) => {
            if (!playing) this.schedule();
        });
        window.addEventListener('beforeunload', () => this.flush());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flush();
        });
    }

    schedule(delay = 400) {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.flush(), delay);
    }

    flush() {
        clearTimeout(this.timer);
        if (this.store.playing) return;
        const content = JSON.stringify({
            doc: this.store.doc,
            camera: this.store.camera,
            scriptsPaused: this.scriptsPaused || undefined,
        });
        if (content === this.lastSaved) return;
        try {
            localStorage.setItem(AUTOSAVE_KEY, `${content.slice(0, -1)},"savedAt":${JSON.stringify(new Date().toISOString())}}`);
            this.lastSaved = content;
            this.onSaved(new Date());
        } catch (e) {
            console.warn('[editor] autosave failed', e);
        }
    }
}

function baseName(doc: SceneDoc): string {
    return (doc.name || 'scene').trim().replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-') || 'scene';
}

export function fileNameFor(doc: SceneDoc): string {
    return `${baseName(doc)}.scene.json`;
}

export function projectFileNameFor(doc: SceneDoc): string {
    return `${baseName(doc)}.canonical.zip`;
}

/**
 * Serializes the scene plus every asset the game uses into one JSON file.
 * Planning assets (concepts, paintovers, captures, snapshots) stay listed
 * but their data is left out to keep the file small: a project file
 * (exportProject) carries them.
 */
export async function exportSceneFile(store: Store): Promise<Blob> {
    const file: SceneFile = { ...JSON.parse(JSON.stringify(store.doc)), camera: store.camera, embedded: {} };
    const used = usedAssetIds(store.doc);
    const design = designAssetIds(store.doc.design);
    file.assets = file.assets.filter((a) => used.has(a.id) || (a.purpose === 'design' && design.has(a.id)));
    for (const asset of file.assets) {
        if (!used.has(asset.id)) continue;
        const blob = await getAssetBlob(asset.id);
        if (blob) file.embedded![asset.id] = await blobToBase64(blob);
    }
    return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

// ---------------------------------------------------------------- projects

/** project.json inside a project file (.canonical.zip). */
interface ProjectManifest {
    format: 'canonical-project';
    version: 1;
    savedAt: string;
    scene: SceneDoc;
    camera?: CameraState;
    /** Every asset in the archive: its meta and path. Includes assets only snapshots use. */
    files: { meta: AssetMeta; path: string }[];
}

const PROJECT_FILE = 'project.json';

function assetFileName(meta: AssetMeta): string {
    const dot = meta.name.lastIndexOf('.');
    const ext = dot > 0 ? meta.name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
    const stem = (dot > 0 ? meta.name.slice(0, dot) : meta.name).normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    return `assets/${meta.id}${stem ? '-' + stem : ''}${ext}`;
}

/**
 * The whole project in one .zip: the scene with its design section, every
 * asset (game and planning) as a file, and the assets of scene snapshots.
 */
export async function exportProject(store: Store): Promise<{ blob: Blob; missing: string[] }> {
    const doc = JSON.parse(JSON.stringify(store.doc)) as SceneDoc;
    const metas = new Map<string, AssetMeta>(doc.assets.map((a) => [a.id, a]));
    // Snapshots can use assets the project no longer lists: take their metas from the snapshots.
    for (const snap of doc.design.snapshots) {
        if (snap.assets.every((id) => metas.has(id))) continue;
        try {
            const blob = await getAssetBlob(snap.asset);
            const old = blob ? (JSON.parse(await blob.text()) as SceneDoc) : null;
            for (const a of old?.assets ?? []) if (!metas.has(a.id) && snap.assets.includes(a.id)) metas.set(a.id, a);
        } catch { /* a damaged snapshot only loses its extra assets */ }
    }
    const entries: ZipEntry[] = [];
    const files: ProjectManifest['files'] = [];
    const missing: string[] = [];
    for (const meta of metas.values()) {
        const blob = await getAssetBlob(meta.id);
        if (!blob) {
            missing.push(meta.name);
            continue;
        }
        const path = assetFileName(meta);
        entries.push({ path, data: blob });
        files.push({ meta, path });
    }
    const manifest: ProjectManifest = { format: 'canonical-project', version: 1, savedAt: new Date().toISOString(), scene: doc, camera: store.camera, files };
    entries.unshift({ path: PROJECT_FILE, data: JSON.stringify(manifest) });
    return { blob: await createZip(entries), missing };
}

/** Reads a project file: stores its assets in this browser and returns the scene. */
export async function importProject(zip: Blob): Promise<{ doc: SceneDoc; camera?: CameraState }> {
    let files: Map<string, Blob>;
    try {
        files = await readZip(zip);
    } catch (e: any) {
        throw new Error(`This is not a Canonical project file (${e?.message || e}).`);
    }
    const manifestBlob = files.get(PROJECT_FILE);
    if (!manifestBlob) throw new Error('This zip file is not a Canonical project (project.json is missing).');
    let manifest: ProjectManifest;
    try {
        manifest = JSON.parse(await manifestBlob.text());
    } catch {
        throw new Error('project.json in this file is not valid.');
    }
    if (manifest?.format !== 'canonical-project' || !manifest.scene) throw new Error('This zip file is not a Canonical project.');
    for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
        const blob = f && typeof f.path === 'string' ? files.get(f.path) : undefined;
        const meta = f?.meta;
        if (!blob || !meta || typeof meta.id !== 'string') continue;
        const typed = blob.type ? blob : new Blob([blob], { type: meta.mime || '' });
        const { id, name, kind, ...extra } = meta;
        await putAsset(typed, name, kind, id, extra);
    }
    return { doc: sanitize(manifest.scene), camera: manifest.camera };
}

export async function importSceneFile(text: string): Promise<{ doc: SceneDoc; camera?: CameraState }> {
    let parsed: SceneFile;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Not a valid JSON file.');
    }
    if (!parsed || (parsed.format !== 'canonical-scene' && !Array.isArray((parsed as any).nodes))) {
        throw new Error('This file is not a Canonical scene.');
    }
    const embedded = parsed.embedded || {};
    for (const asset of Array.isArray(parsed.assets) ? parsed.assets : []) {
        const b64 = embedded[asset.id];
        if (!b64) continue;
        const { id, name, kind, ...extra } = asset;
        await putAsset(base64ToBlob(b64, asset.mime), name, kind, id, extra);
    }
    delete parsed.embedded;
    const camera = parsed.camera;
    delete parsed.camera;
    return { doc: sanitize(parsed), camera };
}

export function usedAssetIds(doc: SceneDoc): Set<string> {
    const ids = new Set<string>();
    const known = new Set(doc.assets.map((a) => a.id));
    // Texture properties of custom shaders hold asset ids as values.
    const params = (values?: Record<string, ParamValue>) => {
        for (const v of Object.values(values ?? {})) if (typeof v === 'string' && known.has(v)) ids.add(v);
    };
    for (const n of doc.nodes) {
        if (n.model?.asset) ids.add(n.model.asset);
        const m = n.mesh?.material;
        for (const id of [m?.map, m?.normalMap, m?.metalRoughMap, m?.aoMap, m?.emissiveMap]) if (id) ids.add(id);
        params(n.mesh?.material.params);
        for (const o of Object.values(n.model?.materials ?? {})) {
            if (o.map) ids.add(o.map);
            params(o.params);
        }
    }
    for (const p of doc.renderGraph.posts) params(p.params);
    // ... and a property's default may name one in the shader code.
    for (const s of doc.shaders) {
        for (const id of known) if (s.code.includes(id)) ids.add(id);
    }
    return ids;
}

/** Drops IndexedDB blobs the current project no longer lists (keeping what its snapshots use). */
export function collectGarbage(doc: SceneDoc) {
    const keep = new Set(doc.assets.map((a) => a.id));
    for (const id of designAssetIds(doc.design)) keep.add(id);
    void deleteAssets(keep);
}

export function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.style.display = 'none';
        input.addEventListener('change', () => {
            resolve(Array.from(input.files || []));
            input.remove();
        });
        document.body.appendChild(input);
        input.click();
    });
}

import { base64ToBlob, blobToBase64, deleteAssets, getAssetBlob, putAsset } from './assets';
import { sanitize, Store } from './store';
import type { CameraState, ParamValue, SceneDoc, SceneFile } from './types';

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

export function fileNameFor(doc: SceneDoc): string {
    const base = (doc.name || 'scene').trim().replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-') || 'scene';
    return `${base}.scene.json`;
}

/** Serializes the scene plus every referenced asset into one JSON file. */
export async function exportSceneFile(store: Store): Promise<Blob> {
    const file: SceneFile = { ...JSON.parse(JSON.stringify(store.doc)), camera: store.camera, embedded: {} };
    const used = usedAssetIds(store.doc);
    file.assets = file.assets.filter((a) => used.has(a.id));
    for (const asset of file.assets) {
        const blob = await getAssetBlob(asset.id);
        if (blob) file.embedded![asset.id] = await blobToBase64(blob);
    }
    return new Blob([JSON.stringify(file)], { type: 'application/json' });
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
        if (b64) await putAsset(base64ToBlob(b64, asset.mime), asset.name, asset.kind, asset.id);
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

/** Drops IndexedDB blobs the current project no longer lists. */
export function collectGarbage(doc: SceneDoc) {
    const keep = new Set(doc.assets.map((a) => a.id));
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

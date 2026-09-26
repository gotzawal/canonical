// Build & Deploy: turns the open project into a standalone web game. A game
// is the player app (player.html and its files, listed in
// player-manifest.json by editor/vite.config.js) renamed to index.html,
// plus game.json with the scene and a media/ folder with its assets.

import { getAssetBlob } from '../core/assets';
import { usedAssetIds } from '../core/persistence';
import type { AssetMeta, CameraState, SceneDoc } from '../core/types';
import { GAME_FILE, PLAYER_MANIFEST, type GameFile, type PlayerManifest } from './gameFile';
import type { ZipEntry } from './zip';

export interface BuildOptions {
    title: string;
    /** Editor view, used by the game when the scene has no camera node. */
    camera?: CameraState;
    /** False leaves the scripts out (they are paused in the editor). */
    scripts: boolean;
}

export interface BuiltGame {
    title: string;
    files: ZipEntry[];
    /** Total size in bytes. */
    size: number;
    warnings: string[];
}

function sizeOf(data: ZipEntry['data']): number {
    if (typeof data === 'string') return new TextEncoder().encode(data).length;
    if (data instanceof Uint8Array) return data.length;
    return data.size;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** A file name for an asset: its id (unique) plus a URL safe form of its name. */
export function assetPath(asset: AssetMeta): string {
    const dot = asset.name.lastIndexOf('.');
    const ext = dot > 0 ? asset.name.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, '') : '';
    const stem = (dot > 0 ? asset.name.slice(0, dot) : asset.name)
        .normalize('NFKD')
        .replace(/[^\w-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
    return `media/${asset.id}${stem ? '-' + stem : ''}${ext}`;
}

/** The player app of this editor: the files every game gets. */
async function playerFiles(title: string): Promise<ZipEntry[]> {
    const manifestUrl = new URL(PLAYER_MANIFEST, document.baseURI);
    let res: Response;
    try {
        res = await fetch(manifestUrl, { cache: 'no-cache' });
    } catch (e: any) {
        throw new Error(`Could not read ${PLAYER_MANIFEST}: ${e?.message || e}`);
    }
    if (!res.ok) {
        throw new Error(
            `This editor has no player app to build games with (${PLAYER_MANIFEST}: ${res.status}). ` +
                'Use an editor built with "pnpm run editor:build" or the dev server.',
        );
    }
    const manifest = (await res.json()) as PlayerManifest;
    if (!manifest?.html || !Array.isArray(manifest.files)) throw new Error(`${PLAYER_MANIFEST} is not valid.`);
    const root = new URL(manifest.base ?? '', manifestUrl);
    const out: ZipEntry[] = [];
    for (const file of manifest.files) {
        const r = await fetch(new URL(file, root), { cache: 'no-cache' });
        if (!r.ok) throw new Error(`Could not read ${file} of the player app (${r.status}).`);
        if (file === manifest.html) {
            const html = (await r.text()).replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`);
            out.push({ path: 'index.html', data: html });
        } else {
            out.push({ path: file, data: await r.blob() });
        }
    }
    return out;
}

function editorSha(): string {
    try {
        return __EDITOR_BUILD__.sha;
    } catch {
        return '';
    }
}

/** A copy of the scene for a game (or a preview): only what the game uses. */
export function gameScene(source: SceneDoc, scripts: boolean): SceneDoc {
    const doc = JSON.parse(JSON.stringify(source)) as SceneDoc;
    delete doc.build;
    // Planning data and prefab templates (instances are already in the nodes) stay in the editor.
    delete (doc as Partial<SceneDoc>).design;
    doc.prefabs = [];
    if (!scripts) {
        doc.scripts = [];
        for (const n of doc.nodes) if (n.scripts) n.scripts = [];
    }
    const used = usedAssetIds(doc);
    doc.assets = doc.assets.filter((a) => used.has(a.id));
    return doc;
}

/** Builds the game files; `log` reports progress. */
export async function buildGame(source: SceneDoc, opts: BuildOptions, log: (text: string) => void = () => {}): Promise<BuiltGame> {
    const title = opts.title.trim() || source.name || 'Game';
    const warnings: string[] = [];
    log('Collecting the player app...');
    const files = await playerFiles(title);

    const doc = gameScene(source, opts.scripts);
    const paths: Record<string, string> = {};
    const kept: AssetMeta[] = [];
    for (const asset of doc.assets) {
        const blob = await getAssetBlob(asset.id);
        if (!blob) {
            warnings.push(`"${asset.name}" is not stored in this browser, so the game will miss it.`);
            continue;
        }
        const path = assetPath(asset);
        paths[asset.id] = path;
        kept.push(asset);
        files.push({ path, data: blob });
    }
    if (kept.length) log(`Added ${kept.length} asset file${kept.length === 1 ? '' : 's'}.`);

    const game: GameFile = {
        format: 'canonical-game',
        version: 1,
        title,
        scene: doc,
        camera: opts.camera,
        files: paths,
        builtAt: new Date().toISOString(),
        editor: editorSha() || undefined,
    };
    files.push({ path: GAME_FILE, data: JSON.stringify(game) });
    // GitHub Pages runs Jekyll, which drops files starting with "_" (Vite
    // names some chunks that way), unless this file is there.
    files.push({ path: '.nojekyll', data: '' });
    const size = files.reduce((s, f) => s + sizeOf(f.data), 0);
    return { title, files, size, warnings };
}

/** Folder-safe form of a title, for the .zip name and a new repository. */
export function slug(title: string): string {
    return (
        title
            .normalize('NFKD')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'game'
    );
}

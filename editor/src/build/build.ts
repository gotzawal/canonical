// Build & Deploy: turns the open project into a standalone web game. A game
// is the player app (player.html and its files, listed in
// player-manifest.json by editor/vite.config.js) renamed to index.html,
// plus game.json with the scene and a media/ folder with its assets.

import { formatBytes, getAssetBlob } from '../core/assets';
import { sceneModelsNeeded } from '../core/behavior/format';
import { shipsCopy, type DerivedRecord, type DerivedRole } from '../core/derived';
import { usedAssetIds } from '../core/persistence';
import { assetRoles } from '../core/refs';
import { usesPhysics } from '../play/physics';
import type { AssetMeta, CameraState, SceneDoc, TextureRole } from '../core/types';
import { GAME_FILE, PLAYER_MANIFEST, type GameFile, type PlayerManifest } from './gameFile';
import { decodersFor, gltfExtensions } from './modelInfo';
import type { ZipEntry } from '../core/zip';

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

/** Compressed copies of textures and models for a build (derive/derivedAssets.ts in the editor). */
export interface BuildTextures {
    /** The copy of a texture for a role (or of a model), made now if missing; null ships the file itself. */
    ensure(meta: AssetMeta, role: DerivedRole, signal?: AbortSignal): Promise<DerivedRecord | null>;
}

/** What the player needs besides its core files. */
interface PlayerUses {
    ai: boolean;
    physics: boolean;
    ktx2: boolean;
    draco: boolean;
    meshopt: boolean;
}

const TEXTURE_ROLES: readonly string[] = ['color', 'normal', 'data'];

/** The file of an asset's compressed copy (a texture's for a role, or a model's), next to where its file goes. */
export function derivedPath(asset: AssetMeta, role: DerivedRole): string {
    return assetPath(asset).replace(/\.[a-z0-9]+$/, '') + (role === 'model' ? '.game.glb' : `.${role}.ktx2`);
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

/** The player app of this editor: the files every game gets (the AI, physics and decoder files only when it uses them). */
async function playerFiles(title: string, uses: PlayerUses): Promise<ZipEntry[]> {
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
    const skip = new Set<string>();
    for (const group of ['ai', 'physics', 'ktx2', 'draco', 'meshopt'] as const) if (!uses[group]) for (const f of manifest[group] ?? []) skip.add(f);
    const out: ZipEntry[] = [];
    for (const file of manifest.files) {
        if (skip.has(file)) continue;
        const r = await fetch(new URL(file, root), { cache: 'no-cache' });
        if (!r.ok) throw new Error(`Could not read ${file} of the player app (${r.status}).`);
        if (file === manifest.html) {
            // A function, so a $ in the title is not read as a replacement pattern.
            const html = (await r.text()).replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeHtml(title)}</title>`);
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

/**
 * Builds the game files; `log` reports progress. With `textures`, texture
 * assets ship as compressed copies (KTX2) for the roles the scene uses
 * them in, made now when missing; the file itself ships only where a role
 * has no copy (compression off or failed, or shader code naming it).
 * Models ship as their copies (KTX2 textures, meshopt geometry) in place
 * of their files where the game is better off with them.
 */
export async function buildGame(source: SceneDoc, opts: BuildOptions, log: (text: string) => void = () => {}, textures?: BuildTextures, signal?: AbortSignal): Promise<BuiltGame> {
    const title = opts.title.trim() || source.name || 'Game';
    const warnings: string[] = [];
    const doc = gameScene(source, opts.scripts);
    const models = sceneModelsNeeded(doc);
    const ai = models.length > 0;
    if (ai) {
        log(
            `The agents use ${models.join(', ')}: ` +
                'the game includes ONNX Runtime and downloads the models into the player\'s browser on first play (they play with the defaults until then).',
        );
    }

    const paths: Record<string, string> = {};
    const derived: Record<string, string> = {};
    const assetFiles: ZipEntry[] = [];
    const uses: PlayerUses = { ai, physics: usesPhysics(doc), ktx2: false, draco: false, meshopt: false };
    const roles = assetRoles(doc);
    let kept = 0;
    const packed = { textures: 0, models: 0, bytes: 0, original: 0 };
    const textureCount = textures ? doc.assets.filter((a) => a.kind === 'texture' && [...(roles.get(a.id) ?? [])].some((r) => TEXTURE_ROLES.includes(r))).length : 0;
    const modelCount = textures ? doc.assets.filter((a) => a.kind === 'model').length : 0;
    if (textureCount || modelCount) {
        const what = [plural(textureCount, 'texture'), plural(modelCount, 'model')].filter(Boolean).join(' and ');
        log(`Compressing ${what} (copies made before are reused)...`);
    }
    const copyOf = (asset: AssetMeta, role: DerivedRole) =>
        textures!.ensure(asset, role, signal).catch((e) => {
            if (e?.name === 'AbortError') throw e;
            return null;
        });
    for (const asset of doc.assets) {
        signal?.throwIfAborted();
        const blob = await getAssetBlob(asset.id);
        if (!blob) {
            warnings.push(`"${asset.name}" is not stored in this browser, so the game will miss it.`);
            continue;
        }
        let needFile = true;
        if (asset.kind === 'texture' && textures) {
            const used = roles.get(asset.id) ?? new Set();
            const textureRoles = [...used].filter((r): r is TextureRole => TEXTURE_ROLES.includes(r));
            // Shader code may load it any way: keep the file too.
            let covered = textureRoles.length > 0 && textureRoles.length === used.size;
            for (const role of textureRoles) {
                const copy = await copyOf(asset, role);
                if (!copy) {
                    covered = false;
                    continue;
                }
                const path = derivedPath(asset, role);
                derived[`${asset.id}|${role}`] = path;
                assetFiles.push({ path, data: copy.blob });
                packed.textures++;
                packed.bytes += copy.bytes;
                uses.ktx2 = true;
            }
            if (textureRoles.length) packed.original += blob.size;
            needFile = !covered;
        }
        if (asset.kind === 'texture' && asset.name.toLowerCase().endsWith('.ktx2')) uses.ktx2 = true;
        if (asset.kind === 'model') {
            // The copy when a game is better off with it (KTX2 textures, or smaller), else the file.
            const copy = textures ? await copyOf(asset, 'model') : null;
            const shipped = copy && shipsCopy(copy, asset) ? copy : null;
            if (shipped) {
                const path = derivedPath(asset, 'model');
                derived[`${asset.id}|model`] = path;
                assetFiles.push({ path, data: shipped.blob });
                packed.models++;
                packed.bytes += shipped.bytes;
                packed.original += blob.size;
                needFile = false;
            }
            const need = decodersFor(await gltfExtensions(shipped?.blob ?? blob));
            uses.ktx2 ||= need.ktx2;
            uses.draco ||= need.draco;
            uses.meshopt ||= need.meshopt;
        }
        if (!needFile) continue;
        const path = assetPath(asset);
        paths[asset.id] = path;
        kept++;
        assetFiles.push({ path, data: blob });
    }
    if (packed.textures || packed.models) {
        const what = [plural(packed.textures, 'texture cop', 'y', 'ies'), plural(packed.models, 'model')].filter(Boolean).join(' and ');
        log(`Compressed ${what}: ${formatBytes(packed.bytes)} (the files were ${formatBytes(packed.original)}).`);
    }
    if (kept) log(`Added ${kept} asset file${kept === 1 ? '' : 's'}.`);

    log('Collecting the player app...');
    const files = await playerFiles(title, uses);
    files.push(...assetFiles);

    const game: GameFile = {
        format: 'canonical-game',
        version: 1,
        title,
        scene: doc,
        camera: opts.camera,
        files: paths,
        ...(Object.keys(derived).length ? { derived } : {}),
        builtAt: new Date().toISOString(),
        editor: editorSha() || undefined,
    };
    files.push({ path: GAME_FILE, data: JSON.stringify(game) });
    const credits = creditsText(doc.assets);
    if (credits) {
        files.push({ path: 'credits.txt', data: credits });
        log('Listed where the downloaded assets come from in credits.txt.');
    }
    // GitHub Pages runs Jekyll, which drops files starting with "_" (Vite
    // names some chunks that way), unless this file is there.
    files.push({ path: '.nojekyll', data: '' });
    const size = files.reduce((s, f) => s + sizeOf(f.data), 0);
    return { title, files, size, warnings };
}

/** The credits of the assets that came from the Library or a link (who made them, the license, where from), or '' for none. */
export function creditsText(assets: readonly AssetMeta[]): string {
    const lines = assets
        .filter((a) => a.source)
        .map((a) => {
            const s = a.source!;
            const who = [s.author && `by ${s.author}`, s.license].filter(Boolean).join(', ');
            return `- ${a.name}${who ? ` (${who})` : ''}: ${s.origin ?? s.url}`;
        });
    if (!lines.length) return '';
    return ['Assets in this game that come from elsewhere:', '', ...[...new Set(lines)].sort(), ''].join('\n');
}

/** "3 textures", "1 texture", or '' for none; `one`/`many` end the word (cop-y, cop-ies). */
function plural(n: number, word: string, one = '', many = 's'): string {
    return n ? `${n} ${word}${n === 1 ? one : many}` : '';
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

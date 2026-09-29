// Formats shared by the editor's Build & Deploy and the player (player/main.ts).

import type { CameraState, SceneDoc } from '../core/types';

/** Project file of a built game, next to its index.html. */
export const GAME_FILE = 'game.json';

/** localStorage key the editor hands a preview tab its scene through. */
export const PREVIEW_KEY = 'canonical-editor/preview';

/** Lists the player app's files in an editor build (written by editor/vite.config.js). */
export const PLAYER_MANIFEST = 'player-manifest.json';

export interface PlayerManifest {
    /** The player page, which becomes index.html of a game. */
    html: string;
    /** Every file the player page needs, relative to `base`, including `html`. */
    files: string[];
    /** Files of `files` only agents with models use (inference worker, ONNX Runtime, WebAssembly). */
    ai?: string[];
    /** Files of `files` only physics uses (Rapier). */
    physics?: string[];
    /** Files of `files` only KTX2 textures use (the Basis transcoder). */
    ktx2?: string[];
    /** Files of `files` only Draco-compressed models use (the Draco decoder). */
    draco?: string[];
    /** Files of `files` only meshopt-compressed models use (the meshopt decoder). */
    meshopt?: string[];
    /** Prefix of the files on this server ('' for a production build). */
    base?: string;
}

export interface GameFile {
    format: 'canonical-game';
    version: 1;
    title: string;
    scene: SceneDoc;
    /** Editor view at build time; the game uses it when the scene has no camera node. */
    camera?: CameraState;
    /** Asset files by asset id, relative to the page. */
    files: Record<string, string>;
    /**
     * Compressed copies by `${asset id}|${role}`, relative to the page, used
     * in place of the files: textures (KTX2) for each role, and models
     * (`|model`: GLB with KTX2 textures and meshopt geometry).
     */
    derived?: Record<string, string>;
    builtAt: string;
    /** Commit of the editor that built the game, when known. */
    editor?: string;
}

/** What a preview tab gets from the editor (its assets come from the same IndexedDB). */
export interface PreviewData {
    title: string;
    scene: SceneDoc;
    camera?: CameraState;
    /** False when the scene's scripts are paused in the editor: the preview runs without them. */
    trusted: boolean;
}

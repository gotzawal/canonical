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

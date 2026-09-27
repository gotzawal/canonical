// Scene format migrations. Every document the editor loads (autosave, scene
// and project files, previews and built games) goes through sanitize() in
// store.ts, which runs these first; sanitize then repairs what is left.

import { SCENE_VERSION } from './types';

type Raw = Record<string, any>;

const STEPS: Record<number, (doc: Raw) => void> = {
    // 1 -> 2: AI behavior data. Older scenes have none of it.
    1: (doc) => {
        doc.blackboards ??= [];
        doc.behaviors ??= [];
        doc.memory ??= { items: [] };
    },
    // 2 -> 3: AI models the scene loads (Laya and e5 are built in).
    2: (doc) => {
        doc.aiModels ??= [];
    },
};

/**
 * Brings a scene document of any older version up to SCENE_VERSION (in
 * place). A newer one is refused: repairing it would drop what this editor
 * does not know, and the next save would lose it.
 */
export function migrateScene(doc: Raw): Raw {
    if (!doc || typeof doc !== 'object') return doc;
    if (Number.isInteger(doc.version) && doc.version > SCENE_VERSION) {
        throw new Error(`This scene was saved by a newer version of the editor (scene format ${doc.version}; this one reads up to ${SCENE_VERSION}). Update the editor to open it.`);
    }
    let version = Number.isInteger(doc.version) && doc.version > 0 ? doc.version : 1;
    while (version < SCENE_VERSION) {
        STEPS[version]?.(doc);
        version++;
    }
    doc.version = SCENE_VERSION;
    return doc;
}

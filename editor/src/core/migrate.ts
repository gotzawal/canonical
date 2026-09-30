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
    // 3 -> 4: each light has its own shadow settings. The environment's
    // directional shadow range, Follow Camera and Cascades move to the
    // directional lights; as before, the cascades are the first shadow
    // caster's (the sun's) and the others follow the camera instead.
    3: (doc) => {
        const s = doc.environment?.shadow;
        if (!s || typeof s !== 'object') return;
        const range = typeof s.range === 'number' ? s.range : 60;
        let sun = true;
        const lists = [doc.nodes, ...(Array.isArray(doc.prefabs) ? doc.prefabs.map((p: Raw) => p?.nodes) : [])];
        for (const nodes of lists) {
            if (!Array.isArray(nodes)) continue;
            for (const n of nodes) {
                const light = n?.light;
                if (!light || typeof light !== 'object' || light.type !== 'directional' || light.shadow) continue;
                const cascades = !!s.cascades && sun && !!light.castShadow;
                if (light.castShadow) sun = false;
                light.shadow = { coverage: cascades ? 'cascades' : s.follow || s.cascades ? 'follow' : 'area', range };
            }
        }
        delete s.range;
        delete s.follow;
        delete s.cascades;
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

// Which objects can move in Play: those that are characters, the player,
// agents, animated, scripted or bodies that are not fixed, and everything
// under them. The rest stands still: shadows that only static objects cast
// are drawn once for it (LightDoc.shadow.update 'static').

import type { SceneDoc } from './types';

/** A test of whether an object (by id) can move in Play; answers are kept for the document it was made for. */
export function movesInPlay(doc: SceneDoc): (id: string | null | undefined) => boolean {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const known = new Map<string, boolean>();
    const test = (id: string | null | undefined): boolean => {
        if (!id) return false;
        let m = known.get(id);
        if (m !== undefined) return m;
        const n = byId.get(id);
        known.set(id, false);
        m = !!n && (!!(n.character || n.player || n.agent || n.animation || n.scripts?.length || (n.body && n.body.type !== 'fixed')) || test(n.parent));
        known.set(id, m);
        return m;
    };
    return test;
}

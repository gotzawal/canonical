// What moved since the last look, from the engine's own change event: every
// transform setter and re-parenting fires LOCAL_ONCHANGE on the transform
// and on every transform below it. Polling every object each frame for a
// move (decomposing or re-boxing it) costs time with the whole scene; this
// costs time with what moved.

import { Transform, type Object3D } from '@orillusion/core';

export class TransformWatch<K> {
    /** Keys of the watched objects that moved since `moved` was last cleared. */
    readonly moved = new Set<K>();
    private subs = new Map<Object3D, { fn: () => void; keys: K[] }>();

    /** Adds `key` to `moved` whenever `obj` (or one of its parents) moves. */
    watch(obj: Object3D, key: K) {
        const known = this.subs.get(obj);
        if (known) {
            known.keys.push(key);
            return;
        }
        // One listener (and this object) per watched object: the engine drops
        // a second listener with the same callback and this object.
        const sub = {
            keys: [key],
            fn: () => {
                for (const k of sub.keys) this.moved.add(k);
            },
        };
        this.subs.set(obj, sub);
        obj.transform?.eventDispatcher?.addEventListener(Transform.LOCAL_ONCHANGE, sub.fn, sub);
    }

    unwatch(obj: Object3D) {
        const sub = this.subs.get(obj);
        if (!sub) return;
        this.subs.delete(obj);
        obj.transform?.eventDispatcher?.removeEventListener(Transform.LOCAL_ONCHANGE, sub.fn, sub);
    }

    /** Stops watching everything (listeners outlive destroyed components, so this has to run). */
    clear() {
        for (const obj of Array.from(this.subs.keys())) this.unwatch(obj);
        this.moved.clear();
    }

    get size(): number {
        return this.subs.size;
    }
}

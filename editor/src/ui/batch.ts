// Views follow the document once a frame: a gizmo drag changes it on every
// pointer move, often several times a frame, and each view only needs to
// show where things ended up. What changed meanwhile comes merged into one
// hint (mergeHints), so a view can still skip what it does not show.

import { listenerSite, timed } from '../core/events';
import { mergeHints, type ChangeHint, type Store } from '../core/store';

export interface FrameChanges {
    /** Runs a waiting update now, before reading what the view shows. */
    flush(): void;
    /** Stops listening. */
    off(): void;
}

const nextFrame: (cb: () => void) => number =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16) as unknown as number;
const cancelFrame: (id: number) => void = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id) => clearTimeout(id);

/**
 * Calls `fn` at most once per animation frame with what changed in the
 * document since its last call (undefined: anything).
 */
export function onChanges(store: Store, fn: (hint: ChangeHint | undefined) => void): FrameChanges {
    const site = listenerSite();
    let pending: ChangeHint | undefined | null = null;
    let frame = 0;
    const run = () => {
        if (frame) cancelFrame(frame);
        frame = 0;
        if (pending === null) return;
        const hint = pending;
        pending = null;
        timed('change (once a frame)', site, () => fn(hint));
    };
    const off = store.on('change', (hint) => {
        pending = mergeHints(pending, hint);
        frame ||= nextFrame(run);
    });
    return {
        flush: run,
        off: () => {
            off();
            if (frame) cancelFrame(frame);
            frame = 0;
            pending = null;
        },
    };
}

/** What a view may show: objects ("transform": where they are, "nodes": anything else about them) and parts of the document. */
export type Shown = 'transform' | 'nodes' | 'env' | 'meta' | 'design' | 'behavior';

/**
 * True when a change with `hint` may have changed what the view shows,
 * named by `shown`. A change without a hint may have changed anything
 * (the scripts and shaders, which only such changes touch, too).
 */
export function touches(hint: ChangeHint | undefined, ...shown: Shown[]): boolean {
    if (!hint || !(hint.nodes || hint.env || hint.meta || hint.design || hint.behavior)) return true;
    for (const k of shown) {
        if (k === 'transform' ? !!hint.nodes : k === 'nodes' ? !!hint.nodes && !hint.transform : !!hint[k]) return true;
    }
    return false;
}

/**
 * Returns a function that calls `fn` once calls to it have paused for `ms`:
 * for views that sum up the whole scene (the pipeline's checklists), which
 * need not follow a drag frame by frame.
 */
export function whenQuiet(ms: number, fn: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
}

// The editor's work on a large scene (scene.ts: 5,000 objects, 1.7 MB of
// JSON), before and after undo steps kept only what changed, the child index
// and the change hints for transforms. `pnpm run editor:bench` runs these
// and fails when a benchmark named "(budget N ms)" takes longer than that
// (its 75th percentile; see budgets.mjs).

import { bench, describe } from 'vitest';
import { mergeHints, Store, type ChangeHint } from '../../src/core/store';
import { refs, useCounts } from '../../src/core/refs';
import type { NodeDoc, SceneDoc } from '../../src/core/types';
import { LegacyStore } from '../unit/legacyStore';
import { syntheticScene } from './scene';

const SCENE = syntheticScene({ nodes: 5000 });
const copy = (): SceneDoc => JSON.parse(JSON.stringify(SCENE));
const objects = SCENE.nodes.filter((n) => n.mesh).map((n) => n.id);
let turn = 0;
const next = () => objects[turn++ % objects.length];

/** A store as the editor runs it: without the development check of every undo step. */
function store(): Store {
    const s = new Store(copy());
    s.verifyHistory = false;
    return s;
}

function move(s: Store | LegacyStore, id: string) {
    s.commit('Move', () => {
        const n = s.node(id)!;
        n.position = [n.position[0] + 0.01, n.position[1], n.position[2]];
    }, { nodes: [id], transform: true });
}

describe('commit a change of one object', () => {
    const now = store();
    const before = new LegacyStore(copy());
    bench('undo step of that object (budget 1 ms)', () => move(now, next()));
    bench('before: two snapshots of the whole document', () => move(before, next()), { iterations: 20, time: 0 });
});

describe('undo and redo a change of one object', () => {
    const now = store();
    const before = new LegacyStore(copy());
    move(now, objects[0]);
    move(before, objects[0]);
    bench('undo steps of that object (budget 1 ms)', () => {
        now.undo();
        now.redo();
    });
    bench('before: whole document snapshots', () => {
        before.undo();
        before.redo();
    }, { iterations: 10, time: 0 });
});

describe('one frame of a gizmo drag: the store and what listens to it', () => {
    // A drag is one transaction; every pointer move updates the dragged objects.
    const now = store();
    // What reacts to every change in the editor: views that catch up once a
    // frame only merge the hint (ui/batch.ts), the rest look at it.
    for (let i = 0; i < 16; i++) {
        let pending: ChangeHint | undefined | null = null;
        now.on('change', (h) => (pending = mergeHints(pending, h)));
        now.on('commit', () => (pending = null));
    }
    for (let i = 0; i < 8; i++) now.on('change', (h) => void (h?.transform || h?.nodes || h?.env));
    const ids = objects.slice(0, 3);
    now.begin('Move');
    bench('update of 3 dragged objects (budget 1 ms)', () => {
        now.update(() => {
            for (const id of ids) {
                const n = now.node(id)!;
                n.position = [n.position[0] + 0.01, n.position[1], n.position[2]];
            }
        }, { nodes: ids, transform: true });
    });
    const before = new LegacyStore(copy());
    before.begin('Move');
    bench('before: re-indexing every object each frame', () => {
        before.update((doc: SceneDoc) => {
            for (const id of ids) {
                const n = doc.nodes.find((x) => x.id === id)!;
                n.position = [n.position[0] + 0.01, n.position[1], n.position[2]];
            }
        }, { nodes: ids });
    });
});

describe('what the assets panel works out when objects change', () => {
    // How many objects use each script and prefab. It skips moves (transform hints) altogether.
    const doc = copy();
    bench('counting uses (budget 0.5 ms)', () => void useCounts(doc));
    bench('before: every reference in the document', () => void refs(doc), { iterations: 50, time: 0 });
});

describe('walk the whole tree', () => {
    const now = store();
    const before = new LegacyStore(copy());
    const walk = (children: (id: string | null) => readonly NodeDoc[]) => {
        let count = 0;
        const visit = (id: string | null) => {
            for (const n of children(id)) {
                count++;
                visit(n.id);
            }
        };
        visit(null);
        return count;
    };
    bench('through the child index (budget 2 ms)', () => void walk((id) => now.children(id)));
    bench('before: filtering every object for each parent', () => void walk((id) => before.children(id)), { iterations: 5, time: 0 });
});

describe('commit adding an object (a snapshot of the whole document, as before)', () => {
    let n = 0;
    const add = (s: Store | LegacyStore) =>
        s.commit('Add', (doc) => void doc.nodes.push({ id: `new${n++}`, name: 'New', parent: null, visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));
    const now = store();
    const before = new LegacyStore(copy());
    bench('snapshot and index with children', () => add(now), { iterations: 20, time: 0 });
    bench('before: snapshot and index', () => add(before), { iterations: 20, time: 0 });
});

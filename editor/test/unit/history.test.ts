// The undo history keeps only what each step changed (the objects and
// parts its change hints name). These tests run the same random edits on
// the store and on the store as it was, which kept the whole document for
// every step (legacyStore.ts), and check they always end up the same:
// document, selection and history.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyScene, makeMeshNode, makeNode } from '../../src/core/defaults';
import { Store, type ChangeHint } from '../../src/core/store';
import type { NodeDoc, SceneDoc, Vec3 } from '../../src/core/types';
import { LegacyStore } from './legacyStore';

/** Deterministic random numbers (mulberry32). */
function random(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (n: number) => Math.floor(next() * n),
        pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
        chance: (p: number) => next() < p,
    };
}

type Rng = ReturnType<typeof random>;

/** A scene with a small hierarchy, a prefab template and behavior data. */
function startScene(): SceneDoc {
    const doc = emptyScene();
    const a = { ...makeMeshNode('box'), id: 'a', name: 'A' };
    const b = { ...makeMeshNode('sphere', 'a'), id: 'b', name: 'B' };
    const c = { ...makeNode('C', 'a'), id: 'c' };
    const d = { ...makeMeshNode('plane'), id: 'd', name: 'D' };
    const e = { ...makeNode('E', 'd'), id: 'e' };
    doc.nodes = [a, b, c, d, e];
    doc.prefabs = [{ id: 'pf1', name: 'Crate', asset: 'pa1', nodes: [{ ...makeNode('Part'), id: 'part1' }] }];
    doc.blackboards = [];
    doc.behaviors = [];
    return JSON.parse(JSON.stringify(doc));
}

type Both = Store | LegacyStore;

/** One edit: the same function runs on both stores. */
type Op = { name: string; run: (s: Both) => void };

const find = (doc: SceneDoc, id: string) => doc.nodes.find((n) => n.id === id);

function makeOps(rng: Rng, store: Store, counter: { n: number }): Op {
    const doc = store.doc;
    const ids = doc.nodes.map((n) => n.id);
    const some = (max = 3) => {
        const out = new Set<string>();
        for (let i = 1 + rng.int(max); i > 0 && ids.length; i--) out.add(rng.pick(ids));
        return [...out];
    };
    const vec = (): Vec3 => [rng.int(20) - 10, rng.int(10), rng.int(20) - 10];
    const kind = rng.int(100);

    if (kind < 12) {
        const moved = some();
        const to = moved.map(() => vec());
        return { name: 'move', run: (s) => s.commit('Move', (d) => moved.forEach((id, i) => (find(d, id)!.position = to[i])), { nodes: moved, transform: true }) };
    }
    if (kind < 18) {
        // A drag: several updates, one step.
        const moved = some(2);
        const frames = 2 + rng.int(4);
        const at = Array.from({ length: frames }, () => moved.map(() => vec()));
        const cancel = rng.chance(0.25);
        return {
            name: cancel ? 'drag-cancel' : 'drag',
            run: (s) => {
                const start = moved.map((id) => [...find(s.doc, id)!.position] as Vec3);
                s.begin('Move');
                for (const f of at) s.update((d) => moved.forEach((id, i) => (find(d, id)!.position = f[i])), { nodes: moved, transform: true });
                if (cancel) s.update((d) => moved.forEach((id, i) => (find(d, id)!.position = start[i])), { nodes: moved, transform: true });
                s.end();
            },
        };
    }
    if (kind < 23 && ids.length) {
        const id = rng.pick(ids);
        const name = `N${rng.int(1000)}`;
        return { name: 'rename', run: (s) => s.commit('Rename', (d) => (find(d, id)!.name = name), { nodes: [id] }) };
    }
    if (kind < 27) {
        const targets = some();
        const color = `#${rng.int(0xffffff).toString(16).padStart(6, '0')}`;
        return {
            name: 'material',
            run: (s) =>
                s.commit('Color', (d) => {
                    for (const id of targets) {
                        const n = find(d, id)!;
                        if (n.mesh) n.mesh.material.color = color;
                        else n.scripts = [{ script: 'none', enabled: true, props: { k: color } }];
                    }
                }, { nodes: targets }),
        };
    }
    if (kind < 30) {
        const targets = some();
        return { name: 'visibility', run: (s) => s.commit('Hide', (d) => targets.forEach((id) => (find(d, id)!.visible = !find(d, id)!.visible)), { nodes: targets }) };
    }
    if (kind < 36) {
        const id = `n${++counter.n}`;
        const parent = ids.length && rng.chance(0.6) ? rng.pick(ids) : null;
        const at = rng.int(ids.length + 1);
        return {
            name: 'add',
            run: (s) =>
                s.commit('Add', (d) => {
                    const node: NodeDoc = rng2node(id, parent);
                    d.nodes.splice(at, 0, node);
                }),
        };
    }
    if (kind < 40 && ids.length) {
        const id = rng.pick(ids);
        return {
            name: 'delete',
            run: (s) => {
                const gone = new Set([id, ...s.descendants(id).map((n) => n.id)]);
                s.commit('Delete', (d) => (d.nodes = d.nodes.filter((n) => !gone.has(n.id))));
            },
        };
    }
    if (kind < 44 && ids.length > 1) {
        const id = rng.pick(ids);
        const parent = rng.chance(0.3) ? null : rng.pick(ids);
        return {
            name: 'reparent',
            run: (s) => {
                if (parent === id || (parent && s.descendants(id).some((n) => n.id === parent))) return;
                s.commit('Reparent', (d) => {
                    const i = d.nodes.findIndex((n) => n.id === id);
                    const [n] = d.nodes.splice(i, 1);
                    n.parent = parent;
                    d.nodes.push(n);
                });
            },
        };
    }
    if (kind < 49) {
        const exposure = rng.int(30) / 10;
        const name = rng.chance(0.3) ? `Scene ${rng.int(100)}` : null;
        return {
            name: 'environment',
            run: (s) =>
                s.commit('Environment', (d) => {
                    d.environment.exposure = exposure;
                    if (name) d.name = name;
                    if (name && d.renderGraph.disabled.length < 3) d.renderGraph.disabled = [...d.renderGraph.disabled, name];
                }, { env: true }),
        };
    }
    if (kind < 54) {
        const text = `Brief ${rng.int(1000)}`;
        const image = rng.chance(0.5) ? `img${++counter.n}` : null;
        return {
            name: 'design',
            run: (s) =>
                s.commit('Design', (d) => {
                    d.design.brief.text = text;
                    if (image) d.assets.push({ id: image, name: `${image}.png`, kind: 'image', mime: 'image/png', size: 10, purpose: 'design' });
                }, { design: true }),
        };
    }
    if (kind < 57) {
        const title = rng.chance(0.3) ? undefined : `Game ${rng.int(100)}`;
        const asPatch = rng.chance(0.5);
        const fn = (d: SceneDoc) => void (d.build = title ? { title } : undefined);
        return { name: asPatch ? 'build-patch' : 'build', run: (s) => (asPatch ? s.patch(fn, { meta: true }) : s.commit('Build', fn, { meta: true })) };
    }
    if (kind < 62) {
        const holder = rng.chance(0.25) ? 'part1' : ids.length ? rng.pick(ids) : 'part1';
        const tree = `t${rng.int(5)}`;
        const remove = rng.chance(0.3);
        return {
            name: 'behavior',
            run: (s) =>
                s.commit('Behavior', (d) => {
                    d.behaviors = [...d.behaviors.filter((t) => t.id !== tree), { id: tree, name: tree } as any];
                    const n = find(d, holder) ?? d.prefabs.flatMap((p) => p.nodes).find((x) => x.id === holder);
                    if (!n) return;
                    if (remove) delete n.agent;
                    else n.agent = { tree, enabled: true, values: {} };
                }, { behavior: true, agents: [holder] }),
        };
    }
    if (kind < 67) {
        // A transaction of changes of every kind.
        const moved = some(2);
        const to = moved.map(() => vec());
        const add = rng.chance(0.4) ? `n${++counter.n}` : null;
        const exposure = rng.int(30) / 10;
        const text = `Plan ${rng.int(100)}`;
        const order = rng.int(3);
        return {
            name: 'mixed',
            run: (s) => {
                s.begin('Mixed');
                const steps = [
                    () => s.update((d) => moved.forEach((id, i) => (find(d, id)!.position = to[i])), { nodes: moved, transform: true }),
                    () => s.update((d) => (d.environment.exposure = exposure), { env: true }),
                    () => s.update((d) => (d.design.brief.text = text), { design: true }),
                ];
                for (let i = 0; i < steps.length; i++) steps[(i + order) % steps.length]();
                if (add) s.update((d) => void d.nodes.push(rng2node(add, null)));
                s.update((d) => moved.forEach((id) => (find(d, id)!.name += '!')), { nodes: moved });
                s.end();
            },
        };
    }
    if (kind < 71) {
        const target = ids.length ? rng.pick(ids) : null;
        const to = vec();
        const structural = rng.chance(0.3) ? `n${++counter.n}` : null;
        const design = rng.chance(0.3);
        return {
            name: 'patch',
            run: (s) => {
                if (structural) s.patch((d) => void d.nodes.push(rng2node(structural, null)));
                else if (design) s.patch((d) => (d.design.memo = { text: `memo ${to[0]}`, at: 'now' }), { design: true });
                else if (target) s.patch((d) => (find(d, target)!.position = to), { nodes: [target], transform: true });
            },
        };
    }
    if (kind < 73) {
        const target = ids.length ? rng.pick(ids) : null;
        return { name: 'noop', run: (s) => s.commit('Nothing', () => {}, target ? { nodes: [target] } : undefined) };
    }
    if (kind < 86) return { name: 'undo', run: (s) => s.undo() };
    if (kind < 95) return { name: 'redo', run: (s) => s.redo() };
    const sel = some();
    return { name: 'select', run: (s) => s.select(sel) };
}

function rng2node(id: string, parent: string | null): NodeDoc {
    return { ...makeMeshNode('box', parent), id, name: id };
}

/** The index agrees with the document: node() and children() give its own objects. */
function expectIndexed(s: Store, where: string) {
    const wrong: string[] = [];
    for (const n of s.doc.nodes) if (s.node(n.id) !== n) wrong.push(`node(${n.id})`);
    for (const p of new Set<string | null>([null, ...s.doc.nodes.map((n) => n.id)])) {
        const kids = s.children(p);
        const want = s.doc.nodes.filter((n) => n.parent === p);
        if (kids.length !== want.length || kids.some((k, i) => k !== want[i])) wrong.push(`children(${p})`);
    }
    if (wrong.length) expect(wrong, where).toEqual([]);
}

/** JSON with the keys of objects sorted, and keys set to undefined left out (as JSON does). */
const canonical = (v: unknown) =>
    JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function expectSame(a: Store, b: LegacyStore, history: { a: unknown; b: unknown }, where: string) {
    // Compared as text first (the order of keys may differ): expect() on every step of every run takes long.
    if (JSON.stringify(a.doc) !== JSON.stringify(b.doc) && canonical(a.doc) !== canonical(b.doc)) expect(a.doc, where).toEqual(b.doc);
    const state = (s: Store | LegacyStore, h: unknown) => JSON.stringify([s.selection, s.undoLabel, h]);
    if (state(a, history.a) !== state(b, history.b)) expect([a.selection, a.undoLabel, history.a], where).toEqual([b.selection, b.undoLabel, history.b]);
}

describe('undo history that keeps only what changed', () => {
    const problem = Store.historyProblem;
    beforeEach(() => {
        Store.historyProblem = (m) => {
            throw new Error(m);
        };
    });
    afterEach(() => {
        Store.historyProblem = problem;
    });

    it('undoes and redoes random edits as keeping the whole document did', () => {
        for (let seed = 1; seed <= 120; seed++) {
            const rng = random(seed);
            const doc = startScene();
            const a = new Store(JSON.parse(JSON.stringify(doc)));
            // Half the runs as in production, without the snapshots that check every step.
            a.verifyHistory = seed % 2 === 1;
            const b = new LegacyStore(JSON.parse(JSON.stringify(doc)));
            const history = { a: null as unknown, b: null as unknown };
            a.on('history', (h) => (history.a = h));
            b.on('history', (h) => (history.b = h));
            const counter = { n: 0 };
            const log: string[] = [];
            let checkpoint: { a: ReturnType<Store['checkpoint']>; b: ReturnType<LegacyStore['checkpoint']> } | null = null;
            let batch = 0;
            for (let i = 0; i < 150; i++) {
                const r = rng.next();
                if (r < 0.03) {
                    // An assistant request: its steps become one, hand edits between them stay.
                    const id = `b${++batch}`;
                    for (let k = 1 + rng.int(4); k > 0; k--) {
                        const hand = rng.chance(0.2);
                        const op = makeOps(rng, a, counter);
                        if (op.name === 'undo' || op.name === 'redo') continue;
                        log.push(`${op.name}${hand ? '' : ` (in ${id})`}`);
                        for (const s of [a, b]) {
                            s.batch = hand ? null : id;
                            op.run(s);
                            s.batch = null;
                        }
                    }
                    log.push(`squash ${id}`);
                    expect(a.squash(id, 'Request')).toBe(b.squash(id, 'Request'));
                } else if (r < 0.05) {
                    log.push(checkpoint ? 'restore checkpoint' : 'checkpoint');
                    if (checkpoint) {
                        a.restoreCheckpoint(checkpoint.a);
                        b.restoreCheckpoint(checkpoint.b);
                        checkpoint = null;
                    } else checkpoint = { a: a.checkpoint(), b: b.checkpoint() };
                } else {
                    const op = makeOps(rng, a, counter);
                    log.push(op.name);
                    op.run(a);
                    op.run(b);
                }
                const where = `seed ${seed}, after ${log.slice(-6).join(' > ')}`;
                expectSame(a, b, history, where);
                expectIndexed(a, where);
            }
            // Everything undoes back to the start and redoes to the end.
            while (b.canUndo) {
                a.undo();
                b.undo();
                expectSame(a, b, history, `seed ${seed}, undoing all`);
            }
            while (b.canRedo) {
                a.redo();
                b.redo();
                expectSame(a, b, history, `seed ${seed}, redoing all`);
            }
            expectIndexed(a, `seed ${seed}, at the end`);
        }
    }, 60_000);

    it('keeps the objects a hinted change touched, not the document', () => {
        const nodes = Array.from({ length: 2000 }, (_, i) => ({ ...makeMeshNode('box'), id: `n${i}`, name: `Box ${i}` }));
        const s = new Store({ ...emptyScene(), nodes });
        s.verifyHistory = false;
        const whole = JSON.stringify(s.doc).length;
        s.commit('Move', (d) => (d.nodes[5].position = [1, 2, 3]), { nodes: ['n5'], transform: true });
        const one = s.historyBytes;
        expect(one).toBeLessThan(1000);
        s.commit('Add', (d) => void d.nodes.push({ ...makeNode('New'), id: 'new' }));
        expect(s.historyBytes - one).toBeGreaterThan(whole);
        s.undo();
        s.undo();
        expect(s.doc.nodes[5].position).toEqual([0, 0.5, 0]);
        expect(s.doc.nodes.length).toBe(2000);
    });

    it('drops the oldest steps beyond its budget, always keeping the last', () => {
        const s = new Store({ ...emptyScene(), nodes: [{ ...makeNode('A'), id: 'a' }] });
        s.historyBudget = 3000;
        for (let i = 1; i <= 50; i++) s.commit(`Move ${i}`, (d) => (d.nodes[0].position = [i, 0, 0]), { nodes: ['a'], transform: true });
        expect(s.historyBytes).toBeLessThanOrEqual(3000);
        let steps = 0;
        while (s.undoLabel) {
            s.undo();
            steps++;
        }
        expect(steps).toBeGreaterThan(3);
        expect(steps).toBeLessThan(50);
        expect(s.doc.nodes[0].position[0]).toBe(50 - steps);
        s.historyBudget = 1;
        s.commit('Last', (d) => (d.nodes[0].name = 'B'), { nodes: ['a'] });
        expect(s.undoLabel).toBe('Last');
    });

    it('squashes a request into one step holding each object as it was first', () => {
        const s = new Store({ ...emptyScene(), nodes: [{ ...makeNode('A'), id: 'a' }, { ...makeNode('B'), id: 'b' }] });
        s.batch = 'r';
        s.commit('Move A', (d) => (d.nodes[0].position = [1, 0, 0]), { nodes: ['a'], transform: true });
        s.commit('Move A again', (d) => (d.nodes[0].position = [2, 0, 0]), { nodes: ['a'], transform: true });
        s.commit('Rename B', (d) => (d.nodes[1].name = 'Bee'), { nodes: ['b'] });
        s.batch = null;
        expect(s.squash('r', 'Request')).toBe(true);
        expect(s.undoLabel).toBe('Request');
        s.undo();
        expect(s.doc.nodes.map((n) => [n.name, n.position[0]])).toEqual([['A', 0], ['B', 0]]);
        expect(s.undoLabel).toBe('');
        s.redo();
        expect(s.doc.nodes.map((n) => [n.name, n.position[0]])).toEqual([['A', 2], ['Bee', 0]]);
    });

    it('reports a change that touched what its hint leaves out', () => {
        const s = new Store({ ...emptyScene(), nodes: [{ ...makeNode('A'), id: 'a' }, { ...makeNode('B'), id: 'b' }] });
        const problems: string[] = [];
        Store.historyProblem = (m) => void problems.push(m);
        s.commit('Wrong', (d) => {
            d.nodes[0].name = 'A2';
            d.nodes[1].name = 'B2';
        }, { nodes: ['a'] });
        expect(problems.join()).toMatch(/Undo of "Wrong" would not bring back object "B"/);
        s.commit('Wrong too', (d) => (d.environment.exposure = 3), { nodes: ['b'] });
        expect(problems.length).toBe(2);
        expect(problems[1]).toMatch(/environment/);
        s.commit('Right', (d) => (d.environment.exposure = 2), { env: true });
        expect(problems.length).toBe(2);
    });

    it('gives numbers that change with what they cover', () => {
        const s = new Store({ ...emptyScene(), nodes: [{ ...makeNode('A'), id: 'a' }, { ...makeNode('B'), id: 'b' }] });
        const v = () => ({ all: s.version, structure: s.structureVersion, parts: s.partsVersion, a: s.nodeVersion('a'), b: s.nodeVersion('b') });
        const v0 = v();
        s.commit('Move', (d) => (d.nodes[0].position = [1, 0, 0]), { nodes: ['a'], transform: true });
        const v1 = v();
        expect(v1.all).toBeGreaterThan(v0.all);
        expect([v1.structure, v1.parts, v1.b]).toEqual([v0.structure, v0.parts, v0.b]);
        expect(v1.a).toBeGreaterThan(v0.a);
        s.commit('Exposure', (d) => (d.environment.exposure = 2), { env: true });
        const v2 = v();
        expect(v2.parts).toBeGreaterThan(v1.parts);
        expect([v2.structure, v2.a, v2.b]).toEqual([v1.structure, v1.a, v1.b]);
        // A change without a hint may touch anything, but only a new order of the objects is a new structure.
        s.commit('Texture', (d) => (d.nodes[1].name = 'B2'));
        const v3 = v();
        expect(v3.structure).toBe(v2.structure);
        expect(v3.b).toBeGreaterThan(v2.b);
        s.commit('Reparent', (d) => (d.nodes[1].parent = 'a'));
        expect(s.structureVersion).toBeGreaterThan(v3.structure);
        s.undo();
        expect(s.children('a')).toEqual([]);
        expect(s.children(null).map((n) => n.id)).toEqual(['a', 'b']);
    });

    it('hints what an undo brings back, so views can follow only that', () => {
        const s = new Store({ ...emptyScene(), nodes: [{ ...makeNode('A'), id: 'a' }] });
        const hints: (ChangeHint | undefined)[] = [];
        s.on('change', (h) => hints.push(h));
        s.begin('Drag');
        s.update((d) => (d.nodes[0].position = [1, 0, 0]), { nodes: ['a'], transform: true });
        s.update((d) => (d.nodes[0].position = [2, 0, 0]), { nodes: ['a'], transform: true });
        s.end();
        hints.length = 0;
        s.undo();
        s.redo();
        expect(hints).toEqual([{ nodes: ['a'], transform: true }, { nodes: ['a'], transform: true }]);
        s.commit('Add', (d) => void d.nodes.push({ ...makeNode('B'), id: 'b' }));
        hints.length = 0;
        s.undo();
        expect(hints).toEqual([undefined]);
    });
});

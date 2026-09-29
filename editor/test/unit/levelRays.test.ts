import { describe, expect, it } from 'vitest';
import { makeNode, newScene } from '../../src/core/defaults';
import { Store } from '../../src/core/store';
import type { NodeDoc, Vec3 } from '../../src/core/types';
import { LevelRays } from '../../src/engine/levelRays';
import { Picker, rendererWorldBox } from '../../src/engine/picking';
import { TransformWatch } from '../../src/engine/transformWatch';
import { asObject, boxRenderer, FakeObject, FakeSync } from './fakeEngine';

/** A level of boxes: node ids, their objects and renderers, a store and a sync over them. */
function level(count: number, seed = 1) {
    let s = seed;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const doc = newScene();
    doc.nodes = [];
    const sync = new FakeSync();
    const objs = new Map<string, FakeObject>();
    const root = new FakeObject();
    for (let i = 0; i < count; i++) {
        const n: NodeDoc = makeNode(`Box ${i}`);
        n.id = `b${i}`;
        doc.nodes.push(n);
        const obj = new FakeObject();
        root.addChild(obj);
        obj.x = Math.round((rnd() * 40 - 20) * 10) / 10;
        obj.y = 0.5;
        obj.z = Math.round((rnd() * 40 - 20) * 10) / 10;
        obj.rotationY = Math.floor(rnd() * 360);
        sync.add(n.id, obj, [boxRenderer(obj, [0.5 + rnd() * 2, 1, 0.5 + rnd() * 2])]);
        objs.set(n.id, obj);
    }
    const store = new Store(doc);
    const picker = new Picker(null as any, sync.asSync(), store);
    return { store, sync, picker, objs, root, rnd };
}

const hitDistance = (rays: LevelRays, o: Vec3, d: Vec3, max = 100) => rays.cast(o, d, max)?.distance ?? null;

describe('world boxes', () => {
    it('match the box around the eight turned corners', () => {
        const obj = new FakeObject();
        obj.x = 3;
        obj.rotationY = 37;
        obj.scaleX = -2;
        const r = boxRenderer(obj, [1, 2, 3]);
        const box = rendererWorldBox(r)!;
        const m = obj.transform.worldMatrix.rawData;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < 8; i++) {
            const p = [i & 1 ? 0.5 : -0.5, i & 2 ? 1 : -1, i & 4 ? 1.5 : -1.5];
            for (let k = 0; k < 3; k++) {
                const v = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k];
                min[k] = Math.min(min[k], v);
                max[k] = Math.max(max[k], v);
            }
        }
        for (let k = 0; k < 3; k++) {
            expect(box.min[k]).toBeCloseTo(min[k], 10);
            expect(box.max[k]).toBeCloseTo(max[k], 10);
        }
    });
});

describe('TransformWatch', () => {
    it('hears an object move, and its parent move, until cleared', () => {
        const parent = new FakeObject();
        const child = new FakeObject();
        parent.addChild(child);
        const watch = new TransformWatch<string>();
        watch.watch(asObject(child), 'a');
        watch.watch(asObject(child), 'b');
        expect(child.listenerCount).toBe(1);
        child.x = 1;
        expect([...watch.moved]).toEqual(['a', 'b']);
        watch.moved.clear();
        parent.z = 4;
        expect(watch.moved.has('a')).toBe(true);
        watch.clear();
        expect(child.listenerCount).toBe(0);
        child.x = 2;
        expect(watch.moved.size).toBe(0);
    });
});

describe('level rays that follow the level', () => {
    it('see objects where they moved, without a refresh', () => {
        const { store, sync, picker, objs } = level(1);
        const box = objs.get('b0')!;
        box.x = 0;
        box.z = 0;
        box.rotationY = 0;
        const rays = new LevelRays(picker, sync.asSync(), store, undefined, { track: true });
        const along = (): number | null => hitDistance(rays, [-10, 0.5, 0], [1, 0, 0]);
        const d0 = along()!;
        box.x = 3;
        expect(along()).toBeCloseTo(d0 + 3, 6);
        // Hidden by a script, shown again.
        const r = sync.renderersOf('b0')[0];
        r.enable = false;
        expect(along()).toBeNull();
        r.enable = true;
        expect(along()).toBeCloseTo(d0 + 3, 6);
        rays.dispose();
        expect(box.listenerCount).toBe(0);
    });

    it('follow a moved parent, leave out destroyed objects and take in new ones', () => {
        const { store, sync, picker, objs, root } = level(2);
        const a = objs.get('b0')!, b = objs.get('b1')!;
        const group = new FakeObject();
        root.addChild(group);
        group.addChild(a);
        a.x = 0;
        a.z = 0;
        b.x = 0;
        b.z = 50;
        const rays = new LevelRays(picker, sync.asSync(), store, undefined, { track: true });
        expect(hitDistance(rays, [0, 0.5, -10], [0, 0, 1])).not.toBeNull();
        group.z = 30;
        // The ray now reaches the box where the group took it.
        expect(hitDistance(rays, [0, 0.5, 10], [0, 0, 1], 25)).not.toBeNull();
        expect(hitDistance(rays, [0, 0.5, -10], [0, 0, 1], 15)).toBeNull();

        // A script destroys it.
        sync.detached.add('b0');
        a.removeFromParent();
        expect(hitDistance(rays, [0, 0.5, 10], [0, 0, 1], 25)).toBeNull();

        // A new object in the document.
        const obj = new FakeObject();
        obj.x = 5;
        obj.y = 0.5;
        sync.add('b2', obj, [boxRenderer(obj)]);
        store.commit('Add', (d) => d.nodes.push({ ...makeNode('New'), id: 'b2' }));
        expect(hitDistance(rays, [-5, 0.5, 0], [1, 0, 0], 20)).not.toBeNull();
        rays.dispose();
    });

    it('find what a fresh look at the level finds, as things move', () => {
        const { store, sync, picker, objs, rnd } = level(300, 7);
        const tracked = new LevelRays(picker, sync.asSync(), store, undefined, { track: true });
        const ids = [...objs.keys()];
        for (let round = 0; round < 20; round++) {
            for (let k = 0; k < 15; k++) {
                const o = objs.get(ids[Math.floor(rnd() * ids.length)])!;
                o.x = o.x + (rnd() * 6 - 3);
                if (rnd() < 0.3) o.rotationY = Math.floor(rnd() * 360);
            }
            const fresh = new LevelRays(picker, sync.asSync(), store);
            fresh.refresh();
            for (let k = 0; k < 40; k++) {
                const o: Vec3 = [rnd() * 44 - 22, 0.2 + rnd() * 0.6, rnd() * 44 - 22];
                const a = rnd() * Math.PI * 2;
                const d: Vec3 = [Math.cos(a), rnd() * 0.2 - 0.1, Math.sin(a)];
                const len = rnd() < 0.2 ? 80 : 4;
                const want = hitDistance(fresh, o, d, len);
                const got = hitDistance(tracked, o, d, len);
                if (want === null) expect(got).toBeNull();
                else expect(got).toBeCloseTo(want, 9);
            }
        }
        tracked.dispose();
    });
});

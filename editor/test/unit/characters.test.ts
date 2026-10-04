import { describe, expect, it } from 'vitest';
import { defaultCharacter } from '../../src/core/character';
import { makeNode, newScene } from '../../src/core/defaults';
import { Store } from '../../src/core/store';
import type { Vec3 } from '../../src/core/types';
import { Picker } from '../../src/engine/picking';
import { Characters } from '../../src/play/character';
import { asObject, boxRenderer, FakeObject, FakeSync } from './fakeEngine';

/** A level of boxes by id (center, size): a store and a sync over them, and their objects. */
function boxes(list: [string, Vec3, Vec3][]) {
    const doc = newScene();
    doc.nodes = [];
    const sync = new FakeSync();
    const objs = new Map<string, FakeObject>();
    for (const [id, at, size] of list) {
        doc.nodes.push({ ...makeNode(id), id });
        const obj = new FakeObject();
        [obj.x, obj.y, obj.z] = at;
        sync.add(id, obj, [boxRenderer(obj, size)]);
        objs.set(id, obj);
    }
    const store = new Store(doc);
    return { store, sync, picker: new Picker(null as any, sync.asSync(), store), objs };
}

describe('Characters', () => {
    it('leave out of the level what scripts turned the collisions of off', () => {
        // A floor, and a can a script holds at a cat's mouth as it hops there (the laundromat's).
        const { store, sync, picker, objs } = boxes([['floor', [0, -0.1, 0], [10, 0.2, 10]], ['can', [1, 0.1, 0], [0.16, 0.2, 0.16]]]);
        const off = new Set(['can']);
        const chars = new Characters(picker, sync.asSync(), store, off);
        // The cat's origin is 0.25 m over its feet, so the can at its mouth holds the start of its ground ray.
        const obj = new FakeObject();
        obj.y = 0.25;
        const cat = chars.add(asObject(obj), { ...defaultCharacter(), height: 0.3, radius: 0.12, eyeHeight: 0.25, stepHeight: 0.14 }, ['cat'], 0);
        const can = objs.get('can')!;
        const hold = (frames: number) => {
            for (let i = 0; i < frames; i++) {
                const m = obj.transform.worldMatrix.rawData;
                [can.x, can.y, can.z] = [m[12], m[13] + 0.2, m[14]];
                chars.update(1 / 60);
            }
        };
        hold(30);
        expect(cat.feet[1]).toBeCloseTo(0, 6);

        // Collisions on, the cat stands on the can, which goes up with it: up and up it goes.
        off.delete('can');
        chars.rays.invalidate();
        hold(10);
        expect(cat.feet[1]).toBeGreaterThan(2);
    });
});

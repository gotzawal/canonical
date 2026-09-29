// What the level costs characters in Play (engine/levelRays.ts): catching
// up with what moved each frame, and the rays of about 20 walking
// characters, among 2,000 objects. `pnpm run editor:bench` fails when a
// benchmark named "(budget N ms)" takes longer (its 75th percentile).

import { bench, describe } from 'vitest';
import { makeNode, newScene } from '../../src/core/defaults';
import { Store } from '../../src/core/store';
import type { Vec3 } from '../../src/core/types';
import { LevelRays } from '../../src/engine/levelRays';
import { Picker } from '../../src/engine/picking';
import { boxRenderer, FakeObject, FakeSync } from '../unit/fakeEngine';

const COUNT = 2000;
let s = 3;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const doc = newScene();
doc.nodes = [];
const sync = new FakeSync();
const objs: FakeObject[] = [];
for (let i = 0; i < COUNT; i++) {
    const n = { ...makeNode(`Prop ${i}`), id: `p${i}` };
    doc.nodes.push(n);
    const obj = new FakeObject();
    obj.x = rnd() * 190 - 95;
    obj.y = 0.5;
    obj.z = rnd() * 190 - 95;
    obj.rotationY = Math.floor(rnd() * 360);
    sync.add(n.id, obj, [boxRenderer(obj, [0.5 + rnd(), 1, 0.5 + rnd()])]);
    objs.push(obj);
}
const store = new Store(doc);
const picker = new Picker(null as any, sync.asSync(), store);
const tracked = new LevelRays(picker, sync.asSync(), store, undefined, { track: true });
const polled = new LevelRays(picker, sync.asSync(), store);
tracked.flush();
polled.refresh();

// 20 characters' rays in a frame (walking: about 23 short rays each).
const rays: [Vec3, Vec3, number][] = [];
for (let c = 0; c < 20; c++) {
    const at: Vec3 = [rnd() * 190 - 95, 0, rnd() * 190 - 95];
    for (let k = 0; k < 23; k++) {
        const a = rnd() * Math.PI * 2;
        rays.push(k % 8 === 0 ? [[at[0], 0.9, at[2]], [0, -1, 0], 0.7] : [[at[0], 0.35 + (k % 5) * 0.35, at[2]], [Math.cos(a), 0, Math.sin(a)], 0.45]);
    }
}
let turn = 0;

describe('catch up with the level each frame', () => {
    bench('nothing moved (budget 0.02 ms)', () => tracked.flush());
    bench('20 objects moved (budget 0.3 ms)', () => {
        for (let k = 0; k < 20; k++) {
            const o = objs[turn++ % COUNT];
            o.x += turn % 2 ? 0.01 : -0.01;
        }
        tracked.flush();
    });
    bench('before: every object boxed again', () => polled.refresh(), { iterations: 50, time: 0 });
});

describe('rays of 20 walking characters', () => {
    bench(`${rays.length} rays among ${COUNT} objects (budget 1 ms)`, () => {
        for (const [o, d, m] of rays) tracked.cast(o, d, m);
    });
});

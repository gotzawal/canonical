// The behavior tree runtime: Parallel, Random Selector, and the Repeat,
// Retry, Invert, Force Result and Time Limit decorators, driven tick by
// tick through script tasks the test finishes.
import { describe, expect, it } from 'vitest';
import { Blackboard } from '../../src/play/ai/blackboard';
import { hear, see, type Senser } from '../../src/play/ai/sensors';
import { TreeInstance, type TaskHandle, type TreeHost } from '../../src/play/ai/tree';
import type { BehaviorTreeDoc, BtNodeDoc, HearingServiceDoc, SightServiceDoc, Vec3 } from '../../src/core/types';

type Behavior = 'ok' | 'no' | 'run';

/** A tree over script tasks: `plan` says what each method does; calls and open handles are recorded. */
function harness(root: BtNodeDoc, plan: Record<string, Behavior>, random = () => 0.5) {
    let time = 0;
    const calls: string[] = [];
    const open = new Map<string, TaskHandle>();
    const aborted: string[] = [];
    const bb = new Blackboard({ id: 's', name: 'S', version: 1, keys: [] }, {}, () => null);
    const host = {
        blackboard: bb,
        now: () => time,
        random,
        callTask: (doc: any, task: TaskHandle) => {
            calls.push(doc.method);
            const b = plan[doc.method];
            if (b === 'run') {
                open.set(doc.method, task);
                return 'running';
            }
            return b === 'ok';
        },
        abortTask: (doc: any) => aborted.push(doc.method),
        contextVersion: 0,
        warn: () => {},
    } as unknown as TreeHost;
    const tree: BehaviorTreeDoc = { id: 't', name: 'T', version: 1, schema: 's', root } as BehaviorTreeDoc;
    const inst = new TreeInstance(tree, host);
    return {
        inst,
        calls,
        open,
        aborted,
        tick(dt = 0.1) {
            time += dt;
            inst.tick();
        },
        last: (id: string) => inst.debug().last[id]?.status,
    };
}

const task = (method: string, decorators: any[] = []): BtNodeDoc => ({ id: method, type: 'script', method, script: '', decorators }) as BtNodeDoc;
const seq = (id: string, children: BtNodeDoc[], decorators: any[] = []): BtNodeDoc => ({ id, type: 'sequence', children, decorators }) as BtNodeDoc;

describe('behavior tree runtime', () => {
    it('Parallel all: succeeds once every child has, and aborts the rest when one fails', () => {
        const h = harness(seq('root', [{ id: 'par', type: 'parallel', policy: 'all', children: [task('walk'), task('look')] } as BtNodeDoc, task('after')]), { walk: 'run', look: 'run', after: 'ok' });
        h.tick();
        expect(h.inst.debug().running).toEqual(['walk', 'look']);
        h.open.get('walk')!.succeed();
        h.tick();
        expect(h.inst.debug().running).toEqual(['look']);
        h.open.get('look')!.succeed();
        h.tick();
        expect(h.calls).toEqual(['walk', 'look', 'after']);
        expect(h.last('par')).toBe('success');

        const f = harness({ id: 'par', type: 'parallel', policy: 'all', children: [task('walk'), task('look')] } as BtNodeDoc, { walk: 'run', look: 'run' });
        f.tick();
        f.open.get('look')!.fail();
        f.tick();
        expect(f.last('par')).toBe('failure');
        expect(f.aborted).toEqual(['walk']);
    });

    it('Parallel first: the side branch starts over until the first child ends', () => {
        const h = harness({ id: 'par', type: 'parallel', policy: 'first', children: [task('walk'), task('bark')] } as BtNodeDoc, { walk: 'run', bark: 'ok' });
        h.tick();
        h.tick();
        h.tick();
        expect(h.calls.filter((c) => c === 'bark').length).toBe(3);
        h.open.get('walk')!.succeed();
        h.tick();
        expect(h.last('par')).toBe('success');
        expect(h.calls.filter((c) => c === 'walk').length).toBe(1);
    });

    it('Repeat runs once per tick, Retry tries again, Invert and Force change results', () => {
        const r = harness(seq('root', [task('step', [{ type: 'repeat', count: 3 }]), task('done')]), { step: 'ok', done: 'ok' });
        r.tick();
        expect(r.calls).toEqual(['step']);
        r.tick();
        r.tick();
        expect(r.calls).toEqual(['step', 'step', 'step', 'done']);

        const t = harness(seq('root', [task('open', [{ type: 'retry', count: 2 }, { type: 'force', result: 'success' }]), task('enter')]), { open: 'no', enter: 'ok' });
        t.tick();
        t.tick();
        expect(t.calls).toEqual(['open', 'open', 'enter']);

        const i = harness(seq('root', [task('check', [{ type: 'invert' }]), task('act')]), { check: 'no', act: 'ok' });
        i.tick();
        expect(i.calls).toEqual(['check', 'act']);
    });

    it('Time Limit aborts a run that takes too long, and it fails', () => {
        const h = harness({ id: 'sel', type: 'selector', children: [task('slow', [{ type: 'time_limit', seconds: 0.5 }]), task('other')] } as BtNodeDoc, { slow: 'run', other: 'ok' });
        h.tick();
        h.tick(0.3);
        expect(h.calls).toEqual(['slow']);
        h.tick(0.3);
        expect(h.aborted).toEqual(['slow']);
        expect(h.calls).toEqual(['slow', 'other']);
    });

    it('Random Selector tries its children in a drawn order until one succeeds', () => {
        const children = [task('a'), task('b'), task('c')];
        const first = harness({ id: 'rnd', type: 'random', children } as BtNodeDoc, { a: 'no', b: 'no', c: 'ok' }, () => 0);
        first.tick();
        const second = harness({ id: 'rnd', type: 'random', children } as BtNodeDoc, { a: 'no', b: 'no', c: 'ok' }, () => 0.99);
        second.tick();
        expect(first.calls.at(-1)).toBe('c');
        expect(second.calls.at(-1)).toBe('c');
        expect(first.calls.join()).not.toBe(second.calls.join());
    });
});

describe('senses', () => {
    const obj = (x: number, z: number) => ({ name: `at ${x}`, transform: { worldPosition: { x, y: 0, z } } }) as any;
    const senser = (wall: number | null) => {
        const facts: Record<string, unknown> = {};
        const noises: { at: Vec3; range: number; source: any; seq: number }[] = [];
        const self = obj(0, 0);
        const s: Senser = {
            obj: self,
            name: 'Guard',
            now: () => 1,
            eyes: () => [0, 1.6, 0],
            facing: () => 0,
            aimPoint: (o: any) => [o.transform.worldPosition.x, 1.2, o.transform.worldPosition.z],
            // A wall across the x axis at `wall` meters (rays toward +x meet it).
            castLevel: (o, d, max) => (wall !== null && d[0] > 0 ? Math.min(max + 1, (wall - o[0]) / d[0]) : null),
            candidates: () => [target],
            noises: () => noises,
            marker: () => obj(0, 0),
            writeFact: (_s, key, v) => (facts[key] = v),
        };
        const target = obj(0, 8);
        return { s, facts, noises, target };
    };
    const sight = { id: 'eyes', type: 'sight', targets: 'named', name: '', range: 10, fov: 90, lineOfSight: true, memory: 2, output: 'seen', visible: 'sees', distance: 'dist', position: '' } as SightServiceDoc;
    const hearing = { id: 'ears', type: 'hearing', sensitivity: 1, walls: true, memory: 2, heard: 'heard', source: 'src', position: '' } as HearingServiceDoc;

    it('Sight sees what is in its field of view, in range and not behind a wall', () => {
        const a = senser(null);
        see(a.s, sight);
        expect(a.facts).toMatchObject({ sees: true, dist: 8 });
        a.target.transform.worldPosition = { x: 8, y: 0, z: 0 };
        see(a.s, sight);
        expect(a.facts.sees).toBe(false);
        const b = senser(4);
        b.target.transform.worldPosition = { x: 6, y: 0, z: 6 };
        see(b.s, { ...sight, fov: 360 });
        expect(b.facts.sees).toBe(false);
    });

    it('Hearing takes sounds made since it last listened, halved by walls', () => {
        const a = senser(3);
        hear(a.s, hearing);
        expect(a.facts.heard).toBe(false);
        // Made after it listened in the same frame: still heard next time.
        a.noises.push({ at: [0, 0, 5], range: 6, source: a.target, seq: 1 });
        hear(a.s, hearing);
        expect(a.facts).toMatchObject({ heard: true, src: a.target });
        // Behind the wall at x = 3 a 6 m sound carries 3 m: from 5 m away it is not heard.
        const b = senser(3);
        b.noises.push({ at: [5, 0, 0], range: 6, source: null, seq: 1 });
        hear(b.s, hearing);
        expect(b.facts.heard).toBe(false);
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyScene, makeNode } from '../../src/core/defaults';
import { mergeHints, Store, type ChangeHint } from '../../src/core/store';
import { onChanges, touches } from '../../src/ui/batch';

describe('views that follow changes once a frame', () => {
    afterEach(() => void vi.useRealTimers());

    it('merge what changed: the objects of moves, one kind of part, else anything', () => {
        expect(mergeHints(null, { nodes: ['a'], transform: true })).toEqual({ nodes: ['a'], transform: true });
        expect(mergeHints({ nodes: ['a'], transform: true }, { nodes: ['b'], transform: true })).toEqual({ nodes: ['a', 'b'], transform: true });
        // A move and another change of an object: the objects, not only their transforms.
        expect(mergeHints({ nodes: ['a'], transform: true }, { nodes: ['a'] })).toEqual({ nodes: ['a'] });
        expect(mergeHints({ design: true }, { design: true })).toEqual({ design: true });
        expect(mergeHints({ nodes: ['a'] }, { design: true })).toBeUndefined();
        expect(mergeHints({ env: true }, undefined)).toBeUndefined();
        const renamed = mergeHints({ behavior: true, renamed: new Map([['t:1', new Map([['x', 'y']])]]) }, { behavior: true, renamed: new Map([['t:1', new Map([['y', 'z']])]]) });
        expect(renamed?.renamed?.get('t:1')).toEqual(new Map([['x', 'z'], ['y', 'z']]));
    });

    it('tell a view whether a change can touch what it shows', () => {
        const move: ChangeHint = { nodes: ['a'], transform: true };
        expect(touches(move, 'nodes', 'design')).toBe(false);
        expect(touches(move, 'transform')).toBe(true);
        expect(touches({ nodes: ['a'] }, 'nodes')).toBe(true);
        expect(touches({ nodes: ['a'] }, 'transform')).toBe(true);
        expect(touches({ env: true }, 'design')).toBe(false);
        // Without a hint anything may have changed (the scripts and shaders too).
        expect(touches(undefined)).toBe(true);
        expect(touches({ renamed: new Map() })).toBe(true);
        expect(touches({ behavior: true })).toBe(false);
    });

    it('call a view once for the changes of a frame, with them merged', () => {
        vi.useFakeTimers();
        const store = new Store({ ...emptyScene(), nodes: [{ ...makeNode('A'), id: 'a' }, { ...makeNode('B'), id: 'b' }] });
        const calls: (ChangeHint | undefined)[] = [];
        const view = onChanges(store, (hint) => calls.push(hint));
        store.begin('Drag');
        for (let i = 1; i <= 5; i++) store.update((d) => (d.nodes[0].position = [i, 0, 0]), { nodes: ['a'], transform: true });
        store.update((d) => (d.nodes[1].position = [1, 0, 0]), { nodes: ['b'], transform: true });
        store.end();
        expect(calls).toEqual([]);
        vi.advanceTimersByTime(20);
        expect(calls).toEqual([{ nodes: ['a', 'b'], transform: true }]);

        // A view about to be read catches up at once.
        store.commit('Rename', (d) => (d.nodes[0].name = 'A2'), { nodes: ['a'] });
        view.flush();
        expect(calls.length).toBe(2);
        vi.advanceTimersByTime(20);
        expect(calls.length).toBe(2);

        view.off();
        store.commit('Rename', (d) => (d.nodes[0].name = 'A3'), { nodes: ['a'] });
        vi.advanceTimersByTime(20);
        expect(calls.length).toBe(2);
    });
});

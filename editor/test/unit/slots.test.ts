import { describe, expect, it } from 'vitest';
import { emptyScene, makeMeshNode } from '../../src/core/defaults';
import { Store } from '../../src/core/store';
import { assignSlot, deleteSlot, upsertSlot } from '../../src/design/materialSlots';

describe('material slots', () => {
    // setup.ts makes an undo step that would not bring back what its change touched fail the test.
    it('undoes deleting a slot, links to its meshes included', () => {
        const store = new Store({ ...emptyScene(), nodes: [{ ...makeMeshNode('box'), id: 'a' }, { ...makeMeshNode('box'), id: 'b' }] });
        const slot = upsertSlot(store, { name: 'Stone' });
        expect(assignSlot(store, slot.id, ['a'])).toBe(1);
        expect(store.node('a')!.mesh!.material.slot).toBe(slot.id);
        deleteSlot(store, slot.id);
        expect(store.node('a')!.mesh!.material.slot).toBeUndefined();
        store.undo();
        expect(store.doc.design.materials.map((s) => s.name)).toEqual(['Stone']);
        expect(store.node('a')!.mesh!.material.slot).toBe(slot.id);
        expect(store.node('b')!.mesh!.material.slot).toBeUndefined();
        // A slot no mesh uses changes only the design.
        const free = upsertSlot(store, { name: 'Wood' });
        deleteSlot(store, free.id);
        store.undo();
        expect(store.doc.design.materials.map((s) => s.name)).toEqual(['Stone', 'Wood']);
    });
});

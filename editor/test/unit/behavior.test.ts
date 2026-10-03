import { describe, expect, it } from 'vitest';
import { emptyScene } from '../../src/core/defaults';
import { applyBehaviorOps, writeBehaviorChanges, type BehaviorOp } from '../../src/core/behavior/ops';
import { validateSchema, validateTree } from '../../src/core/behavior/validate';
import type { SceneDoc } from '../../src/core/types';

const guard: BehaviorOp[] = [
    { op: 'create_schema', name: 'Guard', id: 'bb_guard', keys: [
        { name: 'alert', type: 'bool', owner: 'fact', default: false },
        { name: 'mode', type: 'enum', owner: 'tree', values: [{ value: 'patrol', description: '' }, { value: 'chase', description: '' }], default: 'patrol' },
    ] },
    { op: 'create_tree', name: 'Guard', schema: 'Guard', id: 'bt_guard' },
    { op: 'add_node', tree: 'Guard', parent: 'root', node: { type: 'wait', id: 'look_around', seconds: 2 } },
    { op: 'add_decorator', tree: 'Guard', node: 'look_around', decorator: { type: 'condition', key: 'alert', op: 'eq', value: true } },
];

/** A scene with the ops applied (and committed), failing the test when they are refused. */
function withOps(ops: BehaviorOp[], doc: SceneDoc = emptyScene()): SceneDoc {
    const r = applyBehaviorOps(doc, ops, 'strict');
    expect(r.errors).toEqual([]);
    writeBehaviorChanges(doc, r.changes!);
    return doc;
}

describe('behavior ops', () => {
    it('builds a schema and a tree in one batch', () => {
        const doc = emptyScene();
        const r = applyBehaviorOps(doc, guard, 'strict');
        expect(r.ok).toBe(true);
        expect(r.created.map((c) => c.kind)).toEqual(['schema', 'tree', 'node']);
        expect(r.label).toMatch(/Behavior Edits/);
        // Nothing is written before the caller commits.
        expect(doc.behaviors).toEqual([]);
        writeBehaviorChanges(doc, r.changes!);
        const tree = doc.behaviors[0];
        expect(tree.version).toBe(1);
        expect(tree.root.type).toBe('selector');
        expect((tree.root as any).children[0]).toMatchObject({ id: 'look_around', type: 'wait', seconds: 2 });
    });

    it('applies a batch as a whole or not at all', () => {
        const doc = withOps(guard);
        const before = JSON.stringify(doc);
        const r = applyBehaviorOps(doc, [
            { op: 'add_node', tree: 'Guard', parent: 'root', node: { type: 'wait', id: 'second' } },
            { op: 'delete_node', tree: 'Guard', node: 'nope' },
        ], 'strict');
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatchObject({ op: 1, name: 'delete_node' });
        expect(r.changes).toBeNull();
        expect(JSON.stringify(doc)).toBe(before);
    });

    it('refuses new validation errors in strict mode and applies them in lenient mode', () => {
        const doc = withOps(guard);
        const bad: BehaviorOp[] = [{ op: 'add_decorator', tree: 'Guard', node: 'look_around', decorator: { type: 'condition', key: 'missing', op: 'eq', value: true } }];
        const strict = applyBehaviorOps(doc, bad, 'strict');
        expect(strict.ok).toBe(false);
        expect(strict.errors[0]).toMatchObject({ name: 'validate', node: 'look_around' });
        const lenient = applyBehaviorOps(doc, bad, 'lenient');
        expect(lenient.ok).toBe(true);
        expect(lenient.added.some((i) => i.code === 'key-missing')).toBe(true);
    });

    it('renames a key everywhere the trees use it and raises the revisions', () => {
        const doc = withOps(guard);
        withOps([{ op: 'update_key', schema: 'Guard', key: 'alert', set: { name: 'alarmed' } }], doc);
        const cond = (doc.behaviors[0].root as any).children[0].decorators[0];
        expect(cond.key).toBe('alarmed');
        expect(doc.blackboards[0].version).toBe(2);
        expect(doc.behaviors[0].version).toBe(2);
    });

    it('refuses to delete a key that nodes use', () => {
        const doc = withOps(guard);
        const r = applyBehaviorOps(doc, [{ op: 'delete_key', schema: 'Guard', key: 'alert' }], 'strict');
        expect(r.ok).toBe(false);
        expect(r.errors[0].message).toMatch(/look_around/);
    });

    it('changes nothing for an edit that ends where it started', () => {
        const doc = withOps(guard);
        const r = applyBehaviorOps(doc, [
            { op: 'update_node', tree: 'Guard', node: 'look_around', set: { seconds: 5 } },
            { op: 'update_node', tree: 'Guard', node: 'look_around', set: { seconds: 2 } },
        ], 'strict');
        expect(r.ok).toBe(true);
        expect(r.changes).toBeNull();
    });
});

describe('behavior validation', () => {
    it('reports keys a tree names but its schema lacks, and values of the wrong type', () => {
        const doc = withOps(guard, emptyScene());
        const tree = doc.behaviors[0];
        const cond = (tree.root as any).children[0].decorators[0];
        cond.key = 'ghost';
        expect(validateTree(tree, doc.blackboards).map((i) => i.code)).toContain('key-missing');
        cond.key = 'alert';
        cond.value = 'yes';
        expect(validateTree(tree, doc.blackboards).map((i) => i.code)).toContain('value-type');
    });

    it('reports a tree without its schema', () => {
        const doc = withOps(guard, emptyScene());
        expect(validateTree(doc.behaviors[0], []).map((i) => i.code)).toContain('schema-missing');
    });

    it('checks schema keys: names, duplicates, enums and defaults', () => {
        const codes = validateSchema({
            id: 's', name: 'S', version: 1, keys: [
                { name: 'bad name', type: 'bool', owner: 'fact', default: false, description: '' },
                { name: 'k', type: 'number', owner: 'fact', default: 'x', description: '' },
                { name: 'k', type: 'enum', owner: 'tree', default: null, description: '', values: [] },
                { name: 'context', type: 'string', owner: 'fact', default: '', description: '' },
            ],
        }).map((i) => i.code);
        expect(codes).toEqual(expect.arrayContaining(['bad-id', 'value-type', 'duplicate-id', 'enum-empty', 'reserved']));
    });
});

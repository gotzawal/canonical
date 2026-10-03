import { describe, expect, it } from 'vitest';
import { defaultMaterial, emptyScene, makeMeshNode, makeNode, newScene, uid } from '../../src/core/defaults';
import { applyBehaviorOps, writeBehaviorChanges } from '../../src/core/behavior/ops';
import { defaultCharacter } from '../../src/core/character';
import { isMobileDevice } from '../../src/core/quality';
import { sanitize, Store, viewportDefaults } from '../../src/core/store';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES } from '../../src/core/templates';
import { SCENE_VERSION, type NodeDoc, type SceneDoc } from '../../src/core/types';

const scene = (...nodes: NodeDoc[]) => ({ ...emptyScene(), nodes });
const names = (s: Store) => s.doc.nodes.map((n) => n.name);

/** A scene with most of what a document holds: a script with fields, a shader material, a post effect, a character with a behavior tree and memory. */
function fullScene(): SceneDoc {
    const doc = emptyScene();
    const rotator = SCRIPT_TEMPLATES.find((t) => t.id === 'rotator')!;
    const script = { id: uid('s'), name: 'Rotator.js', code: rotator.code('Rotator') };
    const shaders = ['unlit', 'vignette'].map((id) => {
        const t = SHADER_TEMPLATES.find((x) => x.id === id)!;
        return { id: uid('sh'), name: `${id}.wgsl`, kind: t.kind, lighting: t.lighting, code: t.code };
    });
    const box = makeMeshNode('box');
    box.scripts = [{ script: script.id, enabled: true, props: { speed: 60, axis: 'x' } }];
    const orb = makeMeshNode('sphere');
    orb.mesh.material = { ...defaultMaterial('#ffffff'), type: 'shader', shader: shaders[0].id, params: { glow: '#3dd8ff' } };
    const guard = makeMeshNode('capsule');
    guard.name = 'Guard';
    guard.character = defaultCharacter();
    doc.nodes.push(box, orb, guard);
    doc.scripts.push(script);
    doc.shaders.push(...shaders);
    doc.renderGraph.posts.push({ id: uid('p'), shader: shaders[1].id, enabled: true, params: { strength: 0.5 } });
    const r = applyBehaviorOps(
        doc,
        [
            { op: 'create_schema', name: 'Guard', keys: [
                { name: 'dist', type: 'enum', owner: 'fact', default: 'far', values: [{ value: 'near', description: '' }, { value: 'far', description: '' }] },
                { name: 'threat', type: 'probability', owner: 'ai', description: 'Is the stranger a threat?' },
            ] },
            { op: 'create_tree', name: 'Guard', schema: 'Guard', root: { id: 'root', type: 'selector', services: [{ id: 'judge', type: 'ask', triggers: ['facts'], facts: ['dist'], questions: [{ key: 'threat', text: 'Is the stranger a threat?' }] }], children: [{ id: 'look', type: 'wait', seconds: 1.5 }] } },
            { op: 'set_agent', object: 'Guard', tree: 'Guard' },
            { op: 'add_memory', item: { id: 'rumor', text: 'A thief was seen near the gate.', tags: ['rumor'] } },
        ],
        'strict',
    );
    expect(r.errors).toEqual([]);
    writeBehaviorChanges(doc, r.changes!);
    return doc;
}

describe('sanitize', () => {
    it('keeps valid scenes as they are', () => {
        for (const doc of [newScene(), fullScene()]) {
            const plain = JSON.parse(JSON.stringify(doc));
            expect(JSON.parse(JSON.stringify(sanitize(plain)))).toEqual(plain);
        }
    });

    it('gives repeated ids new ones and drops parents that do not exist', () => {
        const a = makeNode('A');
        const b = { ...makeNode('B'), id: a.id };
        const c = makeNode('C', 'missing');
        const doc = sanitize(scene(a, b, c));
        expect(new Set(doc.nodes.map((n) => n.id)).size).toBe(3);
        expect(doc.nodes[2].parent).toBeNull();
    });

    it('breaks parent cycles', () => {
        const a = makeNode('A');
        const b = makeNode('B', a.id);
        a.parent = b.id;
        const doc = sanitize(scene(a, b));
        expect(doc.nodes.some((n) => n.parent === null)).toBe(true);
    });

    it('repairs components: unknown shapes, sizes, characters and script references', () => {
        const n = makeMeshNode('box') as any;
        n.mesh.geometry = { type: 'blob', width: 'wide' };
        n.character = { height: 500, radius: 'x', stepHeight: -1 };
        n.scripts = [{ script: 'gone', enabled: true, props: {} }];
        const doc = sanitize(scene(n));
        const out = doc.nodes[0];
        expect(out.mesh!.geometry).toEqual({ type: 'box', width: 1, height: 1, depth: 1 });
        expect(out.character!.height).toBe(20);
        expect(out.character!.radius).toBe(0.35);
        expect(out.character!.stepHeight).toBe(0);
        expect(out.scripts).toBeUndefined();
    });

    it('gives an older player a character body', () => {
        const n = makeNode('P') as any;
        n.player = { view: 'first', height: 1.6 };
        const out = sanitize(scene(n)).nodes[0];
        expect(out.player!.view).toBe('first');
        expect(out.character!.height).toBe(1.6);
    });

    it('brings old versions up and refuses newer ones', () => {
        const old = { ...emptyScene(), version: 1 } as any;
        delete old.blackboards;
        delete old.aiModels;
        const doc = sanitize(old);
        expect(doc.version).toBe(SCENE_VERSION);
        expect(doc.blackboards).toEqual([]);
        expect(doc.aiModels).toEqual([]);
        expect(() => sanitize({ ...emptyScene(), version: SCENE_VERSION + 1 })).toThrow(/newer version/);
    });

    it('moves the scene\'s directional shadow settings to its directional lights', () => {
        const sun = (id: string, castShadow: boolean) => ({ id, name: id, parent: null, visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], light: { type: 'directional', castShadow } });
        const old = { ...emptyScene(), version: 3, nodes: [sun('moon', false), sun('sun', true), sun('fill', true)] } as any;
        old.environment = { ...old.environment, shadow: { range: 150, softness: 2, follow: false, cascades: true } };
        const doc = sanitize(old);
        const shadow = (id: string) => doc.nodes.find((n) => n.id === id)!.light!.shadow;
        // The first that casts (the sun) takes the cascades; the others cover the range around the camera.
        expect([shadow('moon').coverage, shadow('sun').coverage, shadow('fill').coverage]).toEqual(['follow', 'cascades', 'follow']);
        expect(shadow('sun')).toMatchObject({ range: 150, cascades: 4, resolution: 'medium', update: 'auto' });
        expect(doc.environment.shadow).toEqual({ softness: 2 });
    });
});

describe('Store', () => {
    it('draws the viewport by the device, and moves stored old defaults to the new ones', () => {
        expect(viewportDefaults(false)).toEqual({ viewportFps: 60, viewportQuality: 'medium' });
        expect(viewportDefaults(true)).toEqual({ viewportFps: 30, viewportQuality: 'low' });
        expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })).toBe(true);
        expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
        expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 })).toBe(false);
        // An earlier build stored every preference, the old defaults too.
        localStorage.setItem('canonical-editor/prefs', JSON.stringify({ viewportFps: 30, viewportQuality: 'low', snap: true }));
        const s = new Store(scene());
        expect([s.prefs.viewportFps, s.prefs.viewportQuality, s.prefs.snap]).toEqual([60, 'medium', true]);
        // Now only a choice is stored, and it stays.
        s.setPrefs({ viewportFps: 30 });
        expect(JSON.parse(localStorage.getItem('canonical-editor/prefs')!)).toEqual({ v: 2, snap: true, viewportFps: 30 });
        expect(new Store(scene()).prefs.viewportFps).toBe(30);
        localStorage.removeItem('canonical-editor/prefs');
    });

    it('undoes and redoes committed steps', () => {
        const s = new Store(scene());
        s.commit('Add A', (d) => void d.nodes.push(makeNode('A')));
        s.commit('Add B', (d) => void d.nodes.push(makeNode('B')));
        expect(s.undoLabel).toBe('Add B');
        s.undo();
        expect(names(s)).toEqual(['A']);
        s.redo();
        expect(names(s)).toEqual(['A', 'B']);
    });

    it('makes one step of a transaction and none of an edit that changes nothing', () => {
        const s = new Store(scene(makeNode('A')));
        const commits: string[] = [];
        s.on('commit', (label) => commits.push(label));
        s.begin('Drag');
        for (let x = 1; x <= 3; x++) s.update((d) => (d.nodes[0].position = [x, 0, 0]));
        s.end();
        s.commit('Nothing', () => {});
        expect(commits).toEqual(['Drag']);
        s.undo();
        expect(s.doc.nodes[0].position).toEqual([0, 0, 0]);
    });

    it('squashes the steps of an assistant request and keeps hand edits between them', async () => {
        const s = new Store(scene());
        await s.inBatch('b1', async () => {
            s.commit('One', (d) => void d.nodes.push(makeNode('1')));
            s.commit('Two', (d) => void d.nodes.push(makeNode('2')));
        });
        s.commit('Hand', (d) => void d.nodes.push(makeNode('H')));
        expect(s.squash('b1', 'Request')).toBe(true);
        s.undo();
        expect(names(s)).toEqual(['1', '2']);
        expect(s.undoLabel).toBe('Request');
        s.undo();
        expect(names(s)).toEqual([]);
        expect(s.squash('b1', 'Again')).toBe(false);
    });

    it('patches without an undo step of its own', () => {
        const s = new Store(scene());
        s.commit('Add', (d) => void d.nodes.push(makeNode('A')));
        s.patch((d) => (d.nodes[0].name = 'Settled'));
        expect(s.undoLabel).toBe('Add');
        s.undo();
        expect(names(s)).toEqual([]);
    });

    it('returns to a checkpoint with its history', () => {
        const s = new Store(scene());
        s.commit('Add', (d) => void d.nodes.push(makeNode('A')));
        const cp = s.checkpoint();
        s.commit('Remove', (d) => void d.nodes.pop());
        s.restoreCheckpoint(cp);
        expect(names(s)).toEqual(['A']);
        expect(s.undoLabel).toBe('Add');
    });

    it('selects, adds to and toggles the selection, skipping unknown ids', () => {
        const a = makeNode('A');
        const b = makeNode('B', a.id);
        const s = new Store(scene(a, b));
        s.select([a.id, 'nope']);
        expect(s.selection).toEqual([a.id]);
        s.select([b.id], 'add');
        expect(s.selectionRoots()).toEqual([a.id]);
        s.select([a.id], 'toggle');
        expect(s.selection).toEqual([b.id]);
        expect(s.isAncestor(a.id, b.id)).toBe(true);
    });
});

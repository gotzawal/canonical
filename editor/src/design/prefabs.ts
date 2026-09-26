// Prefabs: a group of primitives with its materials and a pivot at its
// bottom center, stored once (SceneDoc.prefabs) and placed as instances.
// Instances are expanded into ordinary nodes (the instance root carries
// `prefab`, the generated nodes `prefabChild`), so rendering, Play and built
// games need nothing special; changing the prefab regenerates every
// instance. Once the final mesh exists, a .glb stored under the prefab's
// reserved asset id replaces the template in every instance.

import { decompose, eulerFromQuat, invert, mat4, mul, tidy3 } from '../core/math';
import { uid } from '../core/ids';
import type { NodeDoc, PrefabDoc, SceneDoc, Vec3 } from '../core/types';

/** Deep copy of a node without its ids linked to the original. */
function copy<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

/** Nodes generated for one instance of `prefab` under `rootId`. */
export function instanceChildren(prefab: PrefabDoc, rootId: string): NodeDoc[] {
    if (prefab.useModel) {
        return [
            {
                id: uid(),
                name: prefab.name,
                parent: rootId,
                visible: true,
                position: [...(prefab.modelOffset ?? [0, 0, 0])] as Vec3,
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                model: { asset: prefab.asset },
                prefabChild: true,
            },
        ];
    }
    const ids = new Map<string, string>();
    for (const n of prefab.nodes) ids.set(n.id, uid());
    return prefab.nodes.map((n) => {
        const c = copy(n);
        c.id = ids.get(n.id)!;
        c.parent = n.parent ? ids.get(n.parent) ?? rootId : rootId;
        c.prefabChild = true;
        delete c.prefab;
        return c;
    });
}

/** Removes the generated nodes of an instance (everything below it that is prefabChild). */
function dropGenerated(doc: SceneDoc, rootId: string) {
    const doomed = new Set<string>();
    const walk = (pid: string) => {
        for (const n of doc.nodes) {
            if (n.parent === pid && !doomed.has(n.id)) {
                doomed.add(n.id);
                walk(n.id);
            }
        }
    };
    walk(rootId);
    doc.nodes = doc.nodes.filter((n) => !doomed.has(n.id));
}

/** Rebuilds the generated nodes of every instance of a prefab (or of the given instance roots). */
export function regenerate(doc: SceneDoc, prefabId: string, only?: string[]) {
    const prefab = doc.prefabs.find((p) => p.id === prefabId);
    if (!prefab) return;
    const roots = doc.nodes.filter((n) => n.prefab === prefabId && (!only || only.includes(n.id))).map((n) => n.id);
    for (const rootId of roots) {
        dropGenerated(doc, rootId);
        const at = doc.nodes.findIndex((n) => n.id === rootId);
        doc.nodes.splice(at + 1, 0, ...instanceChildren(prefab, rootId));
    }
}

/** A new instance root (and its children) at `position`. */
export function makeInstance(prefab: PrefabDoc, position: Vec3, name: string, rotationY = 0): NodeDoc[] {
    const root: NodeDoc = {
        id: uid(),
        name,
        parent: null,
        visible: true,
        position: [...position] as Vec3,
        rotation: [0, rotationY, 0],
        scale: [1, 1, 1],
        prefab: prefab.id,
    };
    return [root, ...instanceChildren(prefab, root.id)];
}

/**
 * Builds a prefab from existing nodes. `worldOf` gives each root's world
 * matrix; the pivot is the bottom center of `bounds`. Returns the prefab
 * and the template made from copies of the nodes.
 */
export function prefabFrom(
    doc: SceneDoc,
    roots: string[],
    name: string,
    bounds: { min: Vec3; max: Vec3 },
    worldOf: (id: string) => ArrayLike<number> | null,
): { prefab: PrefabDoc; pivot: Vec3 } {
    const pivot: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, bounds.min[1], (bounds.min[2] + bounds.max[2]) / 2];
    const toPivot = mat4();
    toPivot[12] = -pivot[0];
    toPivot[13] = -pivot[1];
    toPivot[14] = -pivot[2];
    const nodes: NodeDoc[] = [];
    const ids = new Map<string, string>();
    const collect = (id: string) => {
        const n = doc.nodes.find((x) => x.id === id);
        if (!n) return;
        ids.set(n.id, uid('t'));
        nodes.push(n);
        for (const c of doc.nodes) if (c.parent === id) collect(c.id);
    };
    for (const r of roots) collect(r);
    const template = nodes.map((n) => {
        const c = copy(n);
        c.id = ids.get(n.id)!;
        const isRoot = roots.includes(n.id);
        c.parent = isRoot ? null : ids.get(n.parent!) ?? null;
        delete c.prefab;
        delete c.prefabChild;
        if (isRoot) {
            const world = worldOf(n.id);
            if (world) {
                const d = decompose(mul(toPivot, world));
                c.position = tidy3(d.position, 4);
                c.rotation = tidy3(eulerFromQuat(d.rotation), 4);
                c.scale = tidy3(d.scale, 4);
            }
        }
        return c;
    });
    return { prefab: { id: uid('pf'), name, nodes: template, asset: uid('a') }, pivot: tidy3(pivot, 4) };
}

/**
 * The template an edited instance now stands for: its children, with the
 * instance root as the pivot (their transforms are already relative to it).
 */
export function templateFromInstance(doc: SceneDoc, rootId: string): NodeDoc[] {
    const out: NodeDoc[] = [];
    const ids = new Map<string, string>();
    const walk = (pid: string) => {
        for (const n of doc.nodes) {
            if (n.parent !== pid) continue;
            ids.set(n.id, uid('t'));
            out.push(n);
            walk(n.id);
        }
    };
    walk(rootId);
    return out.map((n) => {
        const c = copy(n);
        c.id = ids.get(n.id)!;
        c.parent = n.parent === rootId ? null : ids.get(n.parent!) ?? null;
        delete c.prefab;
        delete c.prefabChild;
        return c;
    });
}

/** The prefab instance a node belongs to (itself, or the root above generated nodes). */
export function instanceRootOf(doc: SceneDoc, id: string): NodeDoc | null {
    let n = doc.nodes.find((x) => x.id === id);
    while (n) {
        if (n.prefab) return n;
        if (!n.prefabChild) return null;
        const parent: string | null = n.parent;
        n = parent ? doc.nodes.find((x) => x.id === parent) : undefined;
    }
    return null;
}

/** Inverse of a world matrix as a helper for callers that place instances under parents. */
export function inverseOf(m: ArrayLike<number> | null): Float64Array {
    return (m && invert(m)) || mat4();
}

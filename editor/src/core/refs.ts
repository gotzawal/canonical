// Where a scene refers to its assets, shaders and scripts: the objects,
// the prefab templates (placed again later), the post chain and shader
// code. Every question about them goes through this one walk: what a file
// must carry, whether something is in use, and what deleting it clears.

import type { MaterialDoc, ParamValue, SceneDoc, TextureRole } from './types';

export type RefKind = 'asset' | 'shader' | 'script';

export interface Ref {
    kind: RefKind;
    id: string;
    /** An object's (a prefab template's too), the post chain's, a prefab's model, or shader code. */
    at: 'object' | 'post' | 'prefab' | 'code';
    /** Of an asset: what it is to its holder, a texture's role or a model; unknown for shader code. */
    role?: TextureRole | 'model';
    /** Takes the reference out (the holder goes back to its default); missing where that is not done. */
    drop?(): void;
}

const MAPS = ['map', 'normalMap', 'metalRoughMap', 'aoMap', 'emissiveMap'] as const satisfies readonly (keyof MaterialDoc)[];

/** The role of the texture of each map of a material. */
export const MAP_ROLES: Record<(typeof MAPS)[number], TextureRole> = { map: 'color', normalMap: 'normal', metalRoughMap: 'data', aoMap: 'data', emissiveMap: 'color' };

export function refs(doc: SceneDoc): Ref[] {
    const out: Ref[] = [];
    const known = new Set(doc.assets.map((a) => a.id));
    // Texture properties of custom shaders hold asset ids as values.
    const params = (values: Record<string, ParamValue> | undefined, at: Ref['at']) => {
        for (const [name, v] of Object.entries(values ?? {})) {
            // Loaded as colors, like every texture property (SceneSync.loadTexture).
            if (typeof v === 'string' && known.has(v)) out.push({ kind: 'asset', id: v, at, role: 'color', drop: () => delete values![name] });
        }
    };
    for (const n of [...doc.nodes, ...doc.prefabs.flatMap((p) => p.nodes)]) {
        const m = n.mesh?.material;
        if (m) {
            for (const key of MAPS) if (m[key]) out.push({ kind: 'asset', id: m[key]!, at: 'object', role: MAP_ROLES[key], drop: () => (m[key] = null) });
            if (m.shader) {
                out.push({
                    kind: 'shader',
                    id: m.shader,
                    at: 'object',
                    drop: () => {
                        m.type = 'lit';
                        m.shader = null;
                        delete m.params;
                    },
                });
            }
            params(m.params, 'object');
        }
        if (n.model?.asset) out.push({ kind: 'asset', id: n.model.asset, at: 'object', role: 'model' });
        for (const o of Object.values(n.model?.materials ?? {})) {
            if (o.map) out.push({ kind: 'asset', id: o.map, at: 'object', role: 'color', drop: () => delete o.map });
            if (o.shader) {
                out.push({
                    kind: 'shader',
                    id: o.shader,
                    at: 'object',
                    drop: () => {
                        delete o.shader;
                        delete o.params;
                    },
                });
            }
            params(o.params, 'object');
        }
        const particles = n.particles;
        if (particles?.texture) out.push({ kind: 'asset', id: particles.texture, at: 'object', role: 'color', drop: () => (particles.texture = null) });
        for (const r of n.scripts ?? []) {
            out.push({
                kind: 'script',
                id: r.script,
                at: 'object',
                drop: () => {
                    n.scripts = n.scripts?.filter((x) => x !== r);
                    if (!n.scripts?.length) delete n.scripts;
                },
            });
        }
    }
    // A prefab keeps its model while its instances show the template.
    for (const p of doc.prefabs) if (known.has(p.asset)) out.push({ kind: 'asset', id: p.asset, at: 'prefab', role: 'model' });
    const rg = doc.renderGraph;
    for (const p of rg.posts) {
        out.push({ kind: 'shader', id: p.shader, at: 'post', drop: () => (rg.posts = rg.posts.filter((x) => x !== p)) });
        params(p.params, 'post');
    }
    // ... and a property's default may name one in the shader code.
    for (const s of doc.shaders) for (const id of known) if (s.code.includes(id)) out.push({ kind: 'asset', id, at: 'code' });
    return out;
}

/**
 * How many objects (in the scene and the prefab templates) use each script,
 * and how many instances each prefab has: what the assets panel shows,
 * without the walk over every reference refs() makes.
 */
export function useCounts(doc: SceneDoc): { scripts: Map<string, number>; prefabs: Map<string, number> } {
    const scripts = new Map<string, number>();
    const prefabs = new Map<string, number>();
    const count = (n: SceneDoc['nodes'][number]) => {
        if (n.scripts) for (const r of n.scripts) scripts.set(r.script, (scripts.get(r.script) ?? 0) + 1);
    };
    for (const n of doc.nodes) {
        if (n.prefab) prefabs.set(n.prefab, (prefabs.get(n.prefab) ?? 0) + 1);
        count(n);
    }
    for (const p of doc.prefabs) for (const n of p.nodes) count(n);
    return { scripts, prefabs };
}

/**
 * What each asset the scene uses is to it: texture roles, 'model', or
 * 'unknown' where only shader code names it (the game may load it any way).
 */
export function assetRoles(doc: SceneDoc): Map<string, Set<TextureRole | 'model' | 'unknown'>> {
    const out = new Map<string, Set<TextureRole | 'model' | 'unknown'>>();
    for (const r of refs(doc)) {
        if (r.kind !== 'asset') continue;
        let set = out.get(r.id);
        if (!set) out.set(r.id, (set = new Set()));
        set.add(r.role ?? 'unknown');
    }
    return out;
}

/** The ids of one kind the scene refers to. */
export function usedIds(doc: SceneDoc, kind: RefKind): Set<string> {
    return new Set(refs(doc).filter((r) => r.kind === kind).map((r) => r.id));
}

/** How many places refer to it. */
export function uses(doc: SceneDoc, kind: RefKind, id: string): number {
    return refs(doc).filter((r) => r.kind === kind && r.id === id).length;
}

/** Takes out the references to it (all, or those at one place), on the document being changed. */
export function dropRefs(doc: SceneDoc, kind: RefKind, id: string, at?: Ref['at']) {
    for (const r of refs(doc)) if (r.kind === kind && r.id === id && (!at || r.at === at)) r.drop?.();
}

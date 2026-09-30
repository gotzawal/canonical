// The level's navigation mesh, the light part: which scenes need one, the
// level's triangles and the settings that fit the characters. Baking and
// path finding (recast-navigation, WebAssembly) are in navmeshRuntime.ts,
// loaded only when a scene needs them (a built game ships them only then).

import type { Object3D } from '@orillusion/core';
import { VertexAttributeName } from '@orillusion/core';
import type { SceneDoc } from '../core/types';
import type { Store } from '../core/store';
import type { SceneSync } from '../engine/sync';
import type { NavQuery } from './ai/agents';

/** The body the navigation mesh is made for: the widest and tallest walking character, the lowest step, the specs' slope. */
export interface NavAgent {
    radius: number;
    height: number;
    climb: number;
    /** Steepest walkable slope, degrees. */
    slope: number;
}

export interface LevelTriangles {
    positions: Float32Array;
    indices: Uint32Array;
}

/** A navigation mesh ready for queries (navmeshRuntime.ts). */
export interface LevelNav extends NavQuery {
    /** Its triangles in world space, to draw it. */
    triangles(): LevelTriangles;
    destroy(): void;
}

/** The scene has characters that walk on their own (NPCs), or scripts that ask for paths. */
export function usesNavigation(doc: SceneDoc): boolean {
    if (doc.nodes.some((n) => n.character && !n.player)) return true;
    return doc.scripts.some((s) => /\bthis\.nav\b/.test(s.code));
}

/** The navigation body for these characters and the design specs. */
export function navAgent(doc: SceneDoc, characters: readonly { radius: number; height: number; stepHeight: number }[]): NavAgent {
    const specs = doc.design.specs;
    const list = characters.length ? characters : [{ radius: specs.playerRadius, height: specs.playerHeight, stepHeight: specs.stepHeight }];
    return {
        radius: Math.max(...list.map((c) => c.radius)),
        height: Math.max(...list.map((c) => c.height)),
        climb: Math.min(...list.map((c) => c.stepHeight)),
        slope: Math.min(89, Math.max(1, specs.maxSlope)),
    };
}

/**
 * The static level in world space: every shown mesh that no moving body
 * holds (dynamic and kinematic bodies move, triggers are not in the way),
 * without the characters and what is under them. Walls, floors, stairs
 * and props all go in; recast keeps what is walkable.
 */
export function levelTriangles(store: Store, sync: SceneSync, skip: (id: string) => boolean = () => false): LevelTriangles {
    const moving = (id: string) => {
        for (let n = store.node(id); n; n = n.parent ? store.node(n.parent) : undefined) {
            if (n.character) return true;
            if (n.body) return n.body.sensor || n.body.type !== 'fixed';
        }
        return false;
    };
    const chunks: { pos: Float32Array; idx: ArrayLike<number> | null; m: ArrayLike<number> }[] = [];
    let verts = 0;
    let tris = 0;
    for (const n of store.doc.nodes) {
        if (!n.mesh && !n.model) continue;
        const entry = sync.entries.get(n.id);
        if (!entry?.visible || sync.detached.has(n.id) || skip(n.id) || moving(n.id)) continue;
        for (const r of sync.renderersOf(n.id)) {
            const pos = r.geometry?.getAttribute(VertexAttributeName.position)?.data as Float32Array | undefined;
            const obj = r.object3D as Object3D | undefined;
            if (!pos || !obj) continue;
            const idx = (r.geometry.getAttribute(VertexAttributeName.indices)?.data as ArrayLike<number> | undefined) ?? null;
            chunks.push({ pos, idx, m: obj.transform.worldMatrix.rawData });
            verts += pos.length / 3;
            tris += Math.floor((idx ? idx.length : pos.length / 3) / 3);
        }
    }
    const positions = new Float32Array(verts * 3);
    const indices = new Uint32Array(tris * 3);
    let v = 0;
    let t = 0;
    for (const { pos, idx, m } of chunks) {
        const base = v / 3;
        const count = pos.length / 3;
        for (let i = 0; i < count; i++) {
            const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
            positions[v++] = m[0] * x + m[4] * y + m[8] * z + m[12];
            positions[v++] = m[1] * x + m[5] * y + m[9] * z + m[13];
            positions[v++] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const n = Math.floor((idx ? idx.length : count) / 3) * 3;
        for (let i = 0; i < n; i++) {
            const k = idx ? idx[i] : i;
            indices[t++] = base + (k < count ? k : 0);
        }
    }
    return { positions, indices: t === indices.length ? indices : indices.subarray(0, t) };
}

/** A short signature of the level and the body (a baked mesh is reused while it holds). */
export function navSignature(level: LevelTriangles, agent: NavAgent): string {
    // FNV-1a over the bytes of the positions and the triangles.
    let h = 0x811c9dc5;
    const mix = (bytes: Uint8Array) => {
        for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
    };
    mix(new Uint8Array(level.positions.buffer, level.positions.byteOffset, level.positions.byteLength));
    mix(new Uint8Array(level.indices.buffer, level.indices.byteOffset, level.indices.byteLength));
    return `${(h >>> 0).toString(16)}:${level.indices.length}:${agent.radius}:${agent.height}:${agent.climb}:${agent.slope}`;
}

/** Bakes (in a worker) or reuses the navigation mesh of a level, and loads it for queries. */
export async function navigationFor(level: LevelTriangles, agent: NavAgent): Promise<LevelNav | null> {
    const runtime = await import('./navmeshRuntime');
    return runtime.navigationFor(level, agent);
}

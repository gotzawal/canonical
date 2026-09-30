// Navigation meshes with recast-navigation (WebAssembly), loaded only when
// a scene needs one (see navmesh.ts). The mesh is baked in a worker from
// the level's triangles for the characters' body, kept per level for the
// session (a second Play of the same level reuses it at once), and loaded
// here for path queries, which take well under a millisecond.

import { getNavMeshPositionsAndIndices, importNavMesh, init, NavMeshQuery, type NavMesh } from 'recast-navigation';
import type { Vec3 } from '../core/types';
import { navSignature, type LevelNav, type LevelTriangles, type NavAgent } from './navmesh';

let ready: Promise<void> | null = null;
/** Baked meshes by level signature (the few latest). */
const baked = new Map<string, Promise<Uint8Array>>();
const KEEP = 4;

/** The recast settings for a body over a level of this size. */
function recastConfig(level: LevelTriangles, agent: NavAgent): { config: Record<string, number>; tiled: boolean } {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const p = level.positions;
    for (let i = 0; i < p.length; i += 3) {
        if (p[i] < minX) minX = p[i];
        if (p[i] > maxX) maxX = p[i];
        if (p[i + 2] < minZ) minZ = p[i + 2];
        if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    const area = Math.max(1, (maxX - minX) * (maxZ - minZ));
    // Cells a third of the body's radius wide, coarser for huge levels (at most about 4 million cells).
    const cs = Math.min(0.5, Math.max(agent.radius / 3, 0.08, Math.sqrt(area / 4e6)));
    // Fine enough in height to tell a step from a wall.
    const ch = Math.max(0.02, Math.min(cs / 2, agent.climb / 3));
    const cells = area / (cs * cs);
    const tiled = cells > 1024 * 1024;
    const config: Record<string, number> = {
        cs,
        ch,
        walkableSlopeAngle: agent.slope,
        walkableHeight: Math.ceil(agent.height / ch),
        walkableClimb: Math.floor(agent.climb / ch),
        walkableRadius: Math.ceil(agent.radius / cs),
        maxEdgeLen: Math.round(12 / cs),
        maxSimplificationError: 1.3,
        minRegionArea: 8 * 8,
        mergeRegionArea: 20 * 20,
        maxVertsPerPoly: 6,
        // Heights of the detail mesh: coarse is enough, the characters stand on the level itself.
        // (Finer sampling overflows recast's per polygon limits on large polygons.)
        detailSampleDist: 6,
        detailSampleMaxError: 1,
    };
    if (tiled) config.tileSize = 64;
    return { config, tiled };
}

/** Bakes a level in a worker (the worker ends when it is done). */
function bake(level: LevelTriangles, agent: NavAgent): Promise<Uint8Array> {
    const { config, tiled } = recastConfig(level, agent);
    const worker = new Worker(new URL('./navmesh.worker.ts', import.meta.url), { type: 'module' });
    return new Promise<Uint8Array>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
            worker.terminate();
            if (e.data.error) reject(new Error(e.data.error));
            else {
                console.info(`[navmesh] baked ${level.indices.length / 3} triangles in ${Math.round(e.data.ms)} ms (${tiled ? 'tiled' : 'one tile'}, ${e.data.data.byteLength} bytes)`);
                resolve(e.data.data as Uint8Array);
            }
        };
        worker.onerror = (e) => {
            worker.terminate();
            reject(new Error(e.message || 'the navigation worker failed'));
        };
        // Copies: the level's arrays stay with the caller.
        worker.postMessage({ id: 1, positions: level.positions.slice(), indices: level.indices.slice(), config, tiled });
    });
}

const v = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] });
const t = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];

class RecastNav implements LevelNav {
    private query: NavMeshQuery;
    private half = { x: 2, y: 4, z: 2 };

    constructor(private navMesh: NavMesh) {
        this.query = new NavMeshQuery(navMesh);
    }

    path(from: Vec3, to: Vec3): Vec3[] | null {
        const r = this.query.computePath(v(from), v(to), { halfExtents: this.half });
        return r.success && r.path.length ? r.path.map(t) : null;
    }

    randomPoint(center: Vec3, radius: number): Vec3 | null {
        const r = this.query.findRandomPointAroundCircle(v(center), radius, { halfExtents: this.half });
        return r.success ? t(r.randomPoint) : null;
    }

    closest(p: Vec3, within: number): Vec3 | null {
        const r = this.query.findClosestPoint(v(p), { halfExtents: { x: within, y: within + 2, z: within } });
        if (!r.success || !r.polyRef) return null;
        const q = t(r.point);
        return Math.hypot(q[0] - p[0], q[2] - p[2]) <= within ? q : null;
    }

    triangles(): LevelTriangles {
        const [positions, indices] = getNavMeshPositionsAndIndices(this.navMesh);
        return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
    }

    destroy() {
        this.query.destroy();
        this.navMesh.destroy();
    }
}

export async function navigationFor(level: LevelTriangles, agent: NavAgent): Promise<LevelNav | null> {
    if (!level.indices.length) return null;
    const key = navSignature(level, agent);
    let data = baked.get(key);
    if (!data) {
        data = bake(level, agent);
        baked.set(key, data);
        data.catch(() => baked.delete(key));
        while (baked.size > KEEP) baked.delete(baked.keys().next().value!);
    }
    ready ??= init();
    const [bytes] = await Promise.all([data, ready]);
    const { navMesh } = importNavMesh(bytes);
    return new RecastNav(navMesh);
}

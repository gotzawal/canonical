// A terrain in the scene (NodeDoc.terrain, core/terrain.ts): its heightmap
// and paint, loaded once per file, drawn as chunk meshes with the terrain
// material (engine/terrainMaterial.ts). Each chunk draws the level of
// detail its distance from the camera calls for: the levels are index
// ranges over the same vertices, so switching costs nothing. Sculpting
// changes a copy of the map; the chunks it touches are written again.

import { BoundingBox, GeometryBase, MeshRenderer, Object3D, Reference, Vector3, VertexAttributeName, type Context3D } from '@orillusion/core';
import { getAssetUrl } from '../core/assets';
import { decodePngRgba, readHeightmap, type Heightmap } from '../core/heightmap';
import { chunkCounts, chunkMesh, chunkQuads, chunkRegion, refillChunk, TERRAIN_LODS, type TerrainFrame, type TerrainSurface } from '../core/terrain';
import type { AssetMeta } from '../core/types';
import { TerrainMaterial, type MaterialLayer } from './terrainMaterial';

/** Maps and paint by asset id. A file never changes under its id: sculpting and painting make new assets. */
const heightmaps = new Map<string, Promise<Heightmap>>();
const paints = new Map<string, Promise<Paint>>();
/** Files kept loaded, the latest used last. */
const KEPT = 12;

export interface Paint {
    width: number;
    height: number;
    data: Uint8Array;
}

function keep<T>(cache: Map<string, Promise<T>>, id: string, value: Promise<T>) {
    cache.delete(id);
    cache.set(id, value);
    while (cache.size > KEPT) cache.delete(cache.keys().next().value!);
    value.catch(() => cache.delete(id));
}

async function fileOf(meta: AssetMeta): Promise<Blob> {
    const url = await getAssetUrl(meta);
    if (!url) throw new Error(`${meta.name} is not stored here.`);
    return (await fetch(url)).blob();
}

/** A heightmap asset's heights (loaded once). */
export function heightmapOf(meta: AssetMeta): Promise<Heightmap> {
    const known = heightmaps.get(meta.id);
    if (known) return known;
    const p = fileOf(meta).then((blob) => readHeightmap(blob, meta.name));
    keep(heightmaps, meta.id, p);
    return p;
}

/** A paint asset's layers (loaded once). */
export function paintOf(meta: AssetMeta): Promise<Paint> {
    const known = paints.get(meta.id);
    if (known) return known;
    const p = fileOf(meta).then(async (blob) => decodePngRgba(new Uint8Array(await blob.arrayBuffer())));
    keep(paints, meta.id, p);
    return p;
}

/** Remembers the heights or paint a new asset was saved from, so it is not read back. */
export function rememberHeightmap(id: string, map: Heightmap) {
    keep(heightmaps, id, Promise.resolve(map));
}
export function rememberPaint(id: string, paint: Paint) {
    keep(paints, id, Promise.resolve(paint));
}

/** A terrain without a heightmap: level with its object. */
export function flatMap(): Heightmap {
    return { width: 33, height: 33, data: new Float32Array(33 * 33) };
}

interface Chunk {
    obj: Object3D;
    renderer: MeshRenderer;
    geometry: GeometryBase;
    cx: number;
    cz: number;
    /** Its middle in the terrain's space, and how far its corners reach from it. */
    center: [number, number, number];
    radius: number;
}

/** Skirt depth: enough to cover the gap between the coarsest and finest levels on steep ground. */
function skirtFor(map: Heightmap, frame: TerrainFrame): number {
    const spacing = Math.max(frame.sizeX / (map.width - 1), frame.sizeZ / (map.height - 1));
    return Math.max(0.5, Math.min(frame.height * 0.25, spacing * 2 ** (TERRAIN_LODS - 1)));
}

export class TerrainView {
    /** Sits at the scene's root, at the terrain's position (a terrain does not turn or scale). */
    readonly root = new Object3D();
    readonly material: TerrainMaterial;
    map: Heightmap = flatMap();
    frame: TerrainFrame = { x: 0, y: 0, z: 0, sizeX: 1, sizeZ: 1, height: 1 };
    private chunks: Chunk[] = [];
    private skirt = 1;
    private castShadow = true;
    /** Meters from the camera the full detail reaches (the terrain's detail times a chunk's size). */
    private near = 50;

    constructor(scene: Object3D, ctx: Context3D, readonly id: string) {
        this.root.name = 'Terrain';
        scene.addChild(this.root);
        this.material = new TerrainMaterial(ctx);
        // Held here too: the last chunk destroyed would destroy the material its next chunks draw with.
        Reference.getInstance().attached(this.material.material, this);
    }

    get surface(): TerrainSurface {
        return { frame: this.frame, map: this.map };
    }

    /** Builds the chunks for a map and frame (a new file, size or height). */
    build(map: Heightmap, frame: TerrainFrame, detail: number) {
        this.clearChunks();
        this.map = map;
        this.frame = frame;
        this.place(frame);
        this.skirt = skirtFor(map, frame);
        const [nx, nz] = chunkCounts(map);
        const q = chunkQuads(map);
        this.near = Math.max(8, (q * Math.max(frame.sizeX / (map.width - 1), frame.sizeZ / (map.height - 1))) * 1.5 * detail);
        for (let cz = 0; cz < nz; cz++) {
            for (let cx = 0; cx < nx; cx++) {
                const mesh = chunkMesh(map, frame, cx, cz, this.skirt);
                const geometry = new GeometryBase();
                geometry.setIndices(mesh.indices);
                geometry.setAttribute(VertexAttributeName.position, mesh.positions);
                geometry.setAttribute(VertexAttributeName.normal, mesh.normals);
                geometry.setAttribute(VertexAttributeName.uv, mesh.uvs);
                geometry.setAttribute(VertexAttributeName.TEXCOORD_1, mesh.uvs);
                geometry.addSubGeometry(...mesh.lods.map((l) => ({ indexStart: l.start, indexCount: l.count, vertexStart: 0, vertexCount: 0, firstStart: 0, index: 0, topology: 0 })));
                const obj = new Object3D();
                obj.name = `Terrain chunk ${cx},${cz}`;
                const renderer = obj.addComponent(MeshRenderer);
                renderer.geometry = geometry;
                renderer.material = this.material.material;
                renderer.castShadow = this.castShadow;
                renderer.receiveShadow = true;
                renderer.castGI = true;
                // It never moves; its shadow is drawn again when its level of detail changes.
                renderer.shadowCacheMode = 'static';
                const chunk: Chunk = { obj, renderer, geometry, cx, cz, center: [0, 0, 0], radius: 0 };
                this.fitBounds(chunk, mesh.positions);
                this.chunks.push(chunk);
                this.root.addChild(obj);
            }
        }
    }

    /** Box and reach of a chunk from its vertices. */
    private fitBounds(c: Chunk, positions: Float32Array) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                min[k] = Math.min(min[k], positions[i + k]);
                max[k] = Math.max(max[k], positions[i + k]);
            }
        }
        c.center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        c.radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
        c.geometry.bounds = new BoundingBox().setFromMinMax(new Vector3(min[0], min[1], min[2]), new Vector3(max[0], max[1], max[2]));
    }

    /** Moves it to the terrain's position (a move needs no new chunks). */
    place(frame: TerrainFrame) {
        this.frame = frame;
        this.root.x = frame.x;
        this.root.y = frame.y;
        this.root.z = frame.z;
        this.material.setFrame(frame);
    }

    /**
     * Writes the chunks a region of the map (in samples) touches again from
     * the map, after sculpting changed it in place.
     */
    refresh(region: { x0: number; z0: number; x1: number; z1: number }) {
        for (const c of this.chunks) {
            const r = chunkRegion(this.map, c.cx, c.cz);
            // A sample's normal reads its neighbors: one more on each side.
            if (r.x1 < region.x0 - 1 || r.x0 > region.x1 || r.z1 < region.z0 - 1 || r.z0 > region.z1) continue;
            const pos = c.geometry.getAttribute(VertexAttributeName.position);
            const nor = c.geometry.getAttribute(VertexAttributeName.normal);
            refillChunk(this.map, this.frame, c.cx, c.cz, this.skirt, pos.data as Float32Array, nor.data as Float32Array);
            c.geometry.vertexBuffer?.upload(VertexAttributeName.position, pos);
            c.geometry.vertexBuffer?.upload(VertexAttributeName.normal, nor);
            this.fitBounds(c, pos.data as Float32Array);
        }
    }

    /** Picks each chunk's level of detail for a camera at `eye` (world). */
    update(eye: ArrayLike<number>) {
        const ex = eye[0] - this.frame.x;
        const ey = eye[1] - this.frame.y;
        const ez = eye[2] - this.frame.z;
        for (const c of this.chunks) {
            const d = Math.max(0, Math.hypot(ex - c.center[0], ey - c.center[1], ez - c.center[2]) - c.radius);
            const lod = Math.min(TERRAIN_LODS - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, d / this.near)) + (d > this.near ? 1 : 0))));
            if (c.renderer.lodLevel !== lod) c.renderer.lodLevel = lod;
        }
    }

    setLayers(layers: MaterialLayer[], size: number) {
        this.material.setLayers(layers, size);
    }

    setShadows(cast: boolean) {
        this.castShadow = cast;
        for (const c of this.chunks) c.renderer.castShadow = cast;
    }

    setVisible(visible: boolean) {
        for (const c of this.chunks) c.renderer.enable = visible;
    }

    /** The chunk renderers (to draw, not to pick: rays use the map, see core/terrain.ts). */
    get renderers(): MeshRenderer[] {
        return this.chunks.map((c) => c.renderer);
    }

    private clearChunks() {
        for (const c of this.chunks) {
            c.obj.removeFromParent();
            c.obj.destroy();
            c.geometry.destroy();
        }
        this.chunks = [];
    }

    dispose() {
        this.clearChunks();
        this.root.removeFromParent();
        this.root.destroy();
        Reference.getInstance().detached(this.material.material, this);
        this.material.material.destroy(true);
        this.material.dispose();
    }
}

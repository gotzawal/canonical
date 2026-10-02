// Making and shaping terrains in the editor: a new terrain of a shape, and
// sculpting and painting one (live while a stroke goes on, one undo step a
// stroke). Heights and paint are saved as new assets: a file never changes
// under its id, so undoing a stroke shows the earlier file again, and the
// file a stroke replaced leaves the project's list (undo brings it back).

import { putAsset } from '../core/assets';
import { encodePngHeightmap, encodePngRgba, readHeightmap, type Heightmap } from '../core/heightmap';
import { Terrain } from '../core/model';
import { uses } from '../core/refs';
import { defaults } from '../core/schema';
import type { Store } from '../core/store';
import { toSamples, type TerrainFrame } from '../core/terrain';
import { generateHeightmap, ISLAND_COAST, paintSplat, sculpt, type Region, type SculptOp, type TerrainShape } from '../core/terrainGen';
import type { AssetMeta, NodeDoc, TerrainDoc, Vec3 } from '../core/types';
import { rememberHeightmap, rememberPaint, type Paint } from '../engine/terrain';
import type { SceneSync } from '../engine/sync';

/** Sizes and heights a shape starts with. */
export const SHAPE_DEFAULTS: Record<TerrainShape, { size: [number, number]; height: number }> = {
    island: { size: [200, 200], height: 40 },
    hills: { size: [200, 200], height: 20 },
    mountains: { size: [400, 400], height: 120 },
    plains: { size: [200, 200], height: 4 },
    flat: { size: [100, 100], height: 10 },
};

export interface NewTerrain {
    shape: TerrainShape;
    size?: [number, number];
    height?: number;
    seed?: number;
    roughness?: number;
    /** How much water has worn it, 0 to 1 (by its shape when left out). */
    erosion?: number;
    /** Samples a side: 257, 513 (default) or 1025. */
    resolution?: number;
    /** Island: the water's height, where its coast lies (0 by default). */
    waterLevel?: number;
}

/** Stores heights as a 16-bit PNG asset (not yet in the document). */
export async function saveHeightmap(map: Heightmap, name: string): Promise<AssetMeta> {
    const bytes = await encodePngHeightmap(map);
    const meta = await putAsset(new Blob([bytes as BlobPart], { type: 'image/png' }), name, 'data', undefined, { width: map.width, height: map.height });
    rememberHeightmap(meta.id, map);
    return meta;
}

async function savePaint(paint: Paint, name: string): Promise<AssetMeta> {
    const bytes = await encodePngRgba(paint.width, paint.height, paint.data);
    const meta = await putAsset(new Blob([bytes as BlobPart], { type: 'image/png' }), name, 'data', undefined, { width: paint.width, height: paint.height });
    rememberPaint(meta.id, paint);
    return meta;
}

/**
 * A terrain object with a new heightmap, and the heightmap's asset (to add
 * together). An island's coast lies at the water level: its object sits
 * that far below it.
 */
export async function newTerrain(o: NewTerrain, name: string, at: Vec3): Promise<{ node: Omit<NodeDoc, 'id' | 'name' | 'parent'> & { terrain: TerrainDoc }; meta: AssetMeta }> {
    const d = SHAPE_DEFAULTS[o.shape];
    const size = o.size ?? d.size;
    const height = o.height ?? d.height;
    const map = generateHeightmap({ shape: o.shape, resolution: o.resolution ?? 513, seed: o.seed ?? 1, roughness: o.roughness, erosion: o.erosion });
    const meta = await saveHeightmap(map, `${name} Heights.png`);
    const y = o.shape === 'island' ? (o.waterLevel ?? 0) - ISLAND_COAST * height : at[1];
    return {
        meta,
        node: {
            visible: true,
            position: [at[0], y, at[2]],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            terrain: { ...defaults(Terrain), heightmap: meta.id, size, height },
        },
    };
}

/**
 * Puts a new asset in a terrain's field (its heightmap or paint) in one
 * undo step; the file it replaces leaves the project's list when nothing
 * else uses it.
 */
function swapIn(store: Store, id: string, field: 'heightmap' | 'splatmap', meta: AssetMeta, label: string) {
    store.commit(label, (d) => {
        const n = d.nodes.find((x) => x.id === id);
        if (!n?.terrain) return;
        const old = n.terrain[field];
        n.terrain[field] = meta.id;
        d.assets.push(meta);
        if (old && !uses(d, 'asset', old)) d.assets = d.assets.filter((a) => a.id !== old);
    });
}

/**
 * Puts a heightmap file (a 16-bit grayscale PNG, or raw 16-bit samples
 * from another tool) on a terrain, in one undo step. Throws when the file
 * is no heightmap.
 */
export async function importHeightmap(store: Store, id: string, file: File) {
    const map = await readHeightmap(file, file.name);
    const meta = await putAsset(file, file.name, 'data', undefined, { width: map.width, height: map.height });
    rememberHeightmap(meta.id, map);
    swapIn(store, id, 'heightmap', meta, 'Import Heightmap');
}

/** What the viewport's terrain brush does while one is chosen: sculpt, or paint a layer. */
export type BrushTool = SculptOp | 'paint';

/** The terrain brush: its tool (null: off, the view selects and moves as usual), meters from its middle to its edge, 0..1 strength, and the layer it paints. */
export interface BrushSettings {
    tool: BrushTool | null;
    radius: number;
    strength: number;
    layer: number;
}

/** A brush stroke in world meters: the points it passes (x, z), how wide and how strong. */
export interface WorldStroke {
    points: [number, number][];
    radius: number;
    strength: number;
}

/**
 * A stroke on a terrain, sculpting or painting a copy of its map or paint
 * and showing it as it goes; end() saves it as one undo step.
 */
export class TerrainStroke {
    private map: Heightmap | null = null;
    private original: Heightmap | null = null;
    private paint: Paint | null = null;
    private touched: Region | null = null;

    constructor(private store: Store, private sync: SceneSync, readonly id: string) {}

    private get frame(): TerrainFrame | null {
        return this.sync.terrainView(this.id)?.frame ?? null;
    }

    /** Samples a meter spans on the map (the finer axis). */
    private samplesPerMeter(map: { width: number; height: number }, f: TerrainFrame): number {
        return Math.max((map.width - 1) / f.sizeX, (map.height - 1) / f.sizeZ);
    }

    /**
     * Sculpts along a stroke: raise and lower move the ground `amount`
     * meters where the stroke is full, flatten pulls it to `target` (a
     * world height; the ground under the first point without one), smooth
     * evens it out, and path levels a walkable way along it.
     */
    sculpt(op: SculptOp, stroke: WorldStroke, opts: { amount?: number; target?: number } = {}): boolean {
        const view = this.sync.terrainView(this.id);
        const f = this.frame;
        if (!view || !f) return false;
        if (!this.map) {
            this.original = view.map;
            this.map = { width: view.map.width, height: view.map.height, data: view.map.data.slice() };
            view.map = this.map;
        }
        const map = this.map;
        const surface = { frame: f, map };
        const points = stroke.points.map(([x, z]) => toSamples(surface, x, z));
        const region = sculpt(map, op, { points, radius: stroke.radius * this.samplesPerMeter(map, f), strength: stroke.strength }, {
            amount: opts.amount !== undefined ? opts.amount / f.height : undefined,
            target: opts.target !== undefined ? (opts.target - f.y) / f.height : undefined,
        });
        this.touch(region);
        this.sync.terrainEdited(this.id, region, true);
        return true;
    }

    /** Paints layer 0-3 along a stroke. */
    async paintLayer(layer: number, stroke: WorldStroke, current: Paint | null): Promise<boolean> {
        const view = this.sync.terrainView(this.id);
        const f = this.frame;
        if (!view || !f) return false;
        if (!this.paint) {
            // A paint map as fine as the heights, up to 1024 a side.
            const w = current?.width ?? Math.min(1024, view.map.width - 1);
            const h = current?.height ?? Math.min(1024, view.map.height - 1);
            this.paint = { width: w, height: h, data: current ? current.data.slice() : new Uint8Array(w * h * 4) };
        }
        const p = this.paint;
        // The paint covers the terrain edge to edge, a texel's middle at each (i + 0.5).
        const points = stroke.points.map(([x, z]): [number, number] => [((x - f.x) / f.sizeX + 0.5) * p.width - 0.5, ((z - f.z) / f.sizeZ + 0.5) * p.height - 0.5]);
        const region = paintSplat(p, layer, { points, radius: stroke.radius * Math.max(p.width / f.sizeX, p.height / f.sizeZ), strength: stroke.strength });
        view.material.updatePaint(p, region);
        return true;
    }

    private touch(r: Region) {
        const t = this.touched;
        this.touched = t ? { x0: Math.min(t.x0, r.x0), z0: Math.min(t.z0, r.z0), x1: Math.max(t.x1, r.x1), z1: Math.max(t.z1, r.z1) } : r;
    }

    /** Saves what the stroke changed as one undo step (label: what the history shows). */
    async end(label: string) {
        const name = this.store.node(this.id)?.name ?? 'Terrain';
        if (this.map && this.touched) {
            this.sync.terrainEdited(this.id, this.touched, false);
            const meta = await saveHeightmap(this.map, `${name} Heights.png`);
            swapIn(this.store, this.id, 'heightmap', meta, label);
        }
        if (this.paint) {
            const meta = await savePaint(this.paint, `${name} Paint.png`);
            swapIn(this.store, this.id, 'splatmap', meta, label);
        }
        this.map = this.original = this.paint = null;
        this.touched = null;
    }

    /** Leaves the terrain as it was. */
    cancel() {
        const view = this.sync.terrainView(this.id);
        if (view && this.original) {
            view.map = this.original;
            if (this.touched) this.sync.terrainEdited(this.id, this.touched, false);
        }
        if (this.paint) this.sync.reloadTerrainPaint(this.id);
        this.map = this.original = this.paint = null;
        this.touched = null;
    }
}

// The Island example: the outdoor features together on one scene. A
// terrain island worn by water, its ground in four Library materials
// (soil, beach sand, gravel, cliff rock), the sea around it, woods of oaks
// and birches on its lower slopes and spruces higher up, mossy rocks on
// the gravel, ferns and a meadow of grass swaying in one wind, loose
// stones, and fair-weather clouds on a late afternoon; and the player (a
// capsule) on its gentle south-west shore, to walk it in Play (keys, or
// the joystick on a touch screen). It is built with the editor's own
// commands (the heightmap is made, the Library's files are fetched), so it
// opens like a scene the user made. Phones and weak GPUs (the low tier)
// get a lighter island.

import { defaultPlayer, makeCharacterNode } from './core/character';
import { defaultTree, emptyScene, forestScatter } from './core/defaults';
import { tidy } from './core/math';
import { Scatter, ScatterSource } from './core/model';
import { defaults } from './core/schema';
import { defaultDesign } from './core/design';
import { BUILTIN_CATALOG, loadCatalog, type LibraryItem } from './core/library';
import type { Store } from './core/store';
import type { CameraState, SceneDoc, ScatterDoc, TerrainLayerDoc, Vec3 } from './core/types';
import type { NewTerrain } from './design/terrainEdit';

/** The editor commands the example is built with. */
export interface IslandEditor {
    readonly store: Store;
    /** The graphics tier of this device: phones (low) get a lighter island. */
    readonly runtime: { readonly deviceQuality: 'low' | 'medium' | 'high' };
    /** The ground's heights, once the terrain's map has loaded: the player stands on them. */
    readonly sync: { whenLoaded(): Promise<void>; terrainHeightAt(x: number, z: number): number | null };
    loadDoc(doc: SceneDoc, camera?: CameraState): void;
    createTerrain(o: NewTerrain & { at?: Vec3; name?: string }): Promise<string>;
    createWater(): string;
    createGrass(): string;
    createScatter(scatter: ScatterDoc, opts?: { name?: string; at?: Vec3 }): string;
    addLibraryMaterial(item: LibraryItem, slot?: string): Promise<unknown>;
    addFromLibrary(item: LibraryItem, opts: { place: boolean }): Promise<{ asset: { id: string } }>;
}

/** Library items it uses: the ground's materials and the models standing on it. */
const ITEMS = {
    soil: 'polyhaven/brown-mud-leaves-01',
    sand: 'polyhaven/sandstone-cracks',
    gravel: 'polyhaven/forest-ground-04',
    rock: 'polyhaven/rock-face-03',
    rocks: 'polyhaven/rock-moss-set-01',
    fern: 'polyhaven/fern-02',
};

/** What the island holds: the terrain's samples a side, the meadow's blades and meters a side, trees, rocks and ferns, and how far grass and ferns are drawn (m). */
export interface IslandBudget {
    resolution: number;
    blades: number;
    meadow: number;
    grassDistance: number;
    woods: number;
    spruces: number;
    rocks: number;
    ferns: number;
    fernDistance: number;
}

/**
 * The island on most devices, and on phones and weak GPUs (the low tier),
 * whose memory and fill rate are small: a coarser map, about half the
 * plants, and a smaller meadow drawn less far. Blades stay within what a
 * Grass component holds (so the island is the same after a reload), on a
 * meadow small enough to stand thick.
 */
export const ISLAND_BUDGET: Record<'full' | 'light', IslandBudget> = {
    full: { resolution: 513, blades: 30000, meadow: 60, grassDistance: 50, woods: 100, spruces: 70, rocks: 140, ferns: 420, fernDistance: 70 },
    light: { resolution: 257, blades: 14000, meadow: 44, grassDistance: 32, woods: 50, spruces: 35, rocks: 80, ferns: 200, fernDistance: 40 },
};

/** Where the player starts looking for its spot (x, z): the gentle shore on the south-west of the island (seed 7). */
const SHORE: [number, number] = [-36, -38];
/** What it faces from there: the wooded hills in the island's middle. */
const HILLS: [number, number] = [0, -12];

/** The ground's slope at a point in degrees, by the heights a meter around it (90 off the ground). */
function slopeAt(height: (x: number, z: number) => number | null, x: number, z: number): number {
    const e = height(x + 1, z), w = height(x - 1, z), n = height(x, z + 1), s = height(x, z - 1);
    if (e === null || w === null || n === null || s === null) return 90;
    return (Math.atan(Math.hypot(e - w, n - s) / 2) * 180) / Math.PI;
}

/**
 * Where a player can start near a point (x, z): the gentlest open spot
 * within `radius` meters that stands between `low` and `high` meters up
 * (off the beach, below the hills), nearer ones first. Its feet, or null
 * when the ground has none. `height` is the ground's height (null off it).
 */
export function findStart(height: (x: number, z: number) => number | null, near: [number, number], o: { radius?: number; low?: number; high?: number } = {}): Vec3 | null {
    const { radius = 24, low = 2.5, high = 9 } = o;
    let best: Vec3 | null = null;
    let score = Infinity;
    for (let dz = -radius; dz <= radius; dz += 2) {
        for (let dx = -radius; dx <= radius; dx += 2) {
            const x = near[0] + dx, z = near[1] + dz;
            const y = height(x, z);
            if (y === null || y < low || y > high) continue;
            // Open ground: nothing steeper than a gentle slope within 4 m, so the view and the first steps are free.
            let steep = slopeAt(height, x, z);
            for (let k = 0; k < 8 && steep <= 15; k++) steep = Math.max(steep, slopeAt(height, x + 4 * Math.cos((k * Math.PI) / 4), z + 4 * Math.sin((k * Math.PI) / 4)));
            if (steep > 15) continue;
            const s = steep + 0.2 * Math.hypot(dx, dz);
            if (s < score) {
                score = s;
                best = [x, y, z];
            }
        }
    }
    return best;
}

export async function buildIsland(editor: IslandEditor): Promise<void> {
    const doc = emptyScene();
    doc.name = 'Island';
    doc.design = defaultDesign();
    doc.design.brief.skipped = true;
    // Late afternoon, fair weather: the sun and key light, clouds, haze and wind follow.
    doc.environment.weather = { ...doc.environment.weather, enable: true, time: 16.4, preset: 'fair', wind: 5, windDirection: 30 };
    doc.environment.clouds = { ...doc.environment.clouds, variety: 0.6, shadows: 0.5 };
    // From over the sea off the south-west shore: the whole island, its woods and the player's shore in front.
    editor.loadDoc(doc, { target: [-4, 6, -4], yaw: 212, pitch: 20, distance: 120, fov: 60 });

    // Phones and weak GPUs: a coarser map and fewer plants (the memory a mobile browser allows is small).
    const budget = ISLAND_BUDGET[editor.runtime.deviceQuality === 'low' ? 'light' : 'full'];
    const terrain = await editor.createTerrain({ shape: 'island', size: [200, 200], height: 26, resolution: budget.resolution, waterLevel: 0, seed: 7, erosion: 0.5, at: [0, 0, 0], name: 'Island' });
    const slots = { soil: 'm_soil', sand: 'm_sand', gravel: 'm_gravel', rock: 'm_rock' };
    editor.store.commit('Island ground', (d) => {
        for (const [name, id] of Object.entries(slots)) d.design.materials.push({ id, name, description: '', swatch: null, color: '#ffffff', roughness: 0.9, metallic: 0, tile: 2 });
        const t = d.nodes.find((n) => n.id === terrain)!.terrain!;
        const layer = (slot: string, height: [number, number], slope: [number, number], debris: number, grass: number): TerrainLayerDoc => ({
            slot, albedo: null, normal: null, arm: null, heightMap: null, tile: 2, color: '#ffffff', roughness: 1, height, slope, heightBlend: 1, slopeBlend: 6, onlyPainted: false, debris, grass,
        });
        // Soil everywhere, sand by the water, gravel on the slopes, rock on the cliffs.
        t.layers = [layer(slots.soil, [-1e4, 1e4], [0, 90], 0.15, 1), layer(slots.sand, [-1e4, 1.4], [0, 25], 0, 0.05), layer(slots.gravel, [1, 1e4], [10, 34], 0.6, 0.4), layer(slots.rock, [-1e4, 1e4], [34, 90], 0, 0)];
        t.relief = 0.6;
    });

    const water = editor.createWater();
    editor.store.commit('Sea', (d) => {
        const w = d.nodes.find((n) => n.id === water)!;
        w.name = 'Sea';
        w.position = [0, 0, 0];
        if (w.mesh?.geometry.type === 'plane') w.mesh.geometry = { ...w.mesh.geometry, width: 900, height: 900 };
    });

    // The player (a capsule, as Create > Player makes it) starts on the gentle shore, or the gentlest open spot of the island, facing the hills.
    await editor.sync.whenLoaded();
    const ground = (x: number, z: number) => editor.sync.terrainHeightAt(x, z);
    const feet = findStart(ground, SHORE) ?? findStart(ground, [0, 0], { radius: 90, high: 30 }) ?? ([0, ground(0, 0) ?? 0, 0] as Vec3);
    const player = makeCharacterNode(editor.store.doc.design.specs, true);
    const tall = player.character!.height;
    player.position = [tidy(feet[0], 3), tidy(feet[1] + tall / 2, 3), tidy(feet[2], 3)];
    player.rotation = [0, tidy((Math.atan2(HILLS[0] - feet[0], HILLS[1] - feet[2]) * 180) / Math.PI, 1), 0];
    // A little farther behind than usual: the island around it is the view.
    player.player = { ...defaultPlayer(), distance: 5 };
    editor.store.commit('Player', (d) => {
        d.nodes.push(player);
    });

    // The meadow lies around the player's first steps, more of it ahead toward the hills; grass thins out on sand and rock by itself.
    const grass = editor.createGrass();
    editor.store.commit('Meadow', (d) => {
        const g = d.nodes.find((n) => n.id === grass)!;
        g.name = 'Meadow';
        g.position = [tidy(feet[0] + 0.3 * (HILLS[0] - feet[0]), 1), 0, tidy(feet[2] + 0.3 * (HILLS[1] - feet[2]), 1)];
        g.grass = { ...g.grass!, ground: terrain, size: [budget.meadow, budget.meadow], count: budget.blades, heights: [0.5, 1.2], width: 0.12, sizes: 'patches', gaps: 0.15, distance: budget.grassDistance };
    });

    // Woods of oaks and birches on the lower slopes, spruces from the middle heights up: above the beach, off the
    // cliffs, in stands with glades between, and clear of the player's first steps. They grow from rules: no download.
    const woods = forestScatter([{ tree: { ...defaultTree('oak', 11), height: 10 }, weight: 3 }, { tree: { ...defaultTree('birch', 23), height: 12 }, weight: 2 }], [200, 200]);
    editor.createScatter({ ...woods, ground: terrain, count: budget.woods, seed: 8, spacing: 5, height: [2.6, 12], slope: [0, 30], clusters: 0.45, clusterSize: 32, avoid: [player.id], margin: 7 }, { name: 'Woods', at: [0, 0, 0] });
    const spruces = forestScatter([{ tree: { ...defaultTree('spruce', 37), height: 13 }, weight: 1 }], [200, 200]);
    editor.createScatter({ ...spruces, ground: terrain, count: budget.spruces, seed: 9, spacing: 4, height: [8, 1e4], slope: [0, 34], clusters: 0.5, clusterSize: 24, avoid: [player.id], margin: 7 }, { name: 'Spruces', at: [0, 0, 0] });

    // The Library's files: without them (offline) the island keeps plain colors, and no rocks or ferns.
    let items: Map<string, LibraryItem>;
    try {
        items = new Map((await loadCatalog(BUILTIN_CATALOG)).items.map((i) => [i.id, i]));
    } catch {
        editor.store.select([]);
        return;
    }
    const item = (id: string) => items.get(id);
    await Promise.all(Object.entries(slots).map(async ([name, slot]) => {
        const it = item(ITEMS[name as keyof typeof ITEMS]);
        if (it) await editor.addLibraryMaterial(it, slot).catch(() => undefined);
    }));
    const model = async (id: string) => {
        const it = item(id);
        return it ? (await editor.addFromLibrary(it, { place: false }).catch(() => null))?.asset.id ?? null : null;
    };
    const [rocks, fern] = await Promise.all([model(ITEMS.rocks), model(ITEMS.fern)]);
    const scatter = (model: string, scale: [number, number], solid: 'box' | 'none', rules: Partial<ScatterDoc>): ScatterDoc => ({
        ...defaults(Scatter), size: [200, 200], ground: terrain, sources: [{ ...defaults(ScatterSource), model, scale, solid }], ...rules,
    });
    // Mossy rocks in clusters on the gravel, sunk into it (none where the player starts); ferns in clumps on the soil, swaying.
    if (rocks) editor.createScatter(scatter(rocks, [0.4, 1.2], 'box', { count: budget.rocks, seed: 3, spacing: 1.2, height: [0.5, 1e4], slope: [0, 40], align: 0.7, sink: 0.05, bury: 0.6, tilt: 25, clusters: 0.8, clusterSize: 18, layer: 3, soil: 0.4, moss: 0.35, vary: 0.4, avoid: [player.id], margin: 3 }), { name: 'Rocks', at: [0, 0, 0] });
    if (fern) editor.createScatter(scatter(fern, [0.8, 1.5], 'none', { count: budget.ferns, seed: 5, spacing: 1, height: [1.5, 1e4], slope: [0, 28], align: 0.5, clusters: 0.7, clusterSize: 8, layer: 1, vary: 0.3, sway: 0.25, distance: budget.fernDistance }), { name: 'Ferns', at: [0, 0, 0] });
    editor.store.select([]);
}

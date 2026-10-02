// The Island example: the outdoor features together on one scene. A
// terrain island worn by water, its ground in four Library materials
// (soil, beach sand, gravel, cliff rock), the sea around it, mossy rocks on
// the gravel, ferns and a meadow of grass swaying in one wind, loose
// stones, and fair-weather clouds on a late afternoon. It is built with the
// editor's own commands (the heightmap is made, the Library's files are
// fetched), so it opens like a scene the user made.

import { emptyScene } from './core/defaults';
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

export async function buildIsland(editor: IslandEditor): Promise<void> {
    const doc = emptyScene();
    doc.name = 'Island';
    doc.design = defaultDesign();
    doc.design.brief.skipped = true;
    // Late afternoon, fair weather: the sun and key light, clouds, haze and wind follow.
    doc.environment.weather = { ...doc.environment.weather, enable: true, time: 16.4, preset: 'fair', wind: 5, windDirection: 30 };
    doc.environment.clouds = { ...doc.environment.clouds, variety: 0.6, shadows: 0.5 };
    editor.loadDoc(doc, { target: [0, 10, 0], yaw: 210, pitch: 16, distance: 70, fov: 60 });

    const terrain = await editor.createTerrain({ shape: 'island', size: [200, 200], height: 26, resolution: 513, waterLevel: 0, seed: 7, erosion: 0.5, at: [0, 0, 0], name: 'Island' });
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

    const grass = editor.createGrass();
    editor.store.commit('Meadow', (d) => {
        const g = d.nodes.find((n) => n.id === grass)!;
        g.name = 'Meadow';
        g.position = [0, 0, 0];
        g.grass = { ...g.grass!, ground: terrain, size: [90, 90], count: 240000, heights: [0.5, 1.2], width: 0.12, sizes: 'patches', gaps: 0.15, distance: 50 };
    });

    // The Library's files: without them (offline) the island keeps plain colors and no models.
    let items: Map<string, LibraryItem>;
    try {
        items = new Map((await loadCatalog(BUILTIN_CATALOG)).items.map((i) => [i.id, i]));
    } catch {
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
    // Mossy rocks in clusters on the gravel, sunk into it; ferns in clumps on the soil, swaying.
    if (rocks) editor.createScatter(scatter(rocks, [0.4, 1.2], 'box', { count: 140, seed: 3, spacing: 1.2, height: [0.5, 1e4], slope: [0, 40], align: 0.7, sink: 0.05, bury: 0.6, tilt: 25, clusters: 0.8, clusterSize: 18, layer: 3, soil: 0.4, moss: 0.35, vary: 0.4 }), { name: 'Rocks', at: [0, 0, 0] });
    if (fern) editor.createScatter(scatter(fern, [0.8, 1.5], 'none', { count: 420, seed: 5, spacing: 1, height: [1.5, 1e4], slope: [0, 28], align: 0.5, clusters: 0.7, clusterSize: 8, layer: 1, vary: 0.3, sway: 0.25, distance: 70 }), { name: 'Ferns', at: [0, 0, 0] });
    editor.store.select([]);
}

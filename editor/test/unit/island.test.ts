// The Island example (exampleIsland.ts), built with stand-ins for the
// editor's commands that put what they make in the store: its woods and
// spruces, where its player starts, the lighter island of a phone, the
// island without the Library, and that a reload keeps it as it was built.
import { readFileSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyScene, makeMeshNode, makeNode } from '../../src/core/defaults';
import { Grass, Mirror, Terrain } from '../../src/core/model';
import { defaults } from '../../src/core/schema';
import { sanitize, Store } from '../../src/core/store';
import { covers, groundHeight, type TerrainSurface } from '../../src/core/terrain';
import { generateHeightmap, ISLAND_COAST } from '../../src/core/terrainGen';
import type { NodeDoc } from '../../src/core/types';
import { buildIsland, findStart, ISLAND_BUDGET, type IslandEditor } from '../../src/exampleIsland';

const g = globalThis as any;
const realFetch = g.fetch;
const catalog = readFileSync(new URL('../../library/catalog.json', import.meta.url), 'utf8');

/**
 * Pages are served from `base`; the Library's catalog is there unless
 * `offline` (each base is a catalog of its own: a catalog read once is kept).
 */
function serve(base: string, offline = false) {
    g.document.baseURI = base;
    g.fetch = async (url: string) => {
        if (offline) throw new TypeError('Failed to fetch');
        return String(url).endsWith('/library/catalog.json') ? new Response(catalog) : new Response('', { status: 404 });
    };
}

afterEach(() => {
    g.fetch = realFetch;
    delete g.document.baseURI;
});

interface Built {
    store: Store;
    /** The terrain's heights, and the samples a side it was made with. */
    surface: TerrainSurface;
    resolution: number;
    node: (name: string) => NodeDoc;
}

/** Builds the island on a device of this tier with the editor's commands as stand-ins. */
async function build(deviceQuality: 'low' | 'high'): Promise<Built> {
    const store = new Store(emptyScene());
    let surface: TerrainSurface | null = null;
    let resolution = 0;
    const add = (node: NodeDoc) => {
        store.commit(`Create ${node.name}`, (d) => {
            d.nodes.push(node);
        });
        return node.id;
    };
    const editor: IslandEditor = {
        store,
        runtime: { deviceQuality },
        sync: {
            whenLoaded: async () => {},
            terrainHeightAt: (x, z) => (surface && covers(surface, x, z) ? groundHeight(surface, x, z) : null),
        },
        loadDoc: (doc, camera) => store.load(doc, camera),
        async createTerrain(o) {
            const height = o.height ?? 40;
            const size = o.size ?? [200, 200];
            resolution = o.resolution ?? 513;
            // As the editor makes it: the coast at the water's height.
            const map = generateHeightmap({ shape: 'island', resolution, seed: o.seed ?? 1, erosion: o.erosion });
            const y = (o.waterLevel ?? 0) - ISLAND_COAST * height;
            surface = { frame: { x: 0, y, z: 0, sizeX: size[0], sizeZ: size[1], height }, map };
            return add({ ...makeNode(o.name ?? 'Terrain', null, [0, y, 0]), terrain: { ...defaults(Terrain), heightmap: 'heights', size, height } });
        },
        createWater: () => add({ ...makeMeshNode('plane'), name: 'Water', mirror: defaults(Mirror) }),
        createGrass: () => add({ ...makeNode('Grass'), grass: defaults(Grass) }),
        createScatter: (scatter, opts = {}) => add({ ...makeNode(opts.name ?? 'Scatter', null, opts.at), scatter }),
        addLibraryMaterial: async () => ({}),
        addFromLibrary: async (item) => ({ asset: { id: `asset:${item.id}` } }),
    };
    await buildIsland(editor);
    const node = (name: string) => {
        const n = store.doc.nodes.find((x) => x.name === name);
        if (!n) throw new Error(`The island has no ${name}.`);
        return n;
    };
    return { store, surface: surface!, resolution, node };
}

/** The ground's slope at a point, degrees. */
function slope(s: TerrainSurface, x: number, z: number): number {
    const h = (dx: number, dz: number) => groundHeight(s, x + dx, z + dz);
    return (Math.atan(Math.hypot(h(1, 0) - h(-1, 0), h(0, 1) - h(0, -1)) / 2) * 180) / Math.PI;
}

describe('the Island example', () => {
    it('grows woods low and spruces high, and puts a player on its shore, facing the hills', async () => {
        serve('http://island.test/');
        const { store, surface, resolution, node } = await build('high');
        expect(resolution).toBe(ISLAND_BUDGET.full.resolution);
        expect(store.doc.nodes.map((n) => n.name)).toEqual(['Sun', 'Island', 'Sea', 'Player', 'Meadow', 'Woods', 'Spruces', 'Rocks', 'Ferns']);
        const terrain = node('Island').id;
        const player = node('Player');

        // Trees grown from rules: oaks and birches from above the beach, spruces from the middle heights up, solid trunks, clear of the player.
        const woods = node('Woods').scatter!;
        const spruces = node('Spruces').scatter!;
        expect(woods.sources.map((s) => s.tree?.species)).toEqual(['oak', 'birch']);
        expect(spruces.sources.map((s) => s.tree?.species)).toEqual(['spruce']);
        for (const s of [woods, spruces]) {
            expect(s.ground).toBe(terrain);
            expect(s.sources.every((src) => !src.model && src.solid === 'trunk' && src.tree!.solid)).toBe(true);
            expect(s.avoid).toEqual([player.id]);
            expect(s.margin).toBeGreaterThanOrEqual(5);
            // Off the cliffs, whose rock layer starts at 34 degrees.
            expect(s.slope[1]).toBeLessThanOrEqual(34);
        }
        // Above the beach, whose sand reaches 1.4 m and fades out over a meter more.
        expect(woods.height[0]).toBeGreaterThan(2.4);
        expect(spruces.height[0]).toBeGreaterThan(woods.height[0]);
        expect([woods.count, spruces.count]).toEqual([ISLAND_BUDGET.full.woods, ISLAND_BUDGET.full.spruces]);

        // The player: a capsule (as Create > Player makes it) with a character the player controls in third person.
        expect(player.character).toBeTruthy();
        expect(player.player).toMatchObject({ view: 'third' });
        expect(player.mesh?.geometry).toMatchObject({ type: 'capsule', height: player.character!.height });
        expect(player.model).toBeUndefined();
        // It stands on gentle open ground above the beach, on the island's south-west shore: a capsule around its middle.
        const [x, mid, z] = player.position;
        const y = mid - player.character!.height / 2;
        expect(y).toBeCloseTo(groundHeight(surface, x, z), 2);
        expect(y).toBeGreaterThan(2.4);
        expect(y).toBeLessThan(9.1);
        expect(slope(surface, x, z)).toBeLessThan(15);
        expect(x).toBeLessThan(-10);
        expect(z).toBeLessThan(-10);
        // Facing the hills in the middle of the island (+z ahead of a turn of yaw degrees).
        const yaw = (player.rotation[1] * Math.PI) / 180;
        const ahead = [x + 20 * Math.sin(yaw), z + 20 * Math.cos(yaw)];
        expect(groundHeight(surface, ahead[0], ahead[1])).toBeGreaterThan(y);
        // The meadow reaches from its shore over the hills; rocks keep clear of its first steps.
        const meadow = node('Meadow');
        expect(Math.abs(x - meadow.position[0])).toBeLessThan(meadow.grass!.size[0] / 2 - 10);
        expect(Math.abs(z - meadow.position[2])).toBeLessThan(meadow.grass!.size[1] / 2 - 10);
        expect(node('Rocks').scatter!.avoid).toEqual([player.id]);
    });

    it('is the same after a reload: every count within what its components hold', async () => {
        serve('http://island.test/');
        for (const tier of ['high', 'low'] as const) {
            const { store } = await build(tier);
            const doc = JSON.parse(JSON.stringify(store.doc));
            expect(sanitize(doc).nodes).toEqual(doc.nodes);
        }
    });

    it('is lighter on a phone: a coarser map, fewer blades and plants, a smaller meadow, grass and ferns drawn less far', async () => {
        serve('http://island.test/');
        const full = await build('high');
        const light = await build('low');
        expect(light.resolution).toBe(ISLAND_BUDGET.light.resolution);
        expect(light.resolution).toBeLessThan(full.resolution);
        const count = (b: Built, name: string) => b.node(name).scatter?.count ?? b.node(name).grass!.count;
        for (const name of ['Meadow', 'Woods', 'Spruces', 'Rocks', 'Ferns']) expect(count(light, name)).toBeLessThan(count(full, name));
        expect(light.node('Meadow').grass!.distance).toBeLessThan(full.node('Meadow').grass!.distance);
        expect(light.node('Ferns').scatter!.distance).toBeLessThan(full.node('Ferns').scatter!.distance);
        // The player starts on the same shore.
        const at = (b: Built) => b.node('Player').position;
        expect(Math.hypot(at(light)[0] - at(full)[0], at(light)[2] - at(full)[2])).toBeLessThan(8);
    });

    it('keeps its trees and its player without the Library', async () => {
        serve('http://offline.test/', true);
        const { store, surface, node } = await build('high');
        expect(store.doc.nodes.map((n) => n.name)).toEqual(['Sun', 'Island', 'Sea', 'Player', 'Meadow', 'Woods', 'Spruces']);
        const player = node('Player');
        expect(player.mesh?.geometry.type).toBe('capsule');
        expect(player.model).toBeUndefined();
        // A capsule stands around its middle.
        const [x, y, z] = player.position;
        expect(y - player.character!.height / 2).toBeCloseTo(groundHeight(surface, x, z), 2);
    });

    it('finds the gentlest open spot near a point, within the heights asked', () => {
        // A plain at 4 m with a steep bank toward +x, and a hollow below 2 m around (-20, 0).
        const height = (x: number, z: number) => (Math.abs(x) > 100 || Math.abs(z) > 100 ? null : Math.hypot(x + 20, z) < 6 ? 1 : x > 10 ? 4 + (x - 10) * 1.5 : 4);
        const at = findStart(height, [12, 0], { radius: 24 })!;
        // Off the bank (and 4 m around it), the nearest such spot.
        expect(at[0]).toBeLessThanOrEqual(6);
        expect(at[0]).toBeGreaterThanOrEqual(2);
        expect(at[1]).toBe(4);
        // Nothing within the heights asked, or off the ground.
        expect(findStart(height, [-20, 0], { radius: 4 })).toBeNull();
        expect(findStart(height, [300, 300], { radius: 10 })).toBeNull();
    });
});

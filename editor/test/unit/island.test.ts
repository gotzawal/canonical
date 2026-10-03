// The Island example (exampleIsland.ts), built with stand-ins for the
// editor's commands that put what they make in the store: a reload keeps
// it as it was built, and its player starts on the gentlest open spot
// near a point.
import { readFileSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyScene, makeMeshNode, makeNode } from '../../src/core/defaults';
import { Grass, Mirror, Terrain } from '../../src/core/model';
import { defaults } from '../../src/core/schema';
import { sanitize, Store } from '../../src/core/store';
import { covers, groundHeight, type TerrainSurface } from '../../src/core/terrain';
import { generateHeightmap, ISLAND_COAST } from '../../src/core/terrainGen';
import type { NodeDoc } from '../../src/core/types';
import { buildIsland, findStart, type IslandEditor } from '../../src/exampleIsland';

const g = globalThis as any;
const realFetch = g.fetch;
const catalog = readFileSync(new URL('../../library/catalog.json', import.meta.url), 'utf8');

/** Pages are served from `base`, the Library's catalog with them (a catalog read once is kept). */
function serve(base: string) {
    g.document.baseURI = base;
    g.fetch = async (url: string) => (String(url).endsWith('/library/catalog.json') ? new Response(catalog) : new Response('', { status: 404 }));
}

afterEach(() => {
    g.fetch = realFetch;
    delete g.document.baseURI;
});

/** Builds the island on a device of this tier with the editor's commands as stand-ins; resolves with its store. */
async function build(deviceQuality: 'low' | 'high'): Promise<Store> {
    const store = new Store(emptyScene());
    let surface: TerrainSurface | null = null;
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
            // As the editor makes it: the coast at the water's height.
            const map = generateHeightmap({ shape: 'island', resolution: o.resolution ?? 513, seed: o.seed ?? 1, erosion: o.erosion });
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
    return store;
}

describe('the Island example', () => {
    it('is the same after a reload: every count within what its components hold, the dog and its tree too', async () => {
        serve('http://island.test/');
        for (const tier of ['high', 'low'] as const) {
            const store = await build(tier);
            const doc = JSON.parse(JSON.stringify(store.doc));
            const again = sanitize(doc);
            expect(again.nodes).toEqual(doc.nodes);
            expect(again.behaviors).toEqual(doc.behaviors);
            expect(doc.nodes.find((n: NodeDoc) => n.name === 'Dog')?.agent?.tree).toBe(doc.behaviors[0].id);
        }
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

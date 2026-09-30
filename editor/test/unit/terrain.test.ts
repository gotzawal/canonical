import { describe, expect, it } from 'vitest';
import { decodePngHeightmap, encodePngHeightmap, heightAt } from '../../src/core/heightmap';
import { chunkCounts, chunkMesh, groundHeight, rayTerrain } from '../../src/core/terrain';
import { generateHeightmap, ISLAND_COAST, sculpt } from '../../src/core/terrainGen';

describe('terrain', () => {
    it('makes the same island from the same seed and keeps its 16-bit heights in the PNG file', async () => {
        const map = generateHeightmap({ shape: 'island', resolution: 65, seed: 7 });
        expect(generateHeightmap({ shape: 'island', resolution: 65, seed: 7 }).data).toEqual(map.data);
        // Sea at the edge, land above the coast in the middle.
        expect(map.data[0]).toBeLessThan(ISLAND_COAST);
        expect(heightAt(map, 32, 32)).toBeGreaterThan(ISLAND_COAST);
        const back = await decodePngHeightmap(await encodePngHeightmap(map));
        expect(back.width).toBe(65);
        for (let i = 0; i < map.data.length; i += 97) expect(back.data[i]).toBeCloseTo(map.data[i], 4);
    });

    it('draws coarser chunks with skirts, sculpts, and finds the ground under a ray', () => {
        const map = generateHeightmap({ shape: 'flat', resolution: 257, seed: 1 });
        const frame = { x: 0, y: 0, z: 0, sizeX: 256, sizeZ: 256, height: 20 };
        expect(chunkCounts(map)).toEqual([8, 8]);
        // 33 x 33 samples and a skirt around them; the third level draws every fourth sample and its own skirt.
        const chunk = chunkMesh(map, frame, 0, 0, 1);
        expect(chunk.positions.length / 3).toBe(33 * 33 + 128);
        expect(chunk.lods.map((l) => l.count)).toEqual([32, 16, 8, 4].map((n) => (n * n * 2 + n * 4 * 2) * 3));
        sculpt(map, 'flatten', { points: [[128, 128]], radius: 20, strength: 1 }, { target: 0.5 });
        const surface = { frame, map };
        expect(groundHeight(surface, 0, 0)).toBeCloseTo(10, 3);
        expect(rayTerrain(surface, [0, 50, 0], [0, -1, 0])).toBeCloseTo(40, 1);
    });
});

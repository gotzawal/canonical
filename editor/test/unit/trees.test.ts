// Trees grown from rules (core/trees.ts): the same tree from a seed, its
// height as asked, levels of detail that get much lighter, and the wind,
// shade and phase each vertex carries; trees in documents and scatters.
import { describe, expect, it } from 'vitest';
import { defaultTree, forestScatter } from '../../src/core/defaults';
import { Scatter, ScatterSource, Tree } from '../../src/core/model';
import { repair } from '../../src/core/schema';
import { growTree, LEAF_CELLS, SPECIES_HEIGHT, TREE_SPECIES, TREE_VARIANTS, treeTriangles, variantIndex, variantSeed, type TreeMesh, type TreeShape } from '../../src/core/trees';

const shape = (species: TreeShape['species'], height = 14): TreeShape => ({ species, height, width: 1, trunk: 1, branches: 1, leaves: 1, leafSize: 1, gnarl: 0.5 });

/** What is wrong with a part, or '' (counted in plain loops: there are many vertices). */
function check(mesh: TreeMesh, min: number[], max: number[]): string {
    const vertices = mesh.positions.length / 3;
    if (mesh.normals.length !== vertices * 3 || mesh.uvs.length !== vertices * 2 || mesh.data.length !== vertices * 2) return 'attribute lengths';
    if (mesh.indices.length % 3) return 'index count';
    for (const i of mesh.indices) if (i >= vertices) return 'index out of range';
    for (let i = 0; i < vertices; i++) {
        if (Math.abs(Math.hypot(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]) - 1) > 1e-3) return 'normal not unit';
        // The wind moves no vertex backward; the shade is a whole number of 0 to 255 and the phase a fraction.
        if (mesh.data[i * 2] < 0) return 'negative flex';
        const shade = Math.floor(mesh.data[i * 2 + 1]);
        if (shade < 0 || shade > 255) return 'shade out of range';
        for (let k = 0; k < 3; k++) {
            const v = mesh.positions[i * 3 + k];
            if (v < min[k] - 1e-4 || v > max[k] + 1e-4) return 'outside the box';
        }
    }
    return '';
}

describe('trees', () => {
    it('grows the same tree from a seed and another from another seed', () => {
        const a = growTree(shape('oak'), 3);
        const b = growTree(shape('oak'), 3);
        const c = growTree(shape('oak'), 4);
        expect(Array.from(b.lods[0].bark.positions)).toEqual(Array.from(a.lods[0].bark.positions));
        expect(Array.from(b.lods[0].leaves.positions)).toEqual(Array.from(a.lods[0].leaves.positions));
        expect(Array.from(c.lods[0].bark.positions)).not.toEqual(Array.from(a.lods[0].bark.positions));
    });

    it('reaches the height asked, stands on its trunk and holds every level in its box', () => {
        for (const species of TREE_SPECIES) {
            for (const height of [6, 14, 25]) {
                const t = growTree(shape(species, height), 1);
                expect(t.max[1]).toBeGreaterThan(height * 0.97);
                expect(t.max[1]).toBeLessThan(height * 1.1);
                // Its foot sinks a little into the ground; nothing hangs far below it.
                expect(t.min[1]).toBeGreaterThan(-1);
                expect(t.trunk.radius).toBeGreaterThan(0.01);
                expect(t.trunk.height).toBeGreaterThan(0.5);
                for (const lod of t.lods) for (const part of [lod.bark, lod.leaves]) expect(check(part, t.min, t.max)).toBe('');
            }
        }
    });

    it('draws far away with a small share of its triangles, and a crown of leaf cards near', () => {
        for (const species of TREE_SPECIES) {
            const t = growTree(shape(species), 2);
            const [near, mid, far] = treeTriangles(t);
            expect(near).toBeLessThan(16000);
            expect(mid).toBeLessThan(near * 0.35);
            expect(far).toBeLessThan(near * 0.08);
            // Leaf cards sample the columns of the leaf texture; far ones the last, dense one.
            const uv = Array.from(t.lods[0].leaves.uvs);
            expect(uv.length).toBeGreaterThan(600 * 2);
            expect(Math.min(...uv)).toBeGreaterThanOrEqual(0);
            expect(Math.max(...uv)).toBeLessThanOrEqual(1);
            const farU = Array.from(t.lods[2].leaves.uvs).filter((_, i) => i % 2 === 0);
            expect(Math.min(...farU)).toBeGreaterThanOrEqual((LEAF_CELLS - 1) / LEAF_CELLS - 1e-6);
        }
    });

    it('moves its twigs in the wind more than its trunk, and shades the inside of its crown', () => {
        const t = growTree(shape('oak'), 5);
        const bark = t.lods[0].bark, leaves = t.lods[0].leaves;
        // The trunk is the first tube: its vertices stay put (the shaders sway it as a whole).
        expect(bark.data[0]).toBe(0);
        let most = 0;
        for (let i = 0; i < leaves.data.length; i += 2) most = Math.max(most, leaves.data[i]);
        expect(most).toBeGreaterThan(0.05);
        // Cards near the crown's middle are darker than those at its edge.
        const c = t.crown.center, r = t.crown.radius;
        const inner: number[] = [], outer: number[] = [];
        for (let i = 0; i < leaves.positions.length / 3; i++) {
            const q = [0, 1, 2].map((k) => (leaves.positions[i * 3 + k] - c[k]) / r[k]);
            const d = Math.hypot(q[0], q[1], q[2]);
            const shade = Math.floor(leaves.data[i * 2 + 1]) / 255;
            if (d < 0.4) inner.push(shade);
            else if (d > 0.9) outer.push(shade);
        }
        const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
        expect(inner.length).toBeGreaterThan(5);
        expect(mean(inner)).toBeLessThan(mean(outer) - 0.15);
    });

    it('keeps a taller tree\'s triangles near its species\' own', () => {
        for (const species of TREE_SPECIES) {
            const own = treeTriangles(growTree(shape(species, SPECIES_HEIGHT[species]), 1))[0];
            // Leaf cards grow with the height's root and thin out per meter: about linear, not with its square.
            expect(treeTriangles(growTree(shape(species, SPECIES_HEIGHT[species] * 3), 1))[0]).toBeLessThan(own * 4.2);
        }
    });

    it('keeps a tree in the document valid, and a scatter\'s tree source', () => {
        const oak = defaultTree('oak', 42);
        expect(oak).toMatchObject({ species: 'oak', seed: 42, height: SPECIES_HEIGHT.oak });
        // Fields out of range are clamped, an unknown species is an oak.
        expect(repair(Tree, { ...oak, species: 'palm', height: 500, leaves: -1 })).toMatchObject({ species: 'oak', height: 60, leaves: 0 });
        // A broken tree leaves its source a model source; a scatter of an older version has none.
        expect(ScatterSource.parse({ model: 'm', tree: 'oak' }).tree).toBeUndefined();
        expect(Scatter.parse({ sources: [{ model: 'm' }] }).sources[0].tree).toBeUndefined();
        expect(Scatter.parse({ sources: [{ tree: { species: 'birch' } }] }).sources[0].tree).toMatchObject({ species: 'birch' });
    });

    it('grows a scatter\'s copies as variants of its tree, and baked copies grow the same', () => {
        const seeds = Array.from({ length: TREE_VARIANTS }, (_, k) => variantSeed(999_990, k));
        expect(seeds[0]).toBe(999_990);
        // Within the seeds a tree takes (0 to 999999), all different.
        for (const s of seeds) expect(s >= 0 && s <= 999_999 && Number.isInteger(s)).toBe(true);
        expect(new Set(seeds).size).toBe(TREE_VARIANTS);
        expect([0, 0.24, 0.25, 0.99, 1].map((v) => variantIndex(v, 4))).toEqual([0, 0, 1, 3, 3]);
    });

    it('makes forest rules by the area: a tree per 50 square meters, solid trunks', () => {
        const trees = TREE_SPECIES.map((sp) => ({ tree: defaultTree(sp, 1), weight: 1 }));
        const small = forestScatter(trees, [80, 80]);
        expect(small.count).toBe(128);
        expect(small.sources.map((s) => [s.tree?.species, s.model, s.solid])).toEqual(TREE_SPECIES.map((sp) => [sp, null, 'trunk']));
        expect(forestScatter(trees, [10, 10]).count).toBe(20);
        expect(forestScatter(trees, [1000, 1000]).count).toBe(1500);
        // Valid rules as they are.
        expect(Scatter.parse(small)).toEqual(small);
    });
});

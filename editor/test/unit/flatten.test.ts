import { describe, expect, it } from 'vitest';
import { newScene } from '../../src/core/defaults';
import { flattenTexture, multiplyHex, usesAsMap } from '../../src/core/flatten';

describe('flat-color textures', () => {
    it('become the values of the materials using them', () => {
        const doc = newScene();
        const box = doc.nodes.find((n) => n.mesh)!;
        const m = box.mesh!.material;
        Object.assign(m, { color: '#ffffff', opacity: 1, roughness: 0.8, metallic: 1, map: 'red', metalRoughMap: 'orm', normalMap: 'flat', aoMap: 'grey' });
        expect(usesAsMap(doc, 'red')).toBe(true);
        expect(flattenTexture(doc, 'red', [255, 0, 0, 128])).toBe(1);
        expect(m.map).toBeNull();
        expect(m.color).toBe('#ff0000');
        expect(m.opacity).toBeCloseTo(0.502, 2);
        // Roughness in G, metalness in B.
        expect(flattenTexture(doc, 'orm', [0, 128, 64, 255])).toBe(1);
        expect(m.roughness).toBeCloseTo(0.8 * (128 / 255), 3);
        expect(m.metallic).toBeCloseTo(64 / 255, 3);
        expect(m.metalRoughMap).toBeUndefined();
        expect(flattenTexture(doc, 'flat', [128, 128, 255, 255])).toBe(1);
        expect(m.normalMap).toBeUndefined();
        // A grey occlusion map has no value to go to: it stays.
        expect(flattenTexture(doc, 'grey', [128, 128, 128, 255])).toBe(0);
        expect(m.aoMap).toBe('grey');
        expect(usesAsMap(doc, 'red')).toBe(false);
    });

    it('multiply colors in linear space, as the GPU does', () => {
        expect(multiplyHex('#ffffff', [200, 100, 50, 255])).toBe('#c86432');
        expect(multiplyHex('#808080', [255, 255, 255, 255])).toBe('#808080');
        expect(multiplyHex('#808080', [128, 128, 128, 255])).toBe('#3d3d3d');
    });
});

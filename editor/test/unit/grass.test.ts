import { describe, expect, it } from 'vitest';
import { bladeBend, bladeProfile, patchNoise, shapeAt, sizeAt } from '../../src/core/grass';

describe('grass blades', () => {
    it('shapes leaves broad in their lower middle and needles thin, all to a point', () => {
        const leaf = bladeProfile('leaf', 5);
        const needle = bladeProfile('needle', 5);
        expect(Math.max(...leaf)).toBe(leaf[2]);
        expect(leaf[2]).toBeGreaterThan(1);
        expect(Math.max(...needle)).toBeLessThan(0.5);
        expect(leaf[5]).toBeCloseTo(0, 6);
        expect(needle[5]).toBeCloseTo(0, 6);
        expect(bladeBend('leaf', 0.4)).toBeGreaterThan(bladeBend('needle', 0.4));
    });

    it('spreads sizes and shapes as asked', () => {
        const rs = Array.from({ length: 2000 }, (_, i) => ((i * 0.618034) % 1));
        const mean = (f: (r: number, i: number) => number) => rs.reduce((s, r, i) => s + f(r, i), 0) / rs.length;
        // Mostly short: most blades in the lower part of the range.
        expect(mean((r) => (sizeAt('short', r, [0, 0], 0.5) < 0.3 ? 1 : 0))).toBeGreaterThan(0.55);
        // Bell: few at the ends.
        expect(mean((r, i) => { const t = sizeAt('bell', r, [rs[(i + 7) % rs.length], rs[(i + 13) % rs.length]], 0.5); return t < 0.15 || t > 0.85 ? 1 : 0; })).toBeLessThan(0.1);
        // Patches: the size follows the patch noise.
        expect(sizeAt('patches', 0.5, [0, 0], 0.9)).toBeGreaterThan(0.8);
        expect(sizeAt('patches', 0.5, [0, 0], 0.1)).toBeLessThan(0.2);
        // Shapes by their shares, mixed or in patches.
        const shares = { blade: 2, leaf: 1, needle: 1 };
        expect(mean((r) => (shapeAt(shares, 'mixed', r, 0.5) === 'blade' ? 1 : 0))).toBeCloseTo(0.5, 1);
        expect(shapeAt(shares, 'patches', 0.6, 0.9)).toBe('needle');
        expect(shapeAt(shares, 'patches', 0.6, 0.1)).toBe('blade');
        expect(shapeAt({ blade: 0, leaf: 0, needle: 0 }, 'mixed', 0.3, 0.5)).toBe('blade');
        // The patch noise is smooth and repeatable.
        expect(patchNoise(3.2, 7.1, 4, 9)).toBe(patchNoise(3.2, 7.1, 4, 9));
        expect(Math.abs(patchNoise(3.2, 7.1, 4, 9) - patchNoise(3.25, 7.1, 4, 9))).toBeLessThan(0.05);
    });
});

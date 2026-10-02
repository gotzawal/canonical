import { describe, expect, it } from 'vitest';
import { ADAPTIVE_SCALES, AdaptiveResolution } from '../../src/core/adaptive';

/** Feeds `seconds` of frames taking `dt` ms; the scales it went through. */
function run(a: AdaptiveResolution, dt: number, seconds: number, clock: { t: number }): number[] {
    const scales: number[] = [];
    for (let i = 0; i < (seconds * 1000) / dt; i++) {
        clock.t += dt;
        if (a.frame(dt, 1000 / 60, clock.t)) scales.push(a.scale);
    }
    return scales;
}

describe('adaptive resolution', () => {
    it('stays sharp while frames come in time', () => {
        const a = new AdaptiveResolution();
        expect(run(a, 16.7, 30, { t: 0 })).toEqual([]);
        expect(a.scale).toBe(1);
    });

    it('steps down while frames run late, to the lowest step at most', () => {
        const a = new AdaptiveResolution();
        const clock = { t: 0 };
        expect(run(a, 25, 2.5, clock)).toEqual([ADAPTIVE_SCALES[1]]);
        run(a, 40, 60, clock);
        expect(a.scale).toBe(ADAPTIVE_SCALES.at(-1));
    });

    it('steps back up when there is room, and waits longer after a step up that failed', () => {
        const a = new AdaptiveResolution();
        const clock = { t: 0 };
        run(a, 25, 3, clock);
        expect(a.level).toBe(1);
        // In time again: up after six in-time windows.
        expect(run(a, 16.7, 8, clock)).toEqual([1]);
        // Late at once: down again, and the next try up waits twice as long.
        run(a, 25, 3, clock);
        expect(a.level).toBe(1);
        expect(run(a, 16.7, 8, clock)).toEqual([]);
        expect(run(a, 16.7, 6, clock)).toEqual([1]);
    });

    it('ignores stalls and hidden tabs', () => {
        const a = new AdaptiveResolution();
        expect(run(a, 1000, 20, { t: 0 })).toEqual([]);
    });
});

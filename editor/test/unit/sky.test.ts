import { describe, expect, it } from 'vitest';
import { newScene } from '../../src/core/defaults';
import { Environment } from '../../src/core/model';
import { defaults, patch, repair, toolSchema } from '../../src/core/schema';
import { skyParams, skySunOf } from '../../src/core/sky';

describe('the sky', () => {
    it('keeps the look of scenes saved before the physical sky', () => {
        expect(defaults(Environment).atmosphere).toEqual({ sunSize: 1, sunBrightness: 1, showSun: true, altitude: 1500, clouds: false });
        const old = repair(Environment, { sky: 'atmospheric', sunX: 0.5, sunY: 0.7 })!;
        expect(old.sky).toBe('atmospheric');
        // The defaults are the sky component's own: the same sun disc and viewer height.
        expect(skyParams(old)).toMatchObject({ sunX: 0.5, sunY: 0.7, eyePos: 1500, sunRadius: 500, sunBrightness: 1, displaySun: true, enableClouds: false });
        // An editor that does not know a sky falls back to the atmospheric one.
        expect(repair(Environment, { sky: 'volumetric' })!.sky).toBe('atmospheric');
    });

    it('takes the assistant\'s physical sky and its clouds', () => {
        const env = patch(Environment, defaults(Environment), { sky: 'physical', atmosphere: { clouds: true, sun_size: 2, altitude: 3000 } }, 'environment');
        expect(skyParams(env)).toMatchObject({ enableClouds: true, sunRadius: 125, eyePos: 3000 });
        // Clouds belong to the physical sky only.
        expect(skyParams({ ...env, sky: 'atmospheric' }).enableClouds).toBe(false);
        const props = toolSchema(Environment).properties;
        expect(props.sky.enum).toEqual(['atmospheric', 'physical', 'color', 'hdri']);
        expect(Object.keys(props.atmosphere.properties)).toEqual(['sun_size', 'sun_brightness', 'show_sun', 'altitude', 'clouds']);
    });

    it('puts the sun of a new scene where its Sun light comes from', () => {
        expect(skySunOf([50, 30, 0])).toEqual({ sunX: 120 / 360, sunY: 50 / 180 + 0.5 });
        expect(skySunOf([10, -120, 0]).sunX).toBeCloseTo(330 / 360);
        expect(skySunOf([120, 0, 0]).sunY).toBe(1);
        const doc = newScene();
        const sun = doc.nodes.find((n) => n.name === 'Sun')!;
        expect({ sunX: doc.environment.sunX, sunY: doc.environment.sunY }).toEqual(skySunOf(sun.rotation));
    });
});

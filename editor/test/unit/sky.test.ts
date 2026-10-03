import { describe, expect, it } from 'vitest';
import { newScene } from '../../src/core/defaults';
import { Environment } from '../../src/core/model';
import { defaults, patch, toolSchema } from '../../src/core/schema';
import { migrateScene } from '../../src/core/migrate';
import { skyParams, skySunOf, sunlightThroughAir } from '../../src/core/sky';

describe('the sky', () => {
    it('takes the assistant\'s physical sky and its clouds', () => {
        const env = patch(Environment, defaults(Environment), { sky: 'physical', atmosphere: { clouds: true, sun_size: 2, altitude: 3000 } }, 'environment');
        expect(skyParams(env)).toMatchObject({ enableClouds: true, sunRadius: 125, eyePos: 3000 });
        // Clouds belong to the physical sky only.
        expect(skyParams({ ...env, sky: 'atmospheric' }).enableClouds).toBe(false);
        const props = toolSchema(Environment).properties;
        expect(props.sky.enum).toEqual(['atmospheric', 'physical', 'color', 'hdri']);
        expect(Object.keys(props.atmosphere.properties)).toEqual(['sun_size', 'sun_brightness', 'show_sun', 'altitude', 'clouds', 'follow_light', 'haze']);
    });

    it('puts the sun of a new scene where its Sun light comes from', () => {
        expect(skySunOf([50, 30, 0])).toEqual({ sunX: 120 / 360, sunY: 50 / 180 + 0.5 });
        expect(skySunOf([10, -120, 0]).sunX).toBeCloseTo(330 / 360);
        expect(skySunOf([120, 0, 0]).sunY).toBe(1);
        const doc = newScene();
        const sun = doc.nodes.find((n) => n.name === 'Sun')!;
        expect({ sunX: doc.environment.sunX, sunY: doc.environment.sunY }).toEqual(skySunOf(sun.rotation));
    });

    it('reddens and dims sunlight through the air as the sun gets low, and none below the horizon', () => {
        const high = sunlightThroughAir(90);
        expect(high.color.map((v) => +v.toFixed(3))).toEqual([1, 1, 1]);
        expect(high.strength).toBeCloseTo(1, 3);
        const low = sunlightThroughAir(5);
        expect(low.color[0]).toBe(1);
        expect(low.color[2]).toBeLessThan(0.3);
        expect(low.strength).toBeLessThan(0.5);
        expect(sunlightThroughAir(-3).strength).toBe(0);
    });

    it('leaves the sky sun and look of scenes saved before the sky followed the key light', () => {
        const old = migrateScene({ format: 'canonical-scene', version: 4, environment: { sky: 'physical', sunY: 0.48, atmosphere: { clouds: true } }, nodes: [] });
        expect(old.environment.atmosphere).toMatchObject({ clouds: true, followLight: false, haze: 0 });
        expect(newScene().environment.atmosphere).toMatchObject({ followLight: true, haze: 1 });
    });
});

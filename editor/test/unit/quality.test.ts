import { describe, expect, it } from 'vitest';
import { Environment } from '../../src/core/model';
import { pickQuality, QUALITY, resolveQuality, sunScatterToLine } from '../../src/core/quality';
import { defaults, InputError, patch, repair, toolSchema } from '../../src/core/schema';

describe('graphics quality', () => {
    const device = (gpu: string, extra: Partial<Parameters<typeof pickQuality>[0]> = {}) => pickQuality({ gpu, fallback: false, mobile: false, ...extra });

    it('picks a tier for the device', () => {
        expect(device('google swiftshader')).toBe('low');
        expect(device('nvidia', { fallback: true })).toBe('low');
        expect(device('qualcomm adreno')).toBe('low');
        expect(device('apple', { mobile: true })).toBe('low');
        expect(device('intel xe')).toBe('medium');
        expect(device('apple metal-3')).toBe('medium');
        expect(device('')).toBe('medium');
        expect(device('nvidia ampere geforce')).toBe('high');
        expect(device('amd rdna-3')).toBe('high');
        // Little memory or small textures hold a dedicated GPU at medium; very little means low.
        expect(device('nvidia', { memory: 4 })).toBe('medium');
        expect(device('amd', { maxTexture: 8192 })).toBe('medium');
        expect(device('nvidia', { memory: 2 })).toBe('low');
    });

    it('draws a preview over the scene setting over the device', () => {
        expect(resolveQuality('auto', 'medium')).toBe('medium');
        expect(resolveQuality('low', 'high')).toBe('low');
        expect(resolveQuality('low', 'high', 'medium')).toBe('medium');
        expect(resolveQuality(undefined, 'high')).toBe('high');
    });

    it('keeps the high tier as the editor drew before', () => {
        expect(QUALITY.high).toMatchObject({ shadowMapSize: 2048, pointShadowSize: 1024, shadowRangeMax: Infinity, shadowEvery: 1, giRealtime: true, ao: true });
        expect(QUALITY.low.shadowMapSize).toBeLessThan(QUALITY.high.shadowMapSize);
        expect(QUALITY.low.godRaySteps).toBe(0);
        // Games on weak devices load textures smaller; the high tier as they are.
        expect([QUALITY.low.textureMaxSize, QUALITY.medium.textureMaxSize, QUALITY.high.textureMaxSize]).toEqual([1024, 2048, Infinity]);
    });

    it('turns the fog glow into the engine setting', () => {
        expect(sunScatterToLine(0)).toBe(0);
        expect(sunScatterToLine(0.5)).toBeCloseTo(1);
        // The default glow keeps the engine's default line.
        expect(sunScatterToLine(1)).toBe(10);
    });
});

describe('environment settings of the graphics upgrade', () => {
    it('default to what scenes looked like before', () => {
        const env = defaults(Environment);
        expect(env.quality).toBe('auto');
        expect(env.shadow).toEqual({ softness: 1 });
        expect(env.fog).toMatchObject({ enable: false, mode: 'linear', near: 5, far: 80, intensity: 1, sky: 0.8, sunScatter: 1, sunFocus: 2.7 });
        expect(env.godRays.enable).toBe(false);
        expect(env.volumetricFog.enable).toBe(false);
        // A scene saved before keeps its fog and gets the rest.
        const old = repair(Environment, { sky: 'color', fog: { enable: true, color: '#112233', near: 2, far: 40, intensity: 0.5 } })!;
        expect(old.fog).toMatchObject({ enable: true, color: '#112233', near: 2, far: 40, intensity: 0.5, mode: 'linear', density: 0.02 });
    });

    it('take the assistant\'s snake_case arguments, clamped', () => {
        const env = patch(Environment, defaults(Environment), { fog: { mode: 'height', height_falloff: 0.2 }, god_rays: { enable: true, focus: 100 }, volumetric_fog: { anisotropy: 2 }, shadow: { softness: 9 } }, 'environment');
        expect(env.fog).toMatchObject({ mode: 'height', heightFalloff: 0.2 });
        expect(env.godRays).toMatchObject({ enable: true, focus: 40 });
        expect(env.volumetricFog.anisotropy).toBe(0.95);
        expect(env.shadow.softness).toBe(4);
        expect(() => patch(Environment, env, { god_rays: { strength: 1 } }, 'environment')).toThrow(InputError);
        const props = toolSchema(Environment).properties;
        expect(props.quality.enum).toEqual(['auto', 'low', 'medium', 'high']);
        expect(props.fog.properties.mode.enum).toEqual(['linear', 'exponential', 'height']);
        expect(Object.keys(props.god_rays.properties)).toEqual(['enable', 'intensity', 'focus']);
    });
});

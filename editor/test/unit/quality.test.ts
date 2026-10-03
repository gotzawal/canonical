import { describe, expect, it } from 'vitest';
import { Environment } from '../../src/core/model';
import { editorQuality, isMobileDevice, pickQuality, resolveQuality, sunScatterToLine } from '../../src/core/quality';
import { defaults, repair } from '../../src/core/schema';

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

    it('draws the low tier in the editor on phones and tablets, the high one on computers', () => {
        const phone = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36', maxTouchPoints: 5 };
        // An iPad reports a Mac, but has touch.
        const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', maxTouchPoints: 5 };
        const mac = { userAgent: ipad.userAgent, maxTouchPoints: 0 };
        expect([phone, ipad, mac].map((nav) => editorQuality(isMobileDevice(nav)))).toEqual(['low', 'low', 'high']);
        // A scene that leaves the tier to the device gets the editor's; one that names a tier draws it.
        expect(resolveQuality('auto', editorQuality(true))).toBe('low');
        expect(resolveQuality('high', editorQuality(true))).toBe('high');
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
});

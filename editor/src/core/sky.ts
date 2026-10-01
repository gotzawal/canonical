// The sky's settings as the engine's sky components take them, and where
// the sky's sun is for a directional light. No engine imports: the runtime
// (engine/runtime.ts) applies them, and they are testable here.

import type { EnvironmentDoc, Vec3 } from './types';

/**
 * The sky's sun (sunX azimuth, sunY elevation, 0..1) of a directional light
 * with this rotation (degrees), by the rule the engine's skies follow when a
 * light drives them: sunX = (rotationY + 90) / 360, sunY = rotationX / 180 + 0.5.
 */
export function skySunOf(rotation: Vec3): { sunX: number; sunY: number } {
    const wrap = (v: number) => ((v % 360) + 360) % 360;
    return { sunX: wrap(rotation[1] + 90) / 360, sunY: Math.max(0, Math.min(1, rotation[0] / 180 + 0.5)) };
}

/** What the atmospheric and physical sky components get. */
export interface SkyParams {
    sunX: number;
    sunY: number;
    /** Viewer altitude, meters. */
    eyePos: number;
    /** Inverse size of the sun disc (500: the default disc, about 3.6 degrees). */
    sunRadius: number;
    sunBrightness: number;
    displaySun: boolean;
    /** The physical sky's cloud layer. */
    enableClouds: boolean;
    /** Brightness of the visible dome (not of the light it gives). */
    exposure: number;
}

export function skyParams(env: EnvironmentDoc): SkyParams {
    const a = env.atmosphere;
    return {
        sunX: env.sunX,
        sunY: env.sunY,
        eyePos: a.altitude,
        sunRadius: 500 / (a.sunSize * a.sunSize),
        sunBrightness: a.sunBrightness,
        displaySun: a.showSun,
        enableClouds: env.sky === 'physical' && a.clouds,
        exposure: env.skyExposure,
    };
}

/**
 * Sunlight after the air it crosses to reach a viewer `altitude` meters up
 * with the sun `elevation` degrees over the horizon: Rayleigh scattering,
 * Mie haze and ozone over a spherical Earth (the physical sky's
 * coefficients), relative to the sun straight overhead. `color` has its
 * largest channel at 1 (white overhead, orange and red near the horizon)
 * and `strength` is how bright it is (1 overhead, 0 once the sun is
 * below the horizon).
 */
export function sunlightThroughAir(elevation: number, altitude = 0): { color: [number, number, number]; strength: number } {
    const R = 6360e3, TOP = 6460e3;
    const rayleigh = [5.802e-6, 13.558e-6, 33.1e-6];
    const mie = 4.4e-6;
    const ozone = [0.65e-6, 1.881e-6, 0.085e-6];
    const depth = (deg: number): number[] => {
        const e = (deg * Math.PI) / 180;
        const r0 = R + Math.max(0, altitude);
        const dir = [Math.cos(e), Math.sin(e)];
        // From the viewer to the top of the air: |p + t d| = TOP.
        const b = r0 * dir[1];
        const far = -b + Math.sqrt(b * b - r0 * r0 + TOP * TOP);
        const steps = 64;
        const out = [0, 0, 0];
        for (let i = 0; i < steps; i++) {
            const t = ((i + 0.5) / steps) * far;
            const h = Math.hypot(t * dir[0], r0 + t * dir[1]) - R;
            if (h < 0) return [Infinity, Infinity, Infinity];
            const ray = Math.exp(-h / 8000);
            const haze = Math.exp(-h / 1200);
            const oz = Math.max(0, 1 - Math.abs(h - 25000) / 15000);
            const dt = far / steps;
            for (let c = 0; c < 3; c++) out[c] += (rayleigh[c] * ray + mie * haze + ozone[c] * oz) * dt;
        }
        return out;
    };
    const overhead = depth(90);
    // Below the horizon the Earth hides the sun: fade out over the last degree.
    const at = depth(Math.max(elevation, 0.5));
    const t = at.map((d, c) => Math.exp(-(d - overhead[c])));
    const fade = Math.min(1, Math.max(0, (elevation + 1) / 2));
    const max = Math.max(t[0], t[1], t[2], 1e-6);
    const luminance = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
    return { color: [t[0] / max, t[1] / max, t[2] / max], strength: Math.min(1, luminance) * fade };
}

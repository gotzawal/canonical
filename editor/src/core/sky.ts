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

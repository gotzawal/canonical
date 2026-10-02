// Weather and the time of day (Environment.weather): one place that sets
// the sun, the sky, the key light (the sun by day, the moon by night), the
// clouds, fog, haze, rain and the wind that grass, clouds and rain share.
// Pure: SceneSync shows the environment and light it gives.

import { CLOUD_PRESETS } from './clouds';
import { sunlightThroughAir } from './sky';
import type { EnvironmentDoc, Vec3 } from './types';

export const WEATHERS = ['clear', 'fair', 'cloudy', 'overcast', 'rain', 'storm', 'fog'] as const;
export type Weather = (typeof WEATHERS)[number];

/** What each weather brings: a cloud preset (or none), rain, fog, haze, how much direct light gets through, and wind. */
const LOOKS: Record<Weather, { clouds: string | null; rain: number; fog: number; haze: number; light: number; gust: number; density?: number }> = {
    clear: { clouds: null, rain: 0, fog: 0, haze: 1, light: 1, gust: 1 },
    fair: { clouds: 'fair', rain: 0, fog: 0, haze: 1, light: 1, gust: 1 },
    cloudy: { clouds: 'broken', rain: 0, fog: 0, haze: 1.3, light: 0.75, gust: 1.2 },
    overcast: { clouds: 'overcast', rain: 0, fog: 0, haze: 1.8, light: 0.35, gust: 1.2 },
    rain: { clouds: 'overcast', rain: 0.6, fog: 0.25, haze: 2.5, light: 0.25, gust: 1.5, density: 2 },
    storm: { clouds: 'towering', rain: 1, fog: 0.3, haze: 3, light: 0.15, gust: 2.5, density: 2.5 },
    fog: { clouds: 'sheets', rain: 0, fog: 1, haze: 4, light: 0.6, gust: 0.4 },
};

export interface WeatherNow {
    /** The environment with the weather's sky sun, clouds, fog, haze and wind. */
    env: EnvironmentDoc;
    /** The key light: its rotation (degrees, as a directional light's), color (linear, largest 1) and how bright, times its own. */
    light: { rotation: Vec3; color: [number, number, number]; strength: number };
    /** Where the sky's sun is drawn (degrees, as a directional light's rotation), and the sun's true elevation. */
    sun: { rotation: Vec3; elevation: number };
    night: boolean;
    /** How bright the stars are, 0 to 1. */
    stars: number;
    /** How hard it rains around the camera, 0 to 1. */
    rain: number;
    /** The wind: m/s, and where it blows toward (degrees around +Y from +X). */
    wind: { speed: number; direction: number };
}

/** The weather and light of `env` at `time` (hours, 0 to 24). */
export function weatherNow(env: EnvironmentDoc, time: number): WeatherNow {
    const w = env.weather;
    const look = LOOKS[w.preset] ?? LOOKS.fair;
    // The sun climbs from the sunrise direction at 6, peaks at noon height at 12, sets opposite at 18, and is as far under the horizon at midnight.
    const day = ((((time - 6) / 24) % 1) + 1) % 1;
    const elevation = w.noon * Math.sin(day * Math.PI * 2);
    const azimuth = w.sunrise + 360 * day;
    const sun: Vec3 = [elevation, azimuth, 0];
    const air = sunlightThroughAir(elevation, env.atmosphere.altitude);
    // The moon: across the sky from the sun, taking over as the light once the sun is well down.
    const night = elevation < -3;
    const moonUp = Math.min(1, Math.max(0, (-elevation - 2) / 8));
    const light = night
        ? { rotation: [-elevation * 0.8, azimuth + 180, 0] as Vec3, color: [0.62, 0.72, 1] as [number, number, number], strength: 0.07 * moonUp * (0.4 + 0.6 * look.light) }
        : { rotation: sun, color: air.color, strength: air.strength * look.light };
    const preset = look.clouds ? CLOUD_PRESETS.find((p) => p.id === look.clouds)?.look : null;
    const speed = w.wind * look.gust;
    // Dusk and night: the sky keeps the sun's glow just under the horizon and dims to dark (the single scattering sky has no twilight of its own).
    const dusk = Math.min(1, Math.max(0, (elevation + 12) / 13));
    const out: EnvironmentDoc = {
        ...env,
        skyExposure: env.skyExposure * (0.03 + 0.97 * dusk * dusk),
        atmosphere: { ...env.atmosphere, followLight: true, haze: env.atmosphere.haze * look.haze },
        clouds: {
            ...env.clouds,
            ...(preset ?? {}),
            ...(look.density ? { density: look.density } : {}),
            enable: !!preset,
            wind: speed,
            windDirection: w.windDirection,
        },
        fog: look.fog > 0
            ? { ...env.fog, enable: true, mode: 'exponential', near: 5, density: 0.003 + 0.03 * look.fog, color: night ? '#2a3038' : '#b4bcc6', intensity: 1, sky: 0.7 }
            : env.fog,
    };
    return {
        env: out,
        light,
        // Just over the horizon at sunset, sinking under it over the next 12 degrees (its glow goes with it).
        sun: { rotation: [elevation > 0 ? Math.max(elevation, 1.5) : elevation > -12 ? 1.5 * (1 + elevation / 6) : elevation, azimuth, 0], elevation },
        night,
        stars: w.stars * Math.min(1, Math.max(0, (-elevation - 4) / 8)),
        rain: look.rain,
        wind: { speed, direction: w.windDirection },
    };
}

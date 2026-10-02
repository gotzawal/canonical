// Graphics quality tiers: what a device can afford. The high tier draws as
// the editor always did; lower tiers use smaller shadow maps, cover less
// shadow range, drop the costly effects and render fewer pixels. Built
// games pick a tier for the device they run on (Environment.quality
// 'auto'); the editor draws the high tier unless View > Graphics Quality
// previews another. No engine imports: the player decides before the
// engine starts, and the unit tests run it in Node.

export const QUALITY_LEVELS = ['low', 'medium', 'high'] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];
export type QualitySetting = 'auto' | QualityLevel;

export interface QualityTier {
    /** A directional light's shadow map at medium resolution, pixels (low halves it, high doubles it). */
    shadowMapSize: number;
    /** Directional shadow maps are at most this size. */
    shadowMapMax: number;
    /** A point or spot light's shadow face at high resolution, pixels (medium halves it, low quarters it). */
    pointShadowSize: number;
    /** The point and spot lights' faces share an atlas at most this wide (faces halve to fit). */
    shadowAtlasMax: number;
    /** Directional shadows cover at most this many meters. */
    shadowRangeMax: number;
    /** Shadows are drawn again every this many frames. */
    shadowEvery: number;
    /** The sun may draw cascaded shadows (four maps); without, a scene asking for them gets one map around the camera. */
    cascades: boolean;
    /** Canvas resolution of games (Runtime VIEWPORT_QUALITY). */
    resolution: QualityLevel;
    /** Global illumination may capture every frame (its realtime option). */
    giRealtime: boolean;
    /** Ambient occlusion may run. */
    ao: boolean;
    /** Steps of the volumetric fog; 0 turns it off. */
    fogSteps: number;
    /** Samples of the god rays (8 to 20); 0 turns them off. */
    godRaySteps: number;
    /** Screen space reflections are traced at this share of the resolution; 0 turns them off. */
    ssrScale: number;
    /** Games load textures at most this large (the longer side, pixels): larger ones skip their top mips. */
    textureMaxSize: number;
    /** Anisotropic filtering of textures: surfaces seen at a grazing angle (floors, roads) stay sharp. */
    anisotropy: number;
    /** Distant ground fades into the sky (aerial perspective); off, the fog pass need not run for it. */
    aerial: boolean;
    /** Terrains mix each map with a larger copy far away (twice the texture reads there). */
    terrainFar: boolean;
    /** Planar mirrors (and water reflecting the scene) capture at this share of their resolution. */
    mirrorScale: number;
    /** Scattered models switch to simpler versions this much nearer (1 as set; less on weak devices). */
    lodDistance: number;
    /** Steps along each ray through the volumetric clouds. */
    cloudSteps: number;
    /** The sun's third cascade is drawn again every this many frames, its fourth every twice that. */
    farCascadeEvery: number;
    /** The clouds in reflections refresh a face of their cube every this many frames. */
    cloudReflectionEvery: number;
}

export const QUALITY: Record<QualityLevel, QualityTier> = {
    low: { shadowMapSize: 1024, shadowMapMax: 1024, pointShadowSize: 256, shadowAtlasMax: 2048, shadowRangeMax: 80, shadowEvery: 2, cascades: false, resolution: 'low', giRealtime: false, ao: false, fogSteps: 12, godRaySteps: 0, ssrScale: 0, textureMaxSize: 1024, anisotropy: 2, aerial: false, terrainFar: false, mirrorScale: 0.5, lodDistance: 0.6, cloudSteps: 20, farCascadeEvery: 4, cloudReflectionEvery: 2 },
    medium: { shadowMapSize: 1024, shadowMapMax: 2048, pointShadowSize: 512, shadowAtlasMax: 4096, shadowRangeMax: 200, shadowEvery: 1, cascades: true, resolution: 'medium', giRealtime: false, ao: true, fogSteps: 20, godRaySteps: 12, ssrScale: 0.5, textureMaxSize: 2048, anisotropy: 4, aerial: true, terrainFar: true, mirrorScale: 0.75, lodDistance: 0.8, cloudSteps: 32, farCascadeEvery: 2, cloudReflectionEvery: 1 },
    high: { shadowMapSize: 2048, shadowMapMax: 4096, pointShadowSize: 1024, shadowAtlasMax: 4096, shadowRangeMax: Infinity, shadowEvery: 1, cascades: true, resolution: 'high', giRealtime: true, ao: true, fogSteps: 32, godRaySteps: 16, ssrScale: 1, textureMaxSize: Infinity, anisotropy: 8, aerial: true, terrainFar: true, mirrorScale: 1, lodDistance: 1, cloudSteps: 48, farCascadeEvery: 2, cloudReflectionEvery: 1 },
};

/**
 * A light's shadow map size at a tier, pixels: a directional light's map
 * (each cascade), or each face of a point or spot light's.
 */
export function lightShadowSize(type: 'directional' | 'point' | 'spot', resolution: 'low' | 'medium' | 'high', tier: QualityTier): number {
    if (type === 'directional') {
        const s = resolution === 'low' ? tier.shadowMapSize / 2 : resolution === 'high' ? tier.shadowMapSize * 2 : tier.shadowMapSize;
        return Math.max(512, Math.min(tier.shadowMapMax, s));
    }
    const s = resolution === 'high' ? tier.pointShadowSize : resolution === 'medium' ? tier.pointShadowSize / 2 : tier.pointShadowSize / 4;
    return Math.max(64, s);
}

export const isQualityLevel = (v: unknown): v is QualityLevel => QUALITY_LEVELS.includes(v as QualityLevel);

/** The tier to draw: a preview or URL override, else the document's level, else the device's. */
export function resolveQuality(setting: QualitySetting | undefined, device: QualityLevel, override?: QualityLevel | null): QualityLevel {
    if (override) return override;
    return setting && setting !== 'auto' ? setting : device;
}

/** Whether the browser runs on a phone or tablet, from its user agent (iPads report a Mac one, but have touch). */
export function isMobileDevice(nav: { userAgent?: string; maxTouchPoints?: number; userAgentData?: { mobile?: boolean } } | undefined = globalThis.navigator): boolean {
    if (!nav) return false;
    const ua = nav.userAgent ?? '';
    return !!nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
}

/** What is known of the device before the engine starts (engine/device.ts). */
export interface DeviceInfo {
    /** Adapter vendor, architecture and description, lower case. */
    gpu: string;
    /** A software or fallback adapter. */
    fallback: boolean;
    /** A phone or tablet. */
    mobile: boolean;
    /** navigator.deviceMemory, GB. */
    memory?: number;
    /** The adapter's maxTextureDimension2D. */
    maxTexture?: number;
    /** The user asked to save data. */
    saveData?: boolean;
}

/**
 * The tier a device can afford: low on phones, tablets, software
 * renderers and devices with little memory; high on dedicated GPUs
 * (NVIDIA, AMD); medium otherwise (integrated GPUs, Apple, unknown).
 */
export function pickQuality(d: DeviceInfo): QualityLevel {
    const gpu = d.gpu.toLowerCase();
    if (d.fallback || /swiftshader|llvmpipe|software|microsoft basic/.test(gpu)) return 'low';
    if (d.mobile || /\b(arm|qualcomm|adreno|mali|imagination|img-tec|powervr|samsung|mediatek)\b/.test(gpu)) return 'low';
    if (d.memory !== undefined && d.memory <= 2) return 'low';
    let level: QualityLevel = /\b(nvidia|amd|radeon|geforce)\b/.test(gpu) ? 'high' : 'medium';
    const weak = (d.memory !== undefined && d.memory <= 4) || (d.maxTexture !== undefined && d.maxTexture < 16384) || !!d.saveData;
    if (level === 'high' && weak) level = 'medium';
    return level;
}

/** The fog's sun glow (0..1) as the engine's dirHeightLine: strength 1 - 2^-line. */
export function sunScatterToLine(s: number): number {
    if (!(s > 0)) return 0;
    if (s >= 0.999) return 10;
    return -Math.log2(1 - s);
}

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
    /** Directional shadow map size, pixels (chosen when the engine starts). */
    shadowMapSize: number;
    /** Point and spot light shadow cube face size, pixels (chosen when the engine starts). */
    pointShadowSize: number;
    /** Directional shadows cover at most this many meters. */
    shadowRangeMax: number;
    /** Shadows are drawn again every this many frames. */
    shadowEvery: number;
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
    /** Games load textures at most this large (the longer side, pixels): larger ones skip their top mips. */
    textureMaxSize: number;
}

export const QUALITY: Record<QualityLevel, QualityTier> = {
    low: { shadowMapSize: 1024, pointShadowSize: 256, shadowRangeMax: 80, shadowEvery: 2, resolution: 'low', giRealtime: false, ao: false, fogSteps: 12, godRaySteps: 0, textureMaxSize: 1024 },
    medium: { shadowMapSize: 1024, pointShadowSize: 512, shadowRangeMax: 200, shadowEvery: 1, resolution: 'medium', giRealtime: false, ao: true, fogSteps: 20, godRaySteps: 12, textureMaxSize: 2048 },
    high: { shadowMapSize: 2048, pointShadowSize: 1024, shadowRangeMax: Infinity, shadowEvery: 1, resolution: 'high', giRealtime: true, ao: true, fogSteps: 32, godRaySteps: 16, textureMaxSize: Infinity },
};

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

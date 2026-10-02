import { Color } from "../../math/Color";

/**
 * Global fog effect setting
 * @group Setting
 */
export type GlobalFogSetting = {
    debug: any;
    /**
     * enable
     */
    enable: boolean;
    /**
     * type of fog:
     * 0: linear from `end` (clear) to `start` (full);
     * 1: exponential, `density` per meter past `end`;
     * 2: exponential squared, likewise;
     * 3: height fog: `density` at `heightBase`, thinning upward by
     *    `fogHeightScale` per meter, past `end`.
     */
    fogType: number;
    /**
     * Height fog: how fast the fog thins upward, per meter (e^-scale for each meter up).
     */
    fogHeightScale: number;
    /**
     * Height fog: the height where the fog is `density` thick.
     */
    heightBase?: number;
    /**
     * Aerial perspective: the air's extinction per meter at height 0
     * (thinning upward like the air, by e^-1 every 8 km). Distant ground
     * fades into the sky color behind it, before the fog; 0 for none.
     */
    airDensity?: number;
    /**
     * If the distance between the object and the camera is set as distance, the fog concentration will be linear interpolation between start and end
     */
    start: number;
    /**
     * If the distance between the object and the camera is set as distance, the fog concentration will be linear interpolation between start and end
     */
    end: number;
    /**
     * When the type is exponential square fog, the fog concentration coefficient is added
     */
    density: number;
    /**
     * The effect of setting height on fog (working together with height)
     */
    ins: number;
    /**
     * mix fog color with sky color
     */
    skyFactor: number;
    /**
     * use mipmap level
     */
    skyRoughness: number,
    /**
     * factor effect the sky
     */
    overrideSkyFactor: number,
    /**
     * fog color
     */
    fogColor: Color,

    falloff: number,
    /** Length of the legacy height term's ray; 0 turns that term off. */
    rayLength: number,
    scatteringExponent: number,
    dirHeightLine: number
};
// Sizes of the DDGI atlases the editor sets the engine up with, and the
// probe grids that fit in them. Shared by the document sanitizer and the
// engine side (engine/gi.ts).

import type { Vec3 } from './types';

/** Size of one cube face when a probe captures the scene. */
export const GI_PROBE_SIZE = 16;
/** Capture atlas: every probe needs 6 faces of GI_PROBE_SIZE. */
export const GI_SOURCE_SIZE = 1024;
/** Irradiance texels per probe (octahedral map side). */
export const GI_OCT_SIZE = 16;
/** Irradiance / depth atlas size. */
export const GI_ATLAS_SIZE = 1024;
export const GI_MAX_PER_AXIS = 16;
export const GI_MAX_PROBES = 512;

/** True when an x * y * z probe grid fits the engine's atlases. */
export function giGridFits(x: number, y: number, z: number): boolean {
    const n = x * y * z;
    if (n < 1 || n > GI_MAX_PROBES) return false;
    // Captures: columns of GI_SOURCE_SIZE / GI_PROBE_SIZE probes, 6 faces wide.
    const perColumn = Math.floor(GI_SOURCE_SIZE / GI_PROBE_SIZE);
    const columns = Math.floor(GI_SOURCE_SIZE / (GI_PROBE_SIZE * 6));
    if (n > perColumn * columns) return false;
    // Irradiance: each y layer is a block of x * z tiles (with a 1 texel
    // border); layers stack vertically and wrap into further columns.
    const tile = GI_OCT_SIZE + 2;
    const layersPerColumn = Math.floor(GI_ATLAS_SIZE / (tile * z));
    if (layersPerColumn < 1) return false;
    return Math.ceil(y / layersPerColumn) * x * tile <= GI_ATLAS_SIZE;
}

/** Rounds and clamps a probe grid until it fits, shrinking the largest axis first. */
export function clampGIGrid(counts: Vec3): Vec3 {
    const c = counts.map((v) => Math.min(GI_MAX_PER_AXIS, Math.max(1, Math.round(Number.isFinite(v) ? v : 1)))) as Vec3;
    while (!giGridFits(c[0], c[1], c[2])) {
        const i = c[0] >= c[1] && c[0] >= c[2] ? 0 : c[2] >= c[1] ? 2 : 1;
        if (c[i] <= 1) break;
        c[i]--;
    }
    return c;
}

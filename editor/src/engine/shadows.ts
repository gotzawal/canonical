// Each light's shadow settings (LightDoc.shadow) on its engine light, fitted
// to the graphics tier drawn: the map size, when the map is drawn again and
// what a directional light's map covers. And what the shadow maps cost.

import { DirectLight, LightBase, PointLight, SpotLight, packShadowAtlas, spotMaxFaces } from '@orillusion/core';
import { defaults } from '../core/schema';
import { LightShadow, type LightShadowDoc } from '../core/model';
import { lightShadowSize, type QualityTier } from '../core/quality';
import type { SceneDoc } from '../core/types';

const DEFAULT: LightShadowDoc = defaults(LightShadow);

const settings = new WeakMap<LightBase, LightShadowDoc>();
/** A directional light's shadow range as fitted (its cascades end there). */
const ranges = new WeakMap<LightBase, number>();

/** The document's shadow settings of an engine light (SceneSync sets them). */
export function setLightShadow(light: LightBase, shadow: LightShadowDoc | undefined) {
    settings.set(light, shadow ?? DEFAULT);
}

/**
 * Where a directional light's cascades end (`index` counts their bounds, 0
 * at the camera's near plane): from the camera out to its shadow range,
 * mostly on a logarithmic scale so the near ones are small and sharp,
 * partly even so the far ones do not grow too wide.
 */
function cascadeSplitFor(light: LightBase) {
    return (near: number, far: number, index: number, bounds: number): number => {
        if (index <= 0) return near;
        const from = Math.max(near, 0.1);
        const end = Math.max(from + 1, Math.min(far, ranges.get(light) ?? far));
        const t = index / (bounds - 1);
        return 0.75 * from * Math.pow(end / from, t) + 0.25 * (from + (end - from) * t);
    };
}

/**
 * Puts a light's shadow settings on the engine light for a tier. A tier
 * without cascades covers their range around the camera instead, and caps
 * the range. The setters do nothing when nothing changed.
 */
export function fitLightShadow(light: LightBase, tier: QualityTier) {
    const s = settings.get(light) ?? DEFAULT;
    light.shadowUpdate = s.update;
    if (light instanceof DirectLight) {
        light.shadowMapSize = lightShadowSize('directional', s.resolution, tier);
        const range = Math.min(s.range, tier.shadowRangeMax);
        ranges.set(light, range);
        const coverage = s.coverage === 'cascades' && !tier.cascades ? 'follow' : s.coverage;
        const csm = coverage === 'cascades';
        if (csm && light.cascadeNum !== s.cascades) light.cascadeNum = s.cascades;
        if (light.enableCSM !== csm) {
            light.csmSplitFunction = cascadeSplitFor(light);
            light.enableCSM = csm;
        }
        if (csm) return;
        // A single map covers the range around the light (or the camera),
        // and as far toward the light as that, so tall casters keep their tops.
        light.shadowBoundWidth = range;
        light.shadowBoundHeight = range;
        light.shadowBoundNear = -range;
        light.shadowBoundFar = range;
        light.shadowFollow = coverage === 'follow';
    } else if (light instanceof PointLight || light instanceof SpotLight) {
        light.shadowMapSize = lightShadowSize(light instanceof SpotLight ? 'spot' : 'point', s.resolution, tier);
    }
}

export interface ShadowCost {
    /** Directional lights' maps: one per light, or one per cascade, all the size of the largest. */
    directional: { maps: number; size: number; bytes: number };
    /** Point and spot lights' faces, packed in one atlas. */
    atlas: { faces: number; width: number; height: number; bytes: number };
    bytes: number;
}

/** A light to cost: its type, settings, and a spot light's full cone angle. */
export interface ShadowCaster {
    type: 'directional' | 'point' | 'spot';
    shadow: LightShadowDoc;
    outerAngle?: number;
}

/**
 * The GPU memory the shadow maps of these shadow-casting lights take at a
 * tier (depth32float: 4 bytes a texel), as the engine sizes them: the
 * directional array at its largest map, the point and spot atlas packed
 * from each light's faces (a spot light keeps the faces its cone can reach).
 */
export function shadowCost(casters: readonly ShadowCaster[], tier: QualityTier, maxLayers = 8): ShadowCost {
    let maps = 0;
    let size = 0;
    let lamps = 0;
    const faces: number[] = [];
    for (const c of casters) {
        const s = c.shadow ?? DEFAULT;
        // The engine gives shadows to at most 8 point and spot lights.
        if (c.type !== 'directional' && ++lamps > 8) continue;
        if (c.type === 'directional') {
            const csm = s.coverage === 'cascades' && tier.cascades;
            const need = csm ? s.cascades : 1;
            if (maps + need > maxLayers) continue;
            maps += need;
            size = Math.max(size, lightShadowSize('directional', s.resolution, tier));
        } else {
            const face = 1 << Math.round(Math.log2(Math.min(2048, Math.max(64, lightShadowSize(c.type, s.resolution, tier)))));
            const n = c.type === 'spot' ? spotMaxFaces(((c.outerAngle ?? 60) / 2) * (Math.PI / 180)) : 6;
            for (let i = 0; i < n; i++) faces.push(face);
        }
    }
    const packed = packShadowAtlas(faces, tier.shadowAtlasMax);
    const directional = { maps, size, bytes: maps * size * size * 4 };
    const atlas = { faces: faces.length, width: packed.width, height: packed.height, bytes: packed.width * packed.height * 4 };
    return { directional, atlas, bytes: directional.bytes + atlas.bytes };
}

/** The shadow-casting lights of a scene, shown ones only (hidden lights are off). */
export function shadowCasters(doc: SceneDoc): ShadowCaster[] {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const shown = (id: string | null): boolean => {
        for (let n = id ? byId.get(id) : undefined; n; n = n.parent ? byId.get(n.parent) : undefined) if (!n.visible) return false;
        return true;
    };
    return doc.nodes
        .filter((n) => n.light?.castShadow && shown(n.id))
        .map((n) => ({ type: n.light!.type, shadow: n.light!.shadow, outerAngle: n.light!.outerAngle }));
}

const mib = (bytes: number) => (bytes / 1048576 >= 10 ? Math.round(bytes / 1048576) : Math.round((bytes / 1048576) * 10) / 10);

/** A line on what the shadow maps take: "Shadow maps: 16 MiB (1 directional map of 2048, 12 faces in a 2048 x 1024 atlas)". */
export function describeShadowCost(cost: ShadowCost): string {
    const parts: string[] = [];
    const d = cost.directional;
    if (d.maps) parts.push(`${d.maps} directional map${d.maps > 1 ? 's' : ''} of ${d.size}`);
    const a = cost.atlas;
    if (a.faces) parts.push(`${a.faces} point and spot face${a.faces > 1 ? 's' : ''} in a ${a.width} x ${a.height} atlas`);
    return parts.length ? `Shadow maps: ${mib(cost.bytes)} MiB (${parts.join(', ')})` : 'No light casts shadows.';
}

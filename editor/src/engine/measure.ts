// What the stages' automatic checks measure in the running editor
// (design/stages.ts CheckContext): the shadow maps' memory, and whether the
// scene's textures ship compressed and no larger than they need.

import { derivedOptions, shipsAsIs } from '../core/derived';
import { QUALITY } from '../core/quality';
import { assetRoles } from '../core/refs';
import type { AssetMeta, SceneDoc, TextureRole } from '../core/types';
import type { DerivedAssets } from '../derive/derivedAssets';
import { swatchSide } from '../design/swatches';
import { shadowCasters, shadowCost } from './shadows';

const TEXTURE_ROLES: readonly TextureRole[] = ['color', 'normal', 'data'];

/** An HDR image (the HDRI sky's), which ships as it is. */
export const isHdr = (meta: Pick<AssetMeta, 'name'>) => /\.hdr$/i.test(meta.name);

/** Largest texture side that ships without being flagged. */
export const TEXTURE_SIDE_MAX = 2048;

export interface TextureShip {
    meta: AssetMeta;
    roles: TextureRole[];
    /** Every role ships as a compressed copy, or the file is compressed already (KTX2). */
    compressed: boolean;
    /** Longer side as shipped (a compressed copy is capped at its max size), pixels; 0 when unknown. */
    side: number;
    /** Longer side its surfaces need, where known (material slots: tile times texel density). */
    need?: number;
    /** Larger than it needs, or than TEXTURE_SIDE_MAX. */
    oversized: boolean;
}

/** The longer side each material slot's textures need: the slot's tile times the design's texel density (as use_swatch sizes them). */
export function slotTextureSides(doc: SceneDoc): Map<string, number> {
    const out = new Map<string, number>();
    const density = doc.design.specs.texelDensity;
    for (const s of doc.design.materials) {
        const side = swatchSide(s.tile, density);
        for (const id of [s.swatch, s.normal, s.arm, s.heightMap]) if (id) out.set(id, Math.max(out.get(id) ?? 0, side));
    }
    return out;
}

/**
 * The textures the scene draws and how they ship. A copy this session has
 * not looked up yet is looked up in the background (the next measure knows).
 */
export function sceneTextures(doc: SceneDoc, derived: DerivedAssets | null): TextureShip[] {
    const out: TextureShip[] = [];
    const byId = new Map(doc.assets.map((a) => [a.id, a]));
    const needs = slotTextureSides(doc);
    for (const [id, used] of assetRoles(doc)) {
        const meta = byId.get(id);
        // The HDRI sky's image ships as it is: the sky reads its full range.
        if (!meta || meta.kind !== 'texture' || isHdr(meta)) continue;
        const roles = TEXTURE_ROLES.filter((r) => used.has(r));
        if (!roles.length) roles.push('color');
        const full = Math.max(meta.width ?? 0, meta.height ?? 0);
        let compressed = shipsAsIs(meta);
        let side = full;
        if (!compressed) {
            // A build compresses what has no copy yet, capped at the max size; with compression off the file ships.
            const opts = roles.map((role) => derivedOptions(role, meta.compress));
            if (opts.every((o) => !!o)) side = Math.min(full, ...opts.map((o) => o!.maxSize));
            compressed = roles.every((role, i) => {
                if (!opts[i] || !derived) return false;
                const state = derived.statusOf(meta, role).state;
                if (state === 'none') void derived.check(meta, role);
                return state === 'ready';
            });
        }
        const need = needs.get(id);
        out.push({ meta, roles, compressed, side, ...(need ? { need } : {}), oversized: side > Math.min(need ?? TEXTURE_SIDE_MAX, TEXTURE_SIDE_MAX) });
    }
    return out;
}

export function measureScene(doc: SceneDoc, derived: DerivedAssets | null) {
    const textures = sceneTextures(doc, derived);
    return {
        shadowBytes: shadowCost(shadowCasters(doc), QUALITY.high).bytes,
        textures: {
            total: textures.length,
            uncompressed: textures.filter((t) => !t.compressed).length,
            oversized: textures.filter((t) => t.oversized).length,
        },
    };
}

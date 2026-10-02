// The GPU textures of trees, painted once per species and engine (by
// engine/treePaint.ts, no download): the bark's color, normal map and mask
// (repeating), and the strip of leaf cells (repeating across, clamped at
// top and bottom), all with mip levels and anisotropic filtering.

import { GPUAddressMode, Uint8ArrayTexture, type Texture } from '@orillusion/core';
import type { TreeSpecies } from '../core/trees';
import { BARK_SIZE, LEAF_H, LEAF_W, paintBark, paintLeaves } from './treePaint';

export interface TreeTextures {
    /** Leaf sprigs: color, and alpha where the leaves are. */
    leaves: Texture;
    bark: Texture;
    barkNormal: Texture;
    /** Red: the shade in the bark's cracks; green: roughness; blue: metal (none). */
    barkMask: Texture;
    /** Roughness for leaves (green), no metal. */
    leafMask: Texture;
    /** The leaves' average color as painted (linear rgb): a tint divides by it to recolor them. */
    leafColor: [number, number, number];
    /** The bark's average color as painted (linear rgb). */
    barkColor: [number, number, number];
}

function texture(width: number, height: number, data: Uint8Array, ctx: object, name: string, wrapV = true): Texture {
    const t = new Uint8ArrayTexture().create(width, height, data, true, ctx as never);
    t.name = name;
    t.addressModeU = GPUAddressMode.repeat;
    t.addressModeV = wrapV ? GPUAddressMode.repeat : GPUAddressMode.clamp_to_edge;
    t.maxAnisotropy = 8;
    return t;
}

/** Painted textures by engine (its Context3D) and species. */
const made = new WeakMap<object, Map<TreeSpecies, TreeTextures>>();

/** A species' textures, painted the first time they are asked for (per engine). */
export function treeTextures(species: TreeSpecies, ctx: object): TreeTextures {
    let mine = made.get(ctx);
    if (!mine) made.set(ctx, (mine = new Map()));
    let t = mine.get(species);
    if (t) return t;
    const bark = paintBark(species);
    const leaves = paintLeaves(species);
    // Rows of a texture upload are 256 bytes apart: 64 texels.
    const flat = (r: number, g: number, b: number) => {
        const d = new Uint8Array(64 * 64 * 4);
        for (let i = 0; i < 64 * 64; i++) d.set([r, g, b, 255], i * 4);
        return d;
    };
    t = {
        leaves: texture(LEAF_W, LEAF_H, leaves.data, ctx, `tree-leaves-${species}`, false),
        bark: texture(BARK_SIZE, BARK_SIZE, bark.color, ctx, `tree-bark-${species}`),
        barkNormal: texture(BARK_SIZE, BARK_SIZE, bark.normal, ctx, `tree-bark-normal-${species}`),
        barkMask: texture(BARK_SIZE, BARK_SIZE, bark.mask, ctx, `tree-bark-mask-${species}`),
        leafMask: texture(64, 64, flat(255, species === 'spruce' ? 150 : 135, 0), ctx, `tree-leaf-mask-${species}`),
        leafColor: leaves.mean,
        barkColor: bark.mean,
    };
    mine.set(species, t);
    return t;
}

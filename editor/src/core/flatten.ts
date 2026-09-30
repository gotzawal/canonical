// Textures of one flat color are only values: the materials using one get
// them as their color, opacity, roughness, metalness or emission instead,
// which saves the texture's memory and sampling. Only slots whose value
// multiplies the map take one; a normal map that points straight up and an
// occlusion map of white say nothing and are simply dropped.

import type { MaterialDoc, SceneDoc } from './types';

type RGBA = readonly [number, number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** A hex color times a texture color, both sRGB, multiplied as the GPU does (in linear). */
export function multiplyHex(hex: string, rgba: RGBA): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const base = m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) : [1, 1, 1];
    return (
        '#' +
        base
            .map((c, i) => Math.round(Math.min(1, Math.max(0, toSrgb(toLinear(c) * toLinear(rgba[i] / 255)))) * 255))
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')
    );
}

/** True when a normal map of this color points straight up (it changes nothing). */
export const isFlatNormal = (rgba: RGBA) => Math.abs(rgba[0] - 128) <= 3 && Math.abs(rgba[1] - 128) <= 3 && rgba[2] >= 250;

/** Moves one flat color into a material's values where it uses the texture; resolves with how many maps went. */
export function flattenMaterial(m: MaterialDoc, assetId: string, rgba: RGBA): number {
    if (m.type === 'shader') return 0;
    const [, g, b, a] = rgba.map((v) => v / 255);
    let n = 0;
    if (m.map === assetId) {
        m.color = multiplyHex(m.color, rgba);
        if (rgba[3] < 253) m.opacity = Math.round(m.opacity * a * 1000) / 1000;
        m.map = null;
        n++;
    }
    if (m.emissiveMap === assetId) {
        m.emissive = multiplyHex(m.emissive, rgba);
        delete m.emissiveMap;
        n++;
    }
    if (m.metalRoughMap === assetId) {
        // Roughness in G, metalness in B, both linear.
        m.roughness = Math.round(m.roughness * g * 1000) / 1000;
        m.metallic = Math.round(m.metallic * b * 1000) / 1000;
        delete m.metalRoughMap;
        n++;
    }
    if (m.normalMap === assetId && isFlatNormal(rgba)) {
        delete m.normalMap;
        n++;
    }
    if (m.aoMap === assetId && rgba[0] >= 250) {
        delete m.aoMap;
        n++;
    }
    return n;
}

/** Flattens a texture in every mesh material of the scene and its prefabs; resolves with how many maps went. */
export function flattenTexture(doc: SceneDoc, assetId: string, rgba: RGBA): number {
    let n = 0;
    for (const node of [...doc.nodes, ...doc.prefabs.flatMap((p) => p.nodes)]) {
        if (node.mesh) n += flattenMaterial(node.mesh.material, assetId, rgba);
    }
    return n;
}

/** Whether any mesh material of the scene uses this texture in a slot flattening could replace. */
export function usesAsMap(doc: SceneDoc, assetId: string): boolean {
    return [...doc.nodes, ...doc.prefabs.flatMap((p) => p.nodes)].some((node) => {
        const m = node.mesh?.material;
        return !!m && m.type !== 'shader' && [m.map, m.emissiveMap, m.metalRoughMap, m.normalMap, m.aoMap].includes(assetId);
    });
}

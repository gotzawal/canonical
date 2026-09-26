import { BlendMode, Engine3D, LambertMaterial, LitMaterial, Material, Object3D, RenderNode, Texture, UnLitMaterial, Vector4 } from '@orillusion/core';
import type { AlphaMode, MaterialDoc } from '../core/types';
import { hexToColor } from './color';
import { setBlended } from './shaders';

// Builds and updates the engine materials behind the editor's material
// types. Shared by primitive meshes (engine/sync.ts) and the material slots
// of imported models (engine/modelParts.ts).

/** Engine materials the editor offers as material types. */
export type BuiltinKind = 'lit' | 'unlit' | 'lambert';

export function createBuiltinMaterial(kind: BuiltinKind, ctx: any): Material {
    if (kind === 'unlit') return new UnLitMaterial(ctx);
    if (kind === 'lambert') return new LambertMaterial(ctx);
    const lit = new LitMaterial(ctx);
    // Without a metallic-roughness map the sliders apply as they are.
    lit.shader.setTexture('maskMap', Engine3D.resFor(ctx).whiteTexture);
    return lit;
}

/** Engine alpha states: OPAQUE, MASK (cut-out) and the transparent BLEND, ADD and MUL. */
export type EngineAlpha = 'OPAQUE' | 'BLEND' | 'MASK' | 'ADD' | 'MUL';

/** 'auto' blends when the material is not fully opaque. */
export function engineAlpha(mode: AlphaMode | undefined, opacity: number): EngineAlpha {
    if (mode === 'opaque') return 'OPAQUE';
    if (mode === 'blend') return 'BLEND';
    if (mode === 'mask') return 'MASK';
    if (mode === 'additive') return 'ADD';
    if (mode === 'multiply') return 'MUL';
    return opacity < 0.999 ? 'BLEND' : 'OPAQUE';
}

export function isTransparent(alpha: EngineAlpha): boolean {
    return alpha === 'BLEND' || alpha === 'ADD' || alpha === 'MUL';
}

function hasUniform(mat: Material, name: string): boolean {
    return !!mat.shader.getDefaultColorShader().uniforms[name];
}

/**
 * Alpha handling for any material. Built-in materials use their alphaMode
 * setters; custom shader materials only switch between opaque and blended
 * (a shader that wants cut-outs discards against materialUniform.alphaCutoff).
 */
export function applyAlpha(mat: Material, alpha: EngineAlpha, cutoff: number) {
    const transparent = isTransparent(alpha);
    if (mat instanceof LitMaterial || mat instanceof UnLitMaterial || mat instanceof LambertMaterial) {
        // The setter skips the mode it has cached, which is stale on a copy
        // of another material (a model's): always apply the state.
        (mat as any)._alphaMode = undefined;
        mat.alphaMode = transparent ? 'BLEND' : (alpha as 'OPAQUE' | 'MASK');
    } else {
        setBlended(mat, transparent);
    }
    if (transparent) mat.blendMode = alpha === 'ADD' ? BlendMode.ADD : alpha === 'MUL' ? BlendMode.MUL : BlendMode.NORMAL;
    // The lit shader only cuts in MASK mode; unlit and lambert always
    // compare against the cutoff, so it must be 0 unless masking.
    if (hasUniform(mat, 'alphaCutoff')) {
        const value = alpha === 'MASK' || mat instanceof LitMaterial ? cutoff : 0;
        mat.shader.setUniformFloat('alphaCutoff', value);
    }
}

const PBR_UV_UNIFORMS = [
    'baseMapOffsetSize', 'normalMapOffsetSize', 'emissiveMapOffsetSize', 'roughnessMapOffsetSize', 'metallicMapOffsetSize', 'aoMapOffsetSize',
];

/** Texture repeat and offset for every map of a material. */
export function applyUVTransform(mat: Material, tiling: readonly number[] | undefined, offset: readonly number[] | undefined) {
    const t = tiling ?? [1, 1];
    const o = offset ?? [0, 0];
    const v = new Vector4(o[0] ?? 0, o[1] ?? 0, t[0] ?? 1, t[1] ?? 1);
    if (hasUniform(mat, 'transformUV1')) {
        mat.shader.setUniformVector4('transformUV1', v);
        return;
    }
    for (const k of PBR_UV_UNIFORMS) if (hasUniform(mat, k)) mat.shader.setUniformVector4(k, v);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Physically based values of a lit material (everything but color, alpha and textures). */
export function applyPBR(mat: LitMaterial, md: Pick<MaterialDoc, 'metallic' | 'roughness' | 'emissive' | 'emissiveIntensity' | 'normalScale' | 'clearcoat' | 'clearcoatRoughness' | 'transmission' | 'ior' | 'thickness' | 'attenuationColor' | 'attenuationDistance'>) {
    const sh = mat.shader;
    mat.metallic = clamp01(md.metallic);
    mat.roughness = clamp01(md.roughness);
    mat.emissiveColor = hexToColor(md.emissive);
    mat.emissiveIntensity = Math.max(0, md.emissiveIntensity);
    sh.setUniformFloat('normalScale', Math.max(0, md.normalScale ?? 1));

    // Clear coat: the setters would switch the shader path on even for 0.
    const coat = clamp01(md.clearcoat ?? 0);
    sh.setUniformFloat('clearcoatFactor', coat);
    sh.setUniformFloat('clearcoatRoughnessFactor', clamp01(md.clearcoatRoughness ?? 0));
    mat.setDefine('USE_CLEARCOAT', coat > 0);

    // Transmission (glass, water): the setter also switches the shader path
    // and binds the scene color the refraction samples.
    const transmission = clamp01(md.transmission ?? 0);
    if (transmission !== mat.transmissionFactor) mat.transmissionFactor = transmission;
    mat.ior = Math.min(3, Math.max(1, md.ior ?? 1.5));
    mat.thicknessFactor = Math.max(0, md.thickness ?? 0);
    mat.attenuationColor = hexToColor(md.attenuationColor ?? '#ffffff');
    const distance = md.attenuationDistance ?? 0;
    mat.attenuationDistance = distance > 0 ? distance : Number.POSITIVE_INFINITY;
}

/** A texture map of a material that can come from a texture asset. */
export interface MapSlot {
    /** Field of MaterialDoc holding the asset id. */
    key: 'map' | 'normalMap' | 'metalRoughMap' | 'aoMap' | 'emissiveMap';
    /** Texture name in the shader. */
    slot: string;
    /** Data maps are sampled as linear values, color maps as sRGB. */
    linear: boolean;
    /** Shader define that turns the map on, if it has one. */
    define?: string;
}

export const BASE_MAP: MapSlot = { key: 'map', slot: 'baseMap', linear: false };

/** Maps of the lit (PBR) material, base color first. */
export const PBR_MAPS: MapSlot[] = [
    BASE_MAP,
    { key: 'normalMap', slot: 'normalMap', linear: true },
    { key: 'metalRoughMap', slot: 'maskMap', linear: true },
    { key: 'aoMap', slot: 'aoMap', linear: true, define: 'USE_AOTEX' },
    { key: 'emissiveMap', slot: 'emissiveMap', linear: false, define: 'USE_EMISSIVEMAP' },
];

/**
 * What a map slot shows when no texture is assigned: the material's own
 * texture, or a neutral placeholder that leaves the material's values as
 * they are (white for metallic-roughness, flat for normals).
 */
export function defaultMapTexture(mat: Material, slot: string, ctx: any): Texture {
    const res = Engine3D.resFor(ctx);
    const own = mat.shader.getTexture(slot) as Texture | undefined;
    // The engine's own metallic-roughness placeholder has 0.5 in G, which halves the roughness.
    if (own && !(slot === 'maskMap' && own === res.maskTexture)) return own;
    if (slot === 'normalMap') return res.normalTexture;
    if (slot === 'emissiveMap') return res.blackTexture;
    return res.whiteTexture;
}

/**
 * Brings the materials of a loaded glTF model in line with glTF, which is
 * what the editor's settings assume:
 * - without a metallic-roughness texture the roughness and metallic factors
 *   apply as they are (the engine binds a placeholder with 0.5 in G, which
 *   halved the roughness);
 * - MASK materials cut out pixels below their cutoff in the opaque queue
 *   (the engine drew them blended, still writing depth), and BLEND
 *   materials blend without writing depth.
 * Materials are shared by every instance of the model, so this runs once
 * per load.
 */
export function normalizeModelMaterials(root: Object3D, ctx: any) {
    const res = Engine3D.resFor(ctx);
    const seen = new Set<Material>();
    root.traverse((o: Object3D) => {
        o.components.forEach((c) => {
            if (!(c instanceof RenderNode)) return;
            for (const mat of c.materials ?? []) {
                if (!mat || seen.has(mat) || !(mat instanceof LitMaterial)) continue;
                seen.add(mat);
                if (mat.shader.getTexture('maskMap') === res.maskTexture) mat.shader.setTexture('maskMap', res.whiteTexture);
                const pass = mat.shader.getDefaultColorShader();
                // The glTF loader gives BLEND materials a blend mode (without
                // the transparent flag) and MASK materials the transparent
                // flag plus their cutoff.
                if (!pass.shaderState.transparent && pass.shaderState.blendMode === BlendMode.NONE) continue;
                const cutoff = pass.uniforms['alphaCutoff'] ? mat.shader.getUniformFloat('alphaCutoff') : 0;
                (mat as any)._alphaMode = undefined;
                mat.alphaMode = cutoff > 0 ? 'MASK' : 'BLEND';
            }
        });
    });
}

/**
 * Tracks which texture assets a material shows, and loads them. A map
 * without an asset shows the texture the material had when it was created
 * (the engine's placeholder, or the model file's own map).
 */
export class MaterialMaps {
    /** Texture asset currently requested per shader slot. */
    private assets = new Map<string, string | null>();
    private defaults = new Map<string, Texture>();
    /** USE_SRGB_ALBEDO as the material had it, for when its own base map is restored. */
    private baseDefine: boolean;

    constructor(
        private mat: Material,
        private ctx: any,
        private load: (assetId: string, linear: boolean) => Promise<Texture | null>,
    ) {
        this.baseDefine = !!mat.shader.getDefaultColorShader().defineValue?.['USE_SRGB_ALBEDO'];
    }

    /** Shows the given asset (or the default when null) in a map slot. */
    set(map: MapSlot, assetId: string | null) {
        const cur = this.assets.get(map.slot);
        if (cur === assetId || (cur === undefined && assetId === null)) return;
        const mat = this.mat;
        if (!this.defaults.has(map.slot)) this.defaults.set(map.slot, defaultMapTexture(mat, map.slot, this.ctx));
        this.assets.set(map.slot, assetId);
        if (!assetId) {
            mat.shader.setTexture(map.slot, this.defaults.get(map.slot)!);
            if (map.define) mat.setDefine(map.define, false);
            if (map.slot === 'baseMap') mat.setDefine('USE_SRGB_ALBEDO', this.baseDefine);
            return;
        }
        void this.load(assetId, map.linear).then((tex) => {
            if (!tex || this.assets.get(map.slot) !== assetId) return;
            // A texture decoded from sRGB by the GPU skips the shader's own decode.
            if (map.slot === 'baseMap') mat.setDefine('USE_SRGB_ALBEDO', (tex as any).format === 'rgba8unorm-srgb');
            mat.shader.setTexture(map.slot, tex);
            if (map.define) mat.setDefine(map.define, true);
        });
    }
}

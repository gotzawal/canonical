// The material terrains are drawn with: up to four layers, each a material
// slot's swatch (color and normal maps at the slot's tile size, its color
// and roughness), blended by the layers' height and slope rules and by
// paint (a splat map, a channel a layer). The layers' maps sit in two
// texture arrays (engine/heldTexture.ts), so the material binds three
// textures whatever the layers are. Each layer is projected along the
// axes the surface faces, so cliffs keep their texture size.

import { Material, PassType, RenderShaderPass, Shader, ShaderLib, Vector4, type Context3D, type Texture } from '@orillusion/core';
import type { TerrainFrame } from '../core/terrain';
import { hexToColor } from './color';
import { buildLayerArray, HeldTexture, uploadTexture, type ArrayLayer } from './heldTexture';
import { litMaterialSource, setEngineDefaults } from './shaders';

const LAYERS = 4;

const FIELDS = [
    ...Array.from({ length: LAYERS }, (_, i) => `    layerColor${i}: vec4<f32>,\n    layerRule${i}: vec4<f32>,\n    layerBlend${i}: vec4<f32>,`),
    '    layerTile: vec4<f32>,',
    '    terrainInfo: vec4<f32>,',
    '    terrainRect: vec4<f32>,',
].join('\n');

const BINDINGS = [
    '@group(1) @binding(auto) var layerAlbedoSampler: sampler;',
    '@group(1) @binding(auto) var layerAlbedo: texture_2d_array<f32>;',
    '@group(1) @binding(auto) var layerNormalSampler: sampler;',
    '@group(1) @binding(auto) var layerNormal: texture_2d_array<f32>;',
    '@group(1) @binding(auto) var splatMapSampler: sampler;',
    '@group(1) @binding(auto) var splatMap: texture_2d<f32>;',
].join('\n');

const pick = (field: string) => `fn ${field}Of(i: i32) -> vec4f {
    if (i == 0) { return materialUniform.${field}0; }
    if (i == 1) { return materialUniform.${field}1; }
    if (i == 2) { return materialUniform.${field}2; }
    return materialUniform.${field}3;
}`;

const BODY = /* wgsl */ `
// layerColor: linear color (rgb) and roughness (a). layerRule: heights
// [x, y] in meters and slopes [z, w] in degrees. layerBlend: height fade
// (x, meters), slope fade (y, degrees), only painted (z). layerTile: the
// tile size of each layer in meters. terrainInfo: layer count, whether
// there is paint, normal map strength. terrainRect: the terrain's -x, -z
// corner and its size, for the splat map.
${pick('layerColor')}
${pick('layerRule')}
${pick('layerBlend')}

fn band(x: f32, lo: f32, hi: f32, soft: f32) -> f32 {
    let s = max(soft, 0.0001) * 0.5;
    return smoothstep(lo - s, lo + s, x) * (1.0 - smoothstep(hi - s, hi + s, x));
}

struct LayerSample {
    color: vec3f,
    bump: vec3f,
};

// A layer along the axes the surface faces (w), with gradients taken
// where every pixel runs (dx, dy: of the world position).
fn sampleLayer(i: i32, p: vec3f, w: vec3f, dx: vec3f, dy: vec3f) -> LayerSample {
    let s = 1.0 / max(materialUniform.layerTile[i], 0.01);
    var out: LayerSample;
    out.color = vec3f(0.0);
    out.bump = vec3f(0.0);
    if (w.x > 0.0) {
        let uv = vec2f(p.z, -p.y) * s;
        let gx = vec2f(dx.z, -dx.y) * s;
        let gy = vec2f(dy.z, -dy.y) * s;
        out.color += textureSampleGrad(layerAlbedo, layerAlbedoSampler, uv, i, gx, gy).rgb * w.x;
        let t = textureSampleGrad(layerNormal, layerNormalSampler, uv, i, gx, gy).xy * 2.0 - 1.0;
        out.bump += (t.x * vec3f(0.0, 0.0, 1.0) + t.y * vec3f(0.0, 1.0, 0.0)) * w.x;
    }
    if (w.y > 0.0) {
        let uv = vec2f(p.x, p.z) * s;
        let gx = vec2f(dx.x, dx.z) * s;
        let gy = vec2f(dy.x, dy.z) * s;
        out.color += textureSampleGrad(layerAlbedo, layerAlbedoSampler, uv, i, gx, gy).rgb * w.y;
        let t = textureSampleGrad(layerNormal, layerNormalSampler, uv, i, gx, gy).xy * 2.0 - 1.0;
        out.bump += (t.x * vec3f(1.0, 0.0, 0.0) + t.y * vec3f(0.0, 0.0, -1.0)) * w.y;
    }
    if (w.z > 0.0) {
        let uv = vec2f(p.x, -p.y) * s;
        let gx = vec2f(dx.x, -dx.y) * s;
        let gy = vec2f(dy.x, -dy.y) * s;
        out.color += textureSampleGrad(layerAlbedo, layerAlbedoSampler, uv, i, gx, gy).rgb * w.z;
        let t = textureSampleGrad(layerNormal, layerNormalSampler, uv, i, gx, gy).xy * 2.0 - 1.0;
        out.bump += (t.x * vec3f(1.0, 0.0, 0.0) + t.y * vec3f(0.0, 1.0, 0.0)) * w.z;
    }
    return out;
}

fn frag() {
    let n = normalize(ORI_VertexVarying.vWorldNormal);
    let p = ORI_VertexVarying.vWorldPos.xyz;
    let dx = dpdx(p);
    let dy = dpdy(p);
    let info = materialUniform.terrainInfo;
    let count = i32(info.x + 0.5);
    let slope = degrees(acos(clamp(n.y, -1.0, 1.0)));

    // Rules: each later layer over those before it.
    var w = array<f32, 4>(1.0, 0.0, 0.0, 0.0);
    for (var i = 1; i < 4; i++) {
        if (i >= count) { break; }
        let r = layerRuleOf(i);
        let b = layerBlendOf(i);
        var a = band(p.y, r.x, r.y, b.x) * band(slope, r.z, r.w, b.y);
        if (b.z > 0.5) { a = 0.0; }
        for (var j = 0; j < i; j++) { w[j] = w[j] * (1.0 - a); }
        w[i] = a;
    }
    // Paint takes over from the rules where it is.
    if (info.y > 0.5) {
        let rect = materialUniform.terrainRect;
        let paint = textureSampleLevel(splatMap, splatMapSampler, (p.xz - rect.xy) / rect.zw, 0.0);
        let painted = min(1.0, paint.x + paint.y + paint.z + paint.w);
        for (var i = 0; i < 4; i++) { w[i] = w[i] * (1.0 - painted) + paint[i]; }
    }

    // Only the projections a surface faces are read.
    var axes = pow(abs(n), vec3f(4.0));
    axes = axes / max(axes.x + axes.y + axes.z, 0.0001);
    axes = select(vec3f(0.0), axes, axes > vec3f(0.02));
    axes = axes / max(axes.x + axes.y + axes.z, 0.0001);

    var color = vec3f(0.0);
    var bump = vec3f(0.0);
    var rough = 0.0;
    var total = 0.0;
    for (var i = 0; i < 4; i++) {
        if (i >= count || w[i] < 0.01) { continue; }
        let s = sampleLayer(i, p, axes, dx, dy);
        let c = layerColorOf(i);
        color += s.color * c.rgb * w[i];
        bump += s.bump * w[i];
        rough += c.a * w[i];
        total += w[i];
    }
    total = max(total, 0.0001);
    ORI_ShadingInput.BaseColor = vec4f(color / total, 1.0);
    ORI_ShadingInput.Roughness = clamp(rough / total, 0.05, 1.0);
    ORI_ShadingInput.Metallic = 0.0;
    ORI_ShadingInput.Specular = 1.0;
    ORI_ShadingInput.AmbientOcclusion = 1.0;
    ORI_ShadingInput.EmissiveColor = vec4f(0.0, 0.0, 0.0, 1.0);
    ORI_ShadingInput.Normal = normalize(n + (bump / total) * info.z);
    useShadow();
    BxDFShading();
}
`;

let shaderName: string | null = null;

function registered(): string {
    if (!shaderName) {
        shaderName = 'morglay_terrain_1';
        ShaderLib.register(shaderName, litMaterialSource(FIELDS, BINDINGS, BODY));
    }
    return shaderName;
}

/** A layer as the material draws it: its maps (loaded textures, or none), tile size, color and roughness, and its rules. */
export interface MaterialLayer {
    albedo: Texture | null;
    normal: Texture | null;
    tile: number;
    color: string;
    roughness: number;
    height: [number, number];
    slope: [number, number];
    heightBlend: number;
    slopeBlend: number;
    onlyPainted: boolean;
}

const WHITE: [number, number, number, number] = [1, 1, 1, 1];
const FLAT: [number, number, number, number] = [0.5, 0.5, 1, 1];

/** A terrain's material, its layer arrays and its paint. */
export class TerrainMaterial {
    readonly material: Material;
    private shader: Shader;
    private albedo: HeldTexture;
    private normal: HeldTexture;
    private splat: HeldTexture;
    /** What the arrays were built from, to build them again only when that changes. */
    private arraysKey = '';
    /** Layers shown, and whether there is paint (terrainInfo). */
    private count = 1;
    private painted = false;

    constructor(private ctx: Context3D) {
        const name = registered();
        const shader = new Shader();
        const pass = new RenderShaderPass(name, name);
        pass.setShaderEntry('VertMain', 'FragMain');
        pass.passType = PassType.COLOR;
        shader.addRenderPass(pass);
        const state = pass.shaderState;
        state.acceptShadow = true;
        state.castShadow = true;
        state.receiveEnv = true;
        state.acceptGI = true;
        state.useLight = true;
        shader.setDefine('USE_CUSTOMUNIFORM', true);
        shader.setDefine('USE_BRDF', true);
        setEngineDefaults(shader, ctx);
        for (let i = 0; i < LAYERS; i++) {
            shader.setUniformVector4(`layerColor${i}`, new Vector4(0.5, 0.5, 0.5, 0.9));
            shader.setUniformVector4(`layerRule${i}`, new Vector4(-1e4, 1e4, 0, 90));
            shader.setUniformVector4(`layerBlend${i}`, new Vector4(1, 5, 0, 0));
        }
        shader.setUniformVector4('layerTile', new Vector4(4, 4, 4, 4));
        shader.setUniformVector4('terrainInfo', new Vector4(1, 0, 1, 0));
        shader.setUniformVector4('terrainRect', new Vector4(0, 0, 1, 1));
        // The arrays are bound before the first draw: the pipeline's layout comes from them.
        this.albedo = new HeldTexture(ctx, '2d-array');
        this.normal = new HeldTexture(ctx, '2d-array');
        this.splat = new HeldTexture(ctx, '2d', 'float', false);
        this.albedo.hold(buildLayerArray(ctx, [{ source: null, fill: WHITE }], 4, 'rgba8unorm-srgb', 'terrain albedo'));
        this.normal.hold(buildLayerArray(ctx, [{ source: null, fill: FLAT }], 4, 'rgba8unorm', 'terrain normal'));
        this.splat.hold(uploadTexture(ctx, 1, 1, 'rgba8unorm', new Uint8Array(4), 'terrain paint'));
        shader.setTexture('layerAlbedo', this.albedo);
        shader.setTexture('layerNormal', this.normal);
        shader.setTexture('splatMap', this.splat);
        this.shader = shader;
        this.material = new Material();
        this.material.name = 'Terrain';
        this.material.shader = shader;
    }

    /** Filters the layers with anisotropy (the graphics tier's). */
    setAnisotropy(n: number) {
        this.albedo.setAnisotropy(n);
        this.normal.setAnisotropy(n);
    }

    /**
     * Shows these layers (the first covers everything). The arrays are
     * built again when the layers' textures or their size change; `size`
     * is the arrays' side in pixels.
     */
    setLayers(layers: MaterialLayer[], size: number) {
        const list = layers.length ? layers.slice(0, LAYERS) : [null];
        const sh = this.shader;
        list.forEach((l, i) => {
            const c = hexToColor(l?.color ?? '#808080');
            sh.setUniformVector4(`layerColor${i}`, new Vector4(c.r, c.g, c.b, l?.roughness ?? 0.9));
            if (!l) return;
            sh.setUniformVector4(`layerRule${i}`, new Vector4(l.height[0], l.height[1], l.slope[0], l.slope[1]));
            sh.setUniformVector4(`layerBlend${i}`, new Vector4(l.heightBlend, l.slopeBlend, l.onlyPainted ? 1 : 0, 0));
        });
        const tiles = list.map((l) => Math.max(0.01, l?.tile ?? 4));
        sh.setUniformVector4('layerTile', new Vector4(tiles[0], tiles[1] ?? 4, tiles[2] ?? 4, tiles[3] ?? 4));
        this.count = list.length;
        this.writeInfo();
        const ids = (t: Texture | null) => (t ? (t as any).instanceID ?? t.name : '-');
        const key = `${size}|` + list.map((l) => `${ids(l?.albedo ?? null)},${ids(l?.normal ?? null)}`).join('|');
        if (key === this.arraysKey) return;
        this.arraysKey = key;
        this.rebuildArrays(list, size);
    }

    /** Builds the arrays again (a layer's texture finished loading or was refilled). */
    rebuildArrays(layers: (MaterialLayer | null)[], size: number) {
        const albedo: ArrayLayer[] = layers.map((l) => ({ source: l?.albedo ?? null, fill: WHITE }));
        const normal: ArrayLayer[] = layers.map((l) => ({ source: l?.normal ?? null, fill: FLAT }));
        this.albedo.hold(buildLayerArray(this.ctx, albedo, size, 'rgba8unorm-srgb', 'terrain albedo'));
        this.normal.hold(buildLayerArray(this.ctx, normal, size, 'rgba8unorm', 'terrain normal'));
    }

    /** Where the terrain is, for its paint. */
    setFrame(frame: TerrainFrame) {
        this.shader.setUniformVector4('terrainRect', new Vector4(frame.x - frame.sizeX / 2, frame.z - frame.sizeZ / 2, frame.sizeX, frame.sizeZ));
    }

    /** The painted layers (RGBA, a channel a layer), or none. */
    setPaint(paint: { width: number; height: number; data: Uint8Array } | null) {
        if (paint) this.splat.hold(uploadTexture(this.ctx, paint.width, paint.height, 'rgba8unorm', paint.data, 'terrain paint'));
        this.painted = !!paint;
        this.writeInfo();
    }

    /** Writes the part of the paint a stroke changed into the texture shown (all of it when none of its size is shown yet). */
    updatePaint(paint: { width: number; height: number; data: Uint8Array }, region: { x0: number; z0: number; x1: number; z1: number }) {
        const tex = this.painted ? this.splat.current : null;
        if (!tex || tex.width !== paint.width || tex.height !== paint.height) {
            this.setPaint(paint);
            return;
        }
        const x0 = Math.max(0, region.x0);
        const z0 = Math.max(0, region.z0);
        const w = Math.min(paint.width, region.x1) - x0;
        const h = Math.min(paint.height, region.z1) - z0;
        if (w <= 0 || h <= 0) return;
        this.ctx.device.queue.writeTexture({ texture: tex, origin: { x: x0, y: z0 } }, paint.data as BufferSource, { offset: (z0 * paint.width + x0) * 4, bytesPerRow: paint.width * 4 }, { width: w, height: h });
    }

    private writeInfo() {
        this.shader.setUniformVector4('terrainInfo', new Vector4(this.count, this.painted ? 1 : 0, 1, 0));
    }

    dispose() {
        this.albedo.release();
        this.normal.release();
        this.splat.release();
    }
}

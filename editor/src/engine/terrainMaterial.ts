// The material terrains are drawn with: up to four layers, each a material
// slot's swatch (color, normal, ARM and height maps at the slot's tile
// size, its color and roughness), placed by the layers' height and slope
// rules and by paint (a splat map, a channel a layer). Where layers meet,
// the one whose texels stand higher shows (height blending: sand fills
// the gaps between stones), and the rules' edges wander with noise instead
// of following contour lines. Large-scale noise varies the color and the
// maps are mixed with a larger copy of themselves far away, so the tiles
// do not repeat visibly. Ground along a water surface over the terrain,
// and under rain, is wet: darker and glossy, with puddles in its hollows.
// The layers' maps sit in two texture arrays (engine/heldTexture.ts):
// color with height in alpha, and normal with roughness and occlusion in
// blue and alpha, so the material binds three textures whatever the layers
// are. Each layer is projected along the axes the surface faces, so cliffs
// keep their texture size.

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
    '    terrainLook: vec4<f32>,',
    '    terrainWater: vec4<f32>,',
    '    terrainRain: vec4<f32>,',
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
// corner and its size, for the splat map. terrainLook: height blending
// (x) and variation (y), 0 to 1. terrainWater: the water's height over
// the terrain (x, -1e9 without), meters above it that are wet (y), rain
// (z, 0 to 1) and puddles (w, 0 to 1). terrainRain: the rain's box, its
// -x, -z and +x, +z corners.
${pick('layerColor')}
${pick('layerRule')}
${pick('layerBlend')}

fn band(x: f32, lo: f32, hi: f32, soft: f32) -> f32 {
    let s = max(soft, 0.0001) * 0.5;
    return smoothstep(lo - s, lo + s, x) * (1.0 - smoothstep(hi - s, hi + s, x));
}

fn tHash(p: vec2f) -> f32 {
    var q = fract(p * vec2f(0.1031, 0.1030));
    q += dot(q, q.yx + 33.33);
    return fract((q.x + q.y) * q.x);
}

fn tNoise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2f(1.0, 0.0)), u.x), mix(tHash(i + vec2f(0.0, 1.0)), tHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

// Three octaves, 0 to 1 (about 0.5 on average).
fn tFbm(p: vec2f) -> f32 {
    return tNoise(p) * 0.5 + tNoise(p * 2.03 + vec2f(17.3, 5.1)) * 0.3 + tNoise(p * 4.11 + vec2f(3.7, 29.9)) * 0.2;
}

struct LayerSample {
    color: vec3f,
    bump: vec3f,
    height: f32,
    rough: f32,
    ao: f32,
};

struct Tap {
    a: vec4f,
    n: vec4f,
};

// Both arrays at uv, mixed by 'far' with the same maps at a larger,
// unrelated scale: far away the tiles stop lining up.
fn tap(i: i32, uv: vec2f, gx: vec2f, gy: vec2f, far: f32) -> Tap {
    var t: Tap;
    t.a = textureSampleGrad(layerAlbedo, layerAlbedoSampler, uv, i, gx, gy);
    t.n = textureSampleGrad(layerNormal, layerNormalSampler, uv, i, gx, gy);
    if (far > 0.0) {
        let k = 0.29;
        let o = vec2f(0.37, 0.71);
        let fa = textureSampleGrad(layerAlbedo, layerAlbedoSampler, uv * k + o, i, gx * k, gy * k);
        let fnm = textureSampleGrad(layerNormal, layerNormalSampler, uv * k + o, i, gx * k, gy * k);
        t.a = mix(t.a, fa, far);
        t.n = mix(t.n, fnm, far);
    }
    return t;
}

// A layer along the axes the surface faces (w), with gradients taken
// where every pixel runs (dx, dy: of the world position).
fn sampleLayer(i: i32, p: vec3f, w: vec3f, dx: vec3f, dy: vec3f, far: f32) -> LayerSample {
    let s = 1.0 / max(materialUniform.layerTile[i], 0.01);
    var out: LayerSample;
    var a = vec4f(0.0);
    var d = vec2f(0.0);
    out.bump = vec3f(0.0);
    if (w.x > 0.0) {
        let t = tap(i, vec2f(p.z, -p.y) * s, vec2f(dx.z, -dx.y) * s, vec2f(dy.z, -dy.y) * s, far);
        a += t.a * w.x;
        d += t.n.zw * w.x;
        let b = t.n.xy * 2.0 - 1.0;
        out.bump += (b.x * vec3f(0.0, 0.0, 1.0) + b.y * vec3f(0.0, 1.0, 0.0)) * w.x;
    }
    if (w.y > 0.0) {
        let t = tap(i, vec2f(p.x, p.z) * s, vec2f(dx.x, dx.z) * s, vec2f(dy.x, dy.z) * s, far);
        a += t.a * w.y;
        d += t.n.zw * w.y;
        let b = t.n.xy * 2.0 - 1.0;
        out.bump += (b.x * vec3f(1.0, 0.0, 0.0) + b.y * vec3f(0.0, 0.0, -1.0)) * w.y;
    }
    if (w.z > 0.0) {
        let t = tap(i, vec2f(p.x, -p.y) * s, vec2f(dx.x, -dx.y) * s, vec2f(dy.x, -dy.y) * s, far);
        a += t.a * w.z;
        d += t.n.zw * w.z;
        let b = t.n.xy * 2.0 - 1.0;
        out.bump += (b.x * vec3f(1.0, 0.0, 0.0) + b.y * vec3f(0.0, 1.0, 0.0)) * w.z;
    }
    out.color = a.rgb;
    out.height = a.a;
    out.rough = d.x;
    out.ao = d.y;
    return out;
}

fn frag() {
    let n = normalize(ORI_VertexVarying.vWorldNormal);
    let p = ORI_VertexVarying.vWorldPos.xyz;
    let dx = dpdx(p);
    let dy = dpdy(p);
    let info = materialUniform.terrainInfo;
    let look = materialUniform.terrainLook;
    let count = i32(info.x + 0.5);
    let slope = degrees(acos(clamp(n.y, -1.0, 1.0)));
    // Noise at the scale of rule edges (meters) and of the land (tens of meters).
    let edge = tFbm(p.xz * 0.37 + vec2f(41.0, 7.0)) - 0.5;
    let land = tFbm(p.xz * 0.021);

    // Rules: each later layer over those before it, its edges wandering.
    var w = array<f32, 4>(1.0, 0.0, 0.0, 0.0);
    for (var i = 1; i < 4; i++) {
        if (i >= count) { break; }
        let r = layerRuleOf(i);
        let b = layerBlendOf(i);
        let hy = p.y + edge * max(b.x, 0.3) * 1.6 * look.x;
        let sl = slope + edge * max(b.y, 2.0) * 1.6 * look.x;
        var a = band(hy, r.x, r.y, b.x) * band(sl, r.z, r.w, b.y);
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
    let far = smoothstep(12.0, 60.0, distance(globalUniform.CameraPos.xyz, p)) * 0.5 * look.y;

    // Each layer shown, and how high its texels stand where it is.
    var smp: array<LayerSample, 4>;
    var hw = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    var top = -1e3;
    var wsum = 0.0;
    for (var i = 0; i < 4; i++) {
        if (i >= count || w[i] < 0.01) { continue; }
        smp[i] = sampleLayer(i, p, axes, dx, dy, far);
        hw[i] = w[i] + smp[i].height;
        top = max(top, hw[i]);
        wsum += w[i];
    }
    // Height blending: within a band below the highest, the higher texels show.
    var hsum = 0.0;
    for (var i = 0; i < 4; i++) {
        if (i >= count || w[i] < 0.01) { continue; }
        hw[i] = max(hw[i] - (top - 0.12), 0.0);
        hsum += hw[i];
    }

    var color = vec3f(0.0);
    var bump = vec3f(0.0);
    var rough = 0.0;
    var ao = 0.0;
    var height = 0.0;
    for (var i = 0; i < 4; i++) {
        if (i >= count || w[i] < 0.01) { continue; }
        let k = mix(w[i] / max(wsum, 0.0001), hw[i] / max(hsum, 0.0001), look.x);
        let c = layerColorOf(i);
        color += smp[i].color * c.rgb * k;
        bump += smp[i].bump * k;
        rough += c.a * smp[i].rough * k;
        ao += smp[i].ao * k;
        height += smp[i].height * k;
    }
    // Variation over the land: patches lighter and darker, drier and smoother.
    let vary = (land - 0.5) * 0.45 + (tFbm(p.xz * 0.11 + vec2f(9.0, 3.0)) - 0.5) * 0.25;
    color *= 1.0 + vary * look.y;
    rough *= 1.0 + vary * 0.4 * look.y;

    // Wet along the water, up a ragged band over the waterline, and under rain.
    let water = materialUniform.terrainWater;
    var wet = 0.0;
    if (water.y > 0.0 && water.x > -1e8) {
        let reach = water.x + water.y * (0.6 + 0.8 * tNoise(p.xz * 0.9));
        wet = 1.0 - smoothstep(water.x, reach, p.y);
    }
    var pool = 0.0;
    if (water.z > 0.0) {
        // Wet inside the rain's box, drying out raggedly over a few meters past its sides.
        let r = materialUniform.terrainRain;
        let fade = max(3.0, 0.15 * min(r.z - r.x, r.w - r.y));
        let past = max(max(r.x - p.x, p.x - r.z), max(r.y - p.z, p.z - r.w)) + edge * fade;
        let inside = 1.0 - smoothstep(-fade, fade, past);
        let rain = water.z * inside;
        wet = max(wet, rain * (0.55 + 0.45 * clamp(n.y, 0.0, 1.0)));
        // Puddles in the hollows of flat ground: where the low noise dips and the texels are low.
        let flatGround = smoothstep(0.93, 0.985, n.y);
        let lowness = tFbm(p.xz * 0.16 + vec2f(5.0, 11.0)) + (0.5 - height) * 0.5;
        let level = 0.66 - 0.22 * water.w;
        pool = rain * step(0.001, water.w) * flatGround * smoothstep(level, level + 0.04, lowness);
    }
    // Wet ground is darker and glossier; a puddle is a dark, flat mirror.
    color *= mix(1.0, 0.55, wet);
    rough = mix(rough, min(rough, 0.28), wet);
    color *= mix(1.0, 0.45, pool);
    rough = mix(rough, 0.03, pool);
    ao = mix(ao, 1.0, pool);

    ORI_ShadingInput.BaseColor = vec4f(color, 1.0);
    ORI_ShadingInput.Roughness = clamp(rough, 0.03, 1.0);
    ORI_ShadingInput.Metallic = 0.0;
    ORI_ShadingInput.Specular = 1.0;
    ORI_ShadingInput.AmbientOcclusion = ao;
    ORI_ShadingInput.EmissiveColor = vec4f(0.0, 0.0, 0.0, 1.0);
    ORI_ShadingInput.Normal = normalize(n + bump * info.z * (1.0 - pool) * (1.0 - 0.3 * wet));
    useShadow();
    BxDFShading();
}
`;

let shaderName: string | null = null;

function registered(): string {
    if (!shaderName) {
        shaderName = 'morglay_terrain_2';
        ShaderLib.register(shaderName, litMaterialSource(FIELDS, BINDINGS, BODY));
    }
    return shaderName;
}

/** A layer as the material draws it: its maps (loaded textures, or none), tile size, color and roughness, and its rules. */
export interface MaterialLayer {
    albedo: Texture | null;
    normal: Texture | null;
    arm: Texture | null;
    heightMap: Texture | null;
    tile: number;
    color: string;
    roughness: number;
    height: [number, number];
    slope: [number, number];
    heightBlend: number;
    slopeBlend: number;
    onlyPainted: boolean;
}

/** Color white, heights level (alpha). */
const WHITE: [number, number, number, number] = [1, 1, 1, 0.5];
/** A flat normal, roughness as the layer's (blue: its factor), no occlusion (alpha). */
const FLAT: [number, number, number, number] = [0.5, 0.5, 1, 1];

/** What a water surface and rain over a terrain make wet (see TerrainMaterial.setWet). */
export interface TerrainWet {
    /** The water's height, or null without water over the terrain. */
    water: number | null;
    /** Meters over the waterline that are wet. */
    shore: number;
    /** The rain's box (its -x, -z, +x, +z corners) and how hard it rains, 0 to 1, or null. */
    rain: { rect: [number, number, number, number]; amount: number } | null;
    /** How much of the flat ground under the rain puddles cover, 0 to 1. */
    puddles: number;
}

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
        shader.setUniformVector4('terrainLook', new Vector4(0.7, 0.5, 0, 0));
        shader.setUniformVector4('terrainWater', new Vector4(-1e9, 0, 0, 0));
        shader.setUniformVector4('terrainRain', new Vector4(0, 0, 0, 0));
        // The arrays are bound before the first draw: the pipeline's layout comes from them.
        this.albedo = new HeldTexture(ctx, '2d-array');
        this.normal = new HeldTexture(ctx, '2d-array');
        this.splat = new HeldTexture(ctx, '2d', 'float', false);
        this.albedo.hold(buildLayerArray(ctx, [{ sources: [], fill: WHITE }], 4, 'rgba8unorm-srgb', 'terrain albedo'));
        this.normal.hold(buildLayerArray(ctx, [{ sources: [], fill: FLAT }], 4, 'rgba8unorm', 'terrain normal'));
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
        const key = `${size}|` + list.map((l) => [l?.albedo, l?.normal, l?.arm, l?.heightMap].map((t) => ids(t ?? null)).join(',')).join('|');
        if (key === this.arraysKey) return;
        this.arraysKey = key;
        this.rebuildArrays(list, size);
    }

    /** Builds the arrays again (a layer's texture finished loading or was refilled). */
    rebuildArrays(layers: (MaterialLayer | null)[], size: number) {
        // Color with height in alpha; normal with roughness and occlusion (an ARM map's G and R) in blue and alpha.
        const albedo: ArrayLayer[] = layers.map((l) => ({ sources: [{ texture: l?.albedo ?? null, channels: 'rgb' }, { texture: l?.heightMap ?? null, channels: 'a' }], fill: WHITE }));
        const normal: ArrayLayer[] = layers.map((l) => ({ sources: [{ texture: l?.normal ?? null, channels: 'rg' }, { texture: l?.arm ?? null, channels: 'ba' }], fill: FLAT }));
        this.albedo.hold(buildLayerArray(this.ctx, albedo, size, 'rgba8unorm-srgb', 'terrain albedo'));
        this.normal.hold(buildLayerArray(this.ctx, normal, size, 'rgba8unorm', 'terrain normal'));
    }

    /** How much the layers' heights decide where they meet (0: they fade evenly) and how much the land varies, 0 to 1. */
    setLook(blending: number, variation: number) {
        this.shader.setUniformVector4('terrainLook', new Vector4(blending, variation, 0, 0));
    }

    /** Wet ground along a water surface over the terrain and under rain. */
    setWet(wet: TerrainWet) {
        this.shader.setUniformVector4('terrainWater', new Vector4(wet.water ?? -1e9, wet.water === null ? 0 : wet.shore, wet.rain?.amount ?? 0, wet.puddles));
        const r = wet.rain?.rect ?? [0, 0, 0, 0];
        this.shader.setUniformVector4('terrainRain', new Vector4(r[0], r[1], r[2], r[3]));
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

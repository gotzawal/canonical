// The materials trees draw with (engine/trees.ts): the engine's lit shader
// with a tree's own steps added, and a shadow pass of its own. Every copy
// of a tree is an instance whose place, turn, size and color it reads from
// a storage buffer (three vec4 each), so a forest draws in a few calls per
// level of detail. In the vertex stage the wind moves it: the tree leans
// and sways as a whole, each branch bobs in its own phase and leaves
// flutter; the shadow pass moves it the same way, so shadows sway with the
// leaves. Leaves are cut out by their alpha (raised with the mip level
// read, so far crowns keep their leaves), lit with the normal they were
// grown with on both sides (round crowns), and let the sun through when it
// is behind them. Bark reads its relief, the shade in its cracks and its
// roughness from its textures.

import {
    Color, GPUCullMode, LitMaterial, PassType, RenderShaderPass, Shader, ShaderLib, StorageGPUBuffer, UniformGPUBuffer, bindCtx, type Material, type Texture,
} from '@orillusion/core';
import type { TreeTextures } from './treeTextures';

const LIT = 'morglay_tree_lit';
const SHADOW = 'morglay_tree_shadow';

/** Floats each copy of a tree takes in the instance buffer: place and size, turn, color and seed. */
export const INSTANCE_FLOATS = 12;

/** The uniforms and instances (WGSL) both passes read, and the wind. */
const COMMON = /* wgsl */ `
struct TreeParams {
    // Where the wind blows toward (x, z, unit), its strength (about 1 at 6 m/s), how fast gusts travel (m/s).
    wind: vec4f,
    // Meters leaves flutter, how much branches move, meters the top sways (all times the wind), the tree's height.
    motion: vec4f,
    // The leaves' tint (times their painted color) and how much light they let through.
    leafTint: vec4f,
    // The bark's tint, and how much copies differ in color.
    barkTint: vec4f,
    // The alpha under which leaves are cut out, how much each mip level raises it, unused,
    // and the painted leaves' mean brightness.
    cut: vec4f,
    // The color leaves turn to in autumn (linear), and how far they have turned.
    autumn: vec4f,
};
struct TreeInstances {
    data: array<vec4f>,
};
@group(1) @binding(auto) var<uniform> treeParams: TreeParams;
@group(1) @binding(auto) var<storage, read> treeInstances: TreeInstances;

// A copy's matrix: its place and size (data[0]) and its turn, a quaternion (data[1]).
fn treeMatrix(i: u32) -> mat4x4<f32> {
    let a = treeInstances.data[i * 3u];
    let q = treeInstances.data[i * 3u + 1u];
    let s = a.w;
    let x2 = q.x + q.x;
    let y2 = q.y + q.y;
    let z2 = q.z + q.z;
    let xx = q.x * x2;
    let xy = q.x * y2;
    let xz = q.x * z2;
    let yy = q.y * y2;
    let yz = q.y * z2;
    let zz = q.z * z2;
    let wx = q.w * x2;
    let wy = q.w * y2;
    let wz = q.w * z2;
    return mat4x4<f32>(
        vec4f((1.0 - (yy + zz)) * s, (xy + wz) * s, (xz - wy) * s, 0.0),
        vec4f((xy - wz) * s, (1.0 - (xx + zz)) * s, (yz + wx) * s, 0.0),
        vec4f((xz + wy) * s, (yz - wx) * s, (1.0 - (xx + yy)) * s, 0.0),
        vec4f(a.xyz, 1.0)
    );
}

fn treeHash(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn treeNoise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(treeHash(i), treeHash(i + vec2f(1.0, 0.0)), u.x), mix(treeHash(i + vec2f(0.0, 1.0)), treeHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

// How far the wind moves a point at world \`wp\` of a copy standing at \`base\`, of scale \`s\`.
// \`flex\` is meters its branch moves (times the wind), \`phase\` its branch's, \`flutter\` 0 at
// a leaf card's stalk to 1 at its far end, \`n\` its normal, \`seed\` the copy's.
fn treeWind(wp: vec3f, base: vec3f, s: f32, flex: f32, phase: f32, flutter: f32, n: vec3f, seed: f32) -> vec3f {
    let w = treeParams.wind;
    let m = treeParams.motion;
    let dir = vec3f(w.x, 0.0, w.y);
    let t = globalUniform.time * 0.001;
    // Gusts: soft patches tens of meters across, carried over the forest by the wind.
    let g = treeNoise(base.xz * 0.035 - w.xy * (t * w.w * 0.035));
    let gust = w.z * (0.4 + 0.8 * g);
    // The whole tree leans with the gusts and sways about that (more the higher up).
    let h = clamp((wp.y - base.y) / max(m.w * s, 0.5), 0.0, 1.5);
    let sway = gust * (0.78 + 0.22 * sin(t * (0.6 + 0.25 * seed) + seed * 6.2832));
    var off = dir * (m.z * s * h * h * sway);
    // Branches: the farther out, the more they move, each in its own phase.
    let bt = t * (1.25 + 0.75 * phase) + phase * 6.2832;
    let b = flex * s * gust * m.y;
    off += dir * (b * (0.5 + 0.5 * sin(bt))) + vec3f(0.0, b * 0.4 * sin(bt * 1.37 + 1.3), 0.0);
    // Leaves: a quick flutter, sharper in gusts.
    off += n * (flutter * m.x * s * (0.25 + gust) * sin(t * (7.0 + 4.0 * phase) + phase * 43.0 + dot(wp, vec3f(1.7, 0.9, 1.3))));
    // What moves sideways drops a little: branches bend rather than stretch.
    off.y -= dot(off.xz, off.xz) / max(1.0, 2.0 * (wp.y - base.y));
    return off;
}
`;

/** The lit shader's steps for trees, before its vertex function. */
const LIT_STEPS = /* wgsl */ `
${COMMON}

// After the engine placed the vertex with the copy's matrix: the wind moves it, and the
// fragment stage gets its crown shade (x), the copy's color shift (y), its sprig's phase (z)
// and the copy's seed (w).
fn treeVert(v: VertexAttributes) {
    let a = treeInstances.data[v.index * 3u];
    let e = treeInstances.data[v.index * 3u + 2u];
    let packed = v.TEXCOORD_1.y;
    let phase = fract(packed);
    var flutter = 0.0;
    #if TREE_LEAVES
        flutter = 1.0 - v.uv.y;
    #endif
    var wp = ORI_VertexOut.varying_WPos.xyz;
    wp += treeWind(wp, a.xyz, a.w, v.TEXCOORD_1.x, phase, flutter, ORI_VertexOut.varying_WNormal, e.y);
    ORI_VertexOut.varying_WPos = vec4f(wp, ORI_VertexOut.varying_WPos.w);
    let view = ORI_MATRIX_V * vec4f(wp, 1.0);
    ORI_VertexOut.varying_ViewPos = view;
    ORI_VertexOut.varying_Clip = ORI_MATRIX_P * view;
    ORI_VertexOut.member = ORI_VertexOut.varying_Clip;
    ORI_VertexOut.varying_Color = vec4f(floor(packed) / 255.0, e.x, phase, e.y);
}

// Leaves are cut out where their alpha is low. Far mip levels average the leaves with the gaps
// between them, so alpha is raised with the level read: far crowns keep their leaves.
fn treeAlpha() {
    #if TREE_LEAVES
        let st = ORI_VertexVarying.fragUV0 * vec2f(textureDimensions(baseMap));
        let d = max(dot(dpdx(st), dpdx(st)), dot(dpdy(st), dpdy(st)));
        let lod = max(0.0, 0.5 * log2(max(d, 1e-8)));
        if (ORI_ShadingInput.BaseColor.a * (1.0 + lod * treeParams.cut.y) < treeParams.cut.x) {
            discard;
        }
        ORI_ShadingInput.BaseColor.a = 1.0;
    #endif
}

// Before lighting: the tint, how each copy and sprig differs, the crown's shade, and for leaves
// the normal they were grown with (leaning out of the crown), the same on both sides.
fn treeSurface() {
    let v = ORI_VertexVarying.vColor;
    #if TREE_LEAVES
        var c = ORI_ShadingInput.BaseColor.rgb;
        let k = fract(v.z * 7.13 + v.w * 3.17) - 0.5;
        // In autumn sprigs turn one by one (some trees earlier), keeping the leaves' own light and dark.
        let fall = treeParams.autumn;
        let turn = smoothstep(0.0, 0.35, fall.w * 1.35 - (k + 0.5) * 0.7 - v.w * 0.25);
        let bright = dot(c, vec3f(0.2126, 0.7152, 0.0722)) / max(treeParams.cut.w, 0.002);
        c = mix(c, fall.rgb * bright * (0.8 + 0.4 * fract(v.z * 3.71)), turn);
        c *= treeParams.leafTint.rgb;
        let hue = v.y * treeParams.barkTint.w;
        c *= (1.0 + 0.26 * k) * vec3f(1.0 + 0.12 * hue, 1.0 + 0.04 * hue, 1.0 - 0.14 * hue);
        ORI_ShadingInput.BaseColor = vec4f(c, 1.0);
        ORI_ShadingInput.Normal = normalize(ORI_VertexVarying.vWorldNormal);
    #else
        var c = ORI_ShadingInput.BaseColor.rgb * treeParams.barkTint.rgb;
        c *= 1.0 + 0.2 * (fract(v.w * 13.7) - 0.5) * treeParams.barkTint.w;
        ORI_ShadingInput.BaseColor = vec4f(c, ORI_ShadingInput.BaseColor.a);
    #endif
    ORI_ShadingInput.AmbientOcclusion *= v.x;
}

// After lighting, leaves: the sun shining through them from behind, more looking toward it,
// less deep in the crown (more leaves in the way), warm yellow-green.
fn treeLight() {
    #if TREE_LEAVES
        let lightIndex = getCluster();
        let start = max(lightIndex.start, 0.0);
        let end = max(start + max(lightIndex.count, 0.0), 0.0);
        var through = vec3f(0.0);
        for (var i: i32 = i32(start); i < i32(end); i += 1) {
            let light = getLight(i);
            if (light.lightType != DirectLightType) {
                continue;
            }
            let L = normalize(-light.direction.xyz);
            let shadow = select(1.0, directShadowVisibility[max(light.castShadow, 0)], light.castShadow >= 0);
            let color = getHDRColor(light.lightColor.rgb, light.linear) * max(0.0, light.intensity);
            let back = saturate(0.3 - dot(fragData.N, L) * 0.7);
            let toward = pow(saturate(dot(fragData.V, -L)), 4.0);
            through += color * shadow * (back * 0.45 + toward * 0.8);
        }
        let tint = fragData.Albedo.rgb * vec3f(1.1, 1.22, 0.5);
        let k = treeParams.leafTint.w * (0.3 + 0.7 * ORI_VertexVarying.vColor.x);
        ORI_FragmentOutput.color = vec4f(ORI_FragmentOutput.color.rgb + through * tint * (k / 3.14159), ORI_FragmentOutput.color.a);
    #endif
}
`;

/** The shadow pass: the copy placed and moved by the wind as above; leaves cut out by alpha. */
const SHADOW_CODE = /* wgsl */ `
#include "GlobalUniform"
#include "VertexAttributes"
${COMMON}

struct TreeShadowOut {
    @location(auto) uv: vec2<f32>,
    @builtin(position) member: vec4<f32>
};

#if TREE_LEAVES
    @group(1) @binding(auto) var baseMapSampler: sampler;
    @group(1) @binding(auto) var baseMap: texture_2d<f32>;
#endif

@vertex
fn main(v: VertexAttributes) -> TreeShadowOut {
    let m = treeMatrix(v.index);
    let a = treeInstances.data[v.index * 3u];
    let e = treeInstances.data[v.index * 3u + 2u];
    var wp = (m * vec4f(v.position, 1.0)).xyz;
    let n = normalize((m * vec4f(v.normal, 0.0)).xyz);
    var flutter = 0.0;
    #if TREE_LEAVES
        flutter = 1.0 - v.uv.y;
    #endif
    wp += treeWind(wp, a.xyz, a.w, v.TEXCOORD_1.x, fract(v.TEXCOORD_1.y), flutter, n, e.y);
    var out: TreeShadowOut;
    out.member = globalUniform.projMat * globalUniform.viewMat * vec4f(wp, 1.0);
    out.uv = v.uv;
    return out;
}

// Depth only: no outputs. Cut-out texels of leaves cast nothing.
@fragment
fn frag(@location(auto) uv: vec2<f32>) {
    #if TREE_LEAVES
        let st = uv * vec2f(textureDimensions(baseMap));
        let d = max(dot(dpdx(st), dpdx(st)), dot(dpdy(st), dpdy(st)));
        let lod = max(0.0, 0.5 * log2(max(d, 1e-8)));
        if (textureSample(baseMap, baseMapSampler, uv).a * (1.0 + lod * treeParams.cut.y) < treeParams.cut.x) {
            discard;
        }
    #endif
}
`;

/** Registers the shaders (once): the lit shader with the tree's steps, and the shadow pass. */
function registered() {
    if (LIT in ShaderLib) return;
    const lit = ShaderLib.getShader('PBRLItShader');
    const steps: [RegExp | string, string][] = [
        ['fn vert(', `${LIT_STEPS}\nfn vert(`],
        // The copy's matrix in place of the renderer's, then the wind.
        [/ORI_Vert\(inputData\)\s*;/, 'ORI_MATRIX_M = treeMatrix(inputData.index);\n        ORI_Vert(inputData);\n        treeVert(inputData);'],
        // Leaves cut before the shadows are looked up: cut-out texels cost little.
        ['#if USE_ALPHACUT', 'treeAlpha();\n        #if USE_ALPHACUT'],
        ['BxDFShading();', 'treeSurface();\n        BxDFShading();\n        treeLight();'],
    ];
    let code = lit;
    for (const [from, to] of steps) {
        const next = code.replace(from, to);
        if (next === code) throw new Error(`[editor] the tree shader found no ${String(from)} in the lit shader`);
        code = next;
    }
    ShaderLib.register(LIT, code);
    ShaderLib.register(SHADOW, SHADOW_CODE);
}

/** One tree species' uniforms: the wind, its motion, tints and cut (see TreeParams in COMMON). */
export class TreeParams {
    readonly buffer = new UniformGPUBuffer(24);
    private values = {
        wind: [1, 0, 0.8, 6],
        motion: [0.04, 1, 0.25, 12],
        leafTint: [1, 1, 1, 0.6],
        barkTint: [1, 1, 1, 0.5],
        cut: [0.5, 0.3, 0, 0.1],
        autumn: [0.4, 0.15, 0.03, 0],
    };

    constructor(ctx: object) {
        bindCtx(this.buffer as never, ctx as never);
        this.buffer.visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this.set({});
    }

    /** Sets some of its values (the others stay). */
    set(v: Partial<Record<'wind' | 'motion' | 'leafTint' | 'barkTint' | 'cut' | 'autumn', number[]>>) {
        Object.assign(this.values, v);
        // Written in the order the shader's struct has them.
        for (const k of ['wind', 'motion', 'leafTint', 'barkTint', 'cut', 'autumn'] as const) this.buffer.setFloat32Array(k, new Float32Array(this.values[k]));
        this.buffer.apply();
    }

    destroy() {
        this.buffer.destroy();
    }
}

/** The instance buffer of a species' copies: INSTANCE_FLOATS floats each, written in parts as their levels change. */
export class TreeInstanceBuffer {
    readonly buffer: StorageGPUBuffer;
    constructor(readonly capacity: number, private ctx: object) {
        this.buffer = new StorageGPUBuffer(Math.max(1, capacity) * INSTANCE_FLOATS);
        bindCtx(this.buffer as never, ctx as never);
        this.buffer.visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    }

    /** Writes copies from `first` on (counted in copies). */
    write(first: number, data: Float32Array) {
        const device = (this.ctx as { device: GPUDevice }).device;
        device.queue.writeBuffer(this.buffer.buffer, first * INSTANCE_FLOATS * 4, data.buffer, data.byteOffset, data.byteLength);
    }

    destroy() {
        this.buffer.destroy();
        try {
            this.buffer.buffer.destroy();
        } catch {
            // Never made.
        }
    }
}

/**
 * A tree material: the lit shader's color pass with the tree's steps
 * (leaves or bark) and its own shadow pass, reading these copies and
 * uniforms.
 */
export function treeMaterial(part: 'bark' | 'leaves', textures: TreeTextures, params: TreeParams, instances: TreeInstanceBuffer, ctx: object): Material {
    registered();
    const mat = new LitMaterial(ctx as never);
    // The engine's lit color pass, under the tree shader's name (a clone takes the shader its names give).
    const base = mat.shader.getDefaultColorShader();
    const names = [base.vsName, base.fsName];
    base.vsName = base.fsName = LIT;
    const color = base.clone();
    [base.vsName, base.fsName] = names;
    const leaves = part === 'leaves';
    color.setDefine('TREE_LEAVES', leaves);
    // Leaves are cut by treeAlpha; the shade in the bark's cracks is its mask's red.
    color.setDefine('USE_ALPHACUT', false);
    color.setDefine('USE_ALPHA_A', false);
    color.setDefine('USE_AO_R', !leaves);
    color.setTexture('baseMap', leaves ? textures.leaves : textures.bark);
    if (!leaves) color.setTexture('normalMap', textures.barkNormal);
    color.setTexture('maskMap', leaves ? textures.leafMask : textures.barkMask);
    color.setUniformColor('baseColor', new Color(1, 1, 1, 1));
    color.setUniformFloat('roughness', 1);
    color.setUniformFloat('metallic', 0);
    color.setUniformFloat('alphaCutoff', 0);
    color.setUniformBuffer('treeParams', params.buffer);
    color.setStorageBuffer('treeInstances', instances.buffer);
    color.shaderState.cullMode = leaves ? GPUCullMode.none : GPUCullMode.back;
    color.shaderState.castShadow = true;

    const shadow = new RenderShaderPass(SHADOW, SHADOW);
    shadow.passType = PassType.SHADOW;
    shadow.setShaderEntry('main', 'frag');
    shadow.setDefine('TREE_LEAVES', leaves);
    if (leaves) shadow.setTexture('baseMap', textures.leaves);
    shadow.setUniformBuffer('treeParams', params.buffer);
    shadow.setStorageBuffer('treeInstances', instances.buffer);
    shadow.shaderState.receiveEnv = false;
    shadow.shaderState.castShadow = false;
    shadow.shaderState.acceptShadow = false;
    shadow.shaderState.useLight = false;
    shadow.shaderState.cullMode = leaves ? GPUCullMode.none : GPUCullMode.back;
    shadow.shaderState.depthBias = 0;
    shadow.shaderState.depthBiasSlopeScale = 0;
    shadow.shaderState.depthBiasClamp = 0;

    const unused = mat.shader;
    const shader = new Shader();
    shader.addRenderPass(color);
    shader.addRenderPass(shadow);
    mat.shader = shader;
    // The lit material's own pass goes, keeping its textures (the engine's shared defaults, and ours).
    for (const list of unused.passShader.values()) for (const p of list) p.textures = {};
    unused.destroy();
    mat.name = `Tree ${part}`;
    mat.castShadow = true;
    return mat;
}

/** Changes a texture of a tree material's passes (the leaves or bark painted again). */
export function setTreeTexture(mat: Material, name: string, texture: Texture) {
    mat.shader.passShader.forEach((passes) => passes.forEach((p) => p.textures[name] && p.setTexture(name, texture)));
}

// Scattered models that sit in the ground (Scatter.soil, Scatter.moss): a
// variant of the engine's lit shader that, before lighting, lets the soil
// under a copy creep up its base (to a ragged height over the terrain),
// grows moss (or dust) on what faces up, and varies each copy's color a
// little. One uniform buffer per scatter carries the terrain's frame, the
// soil and the moss; the terrain's heights are the ones material shaders
// read (ShaderManager.terrainHeights).

import { LitMaterial, ShaderLib, UniformGPUBuffer, type Material, type RenderShaderPass, type Texture } from '@orillusion/core';
import { cloneMaterial } from './modelParts';

const NAME = 'morglay_rock_ground';

const CODE = /* wgsl */ `
struct RockGround {
    // The terrain's middle x, z and size x, z.
    frame: vec4f,
    // Its base, its height, whether there is one (z), how much copies vary (w).
    level: vec4f,
    // The soil's color (linear) and how high it creeps up, meters.
    soil: vec4f,
    // The moss's color (linear) and how much grows.
    moss: vec4f,
    // The wind's direction x, z (unit), how far tops lean in it (meters at \`w\` meters up).
    sway: vec4f,
};
@group(1) @binding(auto) var<uniform> rockGround: RockGround;
@group(1) @binding(auto) var terrainHeightMapSampler: sampler;
@group(1) @binding(auto) var terrainHeightMap: texture_2d<f32>;

fn rgHash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn rgNoise(p: vec3f) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let a = mix(mix(rgHash(i), rgHash(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(rgHash(i + vec3f(0.0, 1.0, 0.0)), rgHash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y);
    let b = mix(mix(rgHash(i + vec3f(0.0, 0.0, 1.0)), rgHash(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(rgHash(i + vec3f(0.0, 1.0, 1.0)), rgHash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y);
    return mix(a, b, u.z);
}

fn rgGround(p: vec3f) -> f32 {
    let f = rockGround.frame;
    let l = rockGround.level;
    let uv = vec2f((p.x - f.x) / f.z + 0.5, (p.z - f.y) / f.w + 0.5);
    if (l.z < 0.5 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return -1e9; }
    let size = vec2i(textureDimensions(terrainHeightMap));
    let s = uv * vec2f(size - 1);
    let i = vec2i(floor(s));
    let t = s - floor(s);
    let hi = size - 1;
    let a = textureLoad(terrainHeightMap, clamp(i, vec2i(0), hi), 0).r;
    let b = textureLoad(terrainHeightMap, clamp(i + vec2i(1, 0), vec2i(0), hi), 0).r;
    let c = textureLoad(terrainHeightMap, clamp(i + vec2i(0, 1), vec2i(0), hi), 0).r;
    let d = textureLoad(terrainHeightMap, clamp(i + vec2i(1, 1), vec2i(0), hi), 0).r;
    return l.x + mix(mix(a, b, t.x), mix(c, d, t.x), t.y) * l.y;
}

// Sway in the wind: bent by the square of the height over the copy's origin, in slow gusts
// (each copy a little out of step), with a fast flutter of what is high up.
fn rgSway() {
    let s = rockGround.sway;
    if (s.z <= 0.0) { return; }
    let base = ORI_MATRIX_M[3].xyz;
    var wp = ORI_VertexOut.varying_WPos.xyz;
    let h = max(wp.y - base.y, 0.0) / max(s.w, 0.1);
    let t = TIME_time() * 0.001;
    let phase = dot(base.xz, vec2f(0.37, 0.61));
    let gust = 0.65 + 0.35 * sin(t * 0.7 + phase * 0.3) + 0.2 * sin(t * 2.3 + phase);
    let bend = s.z * h * h * gust;
    let flutter = 0.04 * s.z * h * sin(t * 9.0 + dot(wp, vec3f(3.1, 1.7, 2.3)));
    wp += vec3f(s.x * bend + flutter, -bend * bend * 0.3 / max(s.w, 0.1), s.y * bend + flutter);
    ORI_VertexOut.varying_WPos = vec4f(wp, ORI_VertexOut.varying_WPos.w);
    let view = ORI_MATRIX_V * vec4f(wp, 1.0);
    ORI_VertexOut.varying_ViewPos = view;
    ORI_VertexOut.varying_Clip = ORI_MATRIX_P * view;
    ORI_VertexOut.member = ORI_VertexOut.varying_Clip;
}

fn rockGroundSurface() {
    let p = ORI_VertexVarying.vWorldPos.xyz;
    let n = ORI_ShadingInput.Normal;
    var c = ORI_ShadingInput.BaseColor.rgb;
    var rough = ORI_ShadingInput.Roughness;
    // Each copy a little lighter or darker, warmer or cooler (by where it stands, at a copy's scale).
    let v = rgNoise(p * 0.4) - 0.5;
    c *= (1.0 + v * 0.5 * rockGround.level.w) * vec3f(1.0 + v * 0.12, 1.0, 1.0 - v * 0.12 * rockGround.level.w);
    // Moss on what faces up, raggedly.
    let m = rockGround.moss;
    if (m.w > 0.0) {
        let up = smoothstep(0.35, 0.8, n.y + (rgNoise(p * 3.1) - 0.5) * 0.6 - (1.0 - m.w) * 0.5) * m.w;
        c = mix(c, m.rgb * (0.75 + 0.5 * rgNoise(p * 9.0)), up);
        rough = mix(rough, 0.95, up);
    }
    // Soil up the base, to a ragged line.
    let s = rockGround.soil;
    if (s.w > 0.0) {
        let depth = p.y - rgGround(p);
        let k = 1.0 - smoothstep(0.0, s.w * (0.4 + 1.2 * rgNoise(p * 2.3)), depth);
        c = mix(c, s.rgb * (0.8 + 0.4 * rgNoise(p * 6.0)), k * 0.9);
        rough = mix(rough, 1.0, k);
    }
    ORI_ShadingInput.BaseColor = vec4f(c, ORI_ShadingInput.BaseColor.a);
    ORI_ShadingInput.Roughness = rough;
}
`;

function registered(): string {
    if (!(NAME in ShaderLib)) {
        const lit = ShaderLib.getShader('PBRLItShader');
        ShaderLib.register(NAME, lit
            .replace('fn vert(', `${CODE}\nfn vert(`)
            .replace(/ORI_Vert\(inputData\)\s*;/, 'ORI_Vert(inputData);\n        rgSway();')
            .replace('BxDFShading();', 'rockGroundSurface();\n        BxDFShading();'));
    }
    return NAME;
}

/** What one scatter's copies read: the terrain under them, their soil, moss and variation. */
export class RockGround {
    readonly buffer = new UniformGPUBuffer(20);
    private values = { frame: [0, 0, 1, 1], level: [0, 0, 0, 0], soil: [0, 0, 0, 0], moss: [0, 0, 0, 0], sway: [0, 0, 0, 1] };
    constructor(readonly heights: Texture) {
        this.set({});
    }

    /** Sets some of its values (the others stay). */
    set(v: Partial<{ frame: number[]; level: number[]; soil: number[]; moss: number[]; sway: number[] }>) {
        Object.assign(this.values, v);
        const b = this.buffer;
        // Written in the order the shader's struct has them.
        for (const k of ['frame', 'level', 'soil', 'moss', 'sway'] as const) b.setFloat32Array(k, new Float32Array(this.values[k]));
        b.apply();
    }

    /**
     * A copy of a material that sits in the ground (the engine's lit
     * material); any other material is copied as it is.
     */
    material(src: Material, ctx?: any): Material {
        if (!(src instanceof LitMaterial)) return cloneMaterial(src, ctx);
        return cloneMaterial(src, ctx, (pass: RenderShaderPass) => {
            if (pass.fsName !== 'pbrlitshader') return pass.clone();
            // A clone that is the variant: the clone takes its shader from the names it is given.
            const names = [pass.vsName, pass.fsName];
            pass.vsName = pass.fsName = registered().toLowerCase();
            const copy = pass.clone();
            [pass.vsName, pass.fsName] = names;
            copy.setUniformBuffer('rockGround', this.buffer);
            copy.setTexture('terrainHeightMap', this.heights);
            return copy;
        });
    }

    destroy() {
        this.buffer.destroy();
    }
}

/** A color for the shader: linear rgb from #rrggbb. */
export function linearOf(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16) || 0;
    const f = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return [f(((n >> 16) & 255) / 255), f(((n >> 8) & 255) / 255), f((n & 255) / 255)];
}

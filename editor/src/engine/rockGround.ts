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
        ShaderLib.register(NAME, lit.replace('fn frag(){', `${CODE}\nfn frag(){`).replace('BxDFShading();', 'rockGroundSurface();\n        BxDFShading();'));
    }
    return NAME;
}

/** What one scatter's copies read: the terrain under them, their soil, moss and variation. */
export class RockGround {
    readonly buffer = new UniformGPUBuffer(16);
    constructor(readonly heights: Texture) {
        this.set({ frame: [0, 0, 1, 1], level: [0, 0, 0, 0], soil: [0, 0, 0, 0], moss: [0, 0, 0, 0] });
    }

    set(v: { frame: number[]; level: number[]; soil: number[]; moss: number[] }) {
        const b = this.buffer;
        b.setFloat32Array('frame', new Float32Array(v.frame));
        b.setFloat32Array('level', new Float32Array(v.level));
        b.setFloat32Array('soil', new Float32Array(v.soil));
        b.setFloat32Array('moss', new Float32Array(v.moss));
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

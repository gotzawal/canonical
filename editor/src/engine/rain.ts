// The Rain component: the drops of a box of rain, drawn by one shader on a
// box at the scene root (RAIN_CODE, a material shader compiled by the
// ShaderManager like the scene's own). The box, the bottom, the shelter's
// dry box and the light's glow come from the scene every frame, so the rain
// follows its object, its shelter and its light, also in Play.

import { BlendMode, BoxGeometry, MeshRenderer, Object3D, type Material, type RenderNode } from '@orillusion/core';
import type { RainDoc, ShaderDoc } from '../core/types';
import { worldBoxInto, type Box } from './picking';
import { applyProps, parseShader, setBlended, type ShaderManager } from './shaders';

/** The rain shader's id among the ShaderManager's shaders (never in a scene). */
export const RAIN_SHADER_ID = 'builtin:rain';

export const RAIN_CODE = `// The built-in rain (Rain component): ONE box, and inside it the drops live
// at real positions in space - no cards, no layers of rain. For every pixel
// the shader walks the eye ray through the volume in steps of one cell. Each
// cell holds one falling drop on a line of its own; where the ray passes
// within that drop's width the exact chord through the drop is added, so
// drops stay thin and get their right size from their distance. Drops fall
// in world Y, stop at the bottom, lean with the wind, and fade out close to
// the camera and at the volume's edges.
//
// Dry box (the shelter): the drops are kept out of one box in space, so no
// rain falls under an awning while the same drop lines carry on above it and
// just past its edge - the rain reads as running off the rim.
//
// Cost: this runs on every pixel of the volume, so the per cell tests stay
// cheap. Each cell is first tested against the ray through its middle with
// the largest offset a drop can have from it: nine cells out of ten drop out
// there, without a single hash. What is left is hashed with an integer hash
// and the distance test compares squared distances, so the square root only
// runs for the few cells a pixel actually hits.
//
// The engine sets the box, the bottom, the shelter and the light from the
// scene every frame (engine/rain.ts); the rest are the component's fields.
//
// @property boxMin vec4 -8 0 -8 0
// @property boxMax vec4 8 10 8 0
// @property cell float 1 0.2 3
// @property drop_width float 0.01 0.004 0.08
// @property fill float 1 0.05 1
// @property density float 8.4 0.2 30
// @property dash_len float 2.85 0.05 3
// @property fall_speed float 5 1 25
// @property slant float -0.17 -0.5 0.5
// @property bottom float 0.0 -1000 1000
// @property intensity float 1.25 0 4
// @property near_fade float 3.2 0.2 20
// @property tint color #e8f0f8
// @property lampTint color #ffbe73
// @property lampGain float 0 0 3
// @property lampPos vec4 0 0 0 1
// @property dryMin vec4 0 0 0 0
// @property dryMax vec4 0 0 0 0
// @property dryFade float 0.3 0 2

// Integer hash: three multiply-xor rounds on the cell id, about a third of the
// cost of the floating point hash it replaces. The top round of bits is dropped
// before the conversion so the 24 bit mantissa is filled with usable bits.
fn hashCell(c: vec2i, seed: u32) -> f32 {
    var h: u32 = u32(c.x) * 1597334673u + u32(c.y) * 3812015801u + seed;
    h = (h ^ (h >> 15u)) * 2246822519u;
    h = (h ^ (h >> 13u)) * 3266489917u;
    h = h ^ (h >> 16u);
    return f32(h >> 8u) * (1.0 / 16777216.0);
}

struct Ray {
    ox: f32,
    oz: f32,
    dx: f32,
    dz: f32,
    camY: f32,
    dirY: f32,
    denom: f32,
    shear2: f32
};

// What one drop of this cell adds to this pixel.
fn dropContribution(cid: vec2i, r: Ray, ta: f32, tb: f32) -> vec4f {
    let cell = materialUniform.cell;
    let bmin = materialUniform.boxMin.xyz;
    let bmax = materialUniform.boxMax.xyz;

    if (r.denom < 1.0e-4) {
        return vec4f(0.0);
    }

    // Cheap out first: the drop's line sits within 0.43 * cell of the middle of
    // its cell on each axis, so if the ray misses that middle by more than the
    // largest that offset can reach the drop cannot be hit either. Most cells
    // of the block are gone here, before any hash is spent on them.
    let cx = (f32(cid.x) + 0.5) * cell;
    let cz = (f32(cid.y) + 0.5) * cell;
    let tsc = ((cx - r.ox) * r.dx + (cz - r.oz) * r.dz) / r.denom;
    let ddxc = (r.ox + r.dx * tsc) - cx;
    let ddzc = (r.oz + r.dz * tsc) - cz;
    let rho2c = (ddxc * ddxc + ddzc * ddzc) * r.shear2;
    let reach = 0.608 * cell + 1.3 * materialUniform.drop_width;
    if (rho2c > reach * reach) {
        return vec4f(0.0);
    }

    let h1 = hashCell(cid, 0u);
    if (h1 >= materialUniform.fill) {
        return vec4f(0.0);
    }
    let h2 = hashCell(cid, 0x9E3779B9u);
    let h3 = hashCell(cid, 0x85EBCA6Bu);

    // the drop's line sits somewhere jittered inside its cell
    let lx = (f32(cid.x) + 0.5 + (h2 - 0.5) * 0.86) * cell;
    let lz = (f32(cid.y) + 0.5 + (h3 - 0.5) * 0.86) * cell;

    // where the eye ray comes closest to that line
    let ts = ((lx - r.ox) * r.dx + (lz - r.oz) * r.dz) / r.denom;
    if (ts < ta || ts > tb) {
        return vec4f(0.0);
    }

    let ddx = (r.ox + r.dx * ts) - lx;
    let ddz = (r.oz + r.dz * ts) - lz;
    // squared distance, so the square root only runs where a drop is hit
    let rho2 = (ddx * ddx + ddz * ddz) * r.shear2;
    let w = materialUniform.drop_width * (0.7 + 0.6 * h3);
    if (rho2 >= w * w) {
        return vec4f(0.0);
    }
    let rho = sqrt(rho2);

    let yAt = r.camY + r.dirY * ts;
    let dash = materialUniform.dash_len * (0.7 + 0.6 * h2);
    let yv = yAt + getTime() * materialUniform.fall_speed * (0.85 + 0.3 * h3) + h1 * 11.0;
    let f = fract(yv / dash);
    var prof = smoothstep(0.0, 0.16, f) * (1.0 - smoothstep(0.42, 0.62, f));
    prof *= smoothstep(materialUniform.bottom - 0.25, materialUniform.bottom + 0.7, yAt);
    prof *= 1.0 - smoothstep(bmax.y - 1.6, bmax.y, yAt);
    let px = lx - materialUniform.slant * yAt;
    let pz = r.oz + r.dz * ts;
    // keep the rain a little clear of the walls, the shop front and the far wall
    prof *= smoothstep(bmin.x, bmin.x + 0.5, px) * (1.0 - smoothstep(bmax.x - 0.5, bmax.x, px));
    prof *= 1.0 - smoothstep(bmax.z - 0.5, bmax.z, pz);

    // the eaves: nothing falls inside the dry box (its footprint is the awning),
    // so under the canopy it stays dry while the same drop lines carry on above
    // it and just past its rim.
    let dmn = materialUniform.dryMin.xyz;
    let dmx = materialUniform.dryMax.xyz;
    let dr = materialUniform.dryFade + 1.0e-3;
    let inx = smoothstep(dmn.x - dr, dmn.x, px) * (1.0 - smoothstep(dmx.x, dmx.x + dr, px));
    let iny = smoothstep(dmn.y, dmn.y + 0.1, yAt) * (1.0 - smoothstep(dmx.y - dr, dmx.y, yAt));
    let inz = smoothstep(dmn.z - dr, dmn.z, pz) * (1.0 - smoothstep(dmx.z, dmx.z + dr, pz));
    prof *= 1.0 - inx * iny * inz;
    if (prof <= 0.0) {
        return vec4f(0.0);
    }

    // how much rain this drop puts in the way, along the ray
    let chord = 2.0 * sqrt(max(w * w - rho2, 0.0));
    var a = 1.0 - exp(-materialUniform.density * chord * prof);
    a *= smoothstep(0.35, materialUniform.near_fade, ts);
    a *= materialUniform.intensity * (0.5 + 0.7 * h2);
    a = clamp(a, 0.0, 1.0);

    // the drop is lit a little by the street lamp it falls past
    let dl = vec3f(px, yAt, pz) - materialUniform.lampPos.xyz;
    let glow = clamp(exp(-dot(dl, dl) / (materialUniform.lampPos.w * materialUniform.lampPos.w)), 0.0, 1.0);
    let c = mix(materialUniform.tint.rgb, materialUniform.lampTint.rgb, glow)
        * (0.7 + 0.6 * h3) * (1.0 + materialUniform.lampGain * glow);

    return vec4f(c * a, a);
}

fn frag() {
    let cam = globalUniform.CameraPos.xyz;
    let wp = ORI_VertexVarying.vWorldPos.xyz;
    let dv = wp - cam;
    let dist = length(dv);
    if (dist < 1.0e-4) {
        discard;
    }
    let dir = dv / dist;

    let bmin = materialUniform.boxMin.xyz;
    let bmax = materialUniform.boxMax.xyz;
    let sd = select(dir, vec3f(1.0e-6, 1.0e-6, 1.0e-6), abs(dir) < vec3f(1.0e-6));
    let ta3 = (bmin - cam) / sd;
    let tb3 = (bmax - cam) / sd;
    let tnear = max(max(min(ta3.x, tb3.x), min(ta3.y, tb3.y)), min(ta3.z, tb3.z));
    let tfar = min(min(max(ta3.x, tb3.x), max(ta3.y, tb3.y)), max(ta3.z, tb3.z));
    if (tfar <= max(tnear, 0.0)) {
        discard;
    }

    // from outside, only the surface the ray enters at draws, so the volume is
    // walked exactly once per pixel
    let camInside = all(cam >= bmin) && all(cam <= bmax);
    if (!camInside && dist > tnear + 0.4) {
        discard;
    }

    let t0 = max(tnear, 0.0);
    let t1 = min(tfar, t0 + 40.0);

    let slant = materialUniform.slant;
    var r: Ray;
    r.ox = cam.x + slant * cam.y;
    r.oz = cam.z;
    r.dx = dir.x + slant * dir.y;
    r.dz = dir.z;
    r.denom = r.dx * r.dx + r.dz * r.dz;
    r.shear2 = 1.0 / (1.0 + slant * slant);
    r.camY = cam.y;
    r.dirY = dir.y;

    let step = materialUniform.cell;
    var acc = 0.0;
    var col = vec3f(0.0);

    for (var i: i32 = 0; i < 34; i = i + 1) {
        let ta = t0 + f32(i) * step;
        if (ta >= t1 || acc > 0.9) {
            break;
        }
        let tb = min(ta + step, t1);
        let p = cam + dir * (ta + step * 0.5);
        let base = vec2i(floor(vec2f(p.x, p.z) / step - vec2f(0.5, 0.5)));
        // the four cells of the block, written out: (0,0) (1,0) (0,1) (1,1)
        let c00 = dropContribution(base, r, ta, tb);
        if (c00.a > 0.0) {
            col = col + c00.rgb * (1.0 - acc);
            acc = acc + c00.a * (1.0 - acc);
        }
        let c10 = dropContribution(base + vec2i(1, 0), r, ta, tb);
        if (c10.a > 0.0) {
            col = col + c10.rgb * (1.0 - acc);
            acc = acc + c10.a * (1.0 - acc);
        }
        let c01 = dropContribution(base + vec2i(0, 1), r, ta, tb);
        if (c01.a > 0.0) {
            col = col + c01.rgb * (1.0 - acc);
            acc = acc + c01.a * (1.0 - acc);
        }
        let c11 = dropContribution(base + vec2i(1, 1), r, ta, tb);
        if (c11.a > 0.0) {
            col = col + c11.rgb * (1.0 - acc);
            acc = acc + c11.a * (1.0 - acc);
        }
    }

    if (acc < 0.004) {
        discard;
    }
    ORI_ShadingInput.BaseColor = vec4f(col / max(acc, 1.0e-4), acc);
    UnLit();
}
`;

export const RAIN_SHADER: ShaderDoc = { id: RAIN_SHADER_ID, name: 'Rain.wgsl', kind: 'material', lighting: 'unlit', code: RAIN_CODE };

const PROPS = parseShader(RAIN_CODE, 'material').props;

/** What a rain volume reads from the scene each frame. */
export interface RainScene {
    /** The world position of the rain's object. */
    center: [number, number, number];
    /** The world box of its shelter. */
    shelter: Box | null;
    /** Its light: world position, color and range. */
    light: { at: [number, number, number]; color: string; range: number } | null;
}

/** One Rain component's box and material. */
export class RainVolume {
    readonly root: Object3D;
    private renderer: MeshRenderer;
    private size = '';
    private material: Material | null = null;
    private version = -1;

    constructor(scene: Object3D, private shaders: ShaderManager) {
        this.root = new Object3D();
        this.root.name = 'Rain';
        this.renderer = this.root.addComponent(MeshRenderer);
        this.renderer.castShadow = false;
        this.renderer.receiveShadow = false;
        this.renderer.castGI = false;
        scene.addChild(this.root);
    }

    setVisible(visible: boolean) {
        this.renderer.enable = visible && !!this.material;
    }

    /** Places the box and sets the shader's values; the material is made once the shader has compiled. */
    update(doc: RainDoc, at: RainScene, visible: boolean) {
        const version = this.shaders.version(RAIN_SHADER_ID);
        if (version !== this.version) {
            const mat = this.shaders.createMaterial(RAIN_SHADER_ID);
            if (mat) {
                setBlended(mat, true);
                const state = mat.shader.getDefaultColorShader().shaderState;
                // Drops add light: they never darken what is behind them.
                state.blendMode = BlendMode.ADD;
                state.cullMode = 'none';
                this.renderer.material = mat;
                this.material?.destroy?.(true);
                this.material = mat;
                this.version = version;
            }
        }
        const size = doc.size.join(',');
        if (size !== this.size) {
            this.size = size;
            this.renderer.geometry = new BoxGeometry(doc.size[0], doc.size[1], doc.size[2]);
        }
        const [x, y, z] = at.center;
        this.root.x = x;
        this.root.y = y;
        this.root.z = z;
        this.renderer.enable = visible && !!this.material;
        const shader = this.material?.shader;
        if (!shader) return;
        const [sx, sy, sz] = doc.size.map((s) => s / 2);
        const values = {
            cell: doc.spacing,
            drop_width: doc.dropWidth,
            fill: doc.amount,
            density: doc.density,
            dash_len: doc.streak,
            fall_speed: doc.speed,
            slant: doc.wind,
            intensity: doc.brightness,
            near_fade: doc.nearFade,
            tint: doc.color,
            // Drops reach the bottom of the box: they fade over the last half meter.
            bottom: y - sy - 0.5,
            boxMin: [x - sx, y - sy, z - sz, 0],
            boxMax: [x + sx, y + sy, z + sz, 0],
            // Under the shelter stays dry from the bottom of the box up to its top.
            dryMin: at.shelter ? [at.shelter.min[0], y - sy, at.shelter.min[2], 0] : [0, 0, 0, 0],
            dryMax: at.shelter ? [...at.shelter.max, 0] : [0, 0, 0, 0],
            lampTint: at.light?.color ?? '#ffffff',
            lampGain: at.light ? doc.lightGain : 0,
            // The glow fades out over about 40% of the light's range.
            lampPos: at.light ? [...at.light.at, Math.max(0.1, at.light.range * 0.4)] : [0, 0, 0, 1],
        };
        applyProps(shader, PROPS, values);
    }

    remove() {
        this.root.removeFromParent();
        // The renderer releases the material it draws with as it goes: destroying
        // it again threw, so stopping Play in a scene with rain left it half rebuilt.
        this.root.destroy();
        this.material = null;
    }
}

/** The world box of an object's renderers (and those under it), or null when it draws nothing. */
export function objectWorldBox(obj: Object3D): Box | null {
    const out: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const box: Box = { min: [0, 0, 0], max: [0, 0, 0] };
    let any = false;
    obj.traverse((o: Object3D) => {
        o.components.forEach((c) => {
            if (!(c instanceof MeshRenderer) || !worldBoxInto(c as RenderNode, box)) return;
            any = true;
            for (let k = 0; k < 3; k++) {
                out.min[k] = Math.min(out.min[k], box.min[k]);
                out.max[k] = Math.max(out.max[k], box.max[k]);
            }
        });
    });
    return any ? out : null;
}

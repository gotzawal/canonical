// Starting points for new scripts and shaders. They double as documentation
// of the script API (play/script.ts) and of the shader conventions
// (engine/shaders.ts), so keep them short and correct.

import type { SceneDoc, ShaderDoc } from './types';

export interface ScriptTemplate {
    id: string;
    label: string;
    description: string;
    code: (className: string) => string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
    {
        id: 'empty',
        label: 'Empty Script',
        description: 'Lifecycle methods with nothing in them.',
        code: (name) => `// Runs in Play mode. Public fields show up in the Inspector.
export default class ${name} extends Script {
    speed = 1;

    start() {
        // Called once, before the first update.
    }

    update(dt) {
        // Called every frame. dt is the frame time in seconds.
    }
}
`,
    },
    {
        id: 'rotator',
        label: 'Rotator',
        description: 'Spins the object around an axis.',
        code: (name) => `// Spins the object. Speed is in degrees per second.
export default class ${name} extends Script {
    speed = 90;
    axis = 'y';

    update(dt) {
        const o = this.object3D;
        if (this.axis === 'x') o.rotationX += this.speed * dt;
        else if (this.axis === 'z') o.rotationZ += this.speed * dt;
        else o.rotationY += this.speed * dt;
    }
}
`,
    },
    {
        id: 'bob',
        label: 'Bobbing',
        description: 'Floats the object up and down.',
        code: (name) => `// Moves the object up and down around where it started.
export default class ${name} extends Script {
    height = 0.25;
    speed = 2;

    start() {
        this.baseY = this.object3D.y;
    }

    update() {
        this.object3D.y = this.baseY + Math.sin(this.time.elapsed * this.speed) * this.height;
    }
}
`,
    },
    {
        id: 'player',
        label: 'Simple Mover',
        description: 'WASD / arrows or the joystick move it, Space jumps. For the player, use Create > Player.',
        code: (name) => `// Moves the object with WASD / arrows (or the on-screen joystick) and jumps with Space.
// For the player with a camera and collisions, use Create > Player instead.
export default class ${name} extends Script {
    speed = 4;
    jump = 5;
    gravity = 14;

    start() {
        this.vy = 0;
        this.groundY = this.object3D.y;
    }

    update(dt) {
        const o = this.object3D;
        const x = this.input.axis('horizontal');
        const z = -this.input.axis('vertical');
        o.x += x * this.speed * dt;
        o.z += z * this.speed * dt;
        if (x || z) o.rotationY = Math.atan2(x, z) * 180 / Math.PI;

        if (this.input.keyDown('space') && o.y <= this.groundY + 1e-3) this.vy = this.jump;
        this.vy -= this.gravity * dt;
        o.y = Math.max(this.groundY, o.y + this.vy * dt);
        if (o.y === this.groundY) this.vy = 0;
    }
}
`,
    },
    {
        id: 'follow',
        label: 'Follow Camera',
        description: 'Put on a Camera node to follow another object.',
        code: (name) => `// Attach to a Camera node. Follows the object named in "target".
export default class ${name} extends Script {
    target = 'Player';
    distance = 6;
    height = 3;
    smooth = 5;

    start() {
        this.goal = this.find(this.target);
        if (!this.goal) this.warn('No object named', this.target);
    }

    lateUpdate(dt) {
        if (!this.goal) return;
        const o = this.object3D;
        const g = this.goal.transform.worldPosition;
        const k = Math.min(1, this.smooth * dt);
        o.x += (g.x - o.x) * k;
        o.y += (g.y + this.height - o.y) * k;
        o.z += (g.z + this.distance - o.z) * k;
        this.lookAt(this.goal);
    }
}
`,
    },
    {
        id: 'spawner',
        label: 'Spawner',
        description: 'Drops random primitives from above.',
        code: (name) => `// Spawns falling primitives around the object.
export default class ${name} extends Script {
    interval = 0.5;
    radius = 3;
    lifetime = 4;

    start() {
        this.every(this.interval, () => {
            const shapes = ['box', 'sphere', 'torus', 'cylinder'];
            const shape = shapes[Math.floor(Math.random() * shapes.length)];
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * this.radius;
            const obj = this.spawn(shape, {
                position: [this.object3D.x + Math.cos(a) * r, this.object3D.y + 6, this.object3D.z + Math.sin(a) * r],
                scale: [0.4, 0.4, 0.4],
                color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
            });
            obj.userData = { vy: 0 };
            this.destroy(obj, this.lifetime);
        });
    }

    update(dt) {
        for (const obj of this.spawned) {
            obj.userData.vy -= 9.8 * dt;
            obj.y = Math.max(0.2, obj.y + obj.userData.vy * dt);
            obj.rotationX += 90 * dt;
        }
    }
}
`,
    },
    {
        id: 'click',
        label: 'Click to Recolor',
        description: 'Changes color when clicked in Play mode.',
        code: (name) => `// Click the object in Play mode to give it a random color.
export default class ${name} extends Script {
    emissive = false;

    onClick() {
        const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        if (this.emissive) this.setEmissive(color, 2);
        else this.setColor(color);
        this.log(this.name, 'is now', color);
    }
}
`,
    },
];

export interface ShaderTemplate {
    id: string;
    label: string;
    description: string;
    kind: ShaderDoc['kind'];
    lighting: ShaderDoc['lighting'];
    code: string;
}

/** Marks the triplanar shader material slots use (see design/materialSlots.ts). */
export const TRIPLANAR_MARKER = '@morglay triplanar';
/** The marker under the editor's earlier name, in older projects. */
export const OLD_TRIPLANAR_MARKER = '@canonical triplanar';

export const TRIPLANAR_CODE = `// World space triplanar surface (${TRIPLANAR_MARKER}): the albedo, normal
// and ARM (occlusion, roughness, metallic) textures are projected along x, y
// and z and blended by the surface normal, so they keep their real size on
// every mesh. tile is the size of one texture tile in meters. Only the
// projections a surface faces are read: a floor or a wall reads each texture
// once. maps says which textures there are (1: normal, 2: ARM); roughness and
// metallic multiply the ARM map's.
// @property albedo texture white
// @property normalTex texture normal
// @property armTex texture data
// @property tile float 2 0.05 50
// @property sharpness float 4 1 16
// @property normalStrength float 1 0 2
// @property maps float 0 0 3

struct Triplanar {
    color: vec4f,
    arm: vec3f,
    // The normal maps' slope, in world space.
    bump: vec3f,
};

fn triplanarSample(p: vec3f, n: vec3f) -> Triplanar {
    let s = 1.0 / max(materialUniform.tile, 0.001);
    var w = pow(abs(n), vec3f(materialUniform.sharpness));
    w = w / max(w.x + w.y + w.z, 0.0001);
    // Leave out the projections that barely count, then weigh the rest to one.
    w = select(vec3f(0.0), w, w > vec3f(0.02));
    w = w / max(w.x + w.y + w.z, 0.0001);
    // Gradients while every pixel runs here: the projections below read
    // only where they weigh (textureSampleGrad needs no uniform flow).
    let dx = dpdx(p) * s;
    let dy = dpdy(p) * s;
    let flags = u32(materialUniform.maps + 0.5);
    let useNormal = (flags & 1u) != 0u;
    let useArm = (flags & 2u) != 0u;
    var out: Triplanar;
    out.color = vec4f(0.0);
    out.arm = vec3f(0.0);
    out.bump = vec3f(0.0);
    // Along x: u east (+z), up the image +y.
    if (w.x > 0.0) {
        let uv = vec2f(p.z, -p.y) * s;
        let gx = vec2f(dx.z, -dx.y);
        let gy = vec2f(dy.z, -dy.y);
        out.color += textureSampleGrad(albedo, albedoSampler, uv, gx, gy) * w.x;
        out.arm += select(vec3f(1.0), textureSampleGrad(armTex, armTexSampler, uv, gx, gy).rgb, useArm) * w.x;
        if (useNormal) {
            let t = textureSampleGrad(normalTex, normalTexSampler, uv, gx, gy).xy * 2.0 - 1.0;
            out.bump += (t.x * vec3f(0.0, 0.0, 1.0) + t.y * vec3f(0.0, 1.0, 0.0)) * w.x;
        }
    }
    // Along y: u +x, up the image -z.
    if (w.y > 0.0) {
        let uv = vec2f(p.x, p.z) * s;
        let gx = vec2f(dx.x, dx.z);
        let gy = vec2f(dy.x, dy.z);
        out.color += textureSampleGrad(albedo, albedoSampler, uv, gx, gy) * w.y;
        out.arm += select(vec3f(1.0), textureSampleGrad(armTex, armTexSampler, uv, gx, gy).rgb, useArm) * w.y;
        if (useNormal) {
            let t = textureSampleGrad(normalTex, normalTexSampler, uv, gx, gy).xy * 2.0 - 1.0;
            out.bump += (t.x * vec3f(1.0, 0.0, 0.0) + t.y * vec3f(0.0, 0.0, -1.0)) * w.y;
        }
    }
    // Along z: u +x, up the image +y.
    if (w.z > 0.0) {
        let uv = vec2f(p.x, -p.y) * s;
        let gx = vec2f(dx.x, -dx.y);
        let gy = vec2f(dy.x, -dy.y);
        out.color += textureSampleGrad(albedo, albedoSampler, uv, gx, gy) * w.z;
        out.arm += select(vec3f(1.0), textureSampleGrad(armTex, armTexSampler, uv, gx, gy).rgb, useArm) * w.z;
        if (useNormal) {
            let t = textureSampleGrad(normalTex, normalTexSampler, uv, gx, gy).xy * 2.0 - 1.0;
            out.bump += (t.x * vec3f(1.0, 0.0, 0.0) + t.y * vec3f(0.0, 1.0, 0.0)) * w.z;
        }
    }
    return out;
}

fn frag() {
    let n = normalize(ORI_VertexVarying.vWorldNormal);
    let p = ORI_VertexVarying.vWorldPos.xyz;
    let t = triplanarSample(p, n);
    let c = t.color * materialUniform.baseColor;
    ORI_ShadingInput.BaseColor = vec4f(c.rgb, materialUniform.baseColor.a);
    ORI_ShadingInput.Roughness = clamp(t.arm.g * materialUniform.roughness, 0.02, 1.0);
    ORI_ShadingInput.Metallic = t.arm.b * materialUniform.metallic;
    ORI_ShadingInput.Specular = 1.0;
    ORI_ShadingInput.AmbientOcclusion = t.arm.r;
    ORI_ShadingInput.EmissiveColor = vec4f(materialUniform.emissiveColor.rgb, 1.0);
    ORI_ShadingInput.Normal = normalize(n + t.bump * materialUniform.normalStrength);
    useShadow();
    BxDFShading();
}
`;

/** Earlier versions of TRIPLANAR_CODE: a project that still has one unchanged gets the current one. */
export const OLD_TRIPLANAR_CODES: readonly string[] = (() => { const v1 = `// World space triplanar surface (${TRIPLANAR_MARKER}): the albedo texture is
// projected along x, y and z and blended by the surface normal, so it keeps
// its real size on every mesh. tile is the size of one texture tile in
// meters. Roughness and metallic come from the material.
// @property albedo texture white
// @property tile float 2 0.05 50
// @property sharpness float 4 1 16

fn triplanarSample(p: vec3f, n: vec3f) -> vec4f {
    let s = 1.0 / max(materialUniform.tile, 0.001);
    var w = pow(abs(n), vec3f(materialUniform.sharpness));
    w = w / max(w.x + w.y + w.z, 0.0001);
    let cx = textureSample(albedo, albedoSampler, vec2f(p.z, -p.y) * s);
    let cy = textureSample(albedo, albedoSampler, vec2f(p.x, p.z) * s);
    let cz = textureSample(albedo, albedoSampler, vec2f(p.x, -p.y) * s);
    return cx * w.x + cy * w.y + cz * w.z;
}

fn frag() {
    let n = normalize(ORI_VertexVarying.vWorldNormal);
    let p = ORI_VertexVarying.vWorldPos.xyz;
    let c = triplanarSample(p, n) * materialUniform.baseColor;
    ORI_ShadingInput.BaseColor = vec4f(c.rgb, materialUniform.baseColor.a);
    ORI_ShadingInput.Roughness = materialUniform.roughness;
    ORI_ShadingInput.Metallic = materialUniform.metallic;
    ORI_ShadingInput.Specular = 1.0;
    ORI_ShadingInput.AmbientOcclusion = 1.0;
    ORI_ShadingInput.EmissiveColor = vec4f(materialUniform.emissiveColor.rgb, 1.0);
    ORI_ShadingInput.Normal = n;
    useShadow();
    BxDFShading();
}
`;
    // Under the editor's earlier marker too.
    return [v1, v1.replace(TRIPLANAR_MARKER, OLD_TRIPLANAR_MARKER)];
})();

/** A post shader running a template's code (found by a marker in it), else one by its file name. */
export function findPostShader(doc: SceneDoc, name: string, marker: string): ShaderDoc | undefined {
    const shaders = doc.shaders.filter((s) => s.kind === 'post');
    return shaders.find((s) => s.code.includes(marker)) ?? shaders.find((s) => s.name === name);
}

export const GRADE_NAME = 'ColorGrade.wgsl';
/** Found in the color grade's code (LGG_CODE), whatever its file is called. */
export const GRADE_MARKER = 'lift, gamma and gain';

/** True when the post chain runs the color grade (design/effects.ts adds it). */
export function hasColorGrade(doc: SceneDoc): boolean {
    const shader = findPostShader(doc, GRADE_NAME, GRADE_MARKER);
    return !!shader && doc.renderGraph.posts.some((p) => p.enabled && p.shader === shader.id);
}

/** Lift / gamma / gain grade, used by the Finish stage (see ai/effectTools.ts). */
export const LGG_CODE = `// Post shader: lift, gamma and gain, then saturation. It works on the HDR
// image before tone mapping: lift raises the darks, gamma bends the mid
// tones, gain scales everything. x, y, z are red, green and blue; w applies
// to all three (lift and gain add / multiply it, gamma multiplies it).
// @property lift vec4 0 0 0 0
// @property gamma vec4 1 1 1 1
// @property gain vec4 1 1 1 1
// @property saturation float 1 0 2

fn post(uv: vec2f) -> vec4f {
    let c = sceneColor(uv);
    let lift = materialUniform.lift.xyz + vec3f(materialUniform.lift.w);
    let gamma = max(materialUniform.gamma.xyz * materialUniform.gamma.w, vec3f(0.01));
    let gain = materialUniform.gain.xyz * materialUniform.gain.w;
    var x = max(c.rgb, vec3f(0.0));
    x = x + lift * max(vec3f(1.0) - x, vec3f(0.0));
    x = max(x * gain, vec3f(0.0));
    x = pow(x, vec3f(1.0) / gamma);
    let luma = dot(x, vec3f(0.2126, 0.7152, 0.0722));
    x = mix(vec3f(luma), x, materialUniform.saturation);
    return vec4f(max(x, vec3f(0.0)), c.a);
}
`;

export const SHADER_TEMPLATES: ShaderTemplate[] = [
    {
        id: 'lit',
        label: 'Lit Surface',
        description: 'PBR lit surface with a pulsing stripe pattern.',
        kind: 'material',
        lighting: 'lit',
        code: `// Lit material shader. Fill ORI_ShadingInput, then call useShadow() and BxDFShading().
// Declared properties appear in the Material section of the Inspector:
// @property stripeColor color #ff7a3d
// @property stripes float 8 1 40
// @property speed float 1 0 10

fn frag() {
    let uv = ORI_VertexVarying.fragUV0;
    let base = textureSample(baseMap, baseMapSampler, uv) * materialUniform.baseColor;
    let wave = sin((uv.y * materialUniform.stripes - getTime() * materialUniform.speed) * 6.2831853);
    let mask = smoothstep(0.2, 0.3, wave);
    let color = mix(base.rgb, materialUniform.stripeColor.rgb, mask);

    ORI_ShadingInput.BaseColor = vec4f(color, base.a);
    ORI_ShadingInput.Roughness = materialUniform.roughness;
    ORI_ShadingInput.Metallic = materialUniform.metallic;
    ORI_ShadingInput.Specular = 1.0;
    ORI_ShadingInput.AmbientOcclusion = 1.0;
    ORI_ShadingInput.EmissiveColor = vec4f(materialUniform.stripeColor.rgb * mask * 0.5, 1.0);
    ORI_ShadingInput.Normal = ORI_VertexVarying.vWorldNormal;
    useShadow();
    BxDFShading();
}
`,
    },
    {
        id: 'triplanar',
        label: 'Triplanar',
        description: 'World space triplanar texture with its tile size in meters (material slots use it).',
        kind: 'material',
        lighting: 'lit',
        code: TRIPLANAR_CODE,
    },
    {
        id: 'unlit',
        label: 'Unlit Hologram',
        description: 'Unlit rim glow with scan lines.',
        kind: 'material',
        lighting: 'unlit',
        code: `// Unlit material shader. Set ORI_ShadingInput.BaseColor, then call UnLit().
// @property glow color #3dd8ff
// @property lines float 60 1 300
// @property power float 2 0.5 8

fn frag() {
    let n = normalize(ORI_VertexVarying.vWorldNormal);
    let v = normalize(globalUniform.CameraPos.xyz - ORI_VertexVarying.vWorldPos.xyz);
    let rim = pow(1.0 - abs(dot(n, v)), materialUniform.power);
    let scan = 0.5 + 0.5 * sin((ORI_VertexVarying.vWorldPos.y * materialUniform.lines) + getTime() * 4.0);
    let c = materialUniform.glow.rgb * (rim * 2.0 + scan * 0.25);
    ORI_ShadingInput.BaseColor = vec4f(c, 1.0);
    UnLit();
}
`,
    },
    {
        id: 'wave',
        label: 'Vertex Wave',
        description: 'Displaces vertices along the normal (vertex stage).',
        kind: 'material',
        lighting: 'lit',
        code: `// A vertex function can move vertices before the engine transforms them.
// @property amplitude float 0.08 0 1
// @property frequency float 6 0 40

fn vert(inputData: VertexAttributes) -> VertexOutput {
    var v = inputData;
    let w = sin(v.position.y * materialUniform.frequency + getTime() * 3.0);
    v.position = v.position + v.normal * w * materialUniform.amplitude;
    ORI_Vert(v);
    return ORI_VertexOut;
}

fn frag() {
    let uv = ORI_VertexVarying.fragUV0;
    let base = textureSample(baseMap, baseMapSampler, uv) * materialUniform.baseColor;
    ORI_ShadingInput.BaseColor = base;
    ORI_ShadingInput.Roughness = materialUniform.roughness;
    ORI_ShadingInput.Metallic = materialUniform.metallic;
    ORI_ShadingInput.Specular = 1.0;
    ORI_ShadingInput.AmbientOcclusion = 1.0;
    ORI_ShadingInput.EmissiveColor = vec4f(materialUniform.emissiveColor.rgb * materialUniform.emissiveIntensity, 1.0);
    ORI_ShadingInput.Normal = ORI_VertexVarying.vWorldNormal;
    useShadow();
    BxDFShading();
}
`,
    },
    {
        id: 'water',
        label: 'Water',
        description: 'See-through water: the scene under it dimmed and tinted by depth (absorption and scattering), bent by the ripples, with caustics on a shallow bed, foam along every shore and around anything standing in it, the sky or (with a Mirror component) the scene reflected by a fresnel term, and the sun\'s highlight.',
        kind: 'material',
        lighting: 'lit',
        code: `// Water for a flat surface (a plane), shaded the way UE's Single Layer Water
// is: the scene behind the surface (sceneBehind) is seen through the water
// and dimmed by absorption over the distance the view ray travels under it
// (sceneDepth - surfaceDepth), while light scattered in the water fills in
// its color. The surface reflects the scene a Mirror component on the object
// captures (mirrorColor), else the sky, by a fresnel term, and the sun gives
// it a GGX highlight. Ripples are noise octaves that fade out as they shrink
// toward a pixel, their lost slope going into roughness so far water still
// glitters instead of turning into a mirror.
//
// absorption / scattering: per meter for red, green, blue (pure water absorbs
// red first: about 0.45, 0.07, 0.04). clarity divides both (2 = twice as clear).
//
// @property absorption vec4 0.45 0.075 0.04 0
// @property scattering vec4 0.012 0.024 0.032 0
// @property foamColor color #eef4f4
// @property clarity float 1 0.1 4
// @property waveScale float 1 0.1 4
// @property waveRelief float 1.4 0 6
// @property waveFlow float 1 0 4
// @property distortion float 0.035 0 0.15
// @property reflectivity float 1 0 1
// @property sunGlint float 1 0 4
// @property crestGlow float 0.6 0 3
// @property foamWidth float 0.6 0 4
// @property caustics float 0.6 0 3

const W_PI: f32 = 3.14159265;

fn wHash(p: vec2f) -> f32 {
    var q = fract(p * vec2f(0.1031, 0.1030));
    q += dot(q, q.yx + 33.33);
    return fract((q.x + q.y) * q.x);
}

// Value noise with its slope from the same four taps: (height, d/dx, d/dy).
fn wNoiseD(p: vec2f) -> vec3f {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let du = 6.0 * f * (1.0 - f);
    let a = wHash(i);
    let b = wHash(i + vec2f(1.0, 0.0));
    let c = wHash(i + vec2f(0.0, 1.0));
    let d = wHash(i + vec2f(1.0, 1.0));
    return vec3f(
        mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
        ((b - a) * (1.0 - u.y) + (d - c) * u.y) * du.x,
        ((c - a) * (1.0 - u.x) + (d - b) * u.x) * du.y
    );
}

// One octave turned by 'angle', so the grids of the octaves never line up,
// at 'freq' (per axis, a swell can be stretched) and drifting by 'drift'.
// The slope is brought back to p's axes (chain rule through the turn).
fn wOctave(p: vec2f, angle: f32, freq: vec2f, drift: vec2f) -> vec3f {
    let c = cos(angle);
    let s = sin(angle);
    let R = mat2x2f(c, s, -s, c);
    let n = wNoiseD(freq * (R * p) + drift);
    return vec3f(n.x, transpose(R) * (freq * n.yz));
}

struct WaveSum {
    h: f32,
    slope: vec2f,
    // Sum of the weights shown (to normalize the height).
    norm: f32,
    // Slope variance of what faded out (goes into roughness).
    lost: f32,
};

// Adds an octave of amplitude 'amp' whose finest wavelength is 1 / 'freq',
// faded out as that wavelength nears a few pixels ('px': what one pixel
// covers here), so it never flickers and switches off without a seam.
fn wAdd(sum: ptr<function, WaveSum>, o: vec3f, amp: f32, freq: f32, px: f32) {
    let w = 1.0 - smoothstep(0.15, 0.35, freq * px);
    (*sum).h += o.x * amp * w;
    (*sum).slope += o.yz * amp * w;
    (*sum).norm += amp * w;
    (*sum).lost += (1.0 - w) * (amp * freq) * (amp * freq);
}

fn wWaves(p: vec2f, t: f32, px: f32) -> WaveSum {
    var sum = WaveSum(0.0, vec2f(0.0), 0.0, 0.0);
    // A long swell, stretched across the wind so it wanders instead of banding.
    wAdd(&sum, wOctave(p, 0.35, vec2f(0.021, 0.058), vec2f(0.47, -0.88) * (t * 0.0625)), 1.0, 0.058, px);
    wAdd(&sum, wOctave(p, 1.70, vec2f(0.113), vec2f(-0.72, 0.51) * (t * 0.270)), 0.5, 0.113, px);
    wAdd(&sum, wOctave(p, 2.90, vec2f(0.317), vec2f(0.44, 0.90) * (t * 0.570)), 0.25, 0.317, px);
    wAdd(&sum, wOctave(p, 4.10, vec2f(0.907), vec2f(-0.86, 0.31) * (t * 1.270)), 0.125, 0.907, px);
    // The low graphics tier skips the finest ripples: their slope goes into roughness.
    if (qualityTier() > 0) {
        wAdd(&sum, wOctave(p, 5.30, vec2f(2.31), vec2f(0.21, -0.98) * (t * 2.100)), 0.0625, 2.31, px);
    } else {
        sum.lost += (0.0625 * 2.31) * (0.0625 * 2.31);
    }
    return sum;
}

// Henyey-Greenstein phase: how much light turned by an angle of cosine 'c' scatters (g > 0: forward).
fn wPhase(c: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * W_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// GGX highlight of a light from l, already multiplied by n.l, water's F0 0.02.
fn wSunSpec(n: vec3f, v: vec3f, l: vec3f, rough: f32) -> f32 {
    let h = normalize(v + l);
    let nh = max(dot(n, h), 0.0);
    let nl = max(dot(n, l), 0.0);
    let nv = max(dot(n, v), 1e-4);
    let a = max(rough * rough, 1e-3);
    let a2 = a * a;
    let dd = nh * nh * (a2 - 1.0) + 1.0;
    let D = a2 / (W_PI * dd * dd);
    let k = a * 0.5;
    let G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
    let F = 0.02 + 0.98 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
    return min(D * G * F / (4.0 * nv), 500.0);
}

// How close p is to the border between cells around wandering points
// (0 on a border): the borders form the net caustics draw.
fn wCells(p: vec2f, t: f32) -> f32 {
    let i = floor(p);
    let f = p - i;
    var d1 = 8.0;
    var d2 = 8.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let g = vec2f(f32(x), f32(y));
            let h = vec2f(wHash(i + g), wHash(i + g + vec2f(17.1, 31.7)));
            let o = 0.5 + 0.4 * sin(t * (0.5 + h) + 6.2831 * h);
            let d = length(g + o - f);
            if (d < d1) {
                d2 = d1;
                d1 = d;
            } else if (d < d2) {
                d2 = d;
            }
        }
    }
    return d2 - d1;
}

// The bright net the waves focus onto a shallow bed: two layers of cell
// borders, bent by noise so they curve, brightest where they cross and
// stronger in drifting patches.
fn wCaustic(p: vec2f, t: f32) -> f32 {
    let warp = vec2f(wNoiseD(p * 0.7 + vec2f(t * 0.1)).x, wNoiseD(p * 0.7 + vec2f(4.3, 1.9) - vec2f(t * 0.1)).x) - 0.5;
    let q = p + warp * 0.9;
    let a = 1.0 - smoothstep(0.0, 0.22, wCells(q, t));
    let b = 1.0 - smoothstep(0.0, 0.22, wCells(q * 1.37 + vec2f(3.1, 7.7), t * 1.3));
    let patches = smoothstep(0.2, 0.8, wNoiseD(p * 0.23 + vec2f(t * 0.03)).x);
    return (a * a * 0.4 + a * b) * (0.4 + 0.6 * patches);
}

fn frag() {
    useShadow();
    let t = getTime() * materialUniform.waveFlow;
    let wp = ORI_VertexVarying.vWorldPos.xyz;
    let cam = globalUniform.CameraPos.xyz;
    let toCam = cam - wp;
    let dist = max(length(toCam), 1e-4);
    let v = toCam / dist;

    // ---- the surface: ripples, their normal and the roughness they leave
    let s = materialUniform.waveScale;
    let q = wp.xz * s;
    let px = max(length(dpdx(q)), length(dpdy(q)));
    let wave = wWaves(q, t, px);
    let relief = materialUniform.waveRelief;
    let slope = wave.slope * s * relief;
    let n = normalize(vec3f(-slope.x, 1.0, -slope.y));
    let rough = clamp(sqrt(0.035 * 0.035 + wave.lost * relief * relief * s * s * 0.5), 0.035, 0.6);
    let crest = smoothstep(0.62, 0.9, wave.h / max(wave.norm, 1e-4));
    let nv = max(dot(n, v), 0.0);
    let F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);

    // ---- light: the first light if it is the sun, and the sky
    let sun = lightBuffer[0];
    var L = vec3f(0.0, 1.0, 0.0);
    var sunRad = vec3f(0.0);
    var shadow = 1.0;
    if (sun.lightType == DirectLightType) {
        L = normalize(-sun.direction);
        sunRad = getHDRColor(sun.lightColor.rgb, sun.linear) * max(sun.intensity, 0.0);
        shadow = select(1.0, directShadowVisibility[max(sun.castShadow, 0)], sun.castShadow >= 0);
    }
    let skyLods = f32(textureNumLevels(prefilterMap)) - 1.0;
    let r = reflect(-v, n);
    // Rays the ripples turn downward would see the ground; show them the low sky instead.
    let sky = textureSampleLevel(prefilterMap, prefilterMapSampler, vec3f(r.x, abs(r.y), r.z), rough * skyLods).rgb * globalUniform.skyExposure;
    let ambient = textureSampleLevel(prefilterMap, prefilterMapSampler, vec3f(0.0, 1.0, 0.0), skyLods * 0.8).rgb * globalUniform.skyExposure;

    // ---- what lies under the water here
    let uv0 = screenUV();
    let zw = max(surfaceDepth(), 1e-4);
    let zs0 = sceneDepth(uv0);
    // The point of the scene under this pixel (same view ray) and how deep it lies.
    let behind = cam - toCam * (zs0 / zw);
    let vdepth = max(wp.y - behind.y, 0.0);
    let path0 = max(zs0 / zw - 1.0, 0.0) * dist;

    // Refraction: shifted by the ripples, less where it is shallow (the shore
    // line stays put) and far away (the same shift on screen is more there).
    var uv = uv0 + n.xz * materialUniform.distortion * clamp(path0 * 0.5, 0.0, 1.0) * min(1.0, 10.0 / zw);
    var zs = sceneDepth(uv);
    // The shifted pixel shows something in front of the water: use the straight one.
    if (zs < zw) {
        uv = uv0;
        zs = zs0;
    }
    // Meters the view ray travels under the water.
    let path = max(zs / zw - 1.0, 0.0) * dist;

    // ---- absorption and scattering in the water (Beer-Lambert)
    let sigmaA = materialUniform.absorption.rgb / materialUniform.clarity;
    let sigmaS = materialUniform.scattering.rgb / materialUniform.clarity;
    let sigmaT = max(sigmaA + sigmaS, vec3f(1e-5));
    let T = exp(-sigmaT * path);
    let albedo = sigmaS / sigmaT;
    let inLight = ambient * 0.5 + sunRad * wPhase(dot(v, -L), 0.5) * shadow;
    let inscatter = albedo * (1.0 - T) * inLight;

    // Caustics on the bed: none at the waterline, fading as it gets deep.
    // (Not on the low graphics tier, nor where they would not show.)
    let causticFade = (1.0 - exp(-vdepth * 4.0)) * exp(-vdepth * 0.35);
    var caustic = 0.0;
    if (qualityTier() > 0 && causticFade * materialUniform.caustics * shadow > 0.002) {
        caustic = wCaustic(behind.xz * 1.2, t) * materialUniform.caustics * causticFade * shadow;
    }
    // Deep or murky water blurs what is under it.
    let blur = clamp(path * dot(sigmaS, vec3f(0.333)) * 30.0, 0.0, 4.0);
    let under = sceneBehind(uv, blur) * (1.0 + caustic * 2.0);
    let transmitted = under * T + inscatter;

    // ---- reflection: the mirrored scene where there is a Mirror, else the sky
    let mirror = mirrorColor(n.xz * materialUniform.distortion);
    let reflection = mix(sky, mirror.rgb, mirror.a) * materialUniform.reflectivity;

    // Sunlight through the thin top of a wave lit from behind.
    let back = pow(clamp(dot(v, -normalize(L + n * 0.4)), 0.0, 1.0), 4.0);
    let sss = exp(-sigmaA * 2.0) * sunRad * back * crest * materialUniform.crestGlow * shadow * 0.15;

    var color = mix(transmitted, reflection, F) + sss;
    color += sunRad * wSunSpec(n, v, L, rough) * materialUniform.sunGlint * shadow;

    // ---- foam along the shore and around anything standing in the water
    let fw = max(materialUniform.foamWidth, 1e-3);
    let edge = 1.0 - smoothstep(0.0, fw, vdepth);
    // A thin unbroken line where the water touches, then lace in bands that run in with the waves.
    let line = smoothstep(0.8, 0.97, edge);
    let bands = 0.5 + 0.5 * sin(vdepth / fw * 9.0 - t * 2.2 + wave.h * 6.0);
    let breakup = wNoiseD(wp.xz * 2.3 + vec2f(t * 0.21, -t * 0.17)).x * 0.65 + wNoiseD(wp.xz * 6.1 - vec2f(t * 0.3, t * 0.1)).x * 0.35;
    let lace = edge * edge * bands * smoothstep(0.45, 0.75, breakup);
    let foam = clamp(line * 0.9 + lace, 0.0, 1.0);
    let foamLit = materialUniform.foamColor.rgb * (ambient + sunRad * max(dot(n, L), 0.0) * shadow / W_PI);
    color = mix(color, foamLit, foam);

    // BxDFShading writes the G-buffer that fog, SSR and AO read; the color is this one.
    // With a Mirror the reflection is complete: the G-buffer says rough so SSR
    // leaves it alone; without one SSR (when on) adds what is on screen.
    ORI_ShadingInput.BaseColor = vec4f(mix(albedo * 0.2, materialUniform.foamColor.rgb, foam), 1.0);
    ORI_ShadingInput.Roughness = mix(rough, 1.0, clamp(mirror.a, 0.0, 1.0));
    ORI_ShadingInput.Metallic = 0.0;
    ORI_ShadingInput.Specular = 0.0;
    ORI_ShadingInput.AmbientOcclusion = 1.0;
    ORI_ShadingInput.EmissiveColor = vec4f(0.0, 0.0, 0.0, 1.0);
    ORI_ShadingInput.Normal = n;
    BxDFShading();
    ORI_FragmentOutput.color = vec4f(max(color, vec3f(0.0)), 1.0);
}
`,
    },
    {
        id: 'vignette',
        label: 'Vignette',
        description: 'Darkens the screen edges (post effect).',
        kind: 'post',
        lighting: 'unlit',
        code: `// Post shader: return the new color for screen position uv (0..1).
// sceneColor(uv) reads the image produced by the passes before this one.
// @property strength float 0.6 0 2
// @property radius float 0.75 0.1 1.5
// @property tint color #000000

fn post(uv: vec2f) -> vec4f {
    let c = sceneColor(uv);
    let d = distance(uv, vec2f(0.5));
    let v = smoothstep(materialUniform.radius, materialUniform.radius - 0.45, d);
    let k = mix(1.0, v, materialUniform.strength);
    return vec4f(mix(materialUniform.tint.rgb, c.rgb, clamp(k, 0.0, 1.0)), c.a);
}
`,
    },
    {
        id: 'grade',
        label: 'Color Grade',
        description: 'Saturation, contrast and tint (post effect).',
        kind: 'post',
        lighting: 'unlit',
        code: `// Post shader: simple color grading on the HDR image (before tone mapping).
// @property saturation float 1.2 0 3
// @property contrast float 1.1 0 3
// @property tint color #ffffff

fn post(uv: vec2f) -> vec4f {
    let c = sceneColor(uv);
    let luma = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
    var rgb = mix(vec3f(luma), c.rgb, materialUniform.saturation);
    rgb = (rgb - vec3f(0.18)) * materialUniform.contrast + vec3f(0.18);
    return vec4f(max(rgb, vec3f(0.0)) * materialUniform.tint.rgb, c.a);
}
`,
    },
    {
        id: 'lgg',
        label: 'Lift Gamma Gain',
        description: 'Lift, gamma, gain and saturation: the usual first color grade (post effect).',
        kind: 'post',
        lighting: 'unlit',
        code: LGG_CODE,
    },
    {
        id: 'chromatic',
        label: 'Chromatic Aberration',
        description: 'Splits color channels toward the edges (post effect).',
        kind: 'post',
        lighting: 'unlit',
        code: `// Post shader: offsets the red and blue channels away from the center.
// @property amount float 0.004 0 0.03

fn post(uv: vec2f) -> vec4f {
    let dir = uv - vec2f(0.5);
    let o = dir * materialUniform.amount * 4.0;
    let r = sceneColor(uv + o).r;
    let g = sceneColor(uv).g;
    let b = sceneColor(uv - o).b;
    return vec4f(r, g, b, 1.0);
}
`,
    },
];

/** Turns "my cool script" into "MyCoolScript". */
export function className(name: string): string {
    const base = name.replace(/\.[a-z0-9]+$/i, '');
    const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
    let out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    if (!out || /^[0-9]/.test(out)) out = 'Script' + out;
    return out;
}

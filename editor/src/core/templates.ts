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
        description: 'Waves, a fresnel reflection of the sky and, with a Mirror component on the object, of the scene, the sun\'s glint, and over a terrain shallow water and foam along the shore.',
        kind: 'material',
        lighting: 'lit',
        code: `// Water for a flat surface (a plane). mirrorColor(offset) is the scene a
// Mirror component on the object reflects, moved by offset (screen units);
// its alpha is 0 without one, and the sky is reflected instead.
// terrainDepth() is how far below the water the terrain lies here (very
// deep without one): the water is lighter where it is shallow, and foam
// runs along the shore.
// @property deepColor color #0b2a36
// @property shallowColor color #1f5e66
// @property waveScale float 1 0.05 5
// @property waveSpeed float 1 0 5
// @property waveHeight float 0.15 0 1
// @property distortion float 0.03 0 0.2
// @property reflectivity float 1 0 1
// @property depthScale float 3 0.1 50
// @property foamColor color #e4eeec
// @property foamWidth float 0.8 0 5

// Slopes of three waves across the surface.
fn waveSlope(p: vec2f, t: f32) -> vec2f {
    let k = materialUniform.waveScale;
    var s = vec2f(0.8, 0.6) * cos(dot(p, vec2f(0.8, 0.6)) * 1.1 * k + t * 1.2);
    s += vec2f(-0.5, 0.87) * cos(dot(p, vec2f(-0.5, 0.87)) * 2.3 * k - t * 1.7) * 0.5;
    s += vec2f(0.28, -0.96) * cos(dot(p, vec2f(0.28, -0.96)) * 4.9 * k + t * 2.3) * 0.25;
    return s * materialUniform.waveHeight;
}

fn frag() {
    let p = ORI_VertexVarying.vWorldPos.xyz;
    // Waves calm with distance: far away they are finer than a pixel and would flicker in stripes.
    let slope = waveSlope(p.xz, getTime() * materialUniform.waveSpeed) / (1.0 + distance(globalUniform.CameraPos.xyz, p) * 0.03);
    let n = normalize(vec3f(-slope.x, 1.0, -slope.y));
    let v = normalize(globalUniform.CameraPos.xyz - p);
    let nv = max(dot(n, v), 0.0);
    let fresnel = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
    let r = reflect(-v, n);

    // The mirrored scene where there is one, else the sky.
    let mirror = mirrorColor(n.xz * materialUniform.distortion);
    let sky = textureSampleLevel(prefilterMap, prefilterMapSampler, r, 0.0).rgb * globalUniform.skyExposure;
    let sun = lightBuffer[0];

    // Shallow over the ground near the shore, deep away from it (and without a terrain).
    let depth = max(terrainDepth(), 0.0);
    let deep = 1.0 - exp(-depth / materialUniform.depthScale);
    let body = mix(materialUniform.shallowColor.rgb, mix(materialUniform.deepColor.rgb, materialUniform.shallowColor.rgb, sqrt(nv)), deep);
    // Foam where the water meets the shore, in bands that run in with the waves.
    let edge = 1.0 - smoothstep(0.0, max(materialUniform.foamWidth, 0.001), depth);
    let bands = 0.5 + 0.5 * sin(depth * 9.0 - getTime() * 2.0 * materialUniform.waveSpeed + (slope.x + slope.y) * 6.0);
    let foam = clamp(edge * (0.55 + 0.45 * bands), 0.0, 1.0);
    let reflection = mix(sky, mirror.rgb, mirror.a) * materialUniform.reflectivity * (1.0 - foam);
    let glint = pow(max(dot(r, -normalize(sun.direction)), 0.0), 600.0) * sun.lightColor.rgb * sun.intensity * 8.0 * (1.0 - foam);

    ORI_ShadingInput.BaseColor = vec4f(mix(body * (1.0 - fresnel), materialUniform.foamColor.rgb, foam), 1.0);
    // Rough, so the lighting adds no reflection of its own over this one.
    ORI_ShadingInput.Roughness = 1.0;
    ORI_ShadingInput.Metallic = 0.0;
    ORI_ShadingInput.Specular = 0.0;
    ORI_ShadingInput.AmbientOcclusion = 1.0;
    ORI_ShadingInput.Normal = n;
    useShadow();
    // Emission is read as gamma-encoded color: encode the linear light.
    let light = reflection * fresnel + glint * directShadowVisibility[0];
    ORI_ShadingInput.EmissiveColor = vec4f(pow(max(light, vec3f(0.0)), vec3f(1.0 / 2.4)), 1.0);
    BxDFShading();
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

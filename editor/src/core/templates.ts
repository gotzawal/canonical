// Starting points for new scripts and shaders. They double as documentation
// of the script API (play/script.ts) and of the shader conventions
// (engine/shaders.ts), so keep them short and correct.

import type { ShaderDoc } from './types';

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
        label: 'Player Controller',
        description: 'WASD / arrow keys movement, Space to jump.',
        code: (name) => `// Click the viewport in Play mode, then use WASD / arrows to move and Space to jump.
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
export const TRIPLANAR_MARKER = '@canonical triplanar';

export const TRIPLANAR_CODE = `// World space triplanar surface (${TRIPLANAR_MARKER}): the albedo texture is
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

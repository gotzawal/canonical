import { h } from './dom';
import { dialog } from './overlays';

// Help > Scripting & Shader Reference. Keep it in step with play/script.ts,
// play/input.ts and engine/shaders.ts (ai/prompt.ts documents the same API
// for the assistant).

const SCRIPT_EXAMPLE = `export default class Spinner extends Script {
    speed = 90;          // number field in the Inspector
    tint = '#ff8800';    // "#rrggbb" strings are color fields

    start() {
        this.setColor(this.tint);
    }

    update(dt) {
        this.object3D.rotationY += this.speed * dt;
    }
}`;

const LIFECYCLE: [string, string][] = [
    ['awake() / start()', 'Once when Play starts. Every awake() runs before the first start().'],
    ['update(dt) / lateUpdate(dt)', 'Every frame. dt is the frame time in seconds.'],
    ['onDestroy()', 'When the object is destroyed, and when Play stops.'],
    ['onKeyDown(key) / onKeyUp(key)', 'Key names in lower case: "w", "space", "arrowup", "shift".'],
    ['onPointerDown(e) / onPointerUp(e) / onClick(e)', 'This object was clicked in Play mode. e has x, y, button and point [x, y, z].'],
];

const MEMBERS: [string, string][] = [
    ['this.object3D', 'The engine object: x, y, z, rotationX / Y / Z (degrees), scaleX / Y / Z, name, transform.'],
    ['this.time', 'delta, elapsed (seconds) and frame.'],
    ['this.input', "key(k), keyDown(k), keyUp(k), axis('horizontal' | 'vertical') from WASD and arrows, mouse { x, y, dx, dy, wheel }, mouseButton(b), mouseDown(b), mouseUp(b)."],
    ['this.find(name) / this.findAll(name)', 'Objects by name.'],
    ['this.getScript(objOrName, scriptName?)', 'A script instance on another object.'],
    ['this.spawn(shape, options?)', "Creates 'box', 'sphere', 'plane', 'cylinder' or 'torus'. Options: position, rotation, scale, color, parent, name. Spawned objects are removed when Play stops; this.spawned lists them."],
    ['this.destroy(obj?, seconds?)', 'Removes an object (this one by default), optionally after a delay.'],
    ['this.setColor(hex, obj?) / this.setEmissive(hex, intensity, obj?)', 'Changes the material of this or another object.'],
    ['this.lookAt(objOrPoint)', 'Turns the object toward another object or a point.'],
    ['this.after(seconds, fn) / this.every(seconds, fn)', 'Timers. Both return a function that cancels them.'],
    ['this.log / warn / error(...args)', 'Writes to the console. Click a message location to jump to the line.'],
    ['this.camera, this.scene, this.engine, this.core', "Engine access. You can also import { Vector3 } from '@orillusion/core'."],
];

const PROPERTIES: [string, string][] = [
    ['// @property speed float 1 0 10', 'f32 with a default and an optional min and max (shown as a slider).'],
    ['// @property tint color #ff8800', 'vec4<f32>, edited with a color picker.'],
    ['// @property offset vec4 0 0 1 1', 'vec4<f32>.'],
    ['// @property pattern texture white', 'A texture and sampler named pattern and patternSampler: white, black, gray, normal or a texture asset.'],
];

const MATERIAL: [string, string][] = [
    ['fn frag()', 'Required. Reads ORI_VertexVarying.fragUV0, .vWorldPos, .vWorldNormal, globalUniform.CameraPos, baseMap / baseMapSampler and materialUniform.baseColor, roughness, metallic, emissiveColor, emissiveIntensity.'],
    ['Lit', 'Set ORI_ShadingInput.BaseColor, Roughness, Metallic, Specular, AmbientOcclusion, EmissiveColor and Normal, then call useShadow(); BxDFShading();'],
    ['Unlit', 'Set ORI_ShadingInput.BaseColor, then call UnLit();'],
    ['fn vert(inputData: VertexAttributes) -> VertexOutput', 'Optional. Change a copy of the input, then ORI_Vert(v); return ORI_VertexOut;'],
];

const POST: [string, string][] = [
    ['fn post(uv: vec2f) -> vec4f', 'Required. Returns the color for screen position uv (0..1). Runs on the HDR image, before anti-aliasing and tone mapping.'],
    ['sceneColor(uv), screenSize(), getTime()', 'The image so far, the size in pixels, and the time in seconds.'],
];

function table(rows: [string, string][]): HTMLElement {
    return h(
        'table',
        { class: 'reference-table' },
        rows.map(([k, v]) => h('tr', null, h('td', null, h('code', { text: k })), h('td', { text: v }))),
    );
}

export function showReference() {
    const body = h(
        'div',
        { class: 'reference' },
        h('h3', { text: 'Scripts' }),
        h('p', {
            text: 'A script is a JavaScript class that extends Script. Create one with + in Assets or with Add Component > Script in the Inspector, attach it by dragging it onto an object, and press Play. Public fields show up in the Inspector. Everything scripts change is undone when Play stops.',
        }),
        h('pre', { class: 'reference-code', text: SCRIPT_EXAMPLE }),
        h('h4', { text: 'Lifecycle (all optional)' }),
        table(LIFECYCLE),
        h('h4', { text: 'Members' }),
        table(MEMBERS),
        h('h3', { text: 'Shaders (WGSL)' }),
        h('p', {
            text: 'Material shaders render meshes: set a material to Custom Shader in the Inspector, or drag the shader onto a mesh. Post shaders run on the whole screen: drag them onto the viewport or use Add Post Effect in the Render Graph panel. Read property values as materialUniform.<name>; getTime() returns seconds.',
        }),
        h('h4', { text: 'Properties' }),
        table(PROPERTIES),
        h('h4', { text: 'Material shaders' }),
        table(MATERIAL),
        h('h4', { text: 'Post shaders' }),
        table(POST),
        h('h3', { text: 'Safety' }),
        h('p', {
            text: 'Scripts run JavaScript in this page. When you open a scene file, its scripts stay paused until you choose Enable Scripts, so read them first if the file is not yours.',
        }),
    );
    void dialog('Scripting & Shader Reference', body);
}

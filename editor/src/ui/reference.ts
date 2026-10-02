import { h, shortcutLabel } from './dom';
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
    ['onTaskAbort(task)', 'A behavior tree aborted a script task of this script (task.signal fired too).'],
    ['onCollisionEnter(other) / onCollisionExit(other)', 'This object\'s body (or level mesh) started or stopped touching another object.'],
    ['onTriggerEnter(other) / onTriggerExit(other)', 'Something entered or left a trigger: a body with Trigger on, this one or the other.'],
];

const MEMBERS: [string, string][] = [
    ['this.object3D', 'The engine object: x, y, z, rotationX / Y / Z (degrees), scaleX / Y / Z, name, transform.'],
    ['this.time', 'delta, elapsed (seconds) and frame.'],
    ['this.input', "key(k), keyDown(k), keyUp(k), axis('horizontal' | 'vertical') from WASD, the arrows and the on-screen joystick, stick { x, y, active }, mouse { x, y, dx, dy, wheel }, mouseButton(b), mouseDown(b), mouseUp(b). On touch screens the jump button presses \"space\" and a tap is a click."],
    ['this.character / this.getCharacter(objOrName)', "The object's character (null without one): move(x, z) this frame, moveTo(objOrPoint, { radius, run }) resolving true on arrival, jump(), stop(), run and face; its state velocity, speed, grounded, facing and mode ('idle', 'walk', 'run', 'jump', 'fall') and on('jump' | 'land' | 'mode', fn) to animate it by."],
    ['this.animator / this.getAnimator(objOrName)', 'The skeletal animation of the object\'s model (null without clips): clips, clip (playing now), speed, and play(clip, fade?) crossfading over fade seconds. A character\'s model changes clip with its mode by itself.'],
    ['this.body / this.getBody(objOrName)', 'The physics body (null without one): velocity and angularVelocity (degrees per second) to read or set, applyImpulse([x, y, z]), applyTorqueImpulse([x, y, z]), teleport(position, rotation?), type, mass, sleeping, wakeUp().'],
    ['this.audio / this.getAudio(objOrName)', 'The Audio component (null without one): play(), pause(), stop(), and playing, time, duration, volume (0..2), pitch (playback rate) and loop.'],
    ['this.playSound(name, options?)', "Plays a sound asset once ('coin' or 'coin.ogg'). Options: volume, pitch, loop, at (an object it follows, or [x, y, z]) for a sound heard from there, near and far (meters). Returns { stop(), done } or null when there is no such sound. Agents with hearing notice sounds played at a place."],
    ['this.nav', 'The navigation mesh in Play (null until it is ready, and in scenes without walking NPCs or scripts that use it): path(from, to) returns the corners of the way around walls, randomPoint(center, radius) a reachable point, closest(point, within?) the nearest point on it. Points are [x, y, z] or objects. this.character.moveTo follows such paths by itself ({ straight: true } walks straight).'],
    ['this.noise(range, at?)', 'Tells agents with hearing that this object made a sound carrying range meters (at its place, or at at), without playing one: footsteps, a door.'],
    ['this.physics', 'The physics world (null when the scene has none): gravity [x, y, z] and raycast(origin, direction, maxDistance?, ignoreObject?) returning { object, point, normal, distance } or null.'],
    ['this.find(name) / this.findAll(name)', 'Objects by name.'],
    ['this.getScript(objOrName, scriptName?)', 'A script instance on another object.'],
    ['this.spawn(shape, options?)', "Creates 'box', 'sphere', 'plane', 'cylinder', 'cone', 'torus', 'ramp', 'stairs' or 'capsule'. Options: position, rotation, scale, color, parent, name, body (true or body settings for a dynamic body). Spawned objects are removed when Play stops; this.spawned lists them."],
    ['this.destroy(obj?, seconds?)', 'Removes an object (this one by default), optionally after a delay.'],
    ['this.setColor(hex, obj?) / this.setEmissive(hex, intensity, obj?)', 'Changes the material of this or another object.'],
    ['this.lookAt(objOrPoint)', 'Turns the object toward another object or a point.'],
    ['this.after(seconds, fn) / this.every(seconds, fn)', 'Timers. Both return a function that cancels them.'],
    ['this.log / warn / error(...args)', 'Writes to the console. Click a message location to jump to the line.'],
    ['this.blackboard / this.getBlackboard(objOrName)', 'The blackboard of this object\'s behavior tree (null without an agent) or another agent\'s: get(key), set(key, value) for fact keys, version(key), answer(key). See Help > Behavior Tree Reference.'],
    ['this.say(text, options?)', 'Speaks a line one sentence at a time and resolves when it was spoken. Options: voice, lang, rate, pitch, volume, signal.'],
    ['this.chat(prompt, options?)', 'Asks an OpenRouter model with the assistant\'s key (in the editor only) and resolves with the text.'],
    ['this.remember(text, tags?) / this.memory(id)', 'Adds a memory that Recall and memory choices can find, or reads one.'],
    ['this.saveMemories() / this.loadMemories(saved)', 'The memories remembered while playing as JSON for a game save, and back.'],
    ['this.setPlayer(obj?)', 'Agents nearest to this object get their questions answered first (the camera until a script sets one).'],
    ['this.camera, this.scene, this.engine, this.core', "Engine access. You can also import { Vector3 } from '@orillusion/core'."],
];

const PROPERTIES: [string, string][] = [
    ['// @property speed float 1 0 10', 'f32 with a default and an optional min and max (shown as a slider).'],
    ['// @property tint color #ff8800', 'vec4<f32>, edited with a color picker.'],
    ['// @property offset vec4 0 0 1 1', 'vec4<f32>.'],
    ['// @property pattern texture white', 'A texture and sampler named pattern and patternSampler: white, black, gray, normal or a texture asset.'],
];

const MATERIAL: [string, string][] = [
    ['fn frag()', 'Required. Reads ORI_VertexVarying.fragUV0, .vWorldPos, .vWorldNormal, globalUniform.CameraPos, baseMap / baseMapSampler and materialUniform.baseColor, roughness, metallic, emissiveColor, emissiveIntensity, alphaCutoff.'],
    ['Lit', 'Set ORI_ShadingInput.BaseColor, Roughness, Metallic, Specular, AmbientOcclusion, EmissiveColor and Normal, then call useShadow(); BxDFShading();'],
    ['Unlit', 'Set ORI_ShadingInput.BaseColor, then call UnLit();'],
    ['fn vert(inputData: VertexAttributes) -> VertexOutput', 'Optional. Change a copy of the input, then ORI_Vert(v); return ORI_VertexOut;'],
    ['Imported models', 'On a material slot of an imported model, baseMap is the model\'s color texture, and texture properties named normalMap, maskMap (roughness in G, metallic in B), emissiveMap and aoMap receive the model\'s own maps: // @property normalMap texture normal'],
    ['mirrorColor(offset), mirrorUV()', 'On an object with a Mirror component: the scene it reflects at this pixel, moved by offset (screen units, e.g. by waves), with alpha 0 without a mirror; mirrorUV() is the undistorted screen position. The Water template uses them.'],
    ['terrainHeight(p), terrainDepth()', 'The height of the terrain under the world point p (the largest terrain shown), -1e9 where there is none; terrainDepth() is how far below this pixel it lies.'],
    ['qualityTier()', 'The graphics tier drawn: 0 low, 1 medium, 2 high. Do less on weaker devices: if (qualityTier() > 0) { ... }. The Water template drops its caustics and finest ripples on low.'],
    ['screenUV(), sceneBehind(uv, lod), sceneDepth(uv), surfaceDepth()', 'What lies behind this surface: screenUV() is this pixel on the screen (0..1 from the top left), sceneBehind(uv, lod) the color of the opaque scene and sky there (lod blurs: each step halves the resolution), sceneDepth(uv) how far in front of the camera it is (meters, the far plane where nothing is) and surfaceDepth() the same for this pixel, so sceneDepth(screenUV()) - surfaceDepth() is how far the view ray goes behind it. A shader using them draws after the rest of the opaque scene and does not see itself or other such surfaces. The Water template uses them for depth color, refraction, caustics and foam.'],
];

const MATERIAL_TYPES: [string, string][] = [
    ['Lit (PBR)', 'The engine\'s physically based material: color, metallic, roughness, emission; normal, metallic-roughness, occlusion and emission maps; clear coat; transmission with IOR, thickness and tint for glass and water. The menu next to the Material title has presets.'],
    ['Unlit', 'Color and texture as they are, ignoring lights.'],
    ['Lambert (Matte)', 'Cheap diffuse shading from directional lights; no specular and no shadows on it.'],
    ['Custom Shader', 'A WGSL material shader (see below).'],
    ['Alpha', 'Auto blends when opacity is below 1, Mask cuts out pixels whose alpha is below the cutoff (leaves, fences), Additive and Multiply are transparent blending modes (glow and fire, stains and tinted glass).'],
    ['Maps left empty', 'A map that is not set leaves the material\'s values as they are: roughness and metallic apply as set, the normals stay flat, and there is no occlusion or emission map.'],
    ['Imported models', 'Each material slot can keep the file\'s material (Model), switch to Unlit or Lambert, or use a custom shader. What a slot does not set keeps the file\'s value, alpha mode and texture tiling included.'],
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
        h('h3', { text: 'Characters and the player' }),
        h('p', {
            text: 'A character (Create > Character, or Add Component > Character) walks the level in Play: it stands on the scene\'s meshes, climbs steps up to its step height, falls, and walls and other characters stop it. Like a pawn in Unreal it moves as its controller says. Create > Player (or Add Component > Player Controller) makes one the player: WASD or the arrow keys walk, Shift runs, Space jumps, and a mouse drag or Q / E turns the camera while the wheel zooms. On phones and tablets a joystick appears under the left thumb, a button jumps, and a finger dragged over the rest of the view turns the camera (two fingers zoom). Its view follows behind (Third Person), looks from its eyes (First Person) or keeps the scene\'s camera node. An NPC is a character with a behavior tree: its Move To task walks it to an object, and scripts drive it with this.character, whose state (speed, mode, jump and land events) is there to animate it by.',
        }),
        h('h3', { text: 'Materials' }),
        table(MATERIAL_TYPES),
        h('h3', { text: 'Global illumination' }),
        h('p', {
            text: 'Scene > Global Illumination turns on DDGI: a grid of light probes captures the scene and lit materials receive the light it bounces, so a red wall tints the floor next to it and shadows get indirect light. Fit to Scene sizes the grid to your meshes; surfaces more than one probe spacing outside the grid get no indirect light. Probes are captured again after every change, or every frame with Realtime. It works in Play mode and in builds.',
        }),
        h('h3', { text: 'Build & Deploy' }),
        h('p', {
            text: `File > Build & Deploy (${shortcutLabel('Mod+B')}) makes a standalone web game of the scene: Run in New Tab plays it without the editor, Download .zip gives a folder for any static host (it must be served over HTTP), and GitHub Pages publishes it with a personal access token. Games play like Play mode: through the player's camera, else the main camera or, without one, from the editor view at build time. The player's controls work on phones too.`,
        }),
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

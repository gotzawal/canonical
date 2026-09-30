// The components of scene objects and the scene settings, written once. The
// document types (core/types.ts re-exports them), their defaults, the repair
// of documents from files, the assistant's tool arguments and the
// inspector's fields all come from these schemas (see core/schema.ts).
// Adding a setting is one line here, plus what the engine does with it.

import { z } from 'zod';
import { clampGIGrid } from './giLimits';
import { asset, bool, color, group, int, num, oneOf, optionalFields, params, range, records, text, vec2, vec3 } from './schema';

const enabled = (m = {}) => bool(false, { title: 'Enabled', ...m });
/** Values of script fields and shader properties, by name. */
export const Params = params();

const unit = (d: number, m = {}) => num(d, 0, 1, { step: 0.01, slider: true, ...m });
const angle = (d: number, min: number, max: number, m = {}) => num(d, min, max, { step: 1, precision: 0, slider: true, ...m });

// ----------------------------------------------------------------- geometry

/**
 * Primitive shapes. Every shape is centered on its origin like the box. The
 * ramp and the stairs rise toward -Z (the first step is at +Z); the
 * capsule's height includes its round caps. The cone stands on its base; up
 * to 8 segments its sides are flat (4: a square pyramid).
 */
const shape = <T extends string, S extends z.ZodRawShape>(type: T, fields: S) => z.object({ type: z.literal(type), ...fields });
export const Geometry = z
    .discriminatedUnion('type', [
        shape('box', { width: num(1), height: num(1), depth: num(1) }),
        shape('sphere', { radius: num(0.5), segments: num(32) }),
        shape('plane', { width: num(10), height: num(10) }),
        shape('cylinder', { radiusTop: num(0.5), radiusBottom: num(0.5), height: num(1), segments: num(32) }),
        shape('cone', { radius: num(0.5), height: num(1), segments: num(32) }),
        shape('torus', { radius: num(0.5), tube: num(0.18), segments: num(32) }),
        shape('ramp', { width: num(2), height: num(1), depth: num(3) }),
        shape('stairs', { width: num(1.5), height: num(1.5), depth: num(3), steps: num(8) }),
        shape('capsule', { radius: num(0.35), height: num(1.8), segments: num(24) }),
    ])
    .catch(() => ({ type: 'box' as const, width: 1, height: 1, depth: 1 }));
export type GeometryDoc = z.output<typeof Geometry>;
export type GeometryType = GeometryDoc['type'];
export const GEOMETRY_TYPES: GeometryType[] = ['box', 'sphere', 'plane', 'cylinder', 'cone', 'torus', 'ramp', 'stairs', 'capsule'];

// ----------------------------------------------------------------- material

export const MATERIAL_TYPES = ['lit', 'unlit', 'lambert', 'shader'] as const;
export const ALPHA_MODES = ['auto', 'opaque', 'blend', 'mask', 'additive', 'multiply'] as const;

/**
 * Surface materials. 'lit' is the engine's PBR material (LitMaterial),
 * 'unlit' ignores lights (UnLitMaterial), 'lambert' is a cheap matte
 * material lit by directional lights (LambertMaterial) and 'shader' renders
 * with a custom WGSL material shader. The optional fields mean their
 * default when missing.
 */
export const Material = z.object({
    type: oneOf(MATERIAL_TYPES, 'lit', { description: 'lit = PBR (LitMaterial), unlit = ignores lights, lambert = cheap matte (directional lights only), shader = custom WGSL shader.' }),
    color: color('#c8c8c8', { description: 'Base color.' }),
    opacity: unit(1),
    metallic: unit(0),
    roughness: unit(0.6),
    emissive: color('#000000'),
    emissiveIntensity: num(1, 0, Infinity, { title: 'Emission', description: 'Emissive intensity: the emissive color times this makes the glow.' }),
    doubleSide: bool(false, { title: 'Double Sided' }),
    map: asset({ description: 'Texture asset id for the base color, or null.' }),
    /** Shader asset id, used when `type` is 'shader'. */
    shader: asset({ description: 'Material shader asset, used when type is shader.' }).optional(),
    /** Values of the custom shader's declared properties, by property name. */
    params: params({ description: 'Values of the shader\'s @property declarations.' }).optional(),
    alphaMode: oneOf(ALPHA_MODES, 'auto', {
        title: 'Alpha',
        labels: { auto: 'Auto', opaque: 'Opaque', mask: 'Mask (cut-out)', blend: 'Blend (transparent)', additive: 'Additive', multiply: 'Multiply' },
        description: 'auto blends when opacity < 1 (on a model slot it keeps the file\'s mode); mask cuts out pixels below alpha_cutoff (foliage, fences); additive (glow, fire) and multiply (stains, tinted glass) are transparent blending modes.',
    }).optional(),
    alphaCutoff: unit(0.5, { title: 'Cutoff', description: 'mask mode: alpha below this is cut out.' }).optional(),
    tiling: vec2([1, 1], { step: 0.01, precision: 3, description: 'Texture repeat [u, v] for every map.' }).optional(),
    offset: vec2([0, 0], { step: 0.005, precision: 3, description: 'Texture offset [u, v] for every map.' }).optional(),
    normalMap: asset({ description: 'Lit only: tangent space normal map (texture asset id).' }).optional(),
    normalScale: num(1, 0, Infinity, { title: 'Strength', description: 'Lit only: strength of the normal map.' }).optional(),
    metalRoughMap: asset({ description: 'Lit only: glTF metallic-roughness map (roughness in G, metallic in B).' }).optional(),
    aoMap: asset({ description: 'Lit only: ambient occlusion map (grayscale).' }).optional(),
    emissiveMap: asset({ description: 'Lit only: emission map, multiplied by the emissive color.' }).optional(),
    clearcoat: unit(0, { title: 'Coat', description: 'Lit only: glossy varnish layer (car paint, lacquer).' }).optional(),
    clearcoatRoughness: unit(0, { title: 'Coat Rough.', description: 'Roughness of the clear coat.' }).optional(),
    transmission: unit(0, { description: 'Lit only: light passes through the surface (glass, water).' }).optional(),
    ior: num(1.5, 1, 3, { title: 'IOR', step: 0.01, slider: true, description: 'Index of refraction for transmission (1.5 glass, 1.33 water).' }).optional(),
    thickness: num(0, 0, Infinity, { step: 0.01, precision: 3, description: 'Lit only: thickness of the volume behind a transmissive surface.' }).optional(),
    attenuationColor: color('#ffffff', { title: 'Tint', description: 'Lit only: color light turns into while it travels through the volume.' }).optional(),
    attenuationDistance: num(0, 0, Infinity, { title: 'Tint Distance', description: 'Lit only: distance at which light in the volume reaches the tint color; 0 means no tint.' }).optional(),
    /** Material slot (DesignDoc.materials): setting its swatch rewrites the material of every mesh in the slot. */
    slot: z.string().min(1).optional().catch(undefined),
});
export type MaterialDoc = z.output<typeof Material>;
export type MaterialType = MaterialDoc['type'];
export type AlphaMode = (typeof ALPHA_MODES)[number];

export const Mesh = z.object({ geometry: Geometry, material: Material, castShadow: bool(true), receiveShadow: bool(true) });
export type MeshDoc = z.output<typeof Mesh>;

// ------------------------------------------------------------------- models

/**
 * Shading model for a material slot of an imported model: 'model' keeps the
 * file's own PBR material, 'unlit' and 'lambert' replace it with the engine
 * material of that name (keeping the file's color texture).
 */
export const SLOT_SHADINGS = ['model', 'unlit', 'lambert'] as const;

/** Per-instance change to one material slot of an imported model: a missing field keeps the file's value. */
export const MaterialOverride = z.object({
    ...optionalFields(Material.shape, [
        'color', 'opacity', 'metallic', 'roughness', 'emissive', 'emissiveIntensity', 'doubleSide', 'map', 'shader', 'alphaMode', 'alphaCutoff', 'normalScale',
        'clearcoat', 'clearcoatRoughness', 'transmission', 'ior',
    ]),
    params: Material.shape.params,
    /** Built-in shading model replacing the file's material (a shader takes precedence); missing means 'model'. */
    shading: z.enum(SLOT_SHADINGS).optional().catch(undefined).meta({ description: 'Built-in shading; "model" is the file\'s material. Ignored while a shader is set.' }),
});
export type MaterialOverride = z.output<typeof MaterialOverride>;
export type SlotShading = (typeof SLOT_SHADINGS)[number];

/** Per-instance change to one mesh part of an imported model. */
export const PartOverride = z.object({
    visible: z.boolean().optional().catch(undefined),
    castShadow: z.boolean().optional().catch(undefined),
    receiveShadow: z.boolean().optional().catch(undefined),
    /** Material slot key to render this part with instead of its own. */
    material: z.string().optional().catch(undefined),
    /** Local transform of the part, replacing the one from the file. */
    position: vec3([0, 0, 0]).optional(),
    rotation: vec3([0, 0, 0]).optional(),
    scale: vec3([1, 1, 1]).optional(),
});
export type PartOverride = z.output<typeof PartOverride>;

export const Model = z.object({
    /** Model asset id (a .glb / .gltf blob stored in IndexedDB). */
    asset: z.string().catch(''),
    /** Material slot overrides keyed by slot key (see engine/modelParts.ts). */
    materials: records(MaterialOverride).optional(),
    /** Mesh part overrides keyed by part path (see engine/modelParts.ts). */
    parts: records(PartOverride).optional(),
});
export type ModelDoc = z.output<typeof Model>;

// -------------------------------------------------------------------- light

export const LIGHT_TYPES = ['directional', 'point', 'spot'] as const;
export const Light = z.object({
    type: oneOf(LIGHT_TYPES, 'point'),
    color: color('#ffffff'),
    intensity: num(4, 0, Infinity, { precision: 2 }),
    castShadow: bool(false, { title: 'Cast Shadows' }),
    /** Point / spot only. */
    range: num(10, 0.01, Infinity, { description: 'Point and spot lights: how far the light reaches.' }),
    /** Point / spot only. */
    radius: num(0.1, 0, Infinity, { step: 0.005, precision: 3, description: 'Point and spot lights: size of the light source.' }),
    /** Spot only: inner cone as a percentage of the outer cone. */
    innerAngle: angle(60, 0, 100, { title: 'Inner Cone %', description: 'Spot lights: inner cone as a percentage of the cone angle.' }),
    /** Spot only: full cone angle in degrees. */
    outerAngle: angle(60, 1, 179, { title: 'Cone Angle', description: 'Spot lights: full cone angle in degrees.' }),
});
export type LightDoc = z.output<typeof Light>;
export type LightType = LightDoc['type'];

// ------------------------------------------------------------------- camera

export const Camera = z.object({
    /** Play mode renders through the first camera marked main. */
    main: bool(true, { description: 'Play renders through the first main camera.' }),
    fov: angle(60, 1, 170, { title: 'Field of View', description: 'Vertical field of view in degrees.' }),
    near: num(0.1, 0.001, Infinity, { step: 0.01, precision: 3 }),
    far: num(1000, 0.01, Infinity, { step: 1, precision: 1 }),
});
export type CameraDoc = z.output<typeof Camera>;

// ---------------------------------------------------------------- particles

export const PARTICLE_SHAPES = ['box', 'circle', 'sphere', 'hemisphere'] as const;

/**
 * A particle emitter (fire, smoke, sparks, dust, rain), simulated on the GPU
 * by packages/particle. Ranges are [lowest, highest]; each particle takes a
 * random value in between.
 */
export const Particles = z
    .object({
        /** Preset it started from (for reference). */
        preset: z.string().max(40).optional().catch(undefined),
        rate: num(40, 0, 5000, { step: 0.5, precision: 1, description: 'Particles per second.' }),
        max: int(2000, 1, 50000, { description: 'Most particles alive at once.' }),
        life: range([1.5, 2.5], 0.01, 60, { title: 'Lifetime', description: 'Seconds a particle lives [lowest, highest].' }),
        size: range([0.15, 0.3], 0.001, 50, { precision: 3, step: 0.01, description: 'Size in meters at birth [lowest, highest].' }),
        sizeEnd: num(1, 0, 20, { title: 'Size at End', description: 'Size at the end of life as a factor of the birth size.' }),
        shape: oneOf(PARTICLE_SHAPES, 'circle', { description: 'Where particles start: on or in this shape around the object.' }),
        radius: num(0.3, 0, 100, { step: 0.01, description: 'Circle, sphere and hemisphere radius in meters.' }),
        box: vec3([1, 1, 1], { description: 'Box size in meters.' }),
        velocityMin: vec3([-0.2, 0.8, -0.2], { description: 'Start velocity m/s per axis in the object\'s space, lowest.' }),
        velocityMax: vec3([0.2, 1.4, 0.2], { description: 'Start velocity m/s per axis in the object\'s space, highest.' }),
        gravity: vec3([0, 0, 0], { description: 'Constant acceleration m/s^2, e.g. [0, -9.8, 0] falls, [0, 1, 0] rises.' }),
        spin: range([0, 360], -3600, 3600, { title: 'Rotation', step: 1, precision: 0, description: 'Start rotation of each sprite in degrees [lowest, highest].' }),
        colorStart: color('#ffffff'),
        colorEnd: color('#ffffff'),
        alphaStart: unit(1, { title: 'Opacity Start' }),
        alphaEnd: unit(0, { title: 'Opacity End' }),
        texture: asset({ description: 'Sprite texture asset id; null draws a soft round dot.' }),
        blend: oneOf(['add', 'alpha'], 'add', { labels: { add: 'Add (glow)', alpha: 'Alpha (cover)' }, description: 'add glows (fire, sparks, magic), alpha covers (smoke, dust, rain).' }),
        local: bool(false, { description: 'Particles move with the object, or stay where they were born.' }),
        prewarm: num(2, 0, 30, { step: 0.5, precision: 1, description: 'Seconds simulated before the first frame, so the effect is already running.' }),
    })
    .overwrite((p) => {
        p.box = p.box.map((v) => Math.min(500, Math.max(0, v))) as typeof p.box;
        for (let i = 0; i < 3; i++) {
            if (p.velocityMin[i] > p.velocityMax[i]) [p.velocityMin[i], p.velocityMax[i]] = [p.velocityMax[i], p.velocityMin[i]];
        }
        return p;
    });
export type ParticlesDoc = z.output<typeof Particles>;
export type ParticleShape = ParticlesDoc['shape'];

// ---------------------------------------------------------------- character

/**
 * A character (see play/character.ts): a standing body that walks, runs,
 * jumps and falls through the level, standing on the scene's meshes,
 * climbing steps and stopping at walls and at other characters. It moves the
 * way its controller tells it: the player (NodeDoc.player), a behavior tree
 * (Move To) or a script (this.character). Sizes are in meters.
 */
export const Character = z
    .object({
        speed: num(3, 0, 100, { title: 'Walk Speed', description: 'm/s.' }),
        runSpeed: num(6, 0, 200, { description: 'm/s: Shift or the joystick at its edge; Run in Move To.' }),
        jump: num(4.5, 0, 100, { description: 'Take-off speed in m/s; 0 turns jumping off.' }),
        gravity: num(14, 0, 200, { description: 'Downward acceleration, m/s².' }),
        height: num(1.8, 0.2, 20, { description: 'Of the body it collides with (m).' }),
        radius: num(0.35, 0.05, 10, { description: 'Of the body (m).' }),
        eyeHeight: num(1.65, 0.05, 20, { description: 'Eyes above the feet: the first person camera height (m).' }),
        stepHeight: num(0.3, 0, 10, { description: 'Highest step it climbs without jumping (m).' }),
        collide: bool(true, { title: 'Collisions', description: 'Walls and other characters stop it and it stands on floors; off, it moves freely at its height.' }),
    })
    .overwrite((c) => {
        c.radius = Math.min(c.radius, c.height / 2);
        c.eyeHeight = Math.min(c.eyeHeight, c.height);
        c.stepHeight = Math.min(c.stepHeight, c.height / 2);
        return c;
    });
export type CharacterDoc = z.output<typeof Character>;

/**
 * The player controls the character of its object (see
 * play/playerController.ts): WASD or the arrow keys (a joystick on touch
 * screens) walk, Shift runs, Space jumps, and the camera turns with a mouse
 * drag or a finger.
 */
export const Player = z.object({
    view: oneOf(['third', 'first', 'scene'], 'third', {
        labels: { third: 'Third Person', first: 'First Person', scene: 'Scene Camera' },
        description: 'third: a camera follows behind; first: from the eyes; scene: keeps the scene\'s camera node (the player walks relative to it).',
    }),
    distance: num(4, 0.5, 100, { description: 'Third person: how far the camera stays behind (m).' }),
    lookSpeed: num(1, 0.05, 10, { step: 0.01, description: 'Look speed factor for mouse drags and fingers (1 = default).' }),
    invertY: bool(false, { title: 'Invert Look', description: 'Dragging up looks down.' }),
});
export type PlayerDoc = z.output<typeof Player>;
export type PlayerView = PlayerDoc['view'];

// ---------------------------------------------------------------- animation

/** A character's modes, which pick its model's clips (play/character.ts). */
export const ANIMATION_MODES = ['idle', 'walk', 'run', 'jump', 'fall'] as const;
const modeClip = (mode: string) => text('', 200, { title: mode[0].toUpperCase() + mode.slice(1), description: `Clip while the character is in its ${mode} mode; empty picks one by its name.` });

/**
 * Skeletal animation of an imported model (see play/animation.ts): the clip
 * it plays, in the editor too while previewed, and on a character the clip
 * of each of its modes, crossfaded as the mode changes. Scripts play clips
 * with this.animator.
 */
export const Animation = z.object({
    clip: text('', 200, { description: 'Clip it plays; empty plays the first.' }),
    speed: num(1, 0, 10, { step: 0.05, description: 'Playback speed: 1 as made.' }),
    fade: num(0.25, 0, 5, { step: 0.05, title: 'Crossfade', description: 'Seconds one clip takes to blend into the next.' }),
    preview: bool(true, { description: 'Plays in the editor too, not only in Play.' }),
    ...Object.fromEntries(ANIMATION_MODES.map((m) => [m, modeClip(m)])) as Record<(typeof ANIMATION_MODES)[number], ReturnType<typeof modeClip>>,
});
export type AnimationDoc = z.output<typeof Animation>;

// ------------------------------------------------------------------ physics

export const BODY_TYPES = ['dynamic', 'kinematic', 'fixed'] as const;
export const BODY_SHAPES = ['auto', 'box', 'sphere', 'capsule', 'hull', 'mesh'] as const;

/**
 * A physics body (see play/physics.ts). In Play a dynamic body falls,
 * collides and bounces, and its object follows it; a kinematic one follows
 * its object (scripts move it) and pushes dynamic bodies; a fixed one stays
 * put. Shown meshes without a body are fixed too, so the level holds what
 * falls on it, and characters push dynamic bodies out of their way.
 */
export const Body = z.object({
    type: oneOf(BODY_TYPES, 'dynamic', { description: 'dynamic falls and collides; kinematic follows its object (moved by scripts) and pushes dynamic bodies; fixed stays put.' }),
    shape: oneOf(BODY_SHAPES, 'auto', {
        title: 'Collider',
        labels: { auto: 'Auto', box: 'Box', sphere: 'Sphere', capsule: 'Capsule', hull: 'Convex Hull', mesh: 'Mesh' },
        description: 'auto fits a primitive exactly and wraps other meshes; box, sphere and capsule fit the meshes\' bounds; hull wraps them; mesh uses their triangles (a dynamic body gets the hull).',
    }),
    mass: num(1, 0.001, 1e6, { description: 'kg (dynamic).' }),
    friction: num(0.5, 0, 2, { step: 0.01, slider: true }),
    bounce: unit(0, { description: 'Restitution: 0 stops dead, 1 bounces back as fast.' }),
    drag: num(0, 0, 100, { step: 0.01, description: 'Linear damping: slows it down over time.' }),
    angularDrag: num(0.05, 0, 100, { step: 0.01, description: 'Angular damping: slows its spin.' }),
    gravity: num(1, -10, 10, { step: 0.05, description: 'Times the world gravity (9.81 m/s² down); 0 floats.' }),
    lockRotation: bool(false, { description: 'Collisions do not turn it (an upright crate, a character-like prop).' }),
    fast: bool(false, { title: 'Continuous', description: 'For fast small objects (balls, bullets): continuous collision detection so they do not pass through thin walls.' }),
    sensor: bool(false, { title: 'Trigger', description: 'Only detects what enters it (onTriggerEnter / onTriggerExit in scripts) instead of colliding.' }),
});
export type BodyDoc = z.output<typeof Body>;
export type BodyType = BodyDoc['type'];

// -------------------------------------------------------------- environment

/**
 * Dynamic diffuse global illumination (DDGI): a grid of light probes
 * captures the scene and lit surfaces receive the light it bounces.
 */
export const GI = group({
    enable: enabled({ description: 'Dynamic diffuse global illumination (DDGI).' }),
    center: vec3([0, 2, 0], { description: 'World position of the center of the probe grid.' }),
    counts: vec3([8, 3, 8], { title: 'Probes', precision: 0, description: 'Probes along x, y and z: at most 16 per axis and 512 in all.' }),
    spacing: num(2, 0.1, 100, { step: 0.01, description: 'Distance between neighboring probes.' }),
    intensity: num(1, 0, Infinity, { description: 'Strength of the indirect light.' }),
    bounce: unit(0.5, { description: 'How much light keeps bouncing between surfaces, 0..1.' }),
    realtime: bool(false, { description: 'Capture the probes continuously (moving objects and lights); otherwise only after changes.' }),
}).overwrite((g) => ({ ...g, counts: clampGIGrid(g.counts) }));
export type GIDoc = z.output<typeof GI>;

export const SKY_TYPES = ['atmospheric', 'physical', 'color'] as const;

export const Environment = z.object({
    sky: oneOf(SKY_TYPES, 'atmospheric', {
        labels: { atmospheric: 'Atmospheric', physical: 'Physical Sky', color: 'Solid Color' },
        description: 'atmospheric: a fast sky with a sun; physical: a physically based sky (light scattered many times, deep sunsets, optional clouds; each change takes longer to redraw); color: one flat color. The sky also lights the scene.',
    }),
    skyColor: color('#3a4250'),
    /** Sky sun azimuth and elevation, 0..1. */
    sunX: unit(0.71, { title: 'Sun Direction', step: 0.005, precision: 3, description: 'Sky sun azimuth 0..1. Keep it where the sun light comes from (apply_key_light does): god rays and the fog glow follow the light.' }),
    sunY: unit(0.6, { title: 'Sun Height', step: 0.005, precision: 3, description: 'Sky sun elevation 0..1: 0.5 on the horizon, 1 straight up.' }),
    skyExposure: num(1, 0, 4, { step: 0.01, slider: true }),
    /** The sun and air of the atmospheric and physical skies. */
    atmosphere: group({
        sunSize: num(1, 0.1, 5, { step: 0.01, slider: true, description: 'Size of the sun disc: 1 is about 3.6 degrees across.' }),
        sunBrightness: num(1, 0, 10, { step: 0.01, slider: true, description: 'Brightness of the sun disc (not of the light).' }),
        showSun: bool(true, { title: 'Show Sun', description: 'Draw the sun disc.' }),
        altitude: num(1500, 0, 10000, { step: 10, precision: 0, description: 'Height of the viewer in the air, meters: higher sees a darker, clearer sky.' }),
        clouds: bool(false, { description: 'Physical sky only: a cloud layer 3-5 km up. The clouds do not move, and each sky change takes much longer to redraw with them.' }),
    }),
    /** Tonemap exposure. */
    exposure: num(1, 0, 4, { step: 0.01, slider: true }),
    fxaa: bool(true, { title: 'Anti-aliasing', description: 'FXAA.' }),
    bloom: group({ enable: enabled(), intensity: num(0.6, 0, 3, { step: 0.01, slider: true }), threshold: num(1, 0, 4, { step: 0.01, slider: true }) }),
    ao: group({ enable: enabled(), strength: num(1, 0.01, 1, { step: 0.01, slider: true }), distance: num(1, 0.1, 10, { step: 0.05, slider: true }) }),
    fog: group({
        enable: enabled(),
        mode: oneOf(['linear', 'exponential', 'height'], 'linear', {
            labels: { linear: 'Linear', exponential: 'Exponential', height: 'Height' },
            description: 'linear: from clear at Start to full at End; exponential: thickens with distance past Start; height: thick low down and thinning upward (valleys, mist over water).',
        }),
        color: color('#aab4be'),
        near: num(5, 0, Infinity, { title: 'Start', step: 0.1, description: 'No fog closer than this, meters.' }),
        far: num(80, 0.1, Infinity, { title: 'End', step: 0.5, description: 'Linear fog: full fog from this distance, meters.' }),
        density: num(0.02, 0, 1, { step: 0.001, precision: 3, description: 'Exponential and height fog: half the view is fogged every 1 / density meters past Start (0.02: 50 m).' }),
        height: num(0, -1000, 1000, { title: 'Base Height', step: 0.1, description: 'Height fog: the height where the fog has its density.' }),
        heightFalloff: num(0.1, 0.001, 2, { step: 0.005, precision: 3, description: 'Height fog: how fast it thins upward, per meter (0.1 halves about every 7 m).' }),
        intensity: unit(1, { title: 'Amount' }),
        sky: unit(0.8, { title: 'Sky Fog', description: 'How much the sky takes the fog color.' }),
        sunScatter: unit(1, { title: 'Sun Glow', description: 'The fog glows looking toward the sun.' }),
        sunFocus: num(2.7, 1, 40, { title: 'Sun Glow Focus', step: 0.1, slider: true, description: 'Higher keeps the glow closer around the sun.' }),
    }),
    /** Directional shadows. */
    shadow: group({
        range: num(60, 5, 1000, { step: 1, precision: 0, description: 'Meters the directional shadows cover: around the directional light object, or around the camera with Follow Camera. A larger range covers more with blurrier shadows.' }),
        softness: num(1, 0.25, 4, { step: 0.05, slider: true, description: 'Width of the blur at shadow edges, in shadow texels.' }),
        follow: bool(false, { title: 'Follow Camera', description: 'Shadows cover their range around the camera instead of around the light object: for levels larger than the range.' }),
    }),
    godRays: group({
        enable: enabled({ description: 'Light shafts: the sun (the first directional light that casts shadows) shining through gaps between shadows.' }),
        intensity: num(0.5, 0.01, 5, { step: 0.01, slider: true }),
        focus: num(5, 1, 40, { step: 0.5, slider: true, description: 'Higher keeps the shafts closer to the direction of the sun.' }),
    }),
    volumetricFog: group({
        enable: enabled({ description: 'Fog lit by the sun that thickens with distance, brighter looking toward the sun (no shafts).' }),
        density: num(0.02, 0, 0.5, { step: 0.001, precision: 3, description: 'Thickness per meter.' }),
        scattering: num(1, 0, 5, { step: 0.05, slider: true, description: 'How bright the sun makes the fog.' }),
        anisotropy: num(0.6, -0.95, 0.95, { step: 0.01, slider: true, description: 'Positive: brightest looking toward the sun; negative: looking away from it.' }),
        distance: num(60, 1, 1000, { step: 1, description: 'Farthest distance, meters; the sky gets this much fog.' }),
        ambient: color('#272738', { description: 'Color of the fog away from the sun.' }),
    }),
    /**
     * Graphics quality of built games. The editor shows the tier the scene
     * names (high for auto) unless View > Graphics Quality picks another.
     */
    quality: oneOf(['auto', 'low', 'medium', 'high'], 'auto', {
        title: 'Graphics Quality',
        labels: { auto: 'Auto (per device)', low: 'Low', medium: 'Medium', high: 'High' },
        description: 'Built games: auto picks low on phones and weak GPUs, medium on integrated GPUs, high on dedicated ones; another value holds every device at that tier, and the editor shows it too. Lower tiers use smaller shadow maps, cover less shadow range, skip ambient occlusion and god rays, and render at a lower resolution.',
    }),
    gi: GI,
});
export type EnvironmentDoc = z.output<typeof Environment>;
export type SkyType = EnvironmentDoc['sky'];

// -------------------------------------------------------------------- specs

/** Measurements the level is built to (DesignDoc.specs). */
export const Specs = z.object({
    playerHeight: num(1.8, 0.1, 100),
    eyeHeight: num(1.65, 0.05, 100),
    playerRadius: num(0.35, 0.01, 50),
    doorWidth: num(1.2, 0.1, 100),
    doorHeight: num(2.2, 0.1, 100),
    stepHeight: num(0.3, 0, 10, { description: 'Highest step the player climbs without jumping.' }),
    maxSlope: num(40, 0, 89, { description: 'Steepest walkable slope, degrees.' }),
    notes: text('', 8000),
});
export type SpecsDoc = z.output<typeof Specs>;

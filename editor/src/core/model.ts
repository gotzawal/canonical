// The components of scene objects and the scene settings, written once. The
// document types (core/types.ts re-exports them), their defaults, the repair
// of documents from files, the assistant's tool arguments and the
// inspector's fields all come from these schemas (see core/schema.ts).
// Adding a setting is one line here, plus what the engine does with it.

import { z } from 'zod';
import { clampGIGrid } from './giLimits';
import { SHAPE_DISTRIBUTIONS, SIZE_DISTRIBUTIONS } from './grass';
import { WEATHERS } from './weather';
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
export const SHADOW_RESOLUTIONS = ['low', 'medium', 'high'] as const;
export const SHADOW_UPDATES = ['auto', 'static', 'every_frame'] as const;
export const SHADOW_COVERAGES = ['area', 'follow', 'cascades'] as const;

/**
 * A light's shadow map: how large it is, when it is drawn again and, for a
 * directional light, what it covers (see engine/shadows.ts for the sizes).
 */
export const LightShadow = group({
    resolution: oneOf(SHADOW_RESOLUTIONS, 'medium', {
        labels: { low: 'Low', medium: 'Medium', high: 'High' },
        description: 'Size of the shadow map at the high graphics tier (lower tiers halve it). Directional: low 1024, medium 2048, high 4096 texels, each map or cascade 4, 16 or 64 MiB. Point and spot: each face 256, 512 or 1024 (a point light has six faces, a spot light only those its cone reaches), 0.25, 1 or 4 MiB a face. Give the key light and lights over the play area more, small, dim and far ones less.',
    }),
    update: oneOf(SHADOW_UPDATES, 'auto', {
        title: 'Redraw',
        labels: { auto: 'When Something Moves', static: 'Static Objects Only', every_frame: 'Every Frame' },
        description: 'auto: drawn again only when the light, or something its shadow reaches, moves or changes (animated models while they play); static: only objects that never move in Play cast it, drawn again only when the level is edited (cheapest: lamps where the shadows of moving characters do not matter); every_frame: always (for vertex animation it cannot see).',
    }),
    coverage: oneOf(SHADOW_COVERAGES, 'area', {
        labels: { area: 'Around the Light', follow: 'Around the Camera', cascades: 'Cascades' },
        description: 'Directional lights: area covers Range meters around the light object (put it over the play area of a small level); follow covers Range meters around the camera (a level larger than the range); cascades splits it into maps from the camera out to Range, sharp near and coarser far (large outdoor levels). follow and cascades are drawn again whenever the camera moves.',
    }),
    cascades: int(4, 2, 4, { description: 'Directional lights with cascades: how many maps. Two draw half as much as four; four keep the far shadows sharper.' }),
    range: num(60, 5, 1000, { step: 1, precision: 0, description: 'Directional lights: meters the shadow covers. A larger range is blurrier (with cascades only far away).' }),
});
export type LightShadowDoc = z.output<typeof LightShadow>;

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
    /** Its shadow map, when it casts shadows. */
    shadow: LightShadow,
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
 * A particle emitter (fire, smoke, sparks, dust, steam), simulated on the GPU
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
        blend: oneOf(['add', 'alpha'], 'add', { labels: { add: 'Add (glow)', alpha: 'Alpha (cover)' }, description: 'add glows (fire, sparks, magic), alpha covers (smoke, dust, mist).' }),
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

// --------------------------------------------------- mirrors, grass, instancing

/**
 * A planar mirror (the engine's MirrorComponent): the object's mesh shows
 * the scene reflected in the plane through its top, facing its local +Y
 * (a plane primitive's face, a box's top). With a built-in material the
 * mesh is a mirror tinted by the material's color; a material shader
 * reads the reflection with mirrorColor(offset) to make water (waves that
 * move it, a fresnel term that blends it). The scene is drawn a second
 * time for it, every frame the camera is in front of it.
 */
export const Mirror = z.object({
    resolution: num(0.5, 0.1, 1, { step: 0.05, slider: true, description: 'Size of the reflection image as a share of the screen\'s: lower is cheaper and softer.' }),
});
export type MirrorDoc = z.output<typeof Mirror>;

/**
 * A field of grass blades (packages/geometry GrassComponent): thousands of
 * blades in one draw, bent by wind gusts. Each blade stands where a
 * vertical line through it meets the ground object, so the field follows
 * any terrain; without a ground it is flat at the object's height. The
 * area is centered on the object and turns with it.
 */
export const Grass = z.object({
    count: int(4000, 1, 30000, { title: 'Blades', description: 'Number of blades (one draw for all of them; each is a matrix the engine updates, so keep large fields to a few objects).' }),
    size: vec2([10, 10], { precision: 2, description: 'Area covered [x, z] in meters, centered on the object.' }),
    ground: z.string().min(1).nullable().catch(null).meta({ description: 'Object (a terrain, a floor or a group of them) the blades stand on, by id; null for a flat field at the object\'s height. Blades outside it or on slopes steeper than 60 degrees are left out.' }),
    height: num(0.6, 0.02, 5, { step: 0.01, precision: 2, description: 'Blade height in meters (each blade varies around it).' }),
    width: num(0.09, 0.005, 1, { step: 0.005, precision: 3, description: 'Blade width at its root in meters.' }),
    heights: range([0.7, 1.3], 0.1, 4, { title: 'Height Spread', precision: 2, step: 0.05, description: 'Each blade\'s height is the height times a number in [least, most], spread by Size Spread.' }),
    widths: range([0.7, 1.3], 0.1, 4, { title: 'Width Spread', precision: 2, step: 0.05, description: 'Each blade\'s width is the width times a number in [least, most], spread by Size Spread.' }),
    sizes: oneOf(SIZE_DISTRIBUTIONS, 'uniform', {
        title: 'Size Spread',
        labels: { uniform: 'Uniform', bell: 'Mostly Middling', short: 'Mostly Short', patches: 'In Patches' },
        description: 'How sizes spread within the height and width ranges: uniform (any size as likely), bell (most near the middle), short (most small, a few tall), patches (tall and short grass in patches of Patch Size).',
    }),
    shapes: group({
        blade: num(1, 0, 10, { step: 0.1, description: 'Share of plain blades that taper evenly to a point.' }),
        leaf: num(0, 0, 10, { step: 0.1, description: 'Share of broad leaves, widest in their lower middle, that bend more.' }),
        needle: num(0, 0, 10, { step: 0.1, description: 'Share of thin, stiff needles.' }),
    }, { description: 'The blade shapes, by their shares (relative to each other).' }),
    shapeSpread: oneOf(SHAPE_DISTRIBUTIONS, 'mixed', {
        title: 'Shape Spread',
        labels: { mixed: 'Mixed', patches: 'In Patches' },
        description: 'mixed: each blade takes a shape by the shares; patches: the shapes gather in patches of Patch Size (a few of the others among them).',
    }),
    curvature: range([0, 0.5], 0, 1, { precision: 2, step: 0.05, description: 'How much blades bend at rest, [least, most] (leaves bend more, needles less).' }),
    patchSize: num(4, 0.5, 200, { title: 'Patch Size', step: 0.5, description: 'Meters across a patch, for sizes or shapes spread in patches (bare patches are three times as large).' }),
    maxSlope: num(40, 5, 80, { title: 'Max Slope', step: 1, description: 'Degrees of slope past which no grass grows; it thins out over the last third.' }),
    waterGap: num(0.3, 0, 5, { title: 'Water Gap', step: 0.05, description: 'Meters above water (a Water plane over a terrain) that stay bare before the grass grows fully.' }),
    gaps: unit(0, { title: 'Bare Patches', description: 'How much of the field is left in bare patches (clumps of grass with ground between); 0 none.' }),
    bottomColor: color('#28461c', { title: 'Root Color' }),
    rootBlend: unit(0.5, { title: 'Into Ground', description: 'How much the blades\' roots take the color of the terrain they grow from, so the field grows out of it.' }),
    dryness: unit(0.3, { description: 'Drier, yellower patches over the field; 0 evenly green.' }),
    topColor: color('#7cab45', { title: 'Tip Color' }),
    wind: num(0.6, 0, 3, { step: 0.01, slider: true, description: 'How far gusts bend the blades.' }),
    windSpeed: num(3, 0, 30, { step: 0.1, description: 'How fast gusts sweep over the field, m/s.' }),
    windDirection: angle(35, 0, 360, { description: 'Where the wind blows toward, degrees around +Y from +X.' }),
    texture: asset({ description: 'Blade texture asset id (alpha below 0.3 is cut out), or null for plain blades.' }),
    windMap: asset({ title: 'Gust Map', description: 'Gust noise texture asset id (its red and green make the gusts, one pixel per meter), or null for built-in noise.' }),
    distance: num(0, 0, 10000, { step: 1, title: 'Draw Distance', description: 'Meters from the camera where the last blades are gone: they thin out from half of it, so far grass costs less; 0 draws every blade at any distance. 30 to 60 suits most fields.' }),
    castShadow: bool(false, { title: 'Cast Shadows', description: 'Blades cast shadows (costly for many blades); they always receive them.' }),
});
export type GrassDoc = z.output<typeof Grass>;

/**
 * Rain falling through a box around the object (engine/rain.ts): drops at
 * real places in space, drawn by one shader that walks each pixel's view
 * ray through the box, so they keep their size with distance, stop at the
 * bottom, lean with the wind, stay out of a shelter and catch the glow of
 * a light. The box is upright in the world: the object's turn and scale do
 * not change it.
 */
export const Rain = z.object({
    size: vec3([16, 10, 16], { precision: 2, description: 'The box the rain falls in [x, y, z], meters, centered on the object. Keep it in the open air, its bottom on the ground and its top above the walls; the less of the screen it covers, the less it costs.' }),
    amount: unit(1, { description: 'Share of the drop lines that hold a drop: 1 is a downpour, 0.3 a drizzle.' }),
    spacing: num(1, 0.2, 3, { step: 0.01, description: 'Budget: meters between drop lines. Smaller makes more drops and costs more; each pixel walks at most 34 steps of it.' }),
    dropWidth: num(0.01, 0.004, 0.08, { title: 'Drop Width', step: 0.001, precision: 3, description: 'Width of a drop, meters.' }),
    streak: num(2.85, 0.05, 3, { title: 'Streak Length', step: 0.05, description: 'Length of the streak a drop draws, meters.' }),
    speed: num(5, 1, 25, { step: 0.1, description: 'How fast the drops fall, m/s.' }),
    wind: num(-0.17, -0.5, 0.5, { step: 0.01, slider: true, description: 'How far the drops lean along the world X axis per meter they fall.' }),
    density: num(8.4, 0.2, 30, { step: 0.1, description: 'How much a drop covers what is behind it.' }),
    brightness: num(1.25, 0, 4, { step: 0.01, slider: true }),
    color: color('#e8f0f8'),
    nearFade: num(3.2, 0.2, 20, { title: 'Near Fade', step: 0.1, description: 'Drops closer to the camera than this fade out, meters (they would cross the view as long bars).' }),
    shelter: z.string().min(1).nullable().catch(null).meta({ description: 'An object whose box stays dry (an awning, a porch roof, a bus shelter), by id; the drops stop above it and carry on past its rim.' }),
    light: z.string().min(1).nullable().catch(null).meta({ description: 'A light whose glow the drops falling near it catch (a street lamp), by id: its color, within its range.' }),
    lightGain: num(0.45, 0, 3, { title: 'Light Glow', step: 0.01, slider: true, description: 'How much brighter the drops are near the light.' }),
});
export type RainDoc = z.output<typeof Rain>;

// ------------------------------------------------------------------ terrain

const nodeRef = (description: string) => z.string().min(1).nullable().catch(null).meta({ description });

/**
 * A layer of a terrain's surface: a material slot's swatch (its color and
 * normal maps at the slot's tile size) where the layer's rules put it, or
 * where it is painted. The first layer covers the whole terrain; each
 * later one goes over those before it where its heights and slopes match.
 */
export const TerrainLayer = z.object({
    slot: nodeRef('Material slot id: the layer shows its swatch, tile size, color and roughness, and follows it when it changes; null for its own.'),
    albedo: asset({ description: 'Color map (texture asset id): the slot\'s swatch.' }),
    normal: asset({ description: 'Normal map (texture asset id): the slot\'s.' }),
    arm: asset({ title: 'ARM', description: 'Occlusion, roughness and metallic map (texture asset id, R G B): the slot\'s; roughness multiplies its G.' }),
    heightMap: asset({ title: 'Height Map', description: 'Height (displacement) map (texture asset id, R): the slot\'s. Where layers meet, the higher texels win, so sand fills the gaps between stones.' }),
    tile: num(4, 0.05, 1000, { step: 0.05, description: 'Meters one tile of the maps covers.' }),
    color: color('#808080', { description: 'Multiplies the color map (white shows it as it is).' }),
    roughness: unit(0.9),
    height: range([-10000, 10000], -10000, 10000, { title: 'Heights', description: 'World heights [lowest, highest] in meters where the layer shows (a beach: up to a meter above the water).' }),
    slope: range([0, 90], 0, 90, { title: 'Slopes', description: 'Slopes [least, steepest] in degrees where the layer shows (0 flat; rock on cliffs: [35, 90]).' }),
    heightBlend: num(1, 0, 100, { step: 0.1, description: 'Meters over which the layer fades in at its height limits.' }),
    slopeBlend: num(5, 0, 45, { step: 0.5, description: 'Degrees over which the layer fades in at its slope limits.' }),
    onlyPainted: bool(false, { title: 'Only Where Painted', description: 'Shows only where it is painted (paths, fields), not by its rules.' }),
    grass: unit(1, { title: 'Grass Grows', description: 'How well Grass fields grow on this layer: 1 fully, 0 not at all (sand, rock); in between they thin out and grow shorter.' }),
    debris: unit(0, { title: 'Loose Stones', description: 'Small stones lying on this layer near the camera, in its colors (0 none, 1 about three a square meter). Not on the low graphics tier.' }),
});
export type TerrainLayerDoc = z.output<typeof TerrainLayer>;

/**
 * A terrain: a heightmap stretched over `size` meters around the object
 * (it keeps only the object's position), from the object's height up to
 * `height` meters above it. It is drawn in chunks that get coarser far
 * from the camera, and its surface blends up to four layers by height,
 * slope and paint. In Play characters and bodies stand on it and the
 * navigation mesh covers it.
 */
export const Terrain = z.object({
    heightmap: asset({ description: 'Heightmap asset id: a 16-bit grayscale PNG (or raw .r16): white is `height` meters above the object, black level with it; null is flat.' }),
    splatmap: asset({ title: 'Paint', description: 'Painted layers asset id (an RGBA PNG, a channel for each layer), made by painting; null for none.' }),
    size: vec2([200, 200], { precision: 1, description: 'Extent [x, z] in meters, centered on the object.' }),
    height: num(40, 0.1, 5000, { step: 0.1, description: 'Meters from the heightmap\'s lowest (black) to its highest (white) point.' }),
    layers: z.array(TerrainLayer).max(4).catch((c) => (Array.isArray(c?.value) ? c.value.slice(0, 4).map((l: unknown) => TerrainLayer.parse(l && typeof l === 'object' ? l : {})) : []))
        .meta({ description: 'Up to four surface layers, the first covering everything; each later one over those before it where its rules match or it is painted.' }),
    detail: num(1, 0.25, 4, { step: 0.05, description: 'How far from the camera the full detail reaches: 1 by default, higher is finer far away and costlier.' }),
    blending: unit(0.7, { title: 'Height Blending', description: 'Where layers meet, how much their height maps decide which shows (sand fills the gaps between stones) and how much their rules\' edges wander instead of following contour lines; 0 fades them evenly.' }),
    variation: unit(0.5, { description: 'Large patches of lighter and darker ground, and the maps mixed with a larger copy far away, so the tiles do not repeat visibly; 0 for none.' }),
    wetShore: num(1.2, 0, 5, { title: 'Wet Shore', step: 0.05, description: 'Meters over a water surface on the terrain (a Water plane) that are wet: darker and glossy; 0 for none.' }),
    puddles: unit(0.5, { description: 'Under a Rain box the ground is wet; this is how much of its flat ground puddles cover (in the hollows); 0 for none.' }),
    relief: unit(0.5, { description: 'How deep the layers\' height maps look up close (stones and gravel standing out of the ground); 0 flat. Not on the low graphics tier.' }),
    compress: bool(false, { title: 'Compress Layers', description: 'Keeps the layers\' textures block compressed on the GPU (BC3): a quarter of the memory and less bandwidth, a little less sharp color and normals. Where the device cannot (most phones) they stay as they are.' }),
    collide: bool(true, { description: 'Characters and bodies stand on it in Play, and the navigation mesh covers it.' }),
    castShadow: bool(true, { title: 'Cast Shadows' }),
});
export type TerrainDoc = z.output<typeof Terrain>;

// ------------------------------------------------------------------ scatter

export const SCATTER_SOLIDS = ['none', 'trunk', 'box'] as const;

/** A kind of copy a scatter places: a model, how often it is picked and how large. */
export const ScatterSource = z.object({
    model: asset({ description: 'Model asset id (a tree, rock, bush).' }),
    weight: num(1, 0, 100, { step: 0.1, description: 'How often it is picked, relative to the other sources.' }),
    scale: range([0.8, 1.2], 0.01, 100, { precision: 2, step: 0.01, description: 'Scale [smallest, largest] each copy picks from.' }),
    solid: oneOf(SCATTER_SOLIDS, 'none', {
        labels: { none: 'Not Solid', trunk: 'Trunk', box: 'Box' },
        description: 'In Play: none lets characters walk through (bushes, flowers); trunk blocks with a thin cylinder at the middle (trees); box blocks with the model\'s box (rocks, crates). Solid copies are holes in the navigation mesh.',
    }),
});
export type ScatterSourceDoc = z.output<typeof ScatterSource>;

/**
 * Copies of models spread over an area by rules: the document keeps only
 * the rules, and the same copies are made again from the seed each time.
 * They stand on the ground object (a terrain or meshes) where its slope
 * and height allow, keep their spacing and stay out of the areas of the
 * objects to avoid. A model that is a set of pieces side by side (a rock
 * set) gives each copy one piece. They are drawn instanced in cells, so
 * the cells out of view (or beyond the draw distance) cost nothing.
 */
export const Scatter = z.object({
    sources: z.array(ScatterSource).max(8).catch((c) => (Array.isArray(c?.value) ? c.value.slice(0, 8).map((x: unknown) => ScatterSource.parse(x && typeof x === 'object' ? x : {})) : []))
        .meta({ description: 'Up to eight models to place, picked by weight.' }),
    size: vec2([30, 30], { precision: 1, description: 'Area [x, z] in meters, centered on the object.' }),
    count: int(200, 0, 20000, { description: 'Copies to place (fewer where the rules or the spacing leave no room).' }),
    seed: int(1, 0, 999999, { description: 'Another seed places the copies anew.' }),
    spacing: num(1.5, 0, 100, { step: 0.1, description: 'Least distance between copies in meters.' }),
    ground: nodeRef('Object the copies stand on (a terrain, a floor or a group of them), by id; null places them flat at the object\'s height.'),
    height: range([-10000, 10000], -10000, 10000, { title: 'Heights', description: 'World heights [lowest, highest] in meters where copies may stand.' }),
    slope: range([0, 30], 0, 90, { title: 'Slopes', description: 'Slopes [least, steepest] in degrees where copies may stand.' }),
    avoid: z.array(z.string().min(1)).max(64).catch((c) => (Array.isArray(c?.value) ? c.value.filter((x: unknown) => typeof x === 'string' && x).slice(0, 64) : []))
        .meta({ description: 'Objects whose ground area stays clear (buildings, paths, the play area), by id.' }),
    margin: num(1, 0, 100, { step: 0.1, description: 'Meters kept clear around the objects to avoid.' }),
    align: unit(0, { description: 'How much copies lean with the ground: 0 upright (trees), 1 along the slope (rocks, grass tufts).' }),
    sink: num(0, 0, 10, { step: 0.01, description: 'Meters the copies sink into the ground (so roots and rock bottoms do not float on slopes).' }),
    bury: unit(0.5, { description: 'Copies always sit with no side of their base over the ground (slopes, tilt); this sinks them further by part of how unevenly they sit: rocks set into a hillside instead of on it.' }),
    soil: num(0.3, 0, 3, { step: 0.05, description: 'Meters the color of the terrain under a copy creeps up its base, to a ragged line, so it sits in the ground; 0 for none. Engine lit materials (Library and imported models).' }),
    moss: unit(0, { description: 'How much moss (or dust: its color) grows on what faces up; 0 for none.' }),
    mossColor: color('#55602f', { title: 'Moss Color' }),
    sway: num(0, 0, 2, { step: 0.01, description: 'Meters the tops of copies lean in the wind, in slow gusts with a flutter (trees 0.2 to 0.5, shrubs 0.1; 0 for rocks). It follows the weather\'s wind (else the clouds\' direction). Engine lit materials.' }),
    vary: unit(0.4, { title: 'Variation', description: 'How much copies differ in brightness and warmth.' }),
    tilt: num(0, 0, 60, { step: 1, description: 'Degrees each copy tilts at random on top of its lean, so rocks do not all sit the same way up; 0 for none.' }),
    clusters: unit(0, { description: 'How much copies gather in groups with bare ground between them, the largest at the middle of a group (rocks, shrubs); 0 spreads them evenly.' }),
    clusterSize: num(15, 1, 1000, { title: 'Cluster Size', step: 0.5, description: 'Meters across a group of copies (with clusters above 0).' }),
    layer: int(0, 0, 4, { title: 'Terrain Layer', description: '1 to 4: copies stand only where that layer of the ground terrain shows (by its rules and paint), as much as it shows (rocks on the gravel layer); 0 anywhere.' }),
    distance: num(0, 0, 100000, { step: 1, title: 'Draw Distance', description: 'Copies farther than this from the camera are not drawn (a part of the area at a time); 0 draws them at any distance. Small copies (grass tufts, pebbles, flowers) can go at 40 to 80 m.' }),
    castShadow: bool(true, { title: 'Cast Shadows' }),
});
export type ScatterDoc = z.output<typeof Scatter>;

/**
 * A sound source (the engine's PositionAudio, or StaticAudio when not 3D)
 * that plays an audio asset in Play: ambience, music, a machine's hum, a
 * fountain. The active camera hears it. Scripts control it with
 * this.audio and play one-off sounds with this.playSound.
 */
export const AudioSource = z.object({
    clip: asset({ description: 'Audio asset id (.mp3, .ogg, .wav...), or null for none.' }),
    volume: num(1, 0, 2, { step: 0.01, slider: true, description: 'Loudness: 1 as recorded, 0 silent.' }),
    pitch: num(1, 0.25, 4, { step: 0.01, description: 'Playback rate: 2 plays twice as fast and an octave higher, 0.5 slower and lower.' }),
    loop: bool(true, { description: 'Starts over at the end (ambience, music); off plays it once.' }),
    autoplay: bool(true, { title: 'Play on Start', description: 'Starts when Play starts; off waits for a script (this.audio.play()).' }),
    spatial: bool(true, { title: '3D', description: 'Heard from where the object is: louder near it and from its side. Off plays it at the same volume everywhere (music, interface sounds).' }),
    near: num(2, 0.1, 1000, { step: 0.1, title: 'Full Volume Within', description: '3D: meters around the object where it plays at full volume.' }),
    far: num(30, 0.5, 10000, { step: 0.5, title: 'Heard Up To', description: '3D: meters from the object where it fades out (linearly from Full Volume Within).' }),
});
export type AudioSourceDoc = z.output<typeof AudioSource>;

/**
 * Instanced drawing (the engine's InstanceDrawComponent) for placing many
 * copies: the meshes of the object and of the objects under it
 * (primitives, prefab parts, imported models) that share a shape and a
 * material are drawn together in one draw call. Moving the children costs nothing extra; adding,
 * removing or restyling them groups them again. Skinned or morphing
 * meshes, transparent materials and mirrors are drawn on their own.
 */
export const Instancing = z.object({});
export type InstancingDoc = z.output<typeof Instancing>;

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
    probesPerFrame: int(1, 1, 8, {
        title: 'Probes per Frame',
        description: 'Budget: probes captured each frame (each draws the scene six times, small). More converges faster after a change and follows moving light sooner, at that many times the capture cost per frame.',
    }),
    updateEvery: int(1, 1, 30, {
        title: 'Update Every',
        description: 'Budget: frames between updates while the probes are captured (after a change, or always in realtime mode). 1 updates every frame; 4 spends about a quarter of the GI time per frame and reacts four times slower.',
    }),
}).overwrite((g) => ({ ...g, counts: clampGIGrid(g.counts) }));
export type GIDoc = z.output<typeof GI>;

export const SKY_TYPES = ['atmospheric', 'physical', 'color', 'hdri'] as const;

export const Environment = z.object({
    /** The sky's physical model (chosen in the Effects stage; the sun's position belongs to the lighting). */
    sky: oneOf(SKY_TYPES, 'atmospheric', {
        title: 'Sky Model',
        labels: { atmospheric: 'Single Scattering', physical: 'Multiple Scattering', color: 'Solid Color', hdri: 'HDRI Image' },
        description:
            'The physical model of the sky, which also lights the scene. atmospheric: single scattering (sunlight scattered once by air, haze and ozone, ray marched with the Chapman approximation): '
            + 'quick to redraw and right for day skies; sunsets and dusk come out darker and flatter. physical: multiple scattering (Hillaire 2020: light scattered many times, '
            + 'from precomputed transmittance and scattering tables): deep sunsets, dusk and twilight glow, optional clouds; each change takes longer to redraw. '
            + 'color: one flat color without a sun (interiors, stylized scenes). '
            + 'hdri: a photographed sky and surroundings (sky_hdri, an .hdr image asset such as a Library HDRI) shown around the scene and lighting it: the most realistic light; point the key light where its sun is.',
    }),
    skyColor: color('#3a4250'),
    skyHdri: asset({ title: 'HDRI', description: 'HDRI sky: the .hdr image asset shown around the scene and lighting it (a Library HDRI).' }),
    /** Sky sun azimuth and elevation, 0..1. */
    sunX: unit(0.71, { title: 'Sun Direction', step: 0.005, precision: 3, description: 'Sky sun azimuth 0..1. Keep it where the sun light comes from (apply_key_light does): god rays and the fog glow follow the light. Not used while the sky follows the key light (atmosphere.followLight).' }),
    sunY: unit(0.6, { title: 'Sun Height', step: 0.005, precision: 3, description: 'Sky sun elevation 0..1: 0.5 on the horizon, 1 straight up.' }),
    skyExposure: num(1, 0, 4, { step: 0.01, slider: true }),
    /** The sun and air of the atmospheric and physical skies. */
    atmosphere: group({
        sunSize: num(1, 0.1, 5, { step: 0.01, slider: true, description: 'Size of the sun disc: 1 is about 3.6 degrees across.' }),
        sunBrightness: num(1, 0, 10, { step: 0.01, slider: true, description: 'Brightness of the sun disc (not of the light).' }),
        showSun: bool(true, { title: 'Show Sun', description: 'Draw the sun disc.' }),
        altitude: num(1500, 0, 10000, { step: 10, precision: 0, description: 'Height of the viewer in the air, meters: higher sees a darker, clearer sky.' }),
        clouds: bool(false, { description: 'Multiple scattering sky only: a cloud layer 3-5 km up. The clouds do not move, and each sky change takes much longer to redraw with them.' }),
        followLight: bool(true, {
            title: 'Sun Follows Light',
            description: 'Single and multiple scattering skies: the sky\'s sun is where the key light (the first shown directional light) comes from, and the light takes the color and brightness of sunlight through the air at that height (warm and dimmer near the horizon, gone below it). Off: Sun Direction and Sun Height place the sky\'s sun and the light keeps its own color.',
        }),
        haze: num(1, 0, 20, {
            title: 'Aerial Perspective',
            step: 0.05,
            description: 'How much distant objects fade into the color of the sky behind them through the air: 1 is a clear day (half faded at about 12 km, thicker low down), higher for hazy or humid air; 0 for none. Works with every sky.',
        }),
    }),
    /** Tonemap exposure. */
    exposure: num(1, 0, 4, { step: 0.01, slider: true }),
    fxaa: bool(true, { title: 'Anti-aliasing', description: 'FXAA.' }),
    fxaaSpan: int(4, 1, 8, {
        title: 'FXAA Reach',
        description: 'Budget: pixels FXAA blends along an edge (4 by default). Lower keeps fine detail and text sharper, higher smooths long shallow edges better. FXAA is one full-screen pass of nine samples a pixel at any reach: its budget is mostly on or off.',
    }),
    bloom: group({
        enable: enabled(),
        intensity: num(0.6, 0, 3, { step: 0.01, slider: true }),
        threshold: num(1, 0, 4, { step: 0.01, slider: true }),
        levels: int(3, 2, 6, {
            description: 'Budget: steps of the glow pyramid, from a quarter of the screen down, each half the size of the last. More spread the glow wider (neon, lamps in fog) and add two small passes each.',
        }),
        blur: int(9, 1, 9, {
            title: 'Blur Size',
            step: 2,
            description: 'Budget: samples across each blur of the glow (odd, 1 to 9). Its cost grows with the square: 9 takes 81 samples a pixel at every level, 5 takes 25, 3 takes 9; smaller blurs give a tighter, grainier glow.',
        }),
    }),
    ao: group({ enable: enabled(), strength: num(1, 0.01, 1, { step: 0.01, slider: true }), distance: num(1, 0.1, 10, { step: 0.05, slider: true }) }),
    /** Screen space reflections. */
    ssr: group({
        enable: enabled({ description: 'Screen space reflections: smooth surfaces (polished and wet floors, metal, calm water) reflect what is on screen. Cheap to add, but what is off screen or hidden behind objects is not reflected: a Mirror component reflects everything on flat mirrors and water.' }),
        strength: unit(0.5, { description: 'How much a perfectly smooth surface reflects (its share is strength squared: 0.5 a quarter, 1 all); rougher surfaces less.' }),
        roughness: unit(0.3, { title: 'Max Roughness', description: 'Surfaces rougher than this reflect nothing (rough ones get grainy reflections).' }),
        distance: num(200, 1, 5000, { step: 1, precision: 0, description: 'Reflected points farther from the camera than this fade out, meters.' }),
        resolution: num(1, 0.25, 1, {
            step: 0.05,
            slider: true,
            description: 'Budget: share of the screen\'s width and height the reflections are traced at (the graphics tier may lower it further: medium traces at most half). 0.5 costs about a quarter and blurs the reflections.',
        }),
        reach: num(0.5, 0.05, 1, {
            title: 'Ray Reach',
            step: 0.05,
            slider: true,
            description: 'Budget: how far a reflected ray is followed across the screen, as a share of its size; the steps (and the cost of misses) grow with it. Short reaches (0.15 to 0.3) suit floors that reflect what stands on them; long ones reach far-off walls and the sky.',
        }),
    }),
    /** Volumetric clouds over the scene (whatever the sky), see engine CloudPost. */
    clouds: group({
        enable: bool(false, { description: 'Volumetric clouds: a layer of clouds drawn in 3D over any sky, drifting with the wind, lit by the sun and the sky, with shadows on the ground. They cost by the graphics tier (fewer steps on weak devices).' }),
        coverage: unit(0.45, { description: 'How much of the sky they cover: 0.2 a few, 0.5 half, 0.9 overcast.' }),
        type: unit(0.6, { description: '0 flat sheets (stratus) to 1 heaps (cumulus) with flat bases and domed tops, taller where they are thickest.' }),
        density: num(1, 0.1, 4, { step: 0.05, slider: true, description: 'How thick and dark they are.' }),
        detail: unit(0.6, { description: 'How much their edges are worn: wisps at their bases, billows on their tops.' }),
        size: num(1, 0.3, 4, { step: 0.05, slider: true, description: 'How big each cloud is: 1 heaps a kilometer or two across, less for small puffs, more for big masses.' }),
        clumping: unit(0.6, { description: '0 many small puffs scattered over the sky to 1 clouds gathered in a few big masses.' }),
        softness: unit(0.3, { description: '0 crisp clouds with sharp edges to 1 soft, hazy ones.' }),
        seed: num(0, 0, 9999, { step: 1, precision: 0, title: 'Pattern', description: 'Another number gives another arrangement of the clouds.' }),
        bottom: num(1500, 100, 10000, { step: 50, precision: 0, title: 'Base', description: 'Altitude of their base, meters.' }),
        thickness: num(2000, 100, 8000, { step: 50, precision: 0, description: 'Meters from their base to their top.' }),
        wind: num(8, 0, 60, { step: 0.5, description: 'How fast they drift, m/s.' }),
        windDirection: num(30, 0, 360, { step: 1, title: 'Wind Direction', description: 'Where they drift toward, degrees around +Y from +X.' }),
        evolve: num(2, 0, 20, { step: 0.1, description: 'How fast their shapes change as they drift, m/s.' }),
        shadows: unit(0.6, { description: 'How dark their shadows on the ground are; 0 for none.' }),
    }),
    /** Weather and the time of day: sets the sun, sky, key light, clouds, fog, rain and wind together (core/weather.ts). */
    weather: group({
        enable: bool(false, { description: 'The time of day and the weather set the sun (and the key light: the moon at night), the sky, clouds, fog, haze, rain around the camera and the wind of grass, clouds and rain together; their own settings are used as they say otherwise.' }),
        time: num(10, 0, 24, { step: 0.05, precision: 2, slider: true, title: 'Time of Day', description: 'Hours: 6 sunrise, 12 noon, 18 sunset.' }),
        cycle: num(0, 0, 240, { step: 0.5, title: 'Day Length', description: 'Real minutes a whole day takes to pass, from Time of Day; 0 stops time.' }),
        sunrise: angle(90, 0, 360, { title: 'Sunrise Direction', description: 'Degrees around +Y from +X where the sun rises (it sets opposite).' }),
        noon: num(60, 5, 90, { step: 1, title: 'Noon Height', description: 'Degrees the sun stands over the horizon at noon (lower far north or in winter).' }),
        preset: oneOf(WEATHERS, 'fair', {
            title: 'Weather',
            labels: { clear: 'Clear', fair: 'Fair', cloudy: 'Cloudy', overcast: 'Overcast', rain: 'Rain', storm: 'Storm', fog: 'Fog' },
            description: 'clear (no clouds), fair (small heaps), cloudy (broken), overcast (a grey deck, dimmer light), rain and storm (rain around the camera, wet ground, gusty), fog (thick haze, high veils).',
        }),
        wind: num(5, 0, 30, { step: 0.5, description: 'Wind m/s, shared by clouds, grass and rain (storms blow harder).' }),
        windDirection: angle(30, 0, 360, { title: 'Wind Direction', description: 'Where the wind blows toward, degrees around +Y from +X.' }),
        stars: unit(1, { description: 'How bright the stars are at night (and the moon\'s disc).' }),
    }),
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
    /** Every shadow's edges; what each light's shadow map covers is the light's (Light.shadow). */
    shadow: group({
        softness: num(1, 0.25, 4, { step: 0.05, slider: true, description: 'Width of the blur at shadow edges, in shadow texels.' }),
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
    texelDensity: num(512, 64, 2048, {
        step: 1,
        precision: 0,
        description: 'Texture pixels per meter the surfaces need where the camera comes closest: 512 for first person (walls within reach), 256 for third person, 128 for top-down or distant views. A tiling texture is sized to its tile times this (a 2 m tile at 512: 1024) and compressed at that size when it is put on a slot.',
    }),
    notes: text('', 8000),
});
export type SpecsDoc = z.output<typeof Specs>;

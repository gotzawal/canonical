// Scene document: the editor's source of truth. It is plain JSON so it can be
// snapshotted for undo/redo, autosaved and written to a file. The engine scene
// is rebuilt from it by engine/sync.ts.

export type Vec3 = [number, number, number];

/**
 * Primitive shapes. Every shape is centered on its origin like the box.
 * The ramp and the stairs rise toward -Z (the first step is at +Z); the
 * capsule's height includes its round caps.
 */
export type GeometryDoc =
    | { type: 'box'; width: number; height: number; depth: number }
    | { type: 'sphere'; radius: number; segments: number }
    | { type: 'plane'; width: number; height: number }
    | { type: 'cylinder'; radiusTop: number; radiusBottom: number; height: number; segments: number }
    | { type: 'torus'; radius: number; tube: number; segments: number }
    | { type: 'ramp'; width: number; height: number; depth: number }
    | { type: 'stairs'; width: number; height: number; depth: number; steps: number }
    | { type: 'capsule'; radius: number; height: number; segments: number };

export type GeometryType = GeometryDoc['type'];

/** Value of a script property or a shader property. Colors are #rrggbb strings, vectors number arrays. */
export type ParamValue = number | string | boolean | number[];

/**
 * Surface materials. 'lit' is the engine's PBR material (LitMaterial),
 * 'unlit' ignores lights (UnLitMaterial), 'lambert' is a cheap matte
 * material lit by directional lights (LambertMaterial) and 'shader' renders
 * with a custom WGSL material shader.
 */
export type MaterialType = 'lit' | 'unlit' | 'lambert' | 'shader';

/**
 * Alpha handling. 'auto' blends when opacity is below 1 (on a model slot it
 * keeps the file's mode), 'mask' cuts out pixels whose alpha is below the
 * cutoff (foliage, fences), 'additive' and 'multiply' are transparent
 * blending modes (glow and fire, stains and tinted glass).
 */
export type AlphaMode = 'auto' | 'opaque' | 'blend' | 'mask' | 'additive' | 'multiply';

export interface MaterialDoc {
    /** 'shader' renders with the custom shader asset in `shader`. */
    type: MaterialType;
    /** Base color as #rrggbb. */
    color: string;
    opacity: number;
    metallic: number;
    roughness: number;
    emissive: string;
    emissiveIntensity: number;
    doubleSide: boolean;
    /** Texture asset id for the base color map, or null. */
    map: string | null;
    /** Shader asset id, used when `type` is 'shader'. */
    shader?: string | null;
    /** Values of the custom shader's declared properties, by property name. */
    params?: Record<string, ParamValue>;
    // The fields below are optional; a missing field means its default.
    /** Default 'auto'. */
    alphaMode?: AlphaMode;
    /** 'mask' mode: alpha below this is cut out. Default 0.5. */
    alphaCutoff?: number;
    /** Texture repeat [u, v] for every map. Default [1, 1]. */
    tiling?: [number, number];
    /** Texture offset [u, v] for every map. Default [0, 0]. */
    offset?: [number, number];
    /** Lit only: tangent space normal map (texture asset id). */
    normalMap?: string | null;
    /** Lit only: strength of the normal map. Default 1. */
    normalScale?: number;
    /** Lit only: glTF style metallic-roughness map, roughness in G and metallic in B. */
    metalRoughMap?: string | null;
    /** Lit only: ambient occlusion map (grayscale; the engine reads G like Unity). */
    aoMap?: string | null;
    /** Lit only: emission map, multiplied by the emissive color. */
    emissiveMap?: string | null;
    /** Lit only: clear coat layer, 0..1. Default 0. */
    clearcoat?: number;
    /** Lit only: roughness of the clear coat, 0..1. Default 0. */
    clearcoatRoughness?: number;
    /** Lit only: light passing through the surface (glass, water), 0..1. Default 0. */
    transmission?: number;
    /** Lit only: index of refraction. Default 1.5. */
    ior?: number;
    /** Lit only: thickness of the volume behind a transmissive surface. Default 0. */
    thickness?: number;
    /** Lit only: color light turns into while it travels through the volume. Default white. */
    attenuationColor?: string;
    /** Lit only: distance at which light inside the volume reaches the attenuation color; 0 means no absorption. */
    attenuationDistance?: number;
    /**
     * Material slot (DesignDoc.materials) this surface belongs to. Setting a
     * slot's swatch rewrites the material of every mesh in the slot.
     */
    slot?: string;
}

export interface MeshDoc {
    geometry: GeometryDoc;
    material: MaterialDoc;
    castShadow: boolean;
    receiveShadow: boolean;
}

export type LightType = 'directional' | 'point' | 'spot';

export interface LightDoc {
    type: LightType;
    color: string;
    intensity: number;
    castShadow: boolean;
    /** Point / spot only. */
    range: number;
    /** Point / spot only. */
    radius: number;
    /** Spot only: inner cone as a percentage of the outer cone (0..100). */
    innerAngle: number;
    /** Spot only: full cone angle in degrees. */
    outerAngle: number;
}

/**
 * Shading model for a material slot of an imported model: 'model' keeps the
 * file's own PBR material, 'unlit' and 'lambert' replace it with the engine
 * material of that name (keeping the file's color texture).
 */
export type SlotShading = 'model' | 'unlit' | 'lambert';

/**
 * Per-instance change to one material slot of an imported model. Every field
 * is optional: a missing field keeps the value from the model file.
 */
export interface MaterialOverride {
    color?: string;
    opacity?: number;
    metallic?: number;
    roughness?: number;
    emissive?: string;
    emissiveIntensity?: number;
    doubleSide?: boolean;
    /** Texture asset replacing the base color map; null removes the map. */
    map?: string | null;
    /** Built-in shading model replacing the file's material; missing means 'model'. */
    shading?: SlotShading;
    /** Custom shader asset replacing the material (takes precedence over `shading`). */
    shader?: string | null;
    params?: Record<string, ParamValue>;
    alphaMode?: AlphaMode;
    alphaCutoff?: number;
    /** PBR only: normal map strength. */
    normalScale?: number;
    /** PBR only: clear coat layer, 0..1. */
    clearcoat?: number;
    clearcoatRoughness?: number;
    /** PBR only: transmission (glass), 0..1. */
    transmission?: number;
    ior?: number;
}

/** Per-instance change to one mesh part of an imported model. */
export interface PartOverride {
    visible?: boolean;
    castShadow?: boolean;
    receiveShadow?: boolean;
    /** Material slot key to render this part with instead of its own. */
    material?: string;
    /** Local transform of the part, replacing the one from the file. */
    position?: Vec3;
    rotation?: Vec3;
    scale?: Vec3;
}

export interface ModelDoc {
    /** Model asset id (a .glb / .gltf blob stored in IndexedDB). */
    asset: string;
    /** Material slot overrides keyed by slot key (see engine/modelParts.ts). */
    materials?: Record<string, MaterialOverride>;
    /** Mesh part overrides keyed by part path (see engine/modelParts.ts). */
    parts?: Record<string, PartOverride>;
}

export interface CameraDoc {
    /** Vertical field of view in degrees. */
    fov: number;
    near: number;
    far: number;
    /** Play mode renders through the first camera marked main. */
    main: boolean;
}

/** A script attached to a node. */
export interface ScriptRef {
    /** Script asset id. */
    script: string;
    enabled: boolean;
    /** Values for the script's public fields, overriding the defaults in code. */
    props: Record<string, ParamValue>;
}

export interface NodeDoc {
    id: string;
    name: string;
    /** Parent node id, or null for scene root. Sibling order is array order. */
    parent: string | null;
    visible: boolean;
    position: Vec3;
    /** Euler angles in degrees, engine convention. */
    rotation: Vec3;
    scale: Vec3;
    mesh?: MeshDoc;
    light?: LightDoc;
    model?: ModelDoc;
    camera?: CameraDoc;
    scripts?: ScriptRef[];
    /**
     * Prefab instance: the id of the prefab (SceneDoc.prefabs). The node's
     * children are generated from the prefab (see prefabChild).
     */
    prefab?: string;
    /** Generated from the prefab of an ancestor instance; replaced whenever the prefab changes. */
    prefabChild?: boolean;
}

/**
 * A reusable group of primitives (a greybox asset) placed as instances.
 * Once the final mesh exists, a model asset replaces the template in every
 * instance: importing a .glb into the prefab stores it under `asset`.
 */
export interface PrefabDoc {
    id: string;
    name: string;
    /**
     * Template nodes. Nodes with parent null sit directly under an instance,
     * positioned relative to the prefab's pivot (the bottom center).
     */
    nodes: NodeDoc[];
    /** Asset id reserved for the model that replaces the template. */
    asset: string;
    /** True once a model is stored under `asset`: instances show the model instead of the template. */
    useModel?: boolean;
    /** Offset that puts the model's bottom center on the pivot. */
    modelOffset?: Vec3;
}

export type SkyType = 'atmospheric' | 'color';

/**
 * Dynamic diffuse global illumination (DDGI): a grid of light probes
 * captures the scene and lit surfaces receive the light it bounces.
 */
export interface GIDoc {
    enable: boolean;
    /** World position of the center of the probe grid. */
    center: Vec3;
    /** Probes along x, y and z. */
    counts: Vec3;
    /** Distance between neighboring probes. */
    spacing: number;
    /** Strength of the indirect light. */
    intensity: number;
    /** How much light keeps bouncing between surfaces, 0..1. */
    bounce: number;
    /** Re-capture the probes continuously (moving objects and lights); otherwise only after changes. */
    realtime: boolean;
}

export interface EnvironmentDoc {
    sky: SkyType;
    skyColor: string;
    /** Atmospheric sun azimuth, 0..1. */
    sunX: number;
    /** Atmospheric sun elevation, 0..1. */
    sunY: number;
    skyExposure: number;
    /** Tonemap exposure. */
    exposure: number;
    bloom: { enable: boolean; intensity: number; threshold: number };
    ao: { enable: boolean; strength: number; distance: number };
    fxaa: boolean;
    fog: { enable: boolean; color: string; near: number; far: number; intensity: number };
    gi: GIDoc;
}

/**
 * 'image' is a picture used for planning (concepts, paintovers, captures,
 * attachments), 'data' a JSON blob (scene snapshots). Neither is used by the
 * game.
 */
export type AssetKind = 'model' | 'texture' | 'image' | 'data';

export interface AssetMeta {
    id: string;
    name: string;
    kind: AssetKind;
    mime: string;
    size: number;
    /**
     * 'design' assets belong to the planning pipeline. Scene files (Ctrl+S)
     * list them without their data to stay small; project files carry them.
     */
    purpose?: 'design';
    /** Pixel size of images, when known. */
    width?: number;
    height?: number;
}

/** A JavaScript behaviour that runs in Play mode (see play/script.ts). */
export interface ScriptDoc {
    id: string;
    /** File-like name, e.g. "Rotator.js". */
    name: string;
    code: string;
}

export type ShaderKind = 'material' | 'post';

/**
 * A WGSL shader written in the editor. Material shaders render meshes,
 * post shaders run as a full screen pass in the render graph's post chain.
 * Properties are declared in the code with `// @property` lines.
 */
export interface ShaderDoc {
    id: string;
    /** File-like name, e.g. "Hologram.wgsl". */
    name: string;
    kind: ShaderKind;
    /** Material shaders only: lit surfaces go through the PBR lighting. */
    lighting: 'lit' | 'unlit';
    code: string;
}

/** A custom post effect in the post chain. */
export interface PostDoc {
    id: string;
    /** Post shader asset id. */
    shader: string;
    enabled: boolean;
    params: Record<string, ParamValue>;
}

/** User changes to the engine's render graph. */
export interface RenderGraphDoc {
    /** Built-in passes switched off, by pass name. */
    disabled: string[];
    /** Custom post effects, in chain order (before anti-aliasing and tone mapping). */
    posts: PostDoc[];
}

export interface SceneDoc {
    format: 'canonical-scene';
    version: 1;
    name: string;
    environment: EnvironmentDoc;
    assets: AssetMeta[];
    scripts: ScriptDoc[];
    shaders: ShaderDoc[];
    renderGraph: RenderGraphDoc;
    nodes: NodeDoc[];
    /** Prefab definitions; their instances are expanded into `nodes`. */
    prefabs: PrefabDoc[];
    build?: BuildDoc;
    /** The planning pipeline: brief, structure, shots and stage state. Not part of built games. */
    design: DesignDoc;
}

// ------------------------------------------------------------------ design

/**
 * Stages of the pipeline, in order: planning input, level (greybox),
 * lighting, materials (with a second lighting pass), effects, finish.
 */
export type StageId = 'brief' | 'level' | 'light' | 'material' | 'effects' | 'finish';

/** 'recheck': done before, but an earlier stage was reopened or the brief changed. */
export type StageStatus = 'todo' | 'active' | 'done' | 'recheck';

/** Stored state of a checklist item (automatic items are computed, see design/stages.ts). */
export interface CheckItemDoc {
    id: string;
    /** Text of items added by the user or the assistant; empty for built-in items. */
    text: string;
    done: boolean;
    by?: 'user' | 'ai';
    note?: string;
}

export interface StageDoc {
    status: StageStatus;
    checks: CheckItemDoc[];
    /** The assistant proposed completing the stage; the user approves it. */
    proposal?: { summary: string; at: string } | null;
    doneAt?: string;
    /** Why the stage needs another look. */
    recheck?: string;
}

export interface AreaObjectDoc {
    name: string;
    count?: number;
    note?: string;
    /** Placed in the level (ticked by the user or the assistant). */
    placed?: boolean;
}

export interface AreaDoc {
    id: string;
    name: string;
    description: string;
    /** What the area needs. */
    objects: AreaObjectDoc[];
    /** Mood of this area when it differs from the scene's mood. */
    mood?: string;
    /** Rough placement for the greybox in meters: center on the ground, size x y z. */
    bounds?: { center: Vec3; size: Vec3 } | null;
    /** Earliest stage the area has to go through again after the brief changed it. */
    rework?: StageId | null;
    reworkNote?: string;
}

/** How the scene is built: decided first, before the areas. */
export interface LayoutDoc {
    /** Kind of place, overall size, ground, how the areas sit and connect. */
    summary: string;
    /** Overall footprint x and z and height y, in meters. */
    size?: Vec3 | null;
    connections: { from: string; to: string; kind?: string; note?: string }[];
}

/** Measurements the level is built to. */
export interface SpecsDoc {
    playerHeight: number;
    eyeHeight: number;
    playerRadius: number;
    doorWidth: number;
    doorHeight: number;
    /** Highest step the player climbs without jumping. */
    stepHeight: number;
    /** Steepest walkable slope, degrees. */
    maxSlope: number;
    notes: string;
}

export interface MoodDoc {
    description: string;
    timeOfDay: string;
    /** Key light direction in degrees (azimuth around +Y from +Z, elevation above the horizon) and color. */
    keyLight: { azimuth: number; elevation: number; color: string; note: string };
    palette: string[];
}

export interface RoutePointDoc {
    id: string;
    name: string;
    area?: string | null;
    position?: Vec3 | null;
    note?: string;
    /** Reached with the walk camera. */
    visited?: boolean;
}

export interface SightlineDoc {
    id: string;
    /** Route point or area id, or a free description. */
    from: string;
    /** Landmark: object name, area id or a description. */
    to: string;
    note?: string;
    /** Checked: true visible, false blocked, missing not checked yet. */
    ok?: boolean | null;
}

/** Play requirements: route, landmark sight lines and the order of areas. */
export interface PlayDoc {
    route: RoutePointDoc[];
    sightlines: SightlineDoc[];
    areaOrder: string[];
    notes: string;
}

export interface EffectItemDoc {
    id: string;
    name: string;
    area?: string | null;
    note?: string;
    done?: boolean;
}

export interface ConceptDoc {
    /** Image asset id. */
    asset: string;
    area?: string | null;
    note?: string;
}

export interface PaintoverDoc {
    asset: string;
    source: 'generated' | 'upload';
    at: string;
    model?: string;
    prompt?: string;
    seed?: number | null;
    /** Asset ids of the reference images. */
    refs?: string[];
    params?: Record<string, ParamValue>;
    cost?: number | null;
}

export interface ShotCaptureDoc {
    stage: StageId;
    asset: string;
    at: string;
    /** Match with the target image (0..100) when it was captured. */
    score?: number | null;
    /** Captured by hand during the stage (not at its completion). */
    manual?: boolean;
}

/** A camera bookmark framed like a concept image. */
export interface ShotDoc {
    id: string;
    name: string;
    area?: string | null;
    /** The concept this shot matches, kept as the record of the original idea. */
    concept?: string | null;
    camera: CameraState;
    /** Frame width / height (the concept image's). */
    aspect: number;
    paintovers: PaintoverDoc[];
    /** Chosen paintover: the target every later comparison uses. */
    target?: string | null;
    /** The level changed after the target was chosen. */
    stale?: boolean;
    history: ShotCaptureDoc[];
    /** Accepted in the final comparison. */
    approved?: boolean;
}

/** A named surface of the level; its swatch is applied with the world space triplanar shader. */
export interface MaterialSlotDoc {
    id: string;
    name: string;
    description: string;
    /** Albedo swatch texture asset, or null while the slot is empty. */
    swatch?: string | null;
    color: string;
    roughness: number;
    metallic: number;
    /** Meters per texture tile. */
    tile: number;
}

export interface SnapshotDoc {
    id: string;
    /** 'data' asset holding the scene JSON. */
    asset: string;
    name: string;
    stage?: StageId | null;
    at: string;
    /** Assets the snapshot uses, kept in the browser while the snapshot exists. */
    assets: string[];
}

export interface QuestionDoc {
    id: string;
    text: string;
    answer: string;
    area?: string | null;
}

export interface DesignDoc {
    version: 1;
    /** Project id; keys the assistant's saved conversation in this browser. */
    id: string;
    brief: {
        text: string;
        /** The user chose to work without a brief. */
        skipped?: boolean;
        /** Brief text the current structure was made from. */
        structured?: string;
        structuredAt?: string;
    };
    layout: LayoutDoc;
    areas: AreaDoc[];
    concepts: ConceptDoc[];
    specs: SpecsDoc;
    mood: MoodDoc;
    play: PlayDoc;
    effects: EffectItemDoc[];
    materials: MaterialSlotDoc[];
    budget: { shadowLights: number; fps: number };
    questions: QuestionDoc[];
    shots: ShotDoc[];
    stage: StageId;
    stages: Record<StageId, StageDoc>;
    snapshots: SnapshotDoc[];
    /** Short running context of the scene for the assistant, refreshed at checkpoints. */
    memo: { text: string; at?: string };
    /** Placement stays editable in the stages that lock it. */
    unlocked?: boolean;
}

/** Build & Deploy settings of a project (File > Build & Deploy). */
export interface BuildDoc {
    /** Page title of the game; the scene name when empty. */
    title?: string;
    /** GitHub repository: "name" or "owner/name". */
    repo?: string;
    /** Branch GitHub Pages publishes. */
    branch?: string;
}

/** Editor camera state. Saved with the scene but kept out of undo history. */
export interface CameraState {
    target: Vec3;
    /** Degrees around +Y. */
    yaw: number;
    /** Degrees above the horizon. */
    pitch: number;
    distance: number;
    fov: number;
}

/** The file written by "Save" and read by "Open". */
export interface SceneFile extends SceneDoc {
    camera?: CameraState;
    /** Asset blobs, base64 encoded, keyed by asset id. */
    embedded?: Record<string, string>;
}

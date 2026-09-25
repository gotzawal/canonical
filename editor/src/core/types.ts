// Scene document: the editor's source of truth. It is plain JSON so it can be
// snapshotted for undo/redo, autosaved and written to a file. The engine scene
// is rebuilt from it by engine/sync.ts.

export type Vec3 = [number, number, number];

export type GeometryDoc =
    | { type: 'box'; width: number; height: number; depth: number }
    | { type: 'sphere'; radius: number; segments: number }
    | { type: 'plane'; width: number; height: number }
    | { type: 'cylinder'; radiusTop: number; radiusBottom: number; height: number; segments: number }
    | { type: 'torus'; radius: number; tube: number; segments: number };

export type GeometryType = GeometryDoc['type'];

/** Value of a script property or a shader property. Colors are #rrggbb strings, vectors number arrays. */
export type ParamValue = number | string | boolean | number[];

export type MaterialType = 'lit' | 'unlit' | 'shader';

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
    /** Custom shader asset replacing the material. */
    shader?: string | null;
    params?: Record<string, ParamValue>;
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
}

export type SkyType = 'atmospheric' | 'color';

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
}

export type AssetKind = 'model' | 'texture';

export interface AssetMeta {
    id: string;
    name: string;
    kind: AssetKind;
    mime: string;
    size: number;
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

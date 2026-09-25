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

export interface MaterialDoc {
    type: 'lit' | 'unlit';
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

export interface ModelDoc {
    /** Model asset id (a .glb / .gltf blob stored in IndexedDB). */
    asset: string;
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

export interface SceneDoc {
    format: 'canonical-scene';
    version: 1;
    name: string;
    environment: EnvironmentDoc;
    assets: AssetMeta[];
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

import { defaultMemory } from './behavior/format';
import { defaultDesign } from './design';
import { Camera, Environment, Geometry, GI, Light, Material } from './model';
import { defaults } from './schema';
import {
    SCENE_VERSION, type CameraDoc, type CameraState, type EnvironmentDoc, type GeometryDoc, type GeometryType, type GIDoc,
    type LightDoc, type LightType, type MaterialDoc, type MeshDoc, type NodeDoc, type NodeWith, type RenderGraphDoc, type SceneDoc,
    type Vec3,
} from './types';

export { uid } from './ids';
import { uid } from './ids';

export const defaultGeometry = <T extends GeometryType>(type: T) => Geometry.parse({ type }) as Extract<GeometryDoc, { type: T }>;

export const defaultMaterial = (color = '#c8c8c8'): MaterialDoc => Material.parse({ color });

export const defaultLight = (type: LightType): LightDoc =>
    Light.parse({ type, intensity: type === 'directional' ? 3 : type === 'point' ? 4 : 6, castShadow: type === 'directional' });

export const defaultEnvironment = (): EnvironmentDoc => defaults(Environment);

/** 8 x 3 x 8 probes, 2 units apart: covers the default 20 x 20 ground. */
export const defaultGI = (): GIDoc => defaults(GI);

export function defaultRenderGraph(): RenderGraphDoc {
    return { disabled: [], posts: [] };
}

export const defaultCameraDoc = (): CameraDoc => defaults(Camera);

export function defaultCamera(): CameraState {
    return { target: [0, 0.5, 0], yaw: 35, pitch: 24, distance: 9, fov: 50 };
}

export function makeNode(name: string, parent: string | null = null, position: Vec3 = [0, 0, 0]): NodeDoc {
    return {
        id: uid(),
        name,
        parent,
        visible: true,
        position: [...position] as Vec3,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
    };
}

const GEOMETRY_NAMES: Record<GeometryType, string> = {
    box: 'Cube',
    sphere: 'Sphere',
    plane: 'Plane',
    cylinder: 'Cylinder',
    cone: 'Cone',
    torus: 'Torus',
    ramp: 'Ramp',
    stairs: 'Stairs',
    capsule: 'Capsule',
};

/** Height of a shape's bounds, to rest it on the ground (shapes are centered on their origin). */
export function geometryHeight(g: GeometryDoc): number {
    switch (g.type) {
        case 'box':
        case 'ramp':
        case 'stairs':
        case 'cylinder':
        case 'cone':
        case 'capsule':
            return g.height;
        case 'sphere':
            return g.radius * 2;
        case 'torus':
            return g.tube * 2;
        case 'plane':
            return 0;
    }
}

export function makeMeshNode(type: GeometryType, parent: string | null = null): NodeWith<'mesh'> {
    const mesh: MeshDoc = { geometry: defaultGeometry(type), material: defaultMaterial(), castShadow: true, receiveShadow: true };
    return { ...makeNode(GEOMETRY_NAMES[type], parent, [0, geometryHeight(mesh.geometry) / 2, 0]), mesh };
}

const LIGHT_NAMES: Record<LightType, string> = {
    directional: 'Directional Light',
    point: 'Point Light',
    spot: 'Spot Light',
};

export function makeLightNode(type: LightType, parent: string | null = null): NodeWith<'light'> {
    const node = { ...makeNode(LIGHT_NAMES[type], parent), light: defaultLight(type) };
    if (type === 'directional') {
        node.position = [0, 6, 0];
        node.rotation = [50, 30, 0];
    } else if (type === 'point') {
        node.position = [0, 2.5, 0];
    } else {
        node.position = [0, 4, 0];
        node.rotation = [90, 0, 0];
    }
    return node;
}

export function makeCameraNode(parent: string | null = null): NodeWith<'camera'> {
    // Cameras look down their local +Z axis: this one faces the origin.
    return { ...makeNode('Camera', parent, [0, 2, 8]), rotation: [14, 180, 0], camera: defaultCameraDoc() };
}

export function newScene(): SceneDoc {
    const sun = makeLightNode('directional');
    sun.name = 'Sun';
    const ground = makeMeshNode('plane');
    ground.name = 'Ground';
    ground.mesh.geometry = { type: 'plane', width: 20, height: 20 };
    ground.mesh.material = defaultMaterial('#7d8288');
    ground.mesh.material.roughness = 0.9;
    ground.mesh.castShadow = false;
    const cube = makeMeshNode('box');
    cube.mesh.material = defaultMaterial('#4f8fe6');
    cube.mesh.material.roughness = 0.35;
    const sphere = makeMeshNode('sphere');
    sphere.position = [1.6, 0.5, 0.4];
    sphere.mesh.material = defaultMaterial('#e6a04f');
    sphere.mesh.material.metallic = 0.8;
    sphere.mesh.material.roughness = 0.25;
    return {
        format: 'canonical-scene',
        version: SCENE_VERSION,
        name: 'Untitled Scene',
        environment: defaultEnvironment(),
        assets: [],
        scripts: [],
        shaders: [],
        renderGraph: defaultRenderGraph(),
        nodes: [sun, ground, cube, sphere],
        prefabs: [],
        blackboards: [],
        behaviors: [],
        memory: defaultMemory(),
        aiModels: [],
        design: defaultDesign(),
    };
}

export function emptyScene(): SceneDoc {
    const sun = makeLightNode('directional');
    sun.name = 'Sun';
    return {
        format: 'canonical-scene',
        version: SCENE_VERSION,
        name: 'Untitled Scene',
        environment: defaultEnvironment(),
        assets: [],
        scripts: [],
        shaders: [],
        renderGraph: defaultRenderGraph(),
        nodes: [sun],
        prefabs: [],
        blackboards: [],
        behaviors: [],
        memory: defaultMemory(),
        aiModels: [],
        design: defaultDesign(),
    };
}

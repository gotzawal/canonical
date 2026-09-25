import type {
    CameraState, EnvironmentDoc, GeometryDoc, GeometryType, LightDoc, LightType,
    MaterialDoc, NodeDoc, SceneDoc, Vec3,
} from './types';

export function uid(prefix = 'n'): string {
    const rnd = crypto.getRandomValues(new Uint32Array(2));
    return `${prefix}_${rnd[0].toString(36)}${rnd[1].toString(36)}`;
}

export function defaultGeometry(type: GeometryType): GeometryDoc {
    switch (type) {
        case 'box': return { type, width: 1, height: 1, depth: 1 };
        case 'sphere': return { type, radius: 0.5, segments: 32 };
        case 'plane': return { type, width: 10, height: 10 };
        case 'cylinder': return { type, radiusTop: 0.5, radiusBottom: 0.5, height: 1, segments: 32 };
        case 'torus': return { type, radius: 0.5, tube: 0.18, segments: 32 };
    }
}

export function defaultMaterial(color = '#c8c8c8'): MaterialDoc {
    return {
        type: 'lit',
        color,
        opacity: 1,
        metallic: 0,
        roughness: 0.6,
        emissive: '#000000',
        emissiveIntensity: 1,
        doubleSide: false,
        map: null,
    };
}

export function defaultLight(type: LightType): LightDoc {
    return {
        type,
        color: '#ffffff',
        intensity: type === 'directional' ? 3 : type === 'point' ? 4 : 6,
        castShadow: type === 'directional',
        range: 10,
        radius: 0.1,
        innerAngle: 60,
        outerAngle: 60,
    };
}

export function defaultEnvironment(): EnvironmentDoc {
    return {
        sky: 'atmospheric',
        skyColor: '#3a4250',
        sunX: 0.71,
        sunY: 0.6,
        skyExposure: 1,
        exposure: 1,
        bloom: { enable: false, intensity: 0.6, threshold: 1 },
        ao: { enable: false, strength: 1, distance: 1 },
        fxaa: true,
        fog: { enable: false, color: '#aab4be', near: 5, far: 80, intensity: 1 },
    };
}

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
    torus: 'Torus',
};

export function makeMeshNode(type: GeometryType, parent: string | null = null): NodeDoc {
    const node = makeNode(GEOMETRY_NAMES[type], parent);
    node.mesh = {
        geometry: defaultGeometry(type),
        material: defaultMaterial(),
        castShadow: true,
        receiveShadow: true,
    };
    if (type === 'torus') node.position = [0, 0.18, 0];
    else if (type !== 'plane') node.position = [0, 0.5, 0];
    return node;
}

const LIGHT_NAMES: Record<LightType, string> = {
    directional: 'Directional Light',
    point: 'Point Light',
    spot: 'Spot Light',
};

export function makeLightNode(type: LightType, parent: string | null = null): NodeDoc {
    const node = makeNode(LIGHT_NAMES[type], parent);
    node.light = defaultLight(type);
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
        version: 1,
        name: 'Untitled Scene',
        environment: defaultEnvironment(),
        assets: [],
        nodes: [sun, ground, cube, sphere],
    };
}

export function emptyScene(): SceneDoc {
    const sun = makeLightNode('directional');
    sun.name = 'Sun';
    return {
        format: 'canonical-scene',
        version: 1,
        name: 'Untitled Scene',
        environment: defaultEnvironment(),
        assets: [],
        nodes: [sun],
    };
}

import {
    defaultEnvironment, defaultMaterial, defaultRenderGraph, makeCameraNode, makeLightNode, makeMeshNode, makeNode, uid,
} from './core/defaults';
import { defaultDesign } from './core/design';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES } from './core/templates';
import type { GeometryType, NodeDoc, ParamValue, SceneDoc, ScriptDoc, ShaderDoc, Vec3 } from './core/types';

function script(template: string, name: string): ScriptDoc {
    const t = SCRIPT_TEMPLATES.find((x) => x.id === template)!;
    return { id: uid('s'), name: `${name}.js`, code: t.code(name) };
}

function shader(template: string, name: string): ShaderDoc {
    const t = SHADER_TEMPLATES.find((x) => x.id === template)!;
    return { id: uid('sh'), name: `${name}.wgsl`, kind: t.kind, lighting: t.lighting, code: t.code };
}

function attach(node: NodeDoc, s: ScriptDoc, props: Record<string, ParamValue> = {}) {
    node.scripts = [...(node.scripts ?? []), { script: s.id, enabled: true, props }];
}

/**
 * A small scene that shows off primitives, materials and light types, plus
 * scripts (press Play), a custom shader material, a post effect and a game
 * camera.
 */
export function exampleShowcase(): SceneDoc {
    const nodes: NodeDoc[] = [];
    const rotator = script('rotator', 'Rotator');
    const bob = script('bob', 'Bobbing');
    const click = script('click', 'ClickToRecolor');
    const hologram = shader('unlit', 'Hologram');
    const vignette = shader('vignette', 'Vignette');
    const sun = makeLightNode('directional');
    sun.name = 'Sun';
    sun.rotation = [42, 145, 0];
    sun.light.intensity = 2.6;
    nodes.push(sun);

    const floor = makeMeshNode('plane');
    floor.name = 'Floor';
    floor.mesh.geometry = { type: 'plane', width: 30, height: 30 };
    floor.mesh.material = { ...defaultMaterial('#5c636b'), roughness: 0.85 };
    floor.mesh.castShadow = false;
    nodes.push(floor);

    const group = makeNode('Primitives');
    nodes.push(group);
    const shapes: { type: GeometryType; color: string; metallic: number; roughness: number; x: number }[] = [
        { type: 'box', color: '#e25b5b', metallic: 0, roughness: 0.45, x: -4 },
        { type: 'sphere', color: '#f2b53c', metallic: 1, roughness: 0.2, x: -2 },
        { type: 'cylinder', color: '#4fb286', metallic: 0.2, roughness: 0.5, x: 0 },
        { type: 'torus', color: '#4f8fe6', metallic: 0.7, roughness: 0.3, x: 2 },
        { type: 'sphere', color: '#dcdfe3', metallic: 0, roughness: 0.05, x: 4 },
    ];
    const prims: NodeDoc[] = [];
    for (const s of shapes) {
        const n = makeMeshNode(s.type, group.id);
        n.position = [s.x, n.position[1], 0] as Vec3;
        n.mesh.material = { ...defaultMaterial(s.color), metallic: s.metallic, roughness: s.roughness };
        nodes.push(n);
        prims.push(n);
    }
    const [box, , , torus, pearl] = prims;
    attach(box, click);
    torus.name = 'Spinning Torus';
    // Raised so it clears the floor while it tumbles.
    torus.position = [2, 0.9, 0];
    attach(torus, rotator, { speed: 60, axis: 'x' });
    pearl.name = 'Hologram Sphere';
    pearl.mesh!.material = { ...pearl.mesh!.material, type: 'shader', shader: hologram.id, params: { glow: '#3dd8ff' } };

    const glass = makeMeshNode('box');
    glass.name = 'Glass Panel';
    glass.position = [0, 1.25, -2.5];
    glass.mesh.geometry = { type: 'box', width: 6, height: 2.5, depth: 0.1 };
    glass.mesh.material = { ...defaultMaterial('#9ad0ff'), opacity: 0.35, roughness: 0.1 };
    nodes.push(glass);

    const glow = makeMeshNode('sphere');
    glow.name = 'Glow Orb';
    glow.position = [0, 3.2, 1.5];
    glow.scale = [0.6, 0.6, 0.6];
    glow.mesh.material = { ...defaultMaterial('#ffffff'), emissive: '#ff8a3d', emissiveIntensity: 4 };
    glow.mesh.castShadow = false;
    attach(glow, bob, { height: 0.3, speed: 1.5 });
    nodes.push(glow);

    const warm = makeLightNode('point');
    warm.name = 'Warm Light';
    warm.position = [-3, 2, 2];
    warm.light = { ...warm.light, color: '#ffb36b', intensity: 3, range: 7 };
    nodes.push(warm);

    const spot = makeLightNode('spot');
    spot.name = 'Spot Light';
    spot.position = [3.5, 4.5, 2];
    spot.rotation = [65, -30, 0];
    spot.light = { ...spot.light, color: '#9fc4ff', intensity: 5, range: 12, outerAngle: 50 };
    nodes.push(spot);

    // Play renders through this camera.
    const cam = makeCameraNode();
    cam.name = 'Main Camera';
    cam.position = [0, 4.5, 11];
    cam.rotation = [17.6, 180, 0];
    nodes.push(cam);

    const env = defaultEnvironment();
    env.bloom = { enable: true, intensity: 0.5, threshold: 1 };
    const renderGraph = defaultRenderGraph();
    renderGraph.posts.push({ id: uid('p'), shader: vignette.id, enabled: true, params: { strength: 0.5 } });
    return {
        format: 'canonical-scene',
        version: 1,
        name: 'Showcase',
        environment: env,
        assets: [],
        scripts: [rotator, bob, click],
        shaders: [hologram, vignette],
        renderGraph,
        nodes,
        prefabs: [],
        design: defaultDesign(),
    };
}

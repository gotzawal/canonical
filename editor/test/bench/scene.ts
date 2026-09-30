// A synthetic scene the size of a large level: thousands of objects in
// groups a few levels deep (primitives with materials, lights, models with
// overrides, scripts, agents, prefab instances), with assets, scripts,
// shaders, behavior trees and a filled-in plan. The benchmarks measure the
// editor's work on it; the browser tests load it too.

import { defaultMaterial, makeLightNode, makeMeshNode, makeNode, newScene } from '../../src/core/defaults';
import { sanitize } from '../../src/core/store';
import type { GeometryDoc, GeometryType, NodeDoc, SceneDoc, Vec3 } from '../../src/core/types';
import { planBuilding, type RoomSpec } from '../../src/design/rooms';

export interface SyntheticOptions {
    /** Objects in the scene. */
    nodes?: number;
    /** Children of a group. */
    fanout?: number;
    /** Objects showing imported models (whose files are not there: the browser tests leave them out). */
    models?: boolean;
    seed?: number;
}

const SHAPES: GeometryType[] = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'ramp', 'stairs', 'capsule'];

export function syntheticScene({ nodes = 5000, fanout = 12, models: withModels = true, seed = 1 }: SyntheticOptions = {}): SceneDoc {
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)];
    const num = (min: number, max: number, digits = 3) => Number((min + rnd() * (max - min)).toFixed(digits));
    const doc = newScene();
    doc.name = `Synthetic ${nodes}`;

    const models = Array.from({ length: 24 }, (_, i) => ({ id: `am${i}`, name: `model-${i}.glb`, kind: 'model' as const, mime: 'model/gltf-binary', size: 400_000 + i * 1000 }));
    const textures = Array.from({ length: 60 }, (_, i) => ({ id: `at${i}`, name: `texture-${i}.png`, kind: 'texture' as const, mime: 'image/png', size: 90_000 + i * 100, width: 1024, height: 1024 }));
    const planning = Array.from({ length: 30 }, (_, i) => ({ id: `ad${i}`, name: `concept-${i}.jpg`, kind: 'image' as const, mime: 'image/jpeg', size: 120_000, purpose: 'design' as const }));
    doc.assets = [...models, ...textures, ...planning];
    doc.scripts = Array.from({ length: 16 }, (_, i) => ({
        id: `s${i}`,
        name: `Behaviour${i}.js`,
        code: `export default class Behaviour${i} extends Script {\n    speed = ${i + 1};\n    update(dt) {\n        this.object3D.rotationY += this.speed * dt;\n    }\n}\n`.repeat(4),
    }));
    doc.shaders = Array.from({ length: 6 }, (_, i) => ({
        id: `sh${i}`,
        name: `Surface${i}.wgsl`,
        kind: 'material' as const,
        lighting: 'lit' as const,
        code: `// @property tint: color = #ffffff\nfn surface(input: SurfaceInput) -> SurfaceOutput {\n    var out: SurfaceOutput;\n    out.color = vec4f(props.tint.rgb, 1.0);\n    return out;\n}\n`,
    }));
    doc.blackboards = [{ id: 'bb1', name: 'Guard', keys: [] } as any];
    doc.behaviors = Array.from({ length: 4 }, (_, i) => ({ id: `bt${i}`, name: `Tree ${i}`, schema: 'bb1', root: null, nodes: [], services: [] }) as any);

    const out: NodeDoc[] = [];
    const add = (n: NodeDoc) => {
        out.push(n);
        return n;
    };
    const object = (parent: string | null, i: number): NodeDoc => {
        const r = rnd();
        let n: NodeDoc;
        if (r < 0.66) {
            n = makeMeshNode(pick(SHAPES), parent);
            const m = n.mesh!.material;
            m.color = `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`;
            m.roughness = num(0, 1, 2);
            m.metallic = num(0, 1, 2);
            if (rnd() < 0.3) m.map = pick(textures).id;
            if (rnd() < 0.1) m.normalMap = pick(textures).id;
        } else if (r < 0.72) {
            n = makeLightNode(pick(['point', 'spot'] as const), parent);
        } else if (r < 0.84 && withModels) {
            n = makeNode(`Prop ${i}`, parent);
            n.model = { asset: pick(models).id };
            if (rnd() < 0.5) n.model.materials = { Body: { color: '#886644', roughness: 0.6 } } as any;
        } else {
            n = makeNode(`Marker ${i}`, parent);
        }
        n.id = `o${i}`;
        n.name = `${n.name} ${i}`;
        n.position = [num(-80, 80), num(0, 6), num(-80, 80)];
        n.rotation = [0, num(0, 360, 1), 0];
        if (rnd() < 0.08) n.scripts = [{ script: pick(doc.scripts).id, enabled: true, props: { speed: num(0, 4, 1) } }];
        if (rnd() < 0.02) n.agent = { tree: pick(doc.behaviors).id, enabled: true, values: {} };
        return n;
    };

    // Groups of `fanout` objects, some of them groups again, two or three levels deep.
    let made = 0;
    const group = (parent: string | null, depth: number) => {
        const g = add(makeNode(`Group ${made}`, parent, [num(-60, 60), 0, num(-60, 60)]));
        g.id = `g${made++}`;
        for (let k = 0; k < fanout && made < nodes; k++) {
            if (depth < 2 && rnd() < 0.15) group(g.id, depth + 1);
            else add(object(g.id, made++));
        }
    };
    while (made < nodes) group(null, 0);

    doc.nodes = [...doc.nodes, ...out];
    const d = doc.design;
    d.brief.text = 'A walled courtyard at dusk with a guard patrolling between market stalls. '.repeat(20);
    d.areas = Array.from({ length: 12 }, (_, i) => ({
        id: `area${i}`,
        name: `Area ${i}`,
        description: 'Stalls, crates and lanterns around a fountain. '.repeat(4),
        objects: Array.from({ length: 10 }, (_, k) => ({ name: `Prop ${i * 10 + k}`, count: 1 + (k % 3) })),
        bounds: { center: [i * 10, 0, 0], size: [9, 4, 9] },
    }));
    d.concepts = planning.slice(0, 12).map((a, i) => ({ asset: a.id, area: `area${i}` }));
    return sanitize(JSON.parse(JSON.stringify(doc)));
}

/** A seeded generator of numbers in [0, 1). */
function random(seed: number) {
    let s = seed >>> 0 || 1;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** A mesh object with deterministic id, shape and color (the same kind of object gets the same shape and material). */
function prop(id: string, name: string, parent: string | null, geometry: GeometryDoc, color: string, position: Vec3, rotationY = 0): NodeDoc {
    const n = makeMeshNode(geometry.type, parent);
    n.id = id;
    n.name = name;
    n.mesh.geometry = geometry;
    n.mesh.material = defaultMaterial(color);
    n.position = position;
    n.rotation = [0, rotationY, 0];
    return n;
}

/**
 * A level as the assistant builds it: a building of ten rooms in two rows
 * (the plan build_rooms makes, each room with a door and a window), about
 * 300 pieces of furniture that repeat the same few shapes and materials,
 * and a few lamps. For measuring what a typical level costs to draw.
 */
export function aiLevelScene(seed = 1): SceneDoc {
    const rnd = random(seed);
    const doc = newScene();
    doc.name = 'AI Level';
    doc.nodes = doc.nodes.filter((n) => n.name === 'Sun' || n.name === 'Ground');
    const ground = doc.nodes.find((n) => n.name === 'Ground')!;
    ground.mesh!.geometry = { type: 'plane', width: 60, height: 60 };

    const rooms: RoomSpec[] = [];
    for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 5; col++) {
            const x = col * 4 - 10, z = row * 5 - 5;
            rooms.push({
                name: `Room ${row * 5 + col + 1}`,
                min: [x, z],
                max: [x + 4, z + 5],
                floorY: 0.1,
                height: 3,
                floor: true,
                ceiling: true,
                open: [],
                openings: [
                    { side: col < 4 ? 'x_max' : 'x_min', kind: 'door', width: 1.2, height: 2.2, sill: 0 },
                    { side: row === 0 ? 'z_min' : 'z_max', kind: 'window', width: 1.2, height: 1.2, sill: 0.9 },
                ],
                holes: [],
            });
        }
    }
    const plan = planBuilding(rooms, { wall: 0.2, slab: 0.2 });
    const building = makeNode('Building', null, [0, 0.1, 0]);
    building.id = 'building';
    doc.nodes.push(building);
    plan.pieces.forEach((p, i) => {
        const color = p.kind === 'wall' ? '#b8b4ac' : p.kind === 'floor' ? '#8a7560' : '#d8d8d8';
        doc.nodes.push(prop(`piece${i}`, p.name, building.id, { type: 'box', width: p.size[0], height: p.size[1], depth: p.size[2] }, color, [p.center[0], p.center[1] - 0.1, p.center[2]]));
    });

    // Furniture: the same few kinds everywhere, as the assistant places them.
    const kinds: { name: string; geometry: GeometryDoc; color: string; y: number }[] = [
        { name: 'Crate', geometry: { type: 'box', width: 0.6, height: 0.6, depth: 0.6 }, color: '#8b6a45', y: 0.4 },
        { name: 'Barrel', geometry: { type: 'cylinder', radiusTop: 0.3, radiusBottom: 0.3, height: 0.9, segments: 16 }, color: '#6d4c30', y: 0.55 },
        { name: 'Table', geometry: { type: 'box', width: 1.2, height: 0.08, depth: 0.8 }, color: '#9a7b58', y: 0.85 },
        { name: 'Stool', geometry: { type: 'cylinder', radiusTop: 0.2, radiusBottom: 0.2, height: 0.45, segments: 12 }, color: '#9a7b58', y: 0.33 },
        { name: 'Pot', geometry: { type: 'sphere', radius: 0.25, segments: 16 }, color: '#b0643c', y: 0.35 },
    ];
    let k = 0;
    for (let i = 0; i < 300; i++) {
        const room = rooms[i % rooms.length];
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        const x = room.min[0] + 0.6 + rnd() * (room.max[0] - room.min[0] - 1.2);
        const z = room.min[1] + 0.6 + rnd() * (room.max[1] - room.min[1] - 1.2);
        doc.nodes.push(prop(`prop${k++}`, `${kind.name} ${i}`, null, kind.geometry, kind.color, [x, kind.y, z], Math.floor(rnd() * 4) * 90));
    }
    for (let i = 0; i < 8; i++) {
        const lamp = makeLightNode('point');
        lamp.id = `lamp${i}`;
        lamp.name = `Lamp ${i}`;
        const room = rooms[i];
        lamp.position = [(room.min[0] + room.max[0]) / 2, 2.6, (room.min[1] + room.max[1]) / 2];
        lamp.light!.castShadow = false;
        doc.nodes.push(lamp);
    }
    return sanitize(JSON.parse(JSON.stringify(doc)));
}

/**
 * Outdoors: a 200 m ground with `props` trees (trunk and crown), rocks,
 * bushes and fence posts spread over it, lit by the sun. For measuring
 * large scenes of repeated objects.
 */
export function outdoorScene(props = 2000, seed = 1): SceneDoc {
    const rnd = random(seed);
    const doc = newScene();
    doc.name = `Outdoor ${props}`;
    doc.nodes = doc.nodes.filter((n) => n.name === 'Sun' || n.name === 'Ground');
    const ground = doc.nodes.find((n) => n.name === 'Ground')!;
    ground.mesh!.geometry = { type: 'plane', width: 200, height: 200 };
    const at = (): [number, number] => [Math.round((rnd() * 190 - 95) * 100) / 100, Math.round((rnd() * 190 - 95) * 100) / 100];
    let made = 0;
    while (made < props) {
        const r = rnd();
        const [x, z] = at();
        const i = made;
        if (r < 0.45 && made + 3 <= props) {
            const tree = makeNode(`Tree ${i}`, null, [x, 0, z]);
            tree.id = `tree${i}`;
            doc.nodes.push(tree);
            doc.nodes.push(prop(`trunk${i}`, 'Trunk', tree.id, { type: 'cylinder', radiusTop: 0.15, radiusBottom: 0.2, height: 2, segments: 8 }, '#5a4030', [0, 1, 0]));
            doc.nodes.push(prop(`crown${i}`, 'Crown', tree.id, { type: 'cone', radius: 1.2, height: 3, segments: 8 }, '#2f6b35', [0, 3.2, 0]));
            made += 3;
        } else if (r < 0.7) {
            doc.nodes.push(prop(`rock${i}`, `Rock ${i}`, null, { type: 'sphere', radius: 0.5, segments: 12 }, '#7a7a78', [x, 0.3, z]));
            made++;
        } else if (r < 0.85) {
            doc.nodes.push(prop(`bush${i}`, `Bush ${i}`, null, { type: 'sphere', radius: 0.6, segments: 10 }, '#3d7a3a', [x, 0.4, z]));
            made++;
        } else {
            doc.nodes.push(prop(`post${i}`, `Fence Post ${i}`, null, { type: 'box', width: 0.15, height: 1.2, depth: 0.15 }, '#8b6a45', [x, 0.6, z], Math.floor(rnd() * 360)));
            made++;
        }
    }
    return sanitize(JSON.parse(JSON.stringify(doc)));
}

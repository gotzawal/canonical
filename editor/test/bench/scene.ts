// A synthetic scene the size of a large level: thousands of objects in
// groups a few levels deep (primitives with materials, lights, models with
// overrides, scripts, agents, prefab instances), with assets, scripts,
// shaders, behavior trees and a filled-in plan. The benchmarks measure the
// editor's work on it; the browser tests load it too.

import { makeLightNode, makeMeshNode, makeNode, newScene } from '../../src/core/defaults';
import { sanitize } from '../../src/core/store';
import type { GeometryType, NodeDoc, SceneDoc } from '../../src/core/types';

export interface SyntheticOptions {
    /** Objects in the scene. */
    nodes?: number;
    /** Children of a group. */
    fanout?: number;
    seed?: number;
}

const SHAPES: GeometryType[] = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'ramp', 'stairs', 'capsule'];

export function syntheticScene({ nodes = 5000, fanout = 12, seed = 1 }: SyntheticOptions = {}): SceneDoc {
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
        } else if (r < 0.84) {
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

import {
    defaultEnvironment, defaultMaterial, defaultRenderGraph, makeCameraNode, makeLightNode, makeMeshNode, makeNode, uid,
} from './core/defaults';
import { defaultMemory } from './core/behavior/format';
import { applyBehaviorOps, writeBehaviorChanges } from './core/behavior/ops';
import { defaultDesign } from './core/design';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES } from './core/templates';
import { SCENE_VERSION, type GeometryType, type NodeDoc, type ParamValue, type SceneDoc, type ScriptDoc, type ShaderDoc, type Vec3 } from './core/types';

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

/** The examples are finished scenes: they skip the planning brief (and its start screen). */
function exampleDesign() {
    const design = defaultDesign();
    design.brief.skipped = true;
    return design;
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
        version: SCENE_VERSION,
        name: 'Showcase',
        environment: env,
        assets: [],
        scripts: [rotator, bob, click],
        shaders: [hologram, vignette],
        renderGraph,
        nodes,
        prefabs: [],
        blackboards: [],
        behaviors: [],
        memory: defaultMemory(),
        aiModels: [],
        design: exampleDesign(),
    };
}

const GUARD_SCRIPT = `// The guard's senses and hands. The behavior tree (Behavior tab) decides
// what the guard does; this script writes what the guard perceives into
// fact keys and carries out the tasks the tree calls.
export default class Guard extends Script {
    walkSpeed = 1.8;
    chaseSpeed = 4;

    start() {
        this.player = this.find('Player');
        this.points = ['Waypoint A', 'Waypoint B', 'Waypoint C'].map((n) => this.find(n)).filter(Boolean);
        this.next = 0;
        this.move = null;
        this.last = this.player ? this.flat(this.player) : null;
        this.pace = 0;
    }

    flat(obj) {
        const p = obj.transform.worldPosition;
        return { x: p.x, z: p.z };
    }

    /** Writes a fact key once the value held for \`hold\` seconds. */
    fact(key, value, hold = 0.5) {
        this.seen ??= {};
        const s = this.seen[key];
        if (!s || s.value !== value) {
            this.seen[key] = { value, since: this.time.elapsed };
            return;
        }
        if (this.time.elapsed - s.since >= hold) this.blackboard.set(key, value);
    }

    update(dt) {
        const bb = this.blackboard;
        if (bb && this.player && dt > 0) {
            // Facts in categories, written once they held for half a second:
            // every change of a fact asks the model again.
            const me = this.flat(this.object3D);
            const p = this.flat(this.player);
            const d = Math.hypot(p.x - me.x, p.z - me.z);
            this.pace = this.pace * 0.9 + (Math.hypot(p.x - this.last.x, p.z - this.last.z) / dt) * 0.1;
            this.last = p;
            this.fact('dist', d < 3 ? 'near' : d < 8 ? 'mid' : 'far');
            this.fact('player_moving', this.pace < 0.3 ? 'still' : this.pace < 3 ? 'walking' : 'running');
        }
        const m = this.move;
        if (!m) return;
        const me = this.flat(this.object3D);
        const goal = this.flat(m.target);
        const dx = goal.x - me.x;
        const dz = goal.z - me.z;
        const d = Math.hypot(dx, dz);
        if (d <= m.stop) {
            this.move = null;
            m.done(true);
            return;
        }
        const step = Math.min(d - m.stop, m.speed * dt);
        this.object3D.x += (dx / d) * step;
        this.object3D.z += (dz / d) * step;
        this.object3D.rotationY = (Math.atan2(dx, dz) * 180) / Math.PI;
    }

    /** Walks to an object; resolves true on arrival, false when the task is aborted. */
    moveTo(target, speed, signal, stop = 0.2) {
        this.move?.done(false);
        return new Promise((resolve) => {
            this.move = { target, speed, stop, done: resolve };
            signal.addEventListener('abort', () => {
                if (this.move?.done === resolve) this.move = null;
                resolve(false);
            }, { once: true });
        });
    }

    // Tasks of the tree (Script Task nodes name these methods).

    nextPatrolPoint(task) {
        if (!this.points.length) return false;
        task.set('patrol_target', this.points[this.next++ % this.points.length]);
        return true;
    }

    walkToTarget(task) {
        const target = task.get('patrol_target');
        return target ? this.moveTo(target, this.walkSpeed, task.signal) : false;
    }

    halt(task) {
        if (this.player) this.lookAt(this.player);
        return this.say('Halt! Who goes there?', { signal: task.signal }).then(() => true, () => false);
    }

    warn(task) {
        if (this.player) this.lookAt(this.player);
        this.setEmissive('#ffb000', 0.6);
        return this.say('Stay where you are, stranger. State your business at the gate.', { signal: task.signal }).then(() => true, () => false);
    }

    chase(task) {
        this.setEmissive('#ff3b30', 1);
        return this.player ? this.moveTo(this.player, this.chaseSpeed, task.signal, 1.2) : false;
    }

    onTaskAbort() {
        this.setEmissive('#000000', 0);
    }
}
`;

const PLAYER_SCRIPT = `// Click the viewport in Play mode, then walk with WASD / arrows; hold Shift to run.
// Keys 1 to 3 say a line to the guard: it goes into the guard's context pool
// (the "dialogue" slot), which the guard's Ask shows the model.
export default class PlayerController extends Script {
    speed = 2.5;
    runSpeed = 6;
    lines = [
        "Good evening. I'm the miller's son, fetching water.",
        'Open the gate, or you will regret it!',
        "I carry the captain's seal.",
    ];

    start() {
        // Agents nearest to the player get their questions answered first.
        this.setPlayer();
    }

    update(dt) {
        const o = this.object3D;
        const x = this.input.axis('horizontal');
        const z = -this.input.axis('vertical');
        const speed = this.input.key('shift') ? this.runSpeed : this.speed;
        o.x += x * speed * dt;
        o.z += z * speed * dt;
        if (x || z) o.rotationY = (Math.atan2(x, z) * 180) / Math.PI;
        this.lines.forEach((text, i) => {
            if (!this.input.keyDown(String(i + 1))) return;
            this.say(text).catch(() => {});
            this.getBlackboard('Guard')?.context.add('dialogue', 'Player: ' + text);
        });
    }
}
`;

const BELL_SCRIPT = `// Press B to ring the alarm bell: the guard's "alarm" fact is on for a while.
export default class AlarmBell extends Script {
    seconds = 10;

    update() {
        if (!this.input.keyDown('b')) return;
        const guard = this.getBlackboard('Guard');
        if (!guard) return;
        guard.set('alarm', true);
        this.setEmissive('#ffcc33', 3);
        this.cancel?.();
        this.cancel = this.after(this.seconds, () => {
            guard.set('alarm', false);
            this.setEmissive('#000000', 0);
        });
    }
}
`;

/**
 * A guard at a gate: a behavior tree whose Ask judges the player from what
 * the guard perceives (distance, pace, the alarm bell), what it recalls
 * (rumors) and what was said (the dialogue slot of its context pool, keys
 * 1 to 3). Without a model the tree still runs: the guard patrols, and says
 * "Halt!" when the player comes near.
 */
export function exampleGuard(): SceneDoc {
    const nodes: NodeDoc[] = [];
    const guardScript: ScriptDoc = { id: uid('s'), name: 'Guard.js', code: GUARD_SCRIPT };
    const playerScript: ScriptDoc = { id: uid('s'), name: 'PlayerController.js', code: PLAYER_SCRIPT };
    const bellScript: ScriptDoc = { id: uid('s'), name: 'AlarmBell.js', code: BELL_SCRIPT };

    const sun = makeLightNode('directional');
    sun.name = 'Sun';
    sun.rotation = [48, 150, 0];
    sun.light.intensity = 2.4;
    nodes.push(sun);

    const ground = makeMeshNode('plane');
    ground.name = 'Ground';
    ground.mesh.geometry = { type: 'plane', width: 30, height: 30 };
    ground.mesh.material = { ...defaultMaterial('#6b7a5e'), roughness: 0.9 };
    ground.mesh.castShadow = false;
    nodes.push(ground);

    const gate = makeNode('Gate');
    nodes.push(gate);
    for (const x of [-1.8, 1.8]) {
        const post = makeMeshNode('box', gate.id);
        post.name = x < 0 ? 'Left Post' : 'Right Post';
        post.mesh.geometry = { type: 'box', width: 0.6, height: 3, depth: 0.6 };
        post.mesh.material = { ...defaultMaterial('#8a7f72'), roughness: 0.8 };
        post.position = [x, 1.5, -4];
        nodes.push(post);
    }
    const lintel = makeMeshNode('box', gate.id);
    lintel.name = 'Lintel';
    lintel.mesh.geometry = { type: 'box', width: 4.2, height: 0.5, depth: 0.6 };
    lintel.mesh.material = { ...defaultMaterial('#8a7f72'), roughness: 0.8 };
    lintel.position = [0, 3.25, -4];
    nodes.push(lintel);

    const route = makeNode('Patrol Route');
    nodes.push(route);
    const points: [string, Vec3][] = [['Waypoint A', [-6, 0.03, -2]], ['Waypoint B', [6, 0.03, -2]], ['Waypoint C', [0, 0.03, -2.5]]];
    for (const [name, pos] of points) {
        const w = makeMeshNode('cylinder', route.id);
        w.name = name;
        w.mesh.geometry = { type: 'cylinder', radiusTop: 0.35, radiusBottom: 0.35, height: 0.06, segments: 24 };
        w.mesh.material = { ...defaultMaterial('#c9c2b0'), roughness: 0.7 };
        w.mesh.castShadow = false;
        w.position = pos;
        nodes.push(w);
    }

    const guard = makeMeshNode('capsule');
    guard.name = 'Guard';
    guard.position = [0, 0.9, -2.5];
    guard.mesh.material = { ...defaultMaterial('#b8483e'), roughness: 0.6 };
    attach(guard, guardScript);
    nodes.push(guard);

    const player = makeMeshNode('capsule');
    player.name = 'Player';
    player.position = [0, 0.9, 7];
    player.mesh.material = { ...defaultMaterial('#3f6fd8'), roughness: 0.6 };
    attach(player, playerScript);
    nodes.push(player);

    const bell = makeMeshNode('sphere');
    bell.name = 'Alarm Bell';
    bell.position = [3.2, 2.2, -4.2];
    bell.scale = [0.45, 0.45, 0.45];
    bell.mesh.material = { ...defaultMaterial('#d4a93a'), metallic: 1, roughness: 0.3 };
    attach(bell, bellScript);
    nodes.push(bell);

    const cam = makeCameraNode();
    cam.name = 'Main Camera';
    cam.position = [0, 12, 12];
    cam.rotation = [42, 180, 0];
    nodes.push(cam);

    const doc: SceneDoc = {
        format: 'canonical-scene',
        version: SCENE_VERSION,
        name: 'Guard Post',
        environment: defaultEnvironment(),
        assets: [],
        scripts: [guardScript, playerScript, bellScript],
        shaders: [],
        renderGraph: defaultRenderGraph(),
        nodes,
        prefabs: [],
        blackboards: [],
        behaviors: [],
        memory: defaultMemory(),
        aiModels: [],
        design: exampleDesign(),
    };
    // The behavior data goes through the edit operations like any edit, so the example is valid by construction.
    const r = applyBehaviorOps(
        doc,
        [
            {
                op: 'create_schema',
                name: 'Guard',
                keys: [
                    { name: 'dist', type: 'enum', owner: 'fact', description: 'How far the player is from the guard', default: 'far', values: [{ value: 'near', description: 'within 3 m' }, { value: 'mid', description: '3 to 8 m' }, { value: 'far', description: 'further than 8 m' }] },
                    { name: 'player_moving', type: 'enum', owner: 'fact', description: 'How the player moves', default: 'still', values: [{ value: 'still', description: 'standing still' }, { value: 'walking', description: 'walking' }, { value: 'running', description: 'running' }] },
                    { name: 'alarm', type: 'bool', owner: 'fact', description: 'The alarm bell is ringing', default: false },
                    { name: 'threat', type: 'probability', owner: 'ai', description: 'Is the stranger a threat to the gate?' },
                    { name: 'response', type: 'enum', owner: 'ai', description: 'What the guard does about the stranger', values: [{ value: 'ignore', description: 'let the stranger pass' }, { value: 'warn', description: 'tell the stranger to stop and state their business' }, { value: 'chase', description: 'chase the stranger away from the gate' }] },
                    { name: 'patrol_target', type: 'object', owner: 'tree', description: 'The waypoint the guard walks to' },
                ],
            },
            {
                op: 'create_tree',
                name: 'Guard',
                schema: 'Guard',
                root: {
                    id: 'root',
                    type: 'selector',
                    note: 'The judge sees the facts and the context pool: the recalled rumors and the dialogue (keys 1 to 3 make the player talk). For spoken replies, add a text generator in the Models view and a Model task with the input {context:dialogue} and History dialogue.',
                    services: [
                        { id: 'recall_rumors', type: 'recall', query: 'a stranger {player_moving} near the gate', tags: ['rumor', 'orders'], count: 2, tokenBudget: 120, interval: 2 },
                        {
                            id: 'judge',
                            type: 'ask',
                            triggers: ['facts'],
                            facts: ['dist', 'player_moving', 'alarm'],
                            context: true,
                            minConfidence: 0.4,
                            minHold: 2,
                            questions: [
                                { key: 'threat', text: 'Is the stranger a threat to the gate?' },
                                { key: 'response', text: 'What should the guard do about the stranger?' },
                            ],
                        },
                    ],
                    children: [
                        {
                            id: 'respond',
                            type: 'selector',
                            note: 'Only when the model answered something else than ignore; without a model the response stays ignore.',
                            decorators: [{ type: 'condition', key: 'response', op: 'ne', value: 'ignore' }],
                            children: [
                                {
                                    id: 'chase',
                                    type: 'script',
                                    method: 'chase',
                                    note: 'Only a stranger judged a threat is chased.',
                                    decorators: [{ type: 'condition', key: 'response', op: 'eq', value: 'chase' }, { type: 'condition', key: 'threat', op: 'ge', value: 0.5 }],
                                },
                                { id: 'warn', type: 'script', method: 'warn' },
                            ],
                        },
                        { id: 'halt', type: 'script', method: 'halt', decorators: [{ type: 'condition', key: 'dist', op: 'eq', value: 'near' }, { type: 'cooldown', seconds: 8 }] },
                        {
                            id: 'patrol',
                            type: 'sequence',
                            children: [
                                { id: 'next', type: 'script', method: 'nextPatrolPoint' },
                                { id: 'walk', type: 'script', method: 'walkToTarget' },
                                { id: 'look', type: 'wait', seconds: 1.5, deviation: 0.5 },
                            ],
                        },
                    ],
                },
            },
            { op: 'set_agent', object: 'Guard', tree: 'Guard' },
            { op: 'add_memory', item: { id: 'orders_night', text: "Nobody passes the gate after dark without the captain's seal.", tags: ['orders'] } },
            { op: 'add_memory', item: { id: 'rumor_thief', text: 'A thief in a blue cloak was seen running near the gate last night.', tags: ['rumor'] } },
            { op: 'add_memory', item: { id: 'rumor_miller', text: "The miller's son often walks past the gate to fetch water.", tags: ['rumor'] } },
        ],
        'strict',
    );
    if (!r.ok || !r.changes) throw new Error(`The guard example is not valid: ${r.errors.map((e) => e.message).join('; ')}`);
    writeBehaviorChanges(doc, r.changes);
    return doc;
}

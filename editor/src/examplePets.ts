// Pets of the examples: the Island's dog, "Shiba" by zixisun02 (CC BY 4.0). It walks with a
// Character, a behavior tree decides what it does and a script carries out the
// tree's tasks and keeps it lively (it bounds along, sits, sniffs and hops).

import { applyBehaviorOps, writeBehaviorChanges } from './core/behavior/ops';
import { defaultCharacter } from './core/character';
import { makeNode, uid } from './core/defaults';
import type { NodeDoc, SceneDoc, ScriptDoc, Vec3 } from './core/types';

const DOG_SCRIPT = `// The island's dog: it trots after the player, sits when they stop and
// sniffs around them. Now and then it runs off to explore, and once it is
// far away and out of sight it pops up behind the player's back and comes
// running, again and again. Its behavior tree (Behavior tab) decides what
// it does; this script writes what it notices into fact keys, carries out
// the tasks the tree names and keeps it lively: it bounds along as it runs,
// sits back on its haunches, puts its nose down to sniff and hops and
// wriggles when it is glad (the model is one piece: it moves it whole).
export default class Dog extends Script {
    lostAt = 28;        // meters away from which it may pop up behind the player
    roamEvery = 20;     // seconds with the player before it runs off to explore (up to 60% more, at random)

    start() {
        this.player = this.find('Player');
        this.figure = this.find('Dog Model');
        const f = this.figure;
        // Its rest pose, which the animation moves around.
        this.rest = f ? { y: f.y, rx: f.rotationX, ry: f.rotationY, rz: f.rotationZ, sy: f.scaleY } : null;
        this.pose = 'stand';    // stand, sit or sniff
        this.glad = 0;          // seconds of wild wagging left
        this.phase = 0;
        this.clock = 0;
        // Markers the tree sends it to: where to sniff, where to run off to.
        this.spot = this.spawn('sphere', { name: 'Dog Sniff Spot', scale: [0.001, 0.001, 0.001] });
        this.roamSpot = this.spawn('sphere', { name: 'Dog Roam Spot', scale: [0.001, 0.001, 0.001] });
        this.comeSpot = this.spawn('sphere', { name: 'Dog Come Spot', scale: [0.001, 0.001, 0.001] });
        this.roamAt = this.roamEvery * 0.6;
    }

    /** Writes a fact key once the value held for \`hold\` seconds. */
    fact(key, value, hold = 0.4) {
        this.seen ??= {};
        const s = this.seen[key];
        if (!s || s.value !== value) {
            this.seen[key] = { value, since: this.time.elapsed };
            return;
        }
        if (this.time.elapsed - s.since >= hold) this.blackboard.set(key, value);
    }

    update(dt) {
        this.clock += dt;
        const me = this.character;
        const player = this.player && this.getCharacter(this.player);
        if (this.blackboard && me && player) {
            if (!this.keyed) {
                this.blackboard.set('player', this.player);
                this.blackboard.set('sniff_spot', this.spot);
                this.blackboard.set('roam_spot', this.roamSpot);
                this.blackboard.set('come_spot', this.comeSpot);
                this.keyed = true;
            }
            const d = Math.hypot(player.feet[0] - me.feet[0], player.feet[2] - me.feet[2]);
            this.fact('dist', d < 2.5 ? 'near' : d < 9 ? 'mid' : d < this.lostAt ? 'far' : 'lost');
            this.fact('player_moving', player.mode === 'run' ? 'running' : player.mode === 'idle' ? 'still' : 'walking');
            // Back from popping up behind them, or given up on getting there.
            if (this.comingAt && this.time.elapsed - this.comingAt > 10) this.welcomed();
            // Now and then, while it is with the player, it runs off to explore.
            if (!this.roaming && d < 9 && this.time.elapsed > this.roamAt) {
                this.roaming = true;
                this.tries = 0;
                this.blackboard.set('roam', true);
            }
        }
        this.animate(dt);
    }

    animate(dt) {
        const f = this.figure;
        const r = this.rest;
        if (!f || !r) return;
        const speed = this.character ? this.character.speed : 0;
        const moving = speed > 0.15;
        const k = 1 - Math.exp(-dt * 12);
        const ease = (key, to) => { f[key] += (to - f[key]) * k; };
        const glad = this.glad > 0;
        if (glad) this.glad -= dt;
        this.phase += dt * (moving ? 7 + speed * 1.6 : 0);
        let y = 0, rx = 0, ry = 0, rz = 0, sy = 1;
        if (moving) {
            // Bounding along: up and down, rocking nose to tail, faster and higher at a run.
            y = Math.abs(Math.sin(this.phase)) * Math.min(0.06, 0.012 + speed * 0.006);
            rx = Math.sin(this.phase * 2) * Math.min(7, 2 + speed);
            rz = Math.sin(this.phase) * 2;
        } else if (glad) {
            // Glad: little hops and a wriggle from nose to tail.
            y = Math.abs(Math.sin(this.clock * 11)) * 0.05;
            ry = Math.sin(this.clock * 18) * 9;
            rz = Math.sin(this.clock * 18 + 1) * 5;
        } else if (this.pose === 'sit') {
            // Back on its haunches, a slow sway.
            rx = -15;
            y = 0.02;
            rz = Math.sin(this.clock * 0.8) * 3;
        } else if (this.pose === 'sniff') {
            // Nose to the ground, snuffling.
            rx = 11 + Math.sin(this.clock * 16) * 1.5;
            ry = Math.sin(this.clock * 3) * 6;
        } else {
            // Standing: breathing.
            sy = 1 + Math.sin(this.clock * 2.2) * 0.012;
        }
        ease('y', r.y + y);
        ease('rotationX', r.rx + rx);
        ease('rotationY', r.ry + ry);
        ease('rotationZ', r.rz + rz);
        ease('scaleY', r.sy * sy);
    }

    // Tasks of the tree (Script Task nodes name these methods).

    /** The way the camera looks, flat: [x, z] of unit length (an engine camera looks along its +z). */
    view(player) {
        const m = this.camera?.transform.worldMatrix.rawData;
        let x = m ? m[8] : Math.sin((player.facing * Math.PI) / 180);
        let z = m ? m[10] : Math.cos((player.facing * Math.PI) / 180);
        const len = Math.hypot(x, z) || 1;
        return [x / len, z / len];
    }

    /** A dry spot on the walkable ground near (x, z), about as high as \`y\`; null when there is none. */
    land(x, z, y) {
        const g = this.character.motor.groundAt([x, y + 30, z], 60);
        if (g === null || g < 0.4 || Math.abs(g - y) > 12) return null;
        const p = this.nav ? this.nav.closest([x, g, z], 3) : [x, g, z];
        return p && p[1] >= 0.4 ? p : null;
    }

    /** Somewhere far off to run to, ahead in the player's view so they see it go. */
    pickRoam() {
        const player = this.player && this.getCharacter(this.player);
        if (!this.character || !player) return false;
        // On its way already: the same place, unless a few tries got it nowhere.
        if (this.tries++ > 0) {
            if (this.tries <= 3) return true;
            this.back();
            return false;
        }
        const f = player.feet;
        const [vx, vz] = this.view(player);
        for (let i = 0; i < 12; i++) {
            const a = ((Math.random() - 0.5) * 120 * Math.PI) / 180;
            const r = 40 + Math.random() * 10;
            const p = this.land(f[0] + (vx * Math.cos(a) - vz * Math.sin(a)) * r, f[2] + (vx * Math.sin(a) + vz * Math.cos(a)) * r, f[1]);
            if (!p) continue;
            this.roamSpot.x = p[0];
            this.roamSpot.y = p[1];
            this.roamSpot.z = p[2];
            return true;
        }
        this.back();
        return false;
    }

    /** Got there with the player still close: a sniff around, then back to them. */
    async explore(task) {
        const ok = await this.hold(task, 1.5 + Math.random(), 'sniff');
        this.back();
        return ok;
    }

    /** Far off and out of sight: it pops up behind the player's back, past the camera, to come running from there. */
    reappear() {
        const me = this.character;
        const player = this.player && this.getCharacter(this.player);
        if (!me || !player) return false;
        const f = player.feet;
        const [vx, vz] = this.view(player);
        // Not while the player can see it vanish, unless it is only a speck in the distance.
        const dx = me.feet[0] - f[0];
        const dz = me.feet[2] - f[2];
        const d = Math.hypot(dx, dz) || 1;
        if (d < 40 && (dx * vx + dz * vz) / d > 0.6) return false;
        const cam = this.camera?.transform.worldPosition;
        const back = (cam ? Math.hypot(cam.x - f[0], cam.z - f[2]) : 0) + 9;
        for (const turn of [0, 25, -25, 50, -50, 80, -80, 110, -110]) {
            const a = (turn * Math.PI) / 180;
            const p = this.land(f[0] - (vx * Math.cos(a) - vz * Math.sin(a)) * back, f[2] - (vx * Math.sin(a) + vz * Math.cos(a)) * back, f[1]);
            if (!p) continue;
            // Moving its object moves its body there.
            this.object3D.x = p[0];
            this.object3D.y = p[1] + me.offset;
            this.object3D.z = p[2];
            me.feet[0] = p[0];
            me.feet[1] = p[1];
            me.feet[2] = p[2];
            me.motor.vy = 0;
            me.lookAt(f);
            this.back();
            // It runs up past them to their front right, where they see it.
            const come = this.land(f[0] + vx * 1.2 - vz * 1.1, f[2] + vz * 1.2 + vx * 1.1, f[1]) ?? [f[0], f[1], f[2]];
            this.comeSpot.x = come[0];
            this.comeSpot.y = come[1];
            this.comeSpot.z = come[2];
            this.comingAt = this.time.elapsed;
            this.blackboard?.set('coming', true);
            return true;
        }
        return false;
    }

    /** With the player again: the next run off is a while away. */
    back() {
        this.roaming = false;
        this.blackboard?.set('roam', false);
        this.roamAt = this.time.elapsed + this.roamEvery * (1 + Math.random() * 0.6);
    }

    /** Glad to be back: a hop and wild wagging. */
    async greet(task) {
        this.glad = 2.5;
        this.character?.jump();
        if (this.player) this.lookAt(this.player);
        const ok = await this.hold(task, 1.2);
        this.welcomed();
        return ok;
    }

    /** Back with the player after popping up. */
    welcomed() {
        this.comingAt = 0;
        this.blackboard?.set('coming', false);
    }

    /** Sits by the player, looking up and wagging. */
    sit(task) {
        if (this.player) this.lookAt(this.player);
        return this.hold(task, 3 + Math.random() * 3, 'sit');
    }

    /** Somewhere near the player to sniff at. */
    pickSniff() {
        const player = this.player && this.getCharacter(this.player);
        if (!this.character || !player || !this.spot) return false;
        for (let i = 0; i < 8; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 2 + Math.random() * 5;
            const p = this.land(player.feet[0] + Math.cos(a) * r, player.feet[2] + Math.sin(a) * r, player.feet[1]);
            if (!p) continue;
            this.spot.x = p[0];
            this.spot.y = p[1];
            this.spot.z = p[2];
            return true;
        }
        return false;
    }

    /** Nose to the ground for a while. */
    sniff(task) {
        return this.hold(task, 1.5 + Math.random() * 2, 'sniff');
    }

    /** Resolves true after \`seconds\` in a pose (back to standing), false when the task is aborted first. */
    hold(task, seconds, pose) {
        if (pose) this.pose = pose;
        return new Promise((resolve) => {
            const done = (ok) => {
                this.pose = 'stand';
                resolve(ok);
            };
            const stop = this.after(seconds, () => done(true));
            task.signal.addEventListener('abort', () => {
                stop();
                done(false);
            }, { once: true });
        });
    }
}
`;

/** The dog's blackboard and behavior tree, and the dog running it. */
const DOG_TREE = [
    {
        op: 'create_schema',
        name: 'Dog',
        keys: [
            { name: 'dist', type: 'enum', owner: 'fact', description: 'How far the player is from the dog', default: 'near', values: [{ value: 'near', description: 'within 2.5 m' }, { value: 'mid', description: '2.5 to 9 m' }, { value: 'far', description: '9 to 28 m' }, { value: 'lost', description: 'further than 28 m' }] },
            { name: 'player_moving', type: 'enum', owner: 'fact', description: 'How the player moves', default: 'still', values: [{ value: 'still', description: 'standing still' }, { value: 'walking', description: 'walking' }, { value: 'running', description: 'running' }] },
            { name: 'roam', type: 'bool', owner: 'fact', description: 'It is off exploring', default: false },
            { name: 'coming', type: 'bool', owner: 'fact', description: 'It popped up behind the player and runs up to them', default: false },
            { name: 'player', type: 'object', owner: 'fact', description: 'The player, to follow' },
            { name: 'sniff_spot', type: 'object', owner: 'fact', description: 'Somewhere near the player to sniff at' },
            { name: 'roam_spot', type: 'object', owner: 'fact', description: 'Somewhere far off it runs to' },
            { name: 'come_spot', type: 'object', owner: 'fact', description: 'Beside the player, in their view: where it runs to after popping up' },
        ],
    },
    {
        op: 'create_tree',
        name: 'Dog',
        schema: 'Dog',
        root: {
            id: 'root',
            type: 'selector',
            note: 'The higher branch wins as soon as its conditions pass. Every 20 to 30 seconds the script sets roam: the dog runs off ahead, and once it is far and out of sight it pops up behind the player and comes running.',
            children: [
                { id: 'reappear', type: 'script', method: 'reappear', note: 'Far away and out of sight: it pops up behind the player\'s back.', decorators: [{ type: 'condition', key: 'dist', op: 'eq', value: 'lost' }, { type: 'cooldown', seconds: 3 }] },
                {
                    id: 'come_back',
                    type: 'sequence',
                    note: 'From behind the player it runs up past them and greets them.',
                    decorators: [{ type: 'condition', key: 'coming', op: 'eq', value: true }],
                    children: [
                        { id: 'dash_back', type: 'move_to', target: 'come_spot', radius: 0.6, run: true },
                        { id: 'hello', type: 'script', method: 'greet' },
                    ],
                },
                {
                    id: 'explore',
                    type: 'sequence',
                    decorators: [{ type: 'condition', key: 'roam', op: 'eq', value: true }],
                    children: [
                        { id: 'pick_far', type: 'script', method: 'pickRoam' },
                        { id: 'run_off', type: 'move_to', target: 'roam_spot', radius: 1.5, run: true },
                        { id: 'look_around', type: 'script', method: 'explore' },
                    ],
                },
                {
                    id: 'catch_up',
                    type: 'sequence',
                    decorators: [{ type: 'condition', key: 'dist', op: 'ne', value: 'near' }, { type: 'condition', key: 'dist', op: 'ne', value: 'mid' }],
                    children: [
                        { id: 'run_up', type: 'move_to', target: 'player', radius: 2.2, run: true },
                        { id: 'glad', type: 'script', method: 'greet' },
                    ],
                },
                {
                    id: 'heel',
                    type: 'sequence',
                    decorators: [{ type: 'condition', key: 'dist', op: 'eq', value: 'mid' }, { type: 'condition', key: 'player_moving', op: 'ne', value: 'still' }],
                    children: [{ id: 'trot', type: 'move_to', target: 'player', radius: 2.2, run: false }],
                },
                {
                    id: 'sit',
                    type: 'sequence',
                    decorators: [{ type: 'condition', key: 'dist', op: 'eq', value: 'near' }, { type: 'condition', key: 'player_moving', op: 'eq', value: 'still' }],
                    children: [{ id: 'sit_down', type: 'script', method: 'sit' }],
                },
                {
                    id: 'sniff',
                    type: 'sequence',
                    children: [
                        { id: 'pick', type: 'script', method: 'pickSniff' },
                        { id: 'go_sniff', type: 'move_to', target: 'sniff_spot', radius: 0.4, run: false },
                        { id: 'nose_down', type: 'script', method: 'sniff' },
                    ],
                },
            ],
        },
    },
    { op: 'set_agent', object: 'Dog', tree: 'Dog' },
];

/**
 * Where the dog model is served (editor/examples/island) and where it came
 * from: "Shiba" by zixisun02 (https://sketchfab.com/3d-models/shiba-faef9fe5ace445e7b2989d1c1ece361c),
 * CC BY 4.0, lit and with a smaller texture for the example.
 */
export const DOG_MODEL = {
    url: 'examples/island/shiba.glb',
    name: 'shiba.glb',
    source: { url: 'https://sketchfab.com/3d-models/shiba-faef9fe5ace445e7b2989d1c1ece361c', license: 'CC-BY-4.0', author: 'zixisun02', origin: 'https://sketchfab.com/zixisun51' },
};

/**
 * Adds the dog to a scene: the Shiba model (asset `model`, 0.6 m tall,
 * facing +z) standing at `at` (its feet) facing `facing` degrees,
 * with Dog.js and its behavior tree. It follows the node named Player.
 */
export function addDog(doc: SceneDoc, at: Vec3, facing: number, model: string) {
    const root: NodeDoc = {
        ...makeNode('Dog', null, at),
        rotation: [0, facing, 0],
        character: { ...defaultCharacter(), height: 0.6, radius: 0.22, eyeHeight: 0.45, stepHeight: 0.25, speed: 3.4, runSpeed: 7, jump: 3.2 },
    };
    const figure: NodeDoc = { ...makeNode('Dog Model', root.id, [0, 0, 0]), model: { asset: model } };
    const script: ScriptDoc = { id: uid('s'), name: 'Dog.js', code: DOG_SCRIPT };
    root.scripts = [{ script: script.id, enabled: true, props: {} }];
    doc.scripts.push(script);
    doc.nodes.push(root, figure);
    const r = applyBehaviorOps(doc, DOG_TREE, 'strict');
    if (!r.ok || !r.changes) throw new Error(`The dog's tree is not valid: ${r.errors.map((e) => e.message).join('; ')}`);
    writeBehaviorChanges(doc, r.changes);
}

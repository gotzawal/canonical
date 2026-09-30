// The agent system: every object with an enabled agent (NodeDoc.agent) gets
// a blackboard and its own instance of its behavior tree when Play starts.
//
// How it runs with the engine and the scripts (Player.tick):
//
//   scripts update() -> timers -> agent phase -> scripts lateUpdate()
//
// The agent phase first applies what arrived since the last frame (model
// answers, recall results), in the order it arrived, then ticks the agents
// that are due. Each agent has a context pool (context.ts) its Recall
// services, Model tasks and scripts write and its models read. Each agent ticks 10 times a second; the agents are spread
// over the frames (each gets its own phase in the 100 ms period), so a
// crowd does not tick in the same frame. Time is play time: pausing stops
// the trees, and a paused game applies nothing until it runs again. The
// request scheduler runs separately, right after the engine drew a frame.

import type { Camera3D, Object3D } from '@orillusion/core';
import { modelsNeeded, schemaOf } from '../../core/behavior/format';
import { Emitter } from '../../core/events';
import type {
    AiModelDoc, AskPriority, AskServiceDoc, AskTaskDoc, BehaviorTreeDoc, BlackboardSchemaDoc, BlackboardValue, HearingServiceDoc, InferTaskDoc,
    MemoryItemDoc, RecallServiceDoc, SceneDoc, ScriptTaskDoc, SightServiceDoc, Vec3,
} from '../../core/types';
import type { HeardSound } from '../audio';
import type { Script } from '../script';
import { AskRunner, fillTemplate } from './ask';
import { Blackboard, BlackboardError, type AnswerMeta, type RuntimeValue } from './blackboard';
import { ContextPool } from './context';
import { InferRunner, type InferHandle } from './infer';
import { DecisionLog } from './log';
import { decodeVector, MemoryIndex, norm, type MemoryEntry } from './memory';
import type { Scheduler } from './scheduler';
import { hear, see, type Senser } from './sensors';
import { TreeInstance, type AskHandle, type SoundPlaying, type TaskHandle, type TreeDebug, type TreeHost, type Walker } from './tree';

/** Seconds between two ticks of one agent (10 Hz). */
export const TICK_INTERVAL = 0.1;

/** What the agent system needs from Play mode (implemented by Player). */
export interface AgentHost {
    readonly time: { elapsed: number; frame: number };
    doc(): SceneDoc;
    /** The engine object of a document node, unless a script destroyed it. */
    objectOf(nodeId: string): Object3D | null;
    /** A scene object by node id or name. */
    findObject(ref: string): Object3D | null;
    /** Script instances on an object (running ones). */
    scriptsOn(obj: Object3D): Script[];
    /** Calls a script method; errors are reported like other script errors. */
    invoke(script: Script, method: string, args: unknown[]): { ok: true; value: unknown } | { ok: false };
    camera(): Camera3D;
    /** A warning in the console and the play log. */
    warn(text: string): void;
    /** Speaks a line for an object (a Model task with Speak). */
    speak?(text: string, obj: Object3D): void;
    /** The character of an object (the walking tasks, Look At). */
    character(obj: Object3D): (Walker & { readonly doc: { eyeHeight: number; height: number } }) | null;
    /** Distance along a ray to the first level object that is not one of `own` (node ids), or null (the senses). */
    castLevel?(origin: Vec3, dir: Vec3, max: number, own: Set<string>): number | null;
    /** The player's character object (Sight). */
    playerObject?: Object3D | null;
    /** Every character's object (Sight). */
    characterObjects?(): Object3D[];
    /** Objects with a name; a trailing * matches the start of names (Find Nearest, Sight). */
    objectsNamed?(pattern: string): Object3D[];
    /** A new object without a mesh, removed when Play stops (the senses' position markers). */
    marker?(name: string): Object3D;
    /** Plays a sound from an object (Play Sound). */
    playSoundAt?(obj: Object3D, clip: string, volume: number, range: number): SoundPlaying | null;
    /** Plays a clip of an object's model; false for an unknown clip (Play Animation). */
    playClip?(obj: Object3D, clip: string, fade?: number): boolean;
    /** Node ids of an object and the objects under it. */
    ownNodes?(obj: Object3D): string[];
}

/** Path finding on the level's navigation mesh (play/navmesh.ts), once there is one. */
export interface NavQuery {
    /** A reachable point within `radius` of `center`, or null. */
    randomPoint(center: Vec3, radius: number): Vec3 | null;
    /** The nearest point on the mesh within `within` meters, or null. */
    closest(p: Vec3, within: number): Vec3 | null;
    /** Corner points from `from` to `to` (to the nearest reachable point), or null when there is no way. */
    path(from: Vec3, to: Vec3): Vec3[] | null;
}

/** The models of the scene (they outlive Play sessions). */
export interface AIServices {
    readonly scheduler: Scheduler;
    /** A model by id: the scene's, then the built-in ones. */
    model(id: string): AiModelDoc | undefined;
    ready(id: string): boolean;
    embed(model: string, texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[] | null>;
    /** Starts loading the models a Play session needs (ids). */
    prepare(ids: string[]): void;
    /** A model stopped while running (its GPU device was lost). */
    readonly lost?: boolean;
}

/** An agent's context pool as scripts see it (context.ts). */
export interface ContextApi {
    readonly slots: string[];
    /** The whole pool, or one slot. */
    get(slot?: string): string;
    /** Adds a line to a slot, e.g. add('dialogue', 'Player: Hello'). */
    add(slot: string, line: string): void;
    /** Replaces a slot's text. */
    set(slot: string, text: string): void;
    /** Empties a slot, or the whole pool. */
    clear(slot?: string): void;
}

/** The blackboard as scripts see it: every key can be read, fact keys written. */
export interface BlackboardApi {
    readonly keys: string[];
    get(key: string): RuntimeValue | undefined;
    /** Writes a fact key (scripts write facts; tree keys come from the tree, AI keys from Ask). */
    set(key: string, value: unknown): void;
    /** Write version of a key (raised by every change). */
    version(key: string): number;
    /** The answer behind an AI key's value: confidence, source, time; null while it has its default. */
    answer(key: string): (AnswerMeta & { value: BlackboardValue }) | null;
    /** The agent's context pool: what its models see besides the facts. */
    readonly context: ContextApi;
}

export interface AgentDebug {
    id: string;
    name: string;
    tree: string;
    treeName: string;
    enabled: boolean;
    ticks: number;
    state: TreeDebug;
    values: Record<string, BlackboardValue>;
    versions: Record<string, number>;
    answers: Record<string, AnswerMeta>;
    /** The context pool by slot. */
    context: { slot: string; text: string; by: string; at: number; ids: string[] }[];
}

const PRIORITY_FACTOR: Record<AskPriority, number> = { high: 0.25, normal: 1, low: 4 };

export class Agent implements TreeHost, Senser {
    readonly tree: TreeInstance;
    /** Where it stood when Play started. */
    private start: Vec3;
    private own: Set<string> | null = null;
    private markers = new Map<string, Object3D>();
    /** Play time of the next tick. */
    nextTick = 0;
    /** Its object was destroyed or Play stopped: results for it are dropped. */
    removed = false;
    /** What its models see besides the facts: Recall results, dialogue lines, script notes. */
    readonly context = new ContextPool();
    private seqs = new Map<string, number>();
    private warned = new Set<string>();

    constructor(
        private sys: AgentSystem,
        readonly id: string,
        readonly name: string,
        readonly obj: Object3D,
        readonly treeDoc: BehaviorTreeDoc,
        readonly blackboard: Blackboard,
    ) {
        this.start = this.position();
        this.tree = new TreeInstance(treeDoc, this);
    }

    // ------------------------------------------------------------ TreeHost

    now(): number {
        return this.sys.time;
    }

    random(): number {
        return Math.random();
    }

    callTask(doc: ScriptTaskDoc, task: TaskHandle): unknown {
        const script = this.sys.findTaskScript(this, doc);
        if (!script) {
            this.warn(doc.id, this.sys.missingScriptText(this, doc));
            throw new Error('missing');
        }
        const r = this.sys.host.invoke(script, doc.method, [task]);
        if (!r.ok) throw new Error('failed');
        return r.value;
    }

    abortTask(doc: ScriptTaskDoc, task: TaskHandle) {
        const script = this.sys.findTaskScript(this, doc);
        if (script && typeof (script as any).onTaskAbort === 'function') this.sys.host.invoke(script, 'onTaskAbort', [task]);
    }

    ask(doc: AskTaskDoc | AskServiceDoc, isTask: boolean): AskHandle {
        return this.sys.asks.request(this, doc, isTask);
    }

    infer(doc: InferTaskDoc): InferHandle {
        return this.sys.infers.request(this, doc);
    }

    get contextVersion(): number {
        return this.context.version;
    }

    recall(doc: RecallServiceDoc) {
        this.sys.recall(this, doc);
    }

    character(): Walker | null {
        return this.sys.host.character(this.obj);
    }

    position(): Vec3 {
        const w = this.obj.transform.worldPosition;
        return [w.x, w.y, w.z];
    }

    home(): Vec3 {
        return [...this.start] as Vec3;
    }

    turn(point: Vec3 | null): boolean {
        const c = this.sys.host.character(this.obj);
        if (!point) {
            if (c) c.face = null;
            return true;
        }
        const p = this.position();
        if (Math.hypot(point[0] - p[0], point[2] - p[2]) < 1e-3) return true;
        const yaw = ((Math.atan2(point[0] - p[0], point[2] - p[2]) * 180) / Math.PI + 360) % 360;
        if (c) {
            c.face = yaw;
            return Math.abs(((((yaw - c.facing) % 360) + 540) % 360) - 180) < 8;
        }
        // Not a character: its object turns at once.
        this.obj.rotationY = yaw;
        return true;
    }

    randomPoint(center: Vec3, radius: number): Vec3 | null {
        const nav = this.sys.nav;
        if (nav) return nav.randomPoint(center, radius);
        // Without a navigation mesh: a point in the ring around the center (walls make the walk fail).
        const a = this.random() * Math.PI * 2;
        const r = radius * (0.35 + 0.65 * Math.sqrt(this.random()));
        return [center[0] + Math.sin(a) * r, center[1], center[2] + Math.cos(a) * r];
    }

    fleePoint(from: Vec3, distance: number): Vec3 | null {
        const p = this.position();
        let dx = p[0] - from[0];
        let dz = p[2] - from[2];
        const len = Math.hypot(dx, dz);
        if (len < 1e-3) {
            const a = this.random() * Math.PI * 2;
            [dx, dz] = [Math.sin(a), Math.cos(a)];
        } else [dx, dz] = [dx / len, dz / len];
        const reach = Math.max(1, distance - len + 2);
        const nav = this.sys.nav;
        let best: Vec3 | null = null;
        let bestScore = -Infinity;
        // Straight away first, then more and more to the sides: the way that ends farthest from the threat.
        for (const deg of [0, 35, -35, 70, -70, 110, -110]) {
            const r = (deg * Math.PI) / 180;
            const ux = dx * Math.cos(r) + dz * Math.sin(r);
            const uz = -dx * Math.sin(r) + dz * Math.cos(r);
            let to: Vec3 | null = [p[0] + ux * reach, p[1], p[2] + uz * reach];
            if (nav) to = nav.closest(to, 3);
            else {
                const eye = this.eyes();
                const hit = this.castLevel(eye, [ux, 0, uz], reach);
                if (hit !== null) to = hit > 1.5 ? [p[0] + ux * (hit - 0.8), p[1], p[2] + uz * (hit - 0.8)] : null;
            }
            if (!to) continue;
            const score = Math.hypot(to[0] - from[0], to[2] - from[2]) - Math.abs(deg) / 200;
            if (score > bestScore) {
                bestScore = score;
                best = to;
            }
        }
        return best;
    }

    findNearest(name: string, radius: number, visible: boolean): Object3D | null {
        const host = this.sys.host;
        const eye = this.eyes();
        let best: Object3D | null = null;
        let bestDist = radius;
        for (const o of host.objectsNamed?.(name) ?? []) {
            if (o === this.obj) continue;
            const p = this.aimPoint(o);
            const d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
            if (d > bestDist) continue;
            if (visible && d > 0.3) {
                const hit = this.castLevel(eye, [(p[0] - eye[0]) / d, (p[1] - eye[1]) / d, (p[2] - eye[2]) / d], d);
                if (hit !== null && hit < d - 0.3) continue;
            }
            best = o;
            bestDist = d;
        }
        return best;
    }

    playSound(clip: string, volume: number, range: number): SoundPlaying | null {
        const h = this.sys.host.playSoundAt?.(this.obj, clip, volume, range) ?? null;
        if (!h) this.warn(`sound:${clip}`, `There is no sound "${clip}" to play (import it, or add one from the Library).`);
        return h;
    }

    playAnimation(clip: string, fade: number): boolean {
        return this.sys.host.playClip?.(this.obj, clip, fade < 0 ? undefined : fade) ?? false;
    }

    sense(doc: SightServiceDoc | HearingServiceDoc) {
        if (doc.type === 'sight') see(this, doc);
        else hear(this, doc);
    }

    // -------------------------------------------------------------- Senser

    eyes(): Vec3 {
        const p = this.position();
        const c = this.sys.host.character(this.obj);
        // A character's origin may be above its feet: its eyes are eye height above them.
        if (c && 'feet' in c) {
            const f = (c as unknown as { feet: Vec3 }).feet;
            return [f[0], f[1] + c.doc.eyeHeight, f[2]];
        }
        return p;
    }

    facing(): number {
        const c = this.sys.host.character(this.obj);
        if (c) return c.facing;
        const m = this.obj.transform.worldMatrix.rawData;
        return (Math.atan2(m[8], m[10]) * 180) / Math.PI;
    }

    aimPoint(obj: Object3D): Vec3 {
        const c = this.sys.host.character(obj);
        if (c && 'feet' in c) {
            const f = (c as unknown as { feet: Vec3 }).feet;
            return [f[0], f[1] + c.doc.height * 0.75, f[2]];
        }
        const w = obj.transform.worldPosition;
        return [w.x, w.y, w.z];
    }

    castLevel(origin: Vec3, dir: Vec3, max: number): number | null {
        const host = this.sys.host;
        if (!host.castLevel) return null;
        this.own ??= new Set(host.ownNodes?.(this.obj) ?? [this.id]);
        return host.castLevel(origin, dir, max, this.own);
    }

    candidates(doc: SightServiceDoc): Object3D[] {
        const host = this.sys.host;
        if (doc.targets === 'player') return host.playerObject ? [host.playerObject] : [];
        if (doc.targets === 'characters') return host.characterObjects?.() ?? [];
        return host.objectsNamed?.(doc.name) ?? [];
    }

    noises() {
        return this.sys.noises;
    }

    marker(id: string): Object3D {
        let m = this.markers.get(id);
        if (!m) {
            m = this.sys.host.marker!(`${this.name} ${id}`);
            this.markers.set(id, m);
        }
        return m;
    }

    writeFact(sensor: string, key: string, value: unknown) {
        try {
            this.blackboard.write(key, value, 'fact');
        } catch (e: any) {
            this.warn(sensor, e?.message || String(e));
        }
    }

    warn(node: string, message: string) {
        const key = `${node}|${message}`;
        if (this.warned.has(key)) return;
        this.warned.add(key);
        this.sys.host.warn(`[${this.treeDoc.name} on ${this.name}] ${message}`);
    }

    // ------------------------------------------------------------ requests

    nextSeq(node: string): number {
        const n = (this.seqs.get(node) ?? 0) + 1;
        this.seqs.set(node, n);
        return n;
    }

    latestSeq(node: string): number {
        return this.seqs.get(node) ?? 0;
    }

    /** Request rank: distance to the player in meters, scaled by the Ask's priority (lower first). */
    priority(p: AskPriority): number {
        const a = this.obj.transform.worldPosition;
        const b = this.sys.playerPosition();
        const d = Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2]);
        return d * PRIORITY_FACTOR[p];
    }
}

export class AgentSystem extends Emitter<{ started: void; stopped: void }> {
    readonly agents: Agent[] = [];
    readonly log = new DecisionLog();
    readonly asks = new AskRunner(this);
    readonly infers = new InferRunner(this);
    /** Scene memory plus what scripts remember while playing. */
    memory: MemoryIndex | null = null;
    /** Distances for request priority are measured from this object (the camera when null). */
    player: Object3D | null = null;
    private inbox: (() => void)[] = [];
    private running = false;
    /** Raised by start and stop: results of an earlier session are dropped. */
    private session = 0;
    /** A model was lost when the last frame looked. */
    modelLost = false;
    /** The agents' tick offsets are set in the first frame of a session. */
    private spreadPending = false;
    /** Sounds of the last second, for the hearing sensors (play/ai/sensors.ts). */
    noises: (HeardSound & { time: number })[] = [];
    /** Some agent's tree listens (a Hearing service): characters' footsteps count as sounds then. */
    listening = false;
    /** The navigation mesh, once Play has one (walking tasks follow its paths). */
    nav: NavQuery | null = null;
    private queryCache = new Map<string, Promise<Float32Array | null>>();
    /** Vectors of the queries embedded so far (by the same keys). */
    private queryVectors = new Map<string, Float32Array>();

    constructor(
        readonly host: AgentHost,
        private services: () => AIServices | null,
    ) {
        super();
    }

    get time(): number {
        return this.host.time.elapsed;
    }

    get frameNumber(): number {
        return this.host.time.frame;
    }

    get active(): boolean {
        return this.running;
    }

    /** The request scheduler, when the models are set up. */
    get scheduler(): Scheduler | null {
        return this.running ? this.services()?.scheduler ?? null : null;
    }

    /** A model by id (the scene's or a built-in one), when the models are set up. */
    modelDoc(id: string): AiModelDoc | undefined {
        return this.services()?.model(id);
    }

    // -------------------------------------------------------------- control

    /**
     * Creates the agents of the scene (Play started; scripts exist, awake()
     * has not run yet, so scripts can write facts in awake / start).
     */
    start() {
        this.stop();
        const doc = this.host.doc();
        this.log.clear();
        // Query vectors belong to the embed model of the last session.
        this.queryCache.clear();
        this.queryVectors.clear();
        this.running = true;
        this.session++;
        // A model lost before this session: the keys start at their defaults anyway.
        this.modelLost = !!this.services()?.lost;
        this.memory = new MemoryIndex(doc.memory);
        this.player = null;
        const list: { id: string; name: string; obj: Object3D; tree: BehaviorTreeDoc; schema: BlackboardSchemaDoc; values: Record<string, BlackboardValue> }[] = [];
        for (const node of doc.nodes) {
            const a = node.agent;
            if (!a?.enabled) continue;
            const tree = doc.behaviors.find((t) => t.id === a.tree);
            const obj = this.host.objectOf(node.id);
            if (!tree || !obj) {
                if (!tree) this.host.warn(`[${node.name}] The agent's behavior tree "${a.tree}" does not exist, so it does not run.`);
                continue;
            }
            const schema = schemaOf(doc.blackboards, tree);
            if (!schema) {
                this.host.warn(`[${tree.name} on ${node.name}] The tree has no blackboard schema, so it does not run.`);
                continue;
            }
            list.push({ id: node.id, name: node.name, obj, tree, schema, values: a.values });
        }
        const resolve = (ref: string) => this.host.findObject(ref);
        for (const a of list) {
            try {
                this.agents.push(new Agent(this, a.id, a.name, a.obj, a.tree, new Blackboard(a.schema, a.values, resolve)));
            } catch (e: any) {
                // One broken agent must not stop Play for the others.
                this.host.warn(`[${a.tree.name} on ${a.name}] The agent could not start: ${e?.message || e}`);
            }
        }
        this.listening = this.agents.some((a) => JSON.stringify(a.treeDoc.root).includes('"hearing"'));
        // Spread the agents over the tick period (again in their first frame, see frame()).
        this.agents.forEach((agent, i) => (agent.nextTick = this.time + (i / Math.max(1, this.agents.length)) * TICK_INTERVAL));
        this.spreadPending = true;
        if (this.agents.length) {
            try {
                const ids = modelsNeeded(Array.from(new Set(this.agents.map((a) => a.treeDoc))), this.memory.embedded, doc.memory.embedder);
                if (ids.length) this.services()?.prepare(ids);
            } catch (e) {
                console.error('[ai] loading the models failed', e);
            }
        }
        this.emit('started', undefined);
    }

    /** Aborts every tree (scripts get onTaskAbort) and drops the agents. */
    stop() {
        if (!this.running && !this.agents.length) return;
        for (const a of this.agents) {
            a.removed = true;
            try {
                a.tree.stop();
            } catch (e) {
                console.error('[ai] stopping a tree failed', e);
            }
        }
        this.agents.length = 0;
        this.inbox = [];
        this.noises = [];
        this.listening = false;
        this.nav = null;
        this.running = false;
        this.session++;
        this.services()?.scheduler.clear();
        this.emit('stopped', undefined);
    }

    /**
     * A poster for work that starts now and finishes later (a model answer,
     * a recall): it queues its result for the next agent phase, and drops it
     * when this Play session ended in the meantime.
     */
    poster(): (fn: () => void) => void {
        const session = this.session;
        return (fn) => {
            if (this.running && session === this.session) this.inbox.push(fn);
        };
    }

    /** The agent phase of a frame (Player.tick, between timers and lateUpdate). */
    frame() {
        if (!this.running) return;
        const due = this.inbox;
        this.inbox = [];
        for (const fn of due) {
            try {
                fn();
            } catch (e) {
                console.error('[ai] applying a result failed', e);
            }
        }
        // After the inbox: answers of the last batch before the loss go too.
        this.checkModelLost();
        const now = this.time;
        if (this.spreadPending) {
            // The offsets count from the first agent frame: a long first frame
            // must not make every agent due at once.
            this.spreadPending = false;
            this.agents.forEach((a, i) => (a.nextTick = now + (i / Math.max(1, this.agents.length)) * TICK_INTERVAL));
        }
        for (const a of this.agents.slice()) {
            // An agent destroyed by another one earlier in this frame does not tick.
            if (a.removed || now < a.nextTick) continue;
            try {
                a.tree.tick();
            } catch (e) {
                console.error(`[ai] tick of "${a.name}" failed`, e);
            }
            a.nextTick += TICK_INTERVAL;
            // After a long frame, skip the missed ticks instead of running them
            // all now, keeping the agent's phase: resetting every late agent to
            // now + interval would line all of them up in the same frames.
            if (a.nextTick <= now) a.nextTick += Math.ceil((now - a.nextTick) / TICK_INTERVAL + 1e-9) * TICK_INTERVAL;
        }
    }

    /**
     * When a model stops in the middle of a session (device lost), the AI
     * keys go back to their schema defaults, as if there had never been a
     * model: old answers must not steer the trees forever.
     */
    private checkModelLost() {
        const lost = !!this.services()?.lost;
        if (lost && !this.modelLost) {
            for (const a of this.agents) for (const k of a.blackboard.keys) if (k.owner === 'ai') a.blackboard.reset(k.name);
            if (this.agents.length) this.host.warn('A model stopped (its GPU device was lost): AI keys are back to their defaults.');
        }
        this.modelLost = lost;
    }

    /** A sound was made (played in 3D, or a script's noise): agents with hearing may notice it. */
    hear(s: HeardSound) {
        if (!this.running || !(s.range > 0)) return;
        const now = this.time;
        this.noises = this.noises.filter((n) => now - n.time <= 1);
        this.noises.push({ ...s, time: now });
    }

    /** An agent's object was destroyed by a script: its tree stops. */
    removeObjects(objects: Set<Object3D>) {
        for (const a of this.agents.slice()) {
            if (!objects.has(a.obj)) continue;
            a.removed = true;
            this.agents.splice(this.agents.indexOf(a), 1);
            a.tree.stop();
        }
    }

    // --------------------------------------------------------------- lookup

    agentOf(target: Object3D | string): Agent | null {
        if (typeof target === 'string') return this.agents.find((a) => a.id === target || a.name === target) ?? null;
        return this.agents.find((a) => a.obj === target) ?? null;
    }

    /** The blackboard API scripts get (null when the object runs no tree). */
    blackboardApi(target: Object3D | string): BlackboardApi | null {
        const agent = this.agentOf(target);
        if (!agent) return null;
        const bb = agent.blackboard;
        return {
            get keys() {
                return bb.keys.map((k) => k.name);
            },
            get: (key) => {
                if (!bb.has(key)) throw new BlackboardError(`No key "${key}" in blackboard "${bb.schema.name}". Keys: ${bb.keys.map((k) => k.name).join(', ')}.`);
                return bb.get(key);
            },
            set: (key, value) => {
                bb.write(key, value, 'fact');
            },
            version: (key) => bb.version(key),
            answer: (key) => {
                const a = bb.answer(key);
                return a ? { ...a, value: bb.plain(key) } : null;
            },
            context: this.contextApi(agent),
        };
    }

    private contextApi(agent: Agent): ContextApi {
        const pool = agent.context;
        const slot = (name: unknown) => {
            const s = String(name ?? '').trim();
            if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(s)) throw new BlackboardError(`"${s}" is not a context slot name: use letters, digits, _ and -.`);
            return s;
        };
        return {
            get slots() {
                return pool.names;
            },
            get: (name) => (name === undefined ? pool.text() : pool.text(slot(name))),
            add: (name, line) => pool.add(slot(name), String(line ?? ''), 'script', this.time),
            set: (name, text) => void pool.set(slot(name), String(text ?? '').slice(0, 4000), 'script', this.time),
            clear: (name) => pool.clear(name === undefined ? undefined : slot(name)),
        };
    }

    playerPosition(): [number, number, number] {
        const obj = this.player ?? this.host.camera()?.object3D;
        const p = obj?.transform.worldPosition;
        return p ? [p.x, p.y, p.z] : [0, 0, 0];
    }

    // ------------------------------------------------------------- scripts

    findTaskScript(agent: Agent, doc: ScriptTaskDoc): Script | null {
        const scripts = this.host.scriptsOn(agent.obj);
        const want = doc.script.trim().replace(/\.js$/i, '').toLowerCase();
        for (const s of scripts) {
            if (want) {
                const file = s.scriptName.replace(/\.js$/i, '').toLowerCase();
                if (file !== want && s.constructor.name.toLowerCase() !== want) continue;
            }
            if (typeof (s as any)[doc.method] === 'function') return s;
        }
        return null;
    }

    missingScriptText(agent: Agent, doc: ScriptTaskDoc): string {
        const scripts = this.host.scriptsOn(agent.obj);
        if (!scripts.length) return `Task "${doc.id}" fails: "${agent.name}" has no running script (scripts may be paused), so ${doc.method}() cannot be called.`;
        return `Task "${doc.id}" fails: no script on "${agent.name}"${doc.script ? ` named ${doc.script}` : ''} has a method ${doc.method}(). Scripts there: ${scripts.map((s) => s.scriptName).join(', ')}.`;
    }

    // --------------------------------------------------------------- recall

    /** Embeds a text with the memory's embed model (cached), or null when it is not ready. */
    embed(text: string, kind: 'query' | 'passage'): Promise<Float32Array | null> {
        const services = this.services();
        const model = this.host.doc().memory.embedder;
        if (!services?.ready(model) || !text.trim()) return Promise.resolve(null);
        const key = `${kind}:${text}`;
        let p = this.queryCache.get(key);
        if (!p) {
            p = services.embed(model, [text], kind).then(
                (v) => {
                    const vector = v?.[0] ?? null;
                    if (vector) this.queryVectors.set(key, vector);
                    return vector;
                },
                () => null,
            );
            this.queryCache.set(key, p);
            if (this.queryCache.size > 512) {
                const old = this.queryCache.keys().next().value!;
                this.queryCache.delete(old);
                this.queryVectors.delete(old);
            }
        }
        return p;
    }

    recall(agent: Agent, doc: RecallServiceDoc) {
        const memory = this.memory;
        if (!memory || !memory.entries.length) return;
        const text = fillTemplate(doc.query, (k) => agent.blackboard.get(k), agent.context);
        // The items go into the context slot named after the service.
        const run = (vector: Float32Array | null) => {
            const hits = memory.search({ vector, text }, doc.tags, doc.count);
            const next = memory.assemble(hits, doc.tokenBudget, this.time, doc.id);
            agent.context.set(doc.id, next.text, doc.id, this.time, { ids: next.ids, vector: next.vector });
        };
        if (!memory.embedded) {
            run(null);
            return;
        }
        // A query embedded before is used right away (an Ask later in this tick sees the context).
        const known = this.queryVectors.get(`query:${text}`);
        if (known) {
            run(known);
            return;
        }
        const post = this.poster();
        void this.embed(text, 'query').then((v) => post(() => {
            if (!agent.removed) run(v);
        }));
    }

    /** Adds a memory while playing (saveMemories() puts it into a game save). */
    remember(text: string, tags: string[] = []): string | null {
        const memory = this.memory;
        if (!memory || !text.trim()) return null;
        const entry = memory.add({ text: text.trim(), tags }, null);
        this.embedLater(entry);
        return entry.id;
    }

    /** Embeds a play memory when the scene's memory is embedded and the model is there. */
    private embedLater(entry: MemoryEntry) {
        if (!this.memory?.embedded) return;
        const post = this.poster();
        void this.embed(entry.text, 'passage').then((v) => post(() => {
            if (!v) return;
            entry.vector = v;
            entry.norm = norm(v);
        }));
    }

    /** The memories added while playing, as JSON for a game save. */
    saveMemories(): MemoryItemDoc[] {
        return this.memory?.playItems() ?? [];
    }

    /**
     * Puts saved play memories back (the ones added so far this session are
     * replaced). Returns how many were loaded.
     */
    loadMemories(items: unknown): number {
        const memory = this.memory;
        if (!memory || !Array.isArray(items)) return 0;
        memory.clearPlay();
        const dims = memory.entries.find((e) => e.vector)?.vector?.length ?? 0;
        let n = 0;
        for (const raw of items.slice(0, 5000)) {
            if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) continue;
            let vector: Int8Array | null = null;
            try {
                vector = typeof raw.vector === 'string' ? decodeVector(raw.vector) : null;
            } catch {
                vector = null;
            }
            // A vector from another embedding model does not compare: embed the text again.
            if (vector && vector.length !== dims) vector = null;
            const tags = Array.isArray(raw.tags) ? raw.tags.filter((t: unknown): t is string => typeof t === 'string') : [];
            const entry = memory.add({ id: typeof raw.id === 'string' ? raw.id : undefined, text: raw.text.slice(0, 4000), tags }, vector);
            if (!vector) this.embedLater(entry);
            n++;
        }
        return n;
    }

    // ---------------------------------------------------------------- debug

    debug(agent: Agent): AgentDebug {
        const bb = agent.blackboard;
        const versions: Record<string, number> = {};
        const answers: Record<string, AnswerMeta> = {};
        for (const k of bb.keys) {
            versions[k.name] = bb.version(k.name);
            const a = bb.answer(k.name);
            if (a) answers[k.name] = a;
        }
        return {
            id: agent.id,
            name: agent.name,
            tree: agent.treeDoc.id,
            treeName: agent.treeDoc.name,
            enabled: true,
            ticks: agent.tree.ticks,
            state: agent.tree.debug(),
            values: bb.snapshot(),
            versions,
            answers,
            context: agent.context.names.map((slot) => {
                const c = agent.context.get(slot)!;
                return { slot, text: c.text, by: c.by, at: c.at, ids: c.ids };
            }),
        };
    }
}

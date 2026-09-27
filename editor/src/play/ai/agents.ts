// The agent system: every object with an enabled agent (NodeDoc.agent) gets
// a blackboard and its own instance of its behavior tree when Play starts.
//
// How it runs with the engine and the scripts (Player.tick):
//
//   scripts update() -> timers -> agent phase -> scripts lateUpdate()
//
// The agent phase first applies what arrived since the last frame (model
// answers, recall results), in the order it arrived, then ticks the agents
// that are due. Each agent ticks 10 times a second; the agents are spread
// over the frames (each gets its own phase in the 100 ms period), so a
// crowd does not tick in the same frame. Time is play time: pausing stops
// the trees, and a paused game applies nothing until it runs again. The
// request scheduler runs separately, right after the engine drew a frame.

import type { Camera3D, Object3D } from '@orillusion/core';
import { modelsNeeded, schemaOf, type ModelNeeds } from '../../core/behavior/format';
import { Emitter } from '../../core/events';
import type {
    AskPriority, AskServiceDoc, AskTaskDoc, BehaviorTreeDoc, BlackboardSchemaDoc, BlackboardValue, MemoryItemDoc,
    RecallServiceDoc, SceneDoc, ScriptTaskDoc,
} from '../../core/types';
import type { Script } from '../script';
import { AskRunner, fillTemplate } from './ask';
import { Blackboard, BlackboardError, type AnswerMeta, type RuntimeValue } from './blackboard';
import { DecisionLog } from './log';
import { decodeVector, MemoryIndex, norm, type MemoryEntry, type RecallContext } from './memory';
import type { Scheduler } from './scheduler';
import { TreeInstance, type AskHandle, type TaskHandle, type TreeDebug, type TreeHost } from './tree';

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
}

/** The decision model and the embedding model (they outlive Play sessions). */
export interface AIServices {
    readonly scheduler: Scheduler;
    readonly embedderReady: boolean;
    embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[] | null>;
    /**
     * Starts loading what the scene needs: the decision model for Ask nodes,
     * the embedding model its memory was embedded with (`embedder`, a model id).
     */
    prepare(needs: ModelNeeds, embedder: string): void;
    /** The decision model was running and stopped (its GPU device was lost). */
    readonly decisionLost?: boolean;
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
    context: { ids: string[]; at: number; by: string } | null;
}

const PRIORITY_FACTOR: Record<AskPriority, number> = { high: 0.25, normal: 1, low: 4 };

export class Agent implements TreeHost {
    readonly tree: TreeInstance;
    /** Play time of the next tick. */
    nextTick = 0;
    /** The context the last Recall assembled. */
    context: RecallContext | null = null;
    /** Raised when a Recall brings other items than before. */
    contextVersion = 0;
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

    recall(doc: RecallServiceDoc) {
        this.sys.recall(this, doc);
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
    /** Scene memory plus what scripts remember while playing. */
    memory: MemoryIndex | null = null;
    /** Distances for request priority are measured from this object (the camera when null). */
    player: Object3D | null = null;
    private inbox: (() => void)[] = [];
    private running = false;
    /** The decision model was lost when the last frame looked. */
    private modelLost = false;
    /** The agents' tick offsets are set in the first frame of a session. */
    private spreadPending = false;
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

    /** The request scheduler, when a decision model is set up. */
    get scheduler(): Scheduler | null {
        return this.running ? this.services()?.scheduler ?? null : null;
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
        // Query vectors belong to the embedding model of the last session.
        this.queryCache.clear();
        this.queryVectors.clear();
        this.running = true;
        // A model lost before this session: the keys start at their defaults anyway.
        this.modelLost = !!this.services()?.decisionLost;
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
        list.forEach((a, i) => {
            const agent = new Agent(this, a.id, a.name, a.obj, a.tree, new Blackboard(a.schema, a.values, resolve));
            // Spread the agents over the tick period.
            agent.nextTick = this.time + (i / Math.max(1, list.length)) * TICK_INTERVAL;
            this.agents.push(agent);
        });
        this.spreadPending = true;
        if (this.agents.length) {
            const needs = modelsNeeded(Array.from(new Set(this.agents.map((a) => a.treeDoc))), this.memory.embedded);
            if (needs.decision || needs.embedder) this.services()?.prepare(needs, this.host.doc().memory.embedder);
        }
        this.emit('started', undefined);
    }

    /** Aborts every tree (scripts get onTaskAbort) and drops the agents. */
    stop() {
        if (!this.running && !this.agents.length) return;
        for (const a of this.agents) {
            try {
                a.tree.stop();
            } catch (e) {
                console.error('[ai] stopping a tree failed', e);
            }
        }
        this.agents.length = 0;
        this.inbox = [];
        this.running = false;
        this.services()?.scheduler.clear();
        this.emit('stopped', undefined);
    }

    /** Queues work for the next agent phase (answers and results that arrive between frames). */
    post(fn: () => void) {
        if (this.running) this.inbox.push(fn);
    }

    /** The agent phase of a frame (Player.tick, between timers and lateUpdate). */
    frame() {
        if (!this.running) return;
        this.checkModelLost();
        const due = this.inbox;
        this.inbox = [];
        for (const fn of due) {
            try {
                fn();
            } catch (e) {
                console.error('[ai] applying a result failed', e);
            }
        }
        const now = this.time;
        if (this.spreadPending) {
            // The offsets count from the first agent frame: a long first frame
            // must not make every agent due at once.
            this.spreadPending = false;
            this.agents.forEach((a, i) => (a.nextTick = now + (i / Math.max(1, this.agents.length)) * TICK_INTERVAL));
        }
        for (const a of this.agents.slice()) {
            if (now < a.nextTick) continue;
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
     * When the decision model stops in the middle of a session (device
     * lost), the AI keys go back to their schema defaults, as if there had
     * never been a model: old answers must not steer the trees forever.
     */
    private checkModelLost() {
        const lost = !!this.services()?.decisionLost;
        if (lost && !this.modelLost) {
            for (const a of this.agents) for (const k of a.blackboard.keys) if (k.owner === 'ai') a.blackboard.reset(k.name);
            if (this.agents.length) this.host.warn('The decision model stopped (its GPU device was lost): AI keys are back to their defaults.');
        }
        this.modelLost = lost;
    }

    /** An agent's object was destroyed by a script: its tree stops. */
    removeObjects(objects: Set<Object3D>) {
        for (const a of this.agents.slice()) {
            if (!objects.has(a.obj)) continue;
            a.tree.stop();
            this.agents.splice(this.agents.indexOf(a), 1);
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

    /** Embeds a text with the embedding model (cached), or null when there is none. */
    embed(text: string, kind: 'query' | 'passage'): Promise<Float32Array | null> {
        const services = this.services();
        if (!services?.embedderReady || !text.trim()) return Promise.resolve(null);
        const key = `${kind}:${text}`;
        let p = this.queryCache.get(key);
        if (!p) {
            p = services.embed([text], kind).then(
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
        const text = fillTemplate(doc.query, (k) => agent.blackboard.get(k));
        const run = (vector: Float32Array | null) => {
            const hits = memory.search({ vector, text }, doc.tags, doc.count);
            const next = memory.assemble(hits, doc.tokenBudget, this.time, doc.id);
            if (!agent.context || agent.context.ids.join('\u0000') !== next.ids.join('\u0000')) agent.contextVersion++;
            agent.context = next;
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
        void this.embed(text, 'query').then((v) => this.post(() => run(v)));
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
        void this.embed(entry.text, 'passage').then((v) => this.post(() => {
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
            context: agent.context ? { ids: agent.context.ids, at: agent.context.at, by: agent.context.by } : null,
        };
    }
}

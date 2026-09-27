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
import { schemaOf } from '../../core/behavior/format';
import { Emitter } from '../../core/events';
import type {
    AskPriority, AskServiceDoc, AskTaskDoc, BehaviorTreeDoc, BlackboardSchemaDoc, BlackboardValue, RecallServiceDoc,
    SceneDoc, ScriptTaskDoc,
} from '../../core/types';
import type { Script } from '../script';
import { AskRunner, fillTemplate } from './ask';
import { Blackboard, BlackboardError, type AnswerMeta, type RuntimeValue } from './blackboard';
import { DecisionLog } from './log';
import { MemoryIndex, type RecallContext } from './memory';
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
    /** Starts loading what the scene needs (the decision model when it has Ask nodes). */
    prepare(needs: { decision: boolean; embedder: boolean }): void;
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
    private queryCache = new Map<string, Promise<Float32Array | null>>();

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
        this.running = true;
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
        if (this.agents.length) {
            const needs = { decision: false, embedder: false };
            const visit = (item: any) => {
                if (item.type === 'ask') {
                    needs.decision = true;
                    if (item.choices === 'memory') needs.embedder = true;
                }
                if (item.type === 'recall') needs.embedder = true;
            };
            const walk = (n: any) => {
                visit(n);
                for (const s of n.services ?? []) visit(s);
                for (const c of n.children ?? []) walk(c);
            };
            for (const a of this.agents) walk(a.treeDoc.root);
            // Without embedded memory, search falls back to shared words: no model needed.
            if (!this.memory.embedded) needs.embedder = false;
            if (needs.decision || needs.embedder) this.services()?.prepare(needs);
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
        for (const a of this.agents.slice()) {
            if (now < a.nextTick) continue;
            try {
                a.tree.tick();
            } catch (e) {
                console.error(`[ai] tick of "${a.name}" failed`, e);
            }
            a.nextTick += TICK_INTERVAL;
            // After a long frame, skip the missed ticks instead of running them all now.
            if (a.nextTick <= now) a.nextTick = now + TICK_INTERVAL;
        }
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
            p = services.embed([text], kind).then((v) => v?.[0] ?? null, () => null);
            this.queryCache.set(key, p);
            if (this.queryCache.size > 512) this.queryCache.delete(this.queryCache.keys().next().value!);
        }
        return p;
    }

    recall(agent: Agent, doc: RecallServiceDoc) {
        const memory = this.memory;
        if (!memory || !memory.entries.length) return;
        const text = fillTemplate(doc.query, (k) => agent.blackboard.get(k));
        const run = (vector: Float32Array | null) => {
            const hits = memory.search({ vector, text }, doc.tags, doc.count);
            agent.context = memory.assemble(hits, doc.tokenBudget, this.time, doc.id);
        };
        if (!memory.embedded) {
            run(null);
            return;
        }
        void this.embed(text, 'query').then((v) => this.post(() => run(v)));
    }

    /** Adds a memory while playing (kept in saves). */
    remember(text: string, tags: string[] = []): string | null {
        const memory = this.memory;
        if (!memory || !text.trim()) return null;
        const entry = memory.add({ text: text.trim(), tags }, null);
        if (memory.embedded) void this.embed(entry.text, 'passage').then((v) => this.post(() => {
            if (v) {
                entry.vector = v;
                let s = 0;
                for (let i = 0; i < v.length; i++) s += v[i] * v[i];
                entry.norm = Math.sqrt(s);
            }
        }));
        return entry.id;
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

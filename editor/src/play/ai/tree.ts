// One agent's instance of a behavior tree. Standard behavior tree rules:
//
// - A tick re-checks conditions only; a running task is not run again, it
//   keeps running until it succeeds or fails (or is aborted).
// - Aborts are always "both": when the conditions of a running branch fail,
//   the branch is aborted (self); when the conditions of a higher branch of a
//   Selector start to pass while a lower branch runs, the lower branch is
//   aborted and the higher one runs (lower priority). "Start to pass" means
//   the result changed from false to true, so a higher branch that just
//   failed for another reason does not take over again on every tick.
// - Services run only while the node they are attached to is active. The
//   root is active as long as the tree runs: when the tree finishes and
//   starts over on the next tick, the root's services are not activated
//   again (an Ask triggered on activate asks once, not on every loop).
// - Aborted tasks get their abort hook (scripts: onTaskAbort and the task's
//   AbortSignal).
// - A Parallel runs its children at the same time, so several branches can
//   be active and several tasks running; every other composite runs one
//   child at a time. A Random Selector draws its order each time it starts.
// - Decorators: conditions and cooldowns decide whether a node may run;
//   Invert and Force Result change the result it ends with (also when its
//   conditions keep it from running or abort it; an abort from above ends
//   a node without a result); Repeat and Retry run it again after a run
//   that succeeded or failed, on the next tick, so nothing spins within a
//   tick; Time Limit aborts a run that takes too long, which then fails.
//
// The tree never waits on anything: answers, recall results and promises
// settle between ticks and the next tick sees them.

import { valueFits } from '../../core/behavior/nodeTypes';
import type { Object3D } from '@orillusion/core';
import type {
    AskServiceDoc, AskTaskDoc, BehaviorTreeDoc, BtDecoratorDoc, BtNodeDoc, BtServiceDoc, ConditionDecoratorDoc, FindTaskDoc, FleeTaskDoc,
    HearingServiceDoc, InferTaskDoc, LookAtTaskDoc, MoveToTaskDoc, ParallelNodeDoc, PlayAnimationTaskDoc, PlaySoundTaskDoc, RecallServiceDoc,
    ScriptTaskDoc, SightServiceDoc, Vec3, WanderTaskDoc,
} from '../../core/types';
import type { Blackboard } from './blackboard';
import type { InferHandle } from './infer';

export type Status = 'running' | 'success' | 'failure';

/** A pending Ask as a task sees it. */
export interface AskHandle {
    /** Settled: every question has an outcome. */
    done: boolean;
    /** Every answer was written. */
    ok: boolean;
}

/** What a script task's method gets. */
export interface TaskHandle {
    /** Node id of the task. */
    readonly node: string;
    readonly method: string;
    /** Fired when the task is aborted. */
    readonly signal: AbortSignal;
    readonly aborted: boolean;
    /** Reads a blackboard key. */
    get(key: string): unknown;
    /** Writes a tree key. */
    set(key: string, value: unknown): void;
    /** Finishes a task whose method returned 'running'. */
    succeed(): void;
    fail(): void;
}

/** What the walking tasks need from the agent's character (play/character.ts, on a path when there is a navigation mesh). */
export interface Walker {
    moveTo(target: Object3D | Vec3, opts: { radius: number; run: boolean; signal: AbortSignal }): Promise<boolean>;
    /** The way to face, degrees around y; null faces the way it walks. */
    face: number | null;
    /** The way the body faces now, degrees around y. */
    readonly facing: number;
}

/** A sound a Play Sound task started. */
export interface SoundPlaying {
    stop(): void;
    readonly done: Promise<void>;
}

/** What the tree needs from its agent. */
export interface TreeHost {
    readonly blackboard: Blackboard;
    /** Play time in seconds. */
    now(): number;
    random(): number;
    /**
     * Calls a script task's method and returns what it returned. Throws when
     * there is no such script or method, or when the method threw (the host
     * reports it); the task then fails.
     */
    callTask(doc: ScriptTaskDoc, task: TaskHandle): unknown;
    /** A script task was aborted: calls the script's onTaskAbort(task). */
    abortTask(doc: ScriptTaskDoc, task: TaskHandle): void;
    /** Starts an Ask request. */
    ask(doc: AskTaskDoc | AskServiceDoc, isTask: boolean): AskHandle;
    /** Starts a Model task's request. */
    infer(doc: InferTaskDoc): InferHandle;
    /** Runs a Recall service once. */
    recall(doc: RecallServiceDoc): void;
    /** The agent's character, for the walking tasks; null without one. */
    character(): Walker | null;
    /** Where the agent's object is. */
    position(): Vec3;
    /** Where the agent stood when Play started (Wander's center). */
    home(): Vec3;
    /** Turns the agent toward a point; true once it faces it. null lets a character face where it walks again. */
    turn(point: Vec3 | null): boolean;
    /** A point to walk to within `radius` of `center` (a reachable one on the navigation mesh), or null. */
    randomPoint(center: Vec3, radius: number): Vec3 | null;
    /** A point about `distance` from `from` the agent can walk to, as far from it as it finds, or null. */
    fleePoint(from: Vec3, distance: number): Vec3 | null;
    /** The nearest object with a name (a trailing * matches the start) within `radius`; `visible`: in plain view. */
    findNearest(name: string, radius: number, visible: boolean): Object3D | null;
    /** Plays a sound at the agent (null when there is no such sound). */
    playSound(clip: string, volume: number, range: number): SoundPlaying | null;
    /** Plays a clip of the agent's model (fade < 0: the model's crossfade); false for an unknown clip. */
    playAnimation(clip: string, fade: number): boolean;
    /** Runs a sensor once. */
    sense(doc: SightServiceDoc | HearingServiceDoc): void;
    /** Raised when the context pool changes (an Ask with Use Context treats it like a fact change). */
    readonly contextVersion: number;
    /** A problem worth a warning in the console (reported once per node). */
    warn(node: string, message: string): void;
}

// ----------------------------------------------------------------- tasks

interface TaskRt {
    start(now: number): Status;
    update(now: number): Status;
    abort(now: number): void;
}

class WaitTask implements TaskRt {
    private until = 0;
    constructor(private doc: Extract<BtNodeDoc, { type: 'wait' }>, private host: TreeHost) {}
    start(now: number): Status {
        const dev = this.doc.deviation > 0 ? (this.host.random() * 2 - 1) * this.doc.deviation : 0;
        this.until = now + Math.max(0, this.doc.seconds + dev);
        return this.update(now);
    }
    update(now: number): Status {
        return now >= this.until ? 'success' : 'running';
    }
    abort() {}
}

class SetKeyTask implements TaskRt {
    constructor(private doc: Extract<BtNodeDoc, { type: 'set_key' }>, private host: TreeHost) {}
    start(): Status {
        try {
            this.host.blackboard.write(this.doc.key, this.doc.value, 'tree');
            return 'success';
        } catch (e: any) {
            this.host.warn(this.doc.id, e?.message || String(e));
            return 'failure';
        }
    }
    update(): Status {
        return 'success';
    }
    abort() {}
}

class ScriptTask implements TaskRt {
    private result: Status = 'running';
    private controller: AbortController | null = null;
    private handle: TaskHandle | null = null;

    constructor(private doc: ScriptTaskDoc, private host: TreeHost) {}

    start(): Status {
        const controller = new AbortController();
        this.controller = controller;
        this.result = 'running';
        const bb = this.host.blackboard;
        const self = this;
        let finished = false;
        const finish = (st: Status) => {
            if (finished || controller.signal.aborted || self.controller !== controller) return;
            finished = true;
            self.result = st;
        };
        const handle: TaskHandle = {
            node: this.doc.id,
            method: this.doc.method,
            signal: controller.signal,
            get aborted() {
                return controller.signal.aborted;
            },
            get: (key) => bb.get(key),
            set: (key, value) => {
                if (controller.signal.aborted) return;
                bb.write(key, value, 'tree');
            },
            succeed: () => finish('success'),
            fail: () => finish('failure'),
        };
        this.handle = handle;
        let value: unknown;
        try {
            value = this.host.callTask(this.doc, handle);
        } catch {
            return 'failure';
        }
        if (value && typeof (value as any).then === 'function') {
            (value as Promise<unknown>).then(
                (v) => finish(v === false ? 'failure' : 'success'),
                (e) => {
                    if (!controller.signal.aborted && e?.name !== 'AbortError') this.host.warn(this.doc.id, `${this.doc.method}() was rejected: ${e?.message || e}`);
                    finish('failure');
                },
            );
            return this.result;
        }
        if (value === 'running') return this.result;
        return value === false ? 'failure' : 'success';
    }

    update(): Status {
        return this.result;
    }

    abort() {
        const c = this.controller;
        const h = this.handle;
        this.controller = null;
        if (!c || !h || c.signal.aborted) return;
        c.abort();
        this.host.abortTask(this.doc, h);
    }
}

class MoveToTask implements TaskRt {
    private result: Status = 'running';
    private controller: AbortController | null = null;
    constructor(private doc: MoveToTaskDoc, private host: TreeHost) {}
    start(): Status {
        const walker = this.host.character();
        const target = this.host.blackboard.get(this.doc.target) as Object3D | null | undefined;
        if (!walker) this.host.warn(this.doc.id, 'Move To needs a Character on the agent\'s object (Add Component > Character).');
        if (!walker || !target) return 'failure';
        const controller = (this.controller = new AbortController());
        this.result = 'running';
        walker.moveTo(target, { radius: this.doc.radius, run: this.doc.run, signal: controller.signal }).then((arrived) => {
            if (!controller.signal.aborted) this.result = arrived ? 'success' : 'failure';
        });
        return 'running';
    }
    update(): Status {
        return this.result;
    }
    abort() {
        this.controller?.abort();
        this.controller = null;
    }
}

class LookAtTask implements TaskRt {
    private until = 0;
    constructor(private doc: LookAtTaskDoc, private host: TreeHost) {}
    start(now: number): Status {
        this.until = now + 3;
        return this.update(now);
    }
    update(now: number): Status {
        const target = this.host.blackboard.get(this.doc.target) as Object3D | null | undefined;
        if (!target?.transform) {
            this.host.turn(null);
            return 'failure';
        }
        const w = target.transform.worldPosition;
        // Done when it faces the target, or when it turned as long as a turn can take.
        if (this.host.turn([w.x, w.y, w.z]) || now >= this.until) {
            this.host.turn(null);
            return 'success';
        }
        return 'running';
    }
    abort() {
        this.host.turn(null);
    }
}

/** Walks the character to a point picked when the task starts (Wander, Flee). */
class WalkTask implements TaskRt {
    private result: Status = 'running';
    private controller: AbortController | null = null;
    constructor(
        private host: TreeHost,
        private id: string,
        private pick: () => Vec3 | null,
        private opts: { radius: number; run: boolean; done?: () => boolean },
    ) {}
    start(): Status {
        const walker = this.host.character();
        if (!walker) {
            this.host.warn(this.id, 'Walking needs a Character on the agent\'s object (Add Component > Character).');
            return 'failure';
        }
        const to = this.pick();
        if (!to) return 'failure';
        const controller = (this.controller = new AbortController());
        walker.moveTo(to, { radius: this.opts.radius, run: this.opts.run, signal: controller.signal }).then((arrived) => {
            if (!controller.signal.aborted) this.result = arrived ? 'success' : 'failure';
        });
        return this.update();
    }
    update(): Status {
        if (this.result === 'running' && this.opts.done?.()) {
            this.abort();
            return 'success';
        }
        return this.result;
    }
    abort() {
        this.controller?.abort();
        this.controller = null;
    }
}

function wanderTask(doc: WanderTaskDoc, host: TreeHost): TaskRt {
    return new WalkTask(host, doc.id, () => {
        const around = doc.around ? (host.blackboard.get(doc.around) as Object3D | null | undefined) : null;
        const w = around?.transform?.worldPosition;
        return host.randomPoint(w ? [w.x, w.y, w.z] : host.home(), doc.radius);
    }, { radius: 0.5, run: doc.run });
}

function fleeTask(doc: FleeTaskDoc, host: TreeHost): TaskRt {
    const threat = (): Vec3 | null => {
        const o = host.blackboard.get(doc.from) as Object3D | null | undefined;
        const w = o?.transform?.worldPosition;
        return w ? [w.x, w.y, w.z] : null;
    };
    const far = () => {
        const t = threat();
        const p = host.position();
        return !t || Math.hypot(p[0] - t[0], p[2] - t[2]) >= doc.distance;
    };
    return new WalkTask(host, doc.id, () => {
        const t = threat();
        return t ? host.fleePoint(t, doc.distance) : null;
    }, { radius: 0.5, run: doc.run, done: far });
}

class FindTask implements TaskRt {
    constructor(private doc: FindTaskDoc, private host: TreeHost) {}
    start(): Status {
        const found = this.host.findNearest(this.doc.name, this.doc.radius, this.doc.visible);
        if (!found) return 'failure';
        try {
            this.host.blackboard.write(this.doc.output, found, 'tree');
            return 'success';
        } catch (e: any) {
            this.host.warn(this.doc.id, e?.message || String(e));
            return 'failure';
        }
    }
    update(): Status {
        return 'success';
    }
    abort() {}
}

class PlaySoundTask implements TaskRt {
    private result: Status = 'running';
    private sound: SoundPlaying | null = null;
    constructor(private doc: PlaySoundTaskDoc, private host: TreeHost) {}
    start(): Status {
        const sound = this.host.playSound(this.doc.clip, this.doc.volume, this.doc.range);
        if (!sound) return 'failure';
        if (!this.doc.wait) return 'success';
        this.sound = sound;
        sound.done.then(() => {
            if (this.sound === sound) this.result = 'success';
        });
        return 'running';
    }
    update(): Status {
        return this.result;
    }
    abort() {
        this.sound?.stop();
        this.sound = null;
    }
}

class PlayAnimationTask implements TaskRt {
    private until = 0;
    constructor(private doc: PlayAnimationTaskDoc, private host: TreeHost) {}
    start(now: number): Status {
        if (!this.host.playAnimation(this.doc.clip, this.doc.fade)) {
            this.host.warn(this.doc.id, `The agent's model has no clip "${this.doc.clip}".`);
            return 'failure';
        }
        this.until = now + Math.max(0, this.doc.seconds);
        return this.update(now);
    }
    update(now: number): Status {
        return now >= this.until ? 'success' : 'running';
    }
    abort() {}
}

class AskTask implements TaskRt {
    private handle: AskHandle | null = null;
    constructor(private doc: AskTaskDoc, private host: TreeHost) {}
    start(): Status {
        this.handle = this.host.ask(this.doc, true);
        return this.update();
    }
    update(): Status {
        const h = this.handle;
        if (!h || !h.done) return 'running';
        return h.ok ? 'success' : 'failure';
    }
    abort() {
        // The request goes on: its answer is still written when it is the newest.
        this.handle = null;
    }
}

class InferTask implements TaskRt {
    private handle: InferHandle | null = null;
    constructor(private doc: InferTaskDoc, private host: TreeHost) {}
    start(now: number): Status {
        this.handle = this.host.infer(this.doc);
        return this.update(now);
    }
    update(now: number): Status {
        const h = this.handle;
        if (!h) return 'failure';
        if (h.done) return h.ok ? 'success' : 'failure';
        return now >= h.deadline ? 'failure' : 'running';
    }
    abort() {
        // The request goes on: its result is still written when it is the newest and in time.
        this.handle = null;
    }
}

function makeTask(doc: BtNodeDoc, host: TreeHost): TaskRt | null {
    switch (doc.type) {
        case 'wait':
            return new WaitTask(doc, host);
        case 'set_key':
            return new SetKeyTask(doc, host);
        case 'script':
            return new ScriptTask(doc, host);
        case 'move_to':
            return new MoveToTask(doc, host);
        case 'look_at':
            return new LookAtTask(doc, host);
        case 'wander':
            return wanderTask(doc, host);
        case 'flee':
            return fleeTask(doc, host);
        case 'find':
            return new FindTask(doc, host);
        case 'play_sound':
            return new PlaySoundTask(doc, host);
        case 'play_animation':
            return new PlayAnimationTask(doc, host);
        case 'ask':
            return new AskTask(doc, host);
        case 'infer':
            return new InferTask(doc, host);
        default:
            return null;
    }
}

// -------------------------------------------------------------- services

class ServiceRt {
    active = false;
    private nextAt = 0;
    /** Ask 'facts' trigger: the fact versions of the last request (0 = schema default). */
    private asked: number[] | null = null;

    constructor(readonly doc: BtServiceDoc, private host: TreeHost) {}

    private interval(): number {
        const j = this.doc.jitter > 0 ? (this.host.random() * 2 - 1) * this.doc.jitter : 0;
        return Math.max(0.05, this.doc.interval * (1 + j));
    }

    /** Recall and the sensors run on their interval. */
    private run(d: Exclude<BtServiceDoc, AskServiceDoc>) {
        if (d.type === 'recall') this.host.recall(d);
        else this.host.sense(d);
    }

    activate(now: number) {
        this.active = true;
        const d = this.doc;
        if (d.type !== 'ask') {
            this.run(d);
            this.nextAt = now + this.interval();
            return;
        }
        this.nextAt = now + this.interval();
        if (d.triggers.includes('activate')) this.request();
        else if (d.triggers.includes('facts') && this.factsChanged()) this.request();
    }

    tick(now: number) {
        const d = this.doc;
        if (d.type !== 'ask') {
            if (now >= this.nextAt) {
                this.run(d);
                this.nextAt = now + this.interval();
            }
            return;
        }
        if (d.triggers.includes('facts') && this.factsChanged()) this.request();
        else if (d.triggers.includes('interval') && now >= this.nextAt) this.request();
        if (now >= this.nextAt) this.nextAt = now + this.interval();
    }

    deactivate() {
        this.active = false;
    }

    /** Write versions of the Ask's facts (and of the recalled context when the Ask sends it). */
    private versions(): number[] {
        const d = this.doc as AskServiceDoc;
        const v = d.facts.map((f) => this.host.blackboard.version(f));
        if (d.context) v.push(this.host.contextVersion);
        return v;
    }

    private factsChanged(): boolean {
        const now = this.versions();
        const before = this.asked ?? now.map(() => 0);
        return now.some((v, i) => v !== before[i]);
    }

    private request() {
        this.asked = this.versions();
        this.host.ask(this.doc as AskServiceDoc, false);
    }
}

// ----------------------------------------------------------------- nodes

type Done = 'success' | 'failure';

class NodeRt {
    readonly children: NodeRt[] = [];
    readonly services: ServiceRt[];
    readonly cooldowns: { doc: BtDecoratorDoc; until: number }[];
    readonly conditions: ConditionDecoratorDoc[];
    /** Result decorators: Invert (an odd number of them), then Force Result. */
    readonly invert: boolean;
    readonly force: Done | null;
    /** Repeat / Retry: runs in all (0: no limit), or null without one. */
    readonly repeat: number | null;
    readonly retry: number | null;
    /** Time Limit: seconds a run may take, or null. */
    readonly timeLimit: number | null;
    active = false;
    /** Selector, Sequence, Random Selector: position of the running child in the run order. */
    current = -1;
    /** Random Selector: the order of this run (child indices). */
    order: number[] | null = null;
    /** Position in the parent's run order (the index, except under a Random Selector). */
    pos = 0;
    /** Parallel: how each child ended in this run (null: running or not started). */
    results: (Done | null)[] = [];
    /** Parallel with policy first: children that run again on the next tick. */
    readonly restart = new Set<number>();
    task: TaskRt | null = null;
    /** Result of the entry check the last time it was made (for lower priority aborts). */
    lastPass: boolean | null = null;
    /** How the node last ended, for the debug view. */
    last: { status: Status | 'aborted'; at: number } | null = null;
    /** Repeat / Retry: runs that succeeded and failed so far in this activation. */
    repeats = 0;
    tries = 0;
    /** Repeat / Retry: the node runs again on the next tick. */
    again = false;
    /** When the current run started (Time Limit). */
    startedAt = 0;

    constructor(readonly doc: BtNodeDoc, readonly parent: NodeRt | null, readonly index: number, host: TreeHost) {
        const decos = doc.decorators ?? [];
        this.conditions = decos.filter((d): d is ConditionDecoratorDoc => d.type === 'condition');
        this.cooldowns = decos.filter((d) => d.type === 'cooldown').map((d) => ({ doc: d, until: -Infinity }));
        this.invert = decos.filter((d) => d.type === 'invert').length % 2 === 1;
        this.force = decos.find((d) => d.type === 'force')?.result ?? null;
        const count = (type: 'repeat' | 'retry') => {
            const d = decos.find((x) => x.type === type) as { count: number } | undefined;
            return d ? Math.max(0, Math.round(d.count)) : null;
        };
        this.repeat = count('repeat');
        this.retry = count('retry');
        const limit = decos.find((d) => d.type === 'time_limit') as { seconds: number } | undefined;
        this.timeLimit = limit ? Math.max(0.05, limit.seconds) : null;
        this.services = (doc.services ?? []).map((s) => new ServiceRt(s, host));
        if (doc.type === 'selector' || doc.type === 'sequence' || doc.type === 'parallel' || doc.type === 'random') {
            doc.children.forEach((c, i) => this.children.push(new NodeRt(c, this, i, host)));
        }
    }

    get composite(): boolean {
        return this.doc.type === 'selector' || this.doc.type === 'sequence' || this.doc.type === 'parallel' || this.doc.type === 'random';
    }

    get parallel(): boolean {
        return this.doc.type === 'parallel';
    }

    get decorated(): boolean {
        return this.conditions.length > 0 || this.cooldowns.length > 0;
    }

    /** The child at a position of the run order. */
    childAt(pos: number): NodeRt | undefined {
        return this.children[this.order ? this.order[pos] : pos];
    }

    /** The running child of a Selector, Sequence or Random Selector. */
    get cur(): NodeRt | undefined {
        return this.current >= 0 ? this.childAt(this.current) : undefined;
    }
}

/** A condition's result on a blackboard. */
export function conditionPasses(bb: Blackboard, d: ConditionDecoratorDoc): boolean {
    const key = bb.key(d.key);
    if (!key) return false;
    const v = bb.get(d.key);
    if (d.minConfidence > 0 && key.owner === 'ai') {
        const a = bb.answer(d.key);
        if (!a || a.confidence < d.minConfidence) return false;
    }
    switch (d.op) {
        case 'set':
            if (key.owner === 'ai') return !!bb.answer(d.key);
            if (key.type === 'bool') return v === true;
            if (key.type === 'string') return typeof v === 'string' && v !== '';
            return v !== null && v !== undefined;
        case 'eq':
        case 'ne': {
            let want: unknown = d.value;
            if (key.type === 'object') {
                try {
                    want = bb.coerce(key, d.value);
                } catch {
                    want = undefined;
                }
            } else if (!valueFits(key, d.value)) return d.op === 'ne';
            return (v === want) === (d.op === 'eq');
        }
        case 'ge':
            return typeof v === 'number' && typeof d.value === 'number' && v >= d.value;
        case 'le':
            return typeof v === 'number' && typeof d.value === 'number' && v <= d.value;
    }
}

/** Debug view of an instance: the active nodes and how nodes last ended. */
export interface TreeDebug {
    active: string[];
    /** The running tasks (several under a Parallel). */
    running: string[];
    last: Record<string, { status: Status | 'aborted'; at: number }>;
}

/** Most node entries in one tick, against trees that would spin (every branch failing at once). */
const MAX_ENTRIES = 256;

export class TreeInstance {
    private root: NodeRt;
    private byId = new Map<string, NodeRt>();
    private entries = 0;
    /**
     * Set by stop(), for good: a task that destroyed its own object stops the
     * tree in the middle of a tick, and nothing after it may start.
     */
    private stopped = false;
    /** Ticks so far, for the debug view. */
    ticks = 0;

    constructor(readonly doc: BehaviorTreeDoc, private host: TreeHost) {
        this.root = new NodeRt(doc.root, null, 0, host);
        const index = (n: NodeRt) => {
            this.byId.set(n.doc.id, n);
            n.children.forEach(index);
        };
        index(this.root);
    }

    // ------------------------------------------------------------- ticking

    tick() {
        if (this.stopped) return;
        const now = this.host.now();
        this.ticks++;
        this.entries = 0;
        if (!this.root.active) {
            // The tree starts over; the root's services stay on through it.
            for (const s of this.root.services) if (s.active) s.tick(now);
            const st = this.enter(this.root, now);
            if (st !== 'running') this.root.last = { status: st, at: now };
            return;
        }
        this.checkAborts(this.root, now);
        this.tickServices(this.root, now);
        this.advance(now);
    }

    /** Aborts everything (Play stops or the agent is removed); the tree does not run again. */
    stop() {
        if (this.stopped) return;
        this.stopped = true;
        if (this.root.active) this.abort(this.root, this.host.now());
        for (const s of this.root.services) s.deactivate();
    }

    // --------------------------------------------------------------- entry

    private entryPasses(n: NodeRt, now: number): boolean {
        for (const c of n.cooldowns) if (now < c.until) return false;
        return this.conditionsPass(n);
    }

    private conditionsPass(n: NodeRt): boolean {
        for (const d of n.conditions) if (!conditionPasses(this.host.blackboard, d)) return false;
        return true;
    }

    /** Invert, then Force Result. */
    private modify(n: NodeRt, st: Done): Done {
        let out = st;
        if (n.invert) out = out === 'success' ? 'failure' : 'success';
        return n.force ?? out;
    }

    /** Tries to run a node: checks its decorators, activates it and runs it as far as it goes now. */
    private enter(n: NodeRt, now: number): Status {
        if (this.stopped || ++this.entries > MAX_ENTRIES) return 'failure';
        const pass = this.entryPasses(n, now);
        n.lastPass = pass;
        if (!pass) {
            const st = this.modify(n, 'failure');
            n.last = { status: st, at: now };
            return st;
        }
        n.active = true;
        n.repeats = 0;
        n.tries = 0;
        for (const s of n.services) if (!s.active) s.activate(now);
        let st = this.body(n, now);
        // The task stopped the tree (it destroyed its own object): everything is aborted already.
        if (this.stopped) return 'failure';
        if (st !== 'running') st = this.settle(n, st, now);
        if (st !== 'running') this.deactivate(n, now, st);
        return st;
    }

    /** Starts a run of an active node: its children or its task. */
    private body(n: NodeRt, now: number): Status {
        n.startedAt = now;
        n.again = false;
        if (n.parallel) return this.runParallel(n, now);
        if (n.composite) {
            if (n.doc.type === 'random') {
                const order = n.children.map((_, i) => i);
                for (let i = order.length - 1; i > 0; i--) {
                    const j = Math.floor(this.host.random() * (i + 1));
                    [order[i], order[j]] = [order[j], order[i]];
                }
                n.order = order;
            }
            return this.runChildren(n, 0, now);
        }
        n.task = makeTask(n.doc, this.host);
        return n.task ? n.task.start(now) : 'failure';
    }

    /**
     * A run of the node ended with `st`: Repeat or Retry may run it again on
     * the next tick ('running'), else Invert and Force give its result.
     */
    private settle(n: NodeRt, st: Done, now: number): Status {
        const limit = st === 'success' ? n.repeat : n.retry;
        if (limit !== null) {
            const runs = st === 'success' ? ++n.repeats : ++n.tries;
            if (limit === 0 || runs < limit) {
                n.again = true;
                n.task = null;
                n.current = -1;
                n.last = { status: st, at: now };
                return 'running';
            }
        }
        return this.modify(n, st);
    }

    /** Runs a composite's children from position `from` on; returns the composite's status (it is not deactivated here). */
    private runChildren(n: NodeRt, from: number, now: number): Status {
        const selector = n.doc.type !== 'sequence';
        for (let i = from; i < n.children.length; i++) {
            n.current = i;
            const child = n.childAt(i)!;
            child.pos = i;
            const st = this.enter(child, now);
            if (this.stopped) return 'failure';
            if (st === 'running') return 'running';
            if (selector && st === 'success') return 'success';
            if (!selector && st === 'failure') return 'failure';
        }
        n.current = -1;
        return selector ? 'failure' : 'success';
    }

    /** Starts every child of a Parallel; its status when that is decided already. */
    private runParallel(n: NodeRt, now: number): Status {
        n.results = n.children.map(() => null);
        n.restart.clear();
        if (!n.children.length) return (n.doc as ParallelNodeDoc).policy === 'one' ? 'failure' : 'success';
        for (const child of n.children) {
            const st = this.enter(child, now);
            if (this.stopped) return 'failure';
            if (st === 'running') continue;
            const decided = this.childEnded(n, child, st, now);
            if (decided) return decided;
        }
        return 'running';
    }

    /**
     * A child of a Parallel ended: the Parallel's result when that decides
     * it (the children still running are aborted), else null.
     */
    private childEnded(n: NodeRt, child: NodeRt, st: Done, now: number): Done | null {
        const policy = (n.doc as ParallelNodeDoc).policy;
        n.results[child.index] = st;
        let decided: Done | null = null;
        if (policy === 'first') {
            if (child.index === 0) decided = st;
            // The others run beside the first one: again on the next tick.
            else n.restart.add(child.index);
        } else if (policy === 'all') {
            if (st === 'failure') decided = 'failure';
            else if (n.results.every((r) => r === 'success')) decided = 'success';
        } else if (st === 'success') decided = 'success';
        else if (n.results.every((r) => r === 'failure')) decided = 'failure';
        if (decided) {
            for (const c of n.children) if (c !== child) this.abort(c, now);
            n.restart.clear();
        }
        return decided;
    }

    private deactivate(n: NodeRt, now: number, st: Status | 'aborted') {
        if (!n.active) return;
        n.active = false;
        n.current = -1;
        n.order = null;
        n.task = null;
        n.again = false;
        n.restart.clear();
        n.last = { status: st, at: now };
        // The root's services run as long as the tree does (see stop()).
        if (n !== this.root) for (const s of n.services) s.deactivate();
        for (const c of n.cooldowns) c.until = now + Math.max(0, (c.doc as any).seconds ?? 0);
    }

    /** Aborts a node and everything running under it, deepest first. */
    private abort(n: NodeRt, now: number) {
        if (!n.active) return;
        if (n.parallel) {
            for (const c of n.children) this.abort(c, now);
        } else if (n.composite) {
            const cur = n.cur;
            if (cur) this.abort(cur, now);
        } else if (n.task) {
            // A task that finished since the last tick (its promise settled,
            // succeed() was called) keeps its result: it is not aborted.
            const done = n.task.update(now);
            if (done !== 'running') {
                this.deactivate(n, now, done);
                return;
            }
            n.task.abort(now);
        }
        this.deactivate(n, now, 'aborted');
    }

    /**
     * A node's run ended on its own (its task, its children, a time limit):
     * it runs again, or it ends and its parents go on.
     */
    private finish(n: NodeRt, st: Done, now: number) {
        const out = this.settle(n, st, now);
        if (out === 'running') return;
        this.deactivate(n, now, out);
        this.propagate(n, out, now);
    }

    /** A child ended with `st`: its parents go on (next child) or end, up to the root. */
    private propagate(child: NodeRt, st: Done, now: number) {
        let node = child;
        let status: Done = st;
        let parent = node.parent;
        while (parent && !this.stopped) {
            if (!parent.active) return;
            let ended: Done;
            if (parent.parallel) {
                const decided = this.childEnded(parent, node, status, now);
                if (!decided) return;
                ended = decided;
            } else {
                const selector = parent.doc.type !== 'sequence';
                const goOn = selector ? status === 'failure' : status === 'success';
                ended = status;
                if (goOn) {
                    const next = this.runChildren(parent, node.pos + 1, now);
                    if (next === 'running') return;
                    ended = next;
                }
            }
            const out = this.settle(parent, ended, now);
            if (out === 'running') return;
            this.deactivate(parent, now, out);
            node = parent;
            status = out;
            parent = node.parent;
        }
        // The root ended: the tree starts over on the next tick.
    }

    // -------------------------------------------------------------- aborts

    /** Checks conditions and time limits over the active nodes; true when something was aborted. */
    private checkAborts(n: NodeRt, now: number): boolean {
        if (!n.active) return false;
        // Self: the node's own conditions (the root has none).
        if (n.parent && n.conditions.length && !this.conditionsPass(n)) {
            n.lastPass = false;
            // A task that finished before its conditions failed keeps its result.
            const done = n.task ? n.task.update(now) : 'running';
            if (done !== 'running') {
                this.finish(n, done, now);
                return true;
            }
            this.abort(n, now);
            const out = this.modify(n, 'failure');
            n.last = { status: out, at: now };
            this.propagate(n, out, now);
            return true;
        }
        // Time Limit: the run took too long, it fails (a Retry may try again).
        if (n.timeLimit !== null && !n.again && now - n.startedAt >= n.timeLimit) {
            const done = n.task ? n.task.update(now) : 'running';
            if (done !== 'running') {
                this.finish(n, done, now);
                return true;
            }
            this.abortRun(n, now);
            this.finish(n, 'failure', now);
            return true;
        }
        if (!n.composite) return false;
        if (n.parallel) {
            for (const c of n.children) if (this.checkAborts(c, now)) return true;
            return false;
        }
        const cur = n.cur;
        if (!cur) return false;
        // Lower priority: a higher branch of a Selector whose decorators start to pass.
        if (n.doc.type === 'selector') {
            for (let i = 0; i < n.current; i++) {
                const sib = n.children[i];
                if (!sib.decorated) continue;
                const pass = this.entryPasses(sib, now);
                const was = sib.lastPass;
                sib.lastPass = pass;
                if (pass && was === false) {
                    this.abort(cur, now);
                    const st = this.runChildren(n, i, now);
                    if (st !== 'running') this.finish(n, st, now);
                    return true;
                }
            }
        }
        return this.checkAborts(cur, now);
    }

    /** Aborts what a node runs now, the node staying active (its run is ended by the caller). */
    private abortRun(n: NodeRt, now: number) {
        if (n.parallel) for (const c of n.children) this.abort(c, now);
        else if (n.composite) {
            const cur = n.cur;
            if (cur) this.abort(cur, now);
        } else n.task?.abort(now);
        n.task = null;
        n.current = -1;
    }

    // ------------------------------------------------------------ services

    private tickServices(n: NodeRt, now: number) {
        if (!n.active) return;
        for (const s of n.services) if (s.active) s.tick(now);
        if (n.parallel) for (const c of n.children) this.tickServices(c, now);
        else if (n.composite) {
            const cur = n.cur;
            if (cur) this.tickServices(cur, now);
        }
    }

    // ---------------------------------------------------------------- tasks

    /**
     * Moves the tree on: running tasks that finished end, nodes that repeat
     * start their next run, and a Parallel's side branches start again.
     */
    private advance(now: number) {
        const work: { n: NodeRt; kind: 'task' | 'again' | 'restart' }[] = [];
        const visit = (n: NodeRt) => {
            if (!n.active) return;
            if (n.again) {
                work.push({ n, kind: 'again' });
                return;
            }
            if (n.parallel) {
                for (const i of n.restart) work.push({ n: n.children[i], kind: 'restart' });
                n.children.forEach(visit);
            } else if (n.composite) {
                const cur = n.cur;
                if (cur) visit(cur);
            } else if (n.task) work.push({ n, kind: 'task' });
        };
        visit(this.root);
        for (const { n, kind } of work) {
            if (this.stopped) return;
            if (kind === 'task') {
                if (!n.active || !n.task) continue;
                const st = n.task.update(now);
                if (st !== 'running') this.finish(n, st, now);
            } else if (kind === 'again') {
                if (!n.active || !n.again) continue;
                const st = this.body(n, now);
                if (st !== 'running' && !this.stopped) this.finish(n, st, now);
            } else {
                const parent = n.parent!;
                if (!parent.active || !parent.restart.delete(n.index)) continue;
                parent.results[n.index] = null;
                const st = this.enter(n, now);
                if (st !== 'running' && !this.stopped) {
                    const decided = this.childEnded(parent, n, st, now);
                    if (decided) this.finish(parent, decided, now);
                }
            }
        }
    }

    // --------------------------------------------------------------- debug

    debug(): TreeDebug {
        const active: string[] = [];
        const running: string[] = [];
        const visit = (n: NodeRt) => {
            if (!n.active) return;
            active.push(n.doc.id);
            for (const s of n.services) if (s.active) active.push(s.doc.id);
            if (n.parallel) n.children.forEach(visit);
            else if (n.composite) {
                const cur = n.cur;
                if (cur) visit(cur);
            } else running.push(n.doc.id);
        };
        if (!this.root.active) for (const s of this.root.services) if (s.active) active.push(s.doc.id);
        visit(this.root);
        const last: TreeDebug['last'] = {};
        for (const [id, node] of this.byId) if (node.last) last[id] = node.last;
        return { active, running, last };
    }
}

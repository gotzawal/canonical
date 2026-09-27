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
// - Services run only while the node they are attached to is active.
// - Aborted tasks get their abort hook (scripts: onTaskAbort and the task's
//   AbortSignal).
//
// The tree never waits on anything: answers, recall results and promises
// settle between ticks and the next tick sees them.

import { valueFits } from '../../core/behavior/nodeTypes';
import type {
    AskServiceDoc, AskTaskDoc, BehaviorTreeDoc, BtDecoratorDoc, BtNodeDoc, BtServiceDoc, ConditionDecoratorDoc,
    RecallServiceDoc, ScriptTaskDoc,
} from '../../core/types';
import type { Blackboard } from './blackboard';

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
    /** Runs a Recall service once. */
    recall(doc: RecallServiceDoc): void;
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

function makeTask(doc: BtNodeDoc, host: TreeHost): TaskRt | null {
    switch (doc.type) {
        case 'wait':
            return new WaitTask(doc, host);
        case 'set_key':
            return new SetKeyTask(doc, host);
        case 'script':
            return new ScriptTask(doc, host);
        case 'ask':
            return new AskTask(doc, host);
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

    activate(now: number) {
        this.active = true;
        const d = this.doc;
        if (d.type === 'recall') {
            this.host.recall(d);
            this.nextAt = now + this.interval();
            return;
        }
        this.nextAt = now + this.interval();
        if (d.triggers.includes('activate')) this.request();
        else if (d.triggers.includes('facts') && this.factsChanged()) this.request();
    }

    tick(now: number) {
        const d = this.doc;
        if (d.type === 'recall') {
            if (now >= this.nextAt) {
                this.host.recall(d);
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

    private versions(): number[] {
        const d = this.doc as AskServiceDoc;
        return d.facts.map((f) => this.host.blackboard.version(f));
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

class NodeRt {
    readonly children: NodeRt[] = [];
    readonly services: ServiceRt[];
    readonly cooldowns: { doc: BtDecoratorDoc; until: number }[];
    readonly conditions: ConditionDecoratorDoc[];
    active = false;
    /** Composites: index of the running child. */
    current = -1;
    task: TaskRt | null = null;
    /** Result of the entry check the last time it was made (for lower priority aborts). */
    lastPass: boolean | null = null;
    /** How the node last ended, for the debug view. */
    last: { status: Status | 'aborted'; at: number } | null = null;

    constructor(readonly doc: BtNodeDoc, readonly parent: NodeRt | null, readonly index: number, host: TreeHost) {
        const decos = doc.decorators ?? [];
        this.conditions = decos.filter((d): d is ConditionDecoratorDoc => d.type === 'condition');
        this.cooldowns = decos.filter((d) => d.type === 'cooldown').map((d) => ({ doc: d, until: -Infinity }));
        this.services = (doc.services ?? []).map((s) => new ServiceRt(s, host));
        if (doc.type === 'selector' || doc.type === 'sequence') {
            doc.children.forEach((c, i) => this.children.push(new NodeRt(c, this, i, host)));
        }
    }

    get composite(): boolean {
        return this.doc.type === 'selector' || this.doc.type === 'sequence';
    }

    get decorated(): boolean {
        return this.conditions.length > 0 || this.cooldowns.length > 0;
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

/** Debug view of an instance: the active path and how nodes last ended. */
export interface TreeDebug {
    active: string[];
    running: string | null;
    last: Record<string, { status: Status | 'aborted'; at: number }>;
}

/** Most node entries in one tick, against trees that would spin (every branch failing at once). */
const MAX_ENTRIES = 256;

export class TreeInstance {
    private root: NodeRt;
    private byId = new Map<string, NodeRt>();
    private entries = 0;
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
        const now = this.host.now();
        this.ticks++;
        this.entries = 0;
        if (!this.root.active) {
            const st = this.enter(this.root, now);
            if (st !== 'running') this.root.last = { status: st, at: now };
            return;
        }
        this.checkAborts(now);
        this.tickServices(this.root, now);
        this.updateTask(now);
    }

    /** Aborts everything (Play stops or the agent is removed). */
    stop() {
        if (this.root.active) this.abort(this.root, this.host.now());
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

    /** Tries to run a node: checks its decorators, activates it and runs it as far as it goes now. */
    private enter(n: NodeRt, now: number): Status {
        if (++this.entries > MAX_ENTRIES) return 'failure';
        const pass = this.entryPasses(n, now);
        n.lastPass = pass;
        if (!pass) {
            n.last = { status: 'failure', at: now };
            return 'failure';
        }
        n.active = true;
        for (const s of n.services) s.activate(now);
        let st: Status;
        if (n.composite) st = this.runChildren(n, 0, now);
        else {
            n.task = makeTask(n.doc, this.host);
            st = n.task ? n.task.start(now) : 'failure';
        }
        if (st !== 'running') this.deactivate(n, now, st);
        return st;
    }

    /** Runs a composite's children from `from` on; returns the composite's status (it is not deactivated here). */
    private runChildren(n: NodeRt, from: number, now: number): Status {
        const selector = n.doc.type === 'selector';
        for (let i = from; i < n.children.length; i++) {
            n.current = i;
            const st = this.enter(n.children[i], now);
            if (st === 'running') return 'running';
            if (selector && st === 'success') return 'success';
            if (!selector && st === 'failure') return 'failure';
        }
        n.current = -1;
        return selector ? 'failure' : 'success';
    }

    private deactivate(n: NodeRt, now: number, st: Status | 'aborted') {
        if (!n.active) return;
        n.active = false;
        n.current = -1;
        n.task = null;
        n.last = { status: st, at: now };
        for (const s of n.services) s.deactivate();
        for (const c of n.cooldowns) c.until = now + Math.max(0, (c.doc as any).seconds ?? 0);
    }

    /** Aborts a node and everything running under it, deepest first. */
    private abort(n: NodeRt, now: number) {
        if (!n.active) return;
        if (n.composite) {
            const cur = n.children[n.current];
            if (cur) this.abort(cur, now);
        } else {
            n.task?.abort(now);
        }
        this.deactivate(n, now, 'aborted');
    }

    /** A child finished with `st`: its parents go on (next child) or finish, up to the root. */
    private propagate(child: NodeRt, st: Status, now: number) {
        let node = child;
        let status = st;
        let parent = node.parent;
        while (parent) {
            const selector = parent.doc.type === 'selector';
            const goOn = selector ? status === 'failure' : status === 'success';
            if (goOn) {
                const next = this.runChildren(parent, node.index + 1, now);
                if (next === 'running') return;
                status = next;
            }
            this.deactivate(parent, now, status);
            node = parent;
            parent = node.parent;
        }
        // The root finished: the tree starts over on the next tick.
    }

    // -------------------------------------------------------------- aborts

    /** Checks the conditions along the active path; returns true when something was aborted. */
    private checkAborts(now: number): boolean {
        let n: NodeRt | undefined = this.root;
        while (n && n.active) {
            // Self: the node's own conditions (the root has none).
            if (n.parent && n.conditions.length && !this.conditionsPass(n)) {
                this.abort(n, now);
                n.lastPass = false;
                this.propagate(n, 'failure', now);
                return true;
            }
            if (!n.composite) return false;
            const cur: NodeRt | undefined = n.children[n.current];
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
                        if (st !== 'running') {
                            this.deactivate(n, now, st);
                            this.propagate(n, st, now);
                        }
                        return true;
                    }
                }
            }
            n = cur;
        }
        return false;
    }

    // ------------------------------------------------------------ services

    private tickServices(n: NodeRt, now: number) {
        if (!n.active) return;
        for (const s of n.services) if (s.active) s.tick(now);
        if (n.composite) {
            const cur = n.children[n.current];
            if (cur) this.tickServices(cur, now);
        }
    }

    // ---------------------------------------------------------------- task

    private updateTask(now: number) {
        let n: NodeRt = this.root;
        while (n.composite) {
            const cur = n.children[n.current];
            if (!cur || !cur.active) return;
            n = cur;
        }
        if (!n.active || !n.task) return;
        const st = n.task.update(now);
        if (st === 'running') return;
        this.deactivate(n, now, st);
        this.propagate(n, st, now);
    }

    // --------------------------------------------------------------- debug

    debug(): TreeDebug {
        const active: string[] = [];
        let running: string | null = null;
        let n: NodeRt | undefined = this.root;
        while (n && n.active) {
            active.push(n.doc.id);
            for (const s of n.services) if (s.active) active.push(s.doc.id);
            if (!n.composite) {
                running = n.doc.id;
                break;
            }
            n = n.children[n.current];
        }
        const last: TreeDebug['last'] = {};
        for (const [id, node] of this.byId) if (node.last) last[id] = node.last;
        return { active, running, last };
    }
}

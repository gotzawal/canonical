import { Camera3D, Color, LitMaterial, MeshRenderer, Object3D, RenderNode } from '@orillusion/core';
import { defaultGeometry } from '../core/defaults';
import { Emitter } from '../core/events';
import type { Checkpoint, Store } from '../core/store';
import type { NodeDoc } from '../core/types';
import { hexToColor } from '../engine/color';
import { cloneMaterial } from '../engine/modelParts';
import type { Picker } from '../engine/picking';
import type { Runtime } from '../engine/runtime';
import { buildGeometry, type SceneSync } from '../engine/sync';
import { logInfo } from '../ui/statusbar';
import { scriptLocation, type ScriptCompiler } from './compiler';
import { Input } from './input';
import { CTX, Script, withContext, type PlayApi, type Shape, type SpawnOptions, type ScriptTime } from './script';

export type PlayState = 'stopped' | 'playing' | 'paused';

/** A problem raised by a script while playing. */
export interface ScriptIssue {
    script: string;
    scriptName: string;
    node: string;
    method: string;
    line: number;
    message: string;
    time: number;
}

/** One line of script output, for the console and the AI tools. */
export interface ScriptLog {
    level: 'info' | 'warn' | 'error';
    text: string;
    time: number;
}

interface Instance {
    script: Script;
    scriptId: string;
    scriptName: string;
    nodeId: string;
    obj: Object3D;
    /** Stopped after an error in a per-frame method. */
    broken: boolean;
    destroyed: boolean;
}

interface Timer {
    owner: Script;
    at: number;
    every: number;
    fn: () => void;
    cancelled: boolean;
}

interface PlayerEvents {
    state: PlayState;
    issue: ScriptIssue;
}

const MAX_DT = 0.1;

/**
 * Play mode: instantiates the scripts attached to nodes, runs their
 * lifecycle every frame and, on Stop, puts the document, its undo history
 * and the engine scene back the way they were.
 */
export class Player extends Emitter<PlayerEvents> implements PlayApi {
    state: PlayState = 'stopped';
    readonly input = new Input();
    readonly time: ScriptTime = { delta: 0, elapsed: 0, frame: 0 };
    readonly issues: ScriptIssue[] = [];
    readonly logs: ScriptLog[] = [];

    private instances: Instance[] = [];
    private timers: Timer[] = [];
    private spawnedBy = new Map<Script, Object3D[]>();
    private spawnedAll = new Set<Object3D>();
    private pendingDestroy: { obj: Object3D; at: number; owner: Script }[] = [];
    private recolored = new WeakSet<RenderNode>();
    private checkpointState: Checkpoint | null = null;
    private sceneChildren = new Set<Object3D>();
    private offFrame: (() => void) | null = null;
    private last = 0;
    private stepOnce = false;
    private pointerTarget: { obj: Object3D; x: number; y: number } | null = null;
    private gameCamera: Camera3D | null = null;
    private listeners: [EventTarget, string, EventListener][] = [];

    constructor(
        private runtime: Runtime,
        private store: Store,
        private sync: SceneSync,
        private picker: Picker,
        private compiler: ScriptCompiler,
    ) {
        super();
    }

    get engine() {
        return this.runtime.engine;
    }

    get scene() {
        return this.runtime.scene;
    }

    camera(): Camera3D {
        return this.runtime.activeCamera;
    }

    /** True when Play renders through a camera node instead of the editor camera. */
    get usesGameCamera(): boolean {
        return !!this.gameCamera;
    }

    // --------------------------------------------------------------- control

    play() {
        if (this.state !== 'stopped') {
            if (this.state === 'paused') this.setState('playing');
            return;
        }
        this.checkpointState = this.store.checkpoint();
        this.store.setPlaying(true);
        this.issues.length = 0;
        this.logs.length = 0;
        this.time.delta = 0;
        this.time.elapsed = 0;
        this.time.frame = 0;
        this.sceneChildren = new Set(this.runtime.scene.entityChildren as Object3D[]);
        this.setupCamera();
        this.instantiate();
        this.bindInput();
        this.last = performance.now();
        this.offFrame = this.runtime.onBeforeFrame(() => this.tick());
        this.setState('playing');
        for (const inst of this.instances) this.call(inst, 'awake');
        for (const inst of this.instances) this.call(inst, 'start');
    }

    pause() {
        if (this.state === 'playing') this.setState('paused');
    }

    /** Advances one frame while paused. */
    step() {
        if (this.state === 'paused') this.stepOnce = true;
    }

    stop() {
        if (this.state === 'stopped') return;
        for (const inst of this.instances) {
            if (!inst.destroyed) this.call(inst, 'onDestroy');
        }
        this.offFrame?.();
        this.offFrame = null;
        this.unbindInput();
        this.instances = [];
        this.timers = [];
        this.spawnedBy.clear();
        this.pendingDestroy = [];
        this.pointerTarget = null;
        this.runtime.setActiveCamera(null);
        this.gameCamera = null;
        // Remove everything scripts added to the scene root, then rebuild
        // the document's objects from scratch.
        for (const child of Array.from(this.runtime.scene.entityChildren as Object3D[])) {
            if (!this.sceneChildren.has(child)) {
                child.removeFromParent();
                try {
                    child.destroy();
                } catch { /* already gone */ }
            }
        }
        this.spawnedAll.clear();
        this.sync.detached.clear();
        if (this.checkpointState) this.store.restoreCheckpoint(this.checkpointState);
        this.checkpointState = null;
        this.runtime.invalidateEnvironment();
        this.sync.rebuild();
        this.input.reset();
        this.input.endFrame();
        this.setState('stopped');
        this.store.setPlaying(false);
    }

    /** Plays for `seconds`, stops, and returns what the scripts reported. */
    async runFor(seconds: number): Promise<{ logs: ScriptLog[]; issues: ScriptIssue[]; frames: number }> {
        if (this.state !== 'stopped') this.stop();
        this.play();
        await new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
        const result = { logs: this.logs.slice(), issues: this.issues.slice(), frames: this.time.frame };
        this.stop();
        return result;
    }

    private setState(state: PlayState) {
        this.state = state;
        this.emit('state', state);
    }

    // ---------------------------------------------------------------- setup

    private setupCamera() {
        const nodes = this.store.doc.nodes.filter((n) => n.camera);
        const node = nodes.find((n) => n.camera!.main) ?? nodes[0];
        if (!node) return;
        const entry = this.sync.entries.get(node.id);
        if (!entry) return;
        const cam = entry.obj.addComponent(Camera3D);
        const c = node.camera!;
        cam.perspective(c.fov, this.runtime.engine.aspect, c.near, c.far);
        this.gameCamera = cam;
        this.runtime.setActiveCamera(cam);
    }

    private instantiate() {
        const failed = new Set<string>();
        let paused = false;
        for (const node of this.store.doc.nodes) {
            if (!node.scripts?.length) continue;
            const entry = this.sync.entries.get(node.id);
            if (!entry) continue;
            for (const ref of node.scripts) {
                if (!ref.enabled) continue;
                const compiled = this.compiler.get(ref.script);
                if (!compiled) continue;
                if (compiled.paused) {
                    paused = true;
                    continue;
                }
                if (!compiled.cls) {
                    if (!failed.has(ref.script)) {
                        failed.add(ref.script);
                        const e = compiled.error;
                        this.report(ref.script, compiled.name, node, 'compile', e?.line ?? 0, e?.message ?? 'The script does not compile.');
                    }
                    continue;
                }
                const ctx = { nodeId: node.id, nodeName: node.name, scriptName: compiled.name, object3D: entry.obj, api: this };
                let script: Script;
                try {
                    script = withContext(ctx, () => new compiled.cls!());
                } catch (e: any) {
                    const loc = scriptLocation(e);
                    this.report(ref.script, compiled.name, node, 'constructor', loc?.line ?? 0, e?.message || String(e));
                    continue;
                }
                for (const f of compiled.fields) {
                    if (!(f.name in ref.props)) continue;
                    const v = ref.props[f.name];
                    const ok =
                        (f.type === 'number' && typeof v === 'number') ||
                        (f.type === 'boolean' && typeof v === 'boolean') ||
                        ((f.type === 'string' || f.type === 'color') && typeof v === 'string') ||
                        (f.type === 'vec3' && Array.isArray(v) && v.length === 3);
                    if (ok) (script as any)[f.name] = Array.isArray(v) ? v.slice() : v;
                }
                this.instances.push({
                    script,
                    scriptId: ref.script,
                    scriptName: compiled.name,
                    nodeId: node.id,
                    obj: entry.obj,
                    broken: false,
                    destroyed: false,
                });
            }
        }
        if (paused) {
            const text = 'Scripts are paused, so the scene plays without them. Choose "Enable Scripts" to run them.';
            console.warn(text);
            this.pushLog('warn', text);
        }
    }

    // ----------------------------------------------------------------- frame

    private tick() {
        const now = performance.now();
        const raw = (now - this.last) / 1000;
        this.last = now;
        if (this.state !== 'playing' && !this.stepOnce) return;
        const dt = this.stepOnce ? 1 / 60 : Math.min(MAX_DT, Math.max(0, raw));
        this.stepOnce = false;
        this.time.delta = dt;
        this.time.elapsed += dt;
        this.time.frame++;

        for (const inst of this.instances.slice()) {
            if (!inst.broken && !inst.destroyed) this.call(inst, 'update', dt);
        }
        this.runTimers();
        for (const inst of this.instances.slice()) {
            if (!inst.broken && !inst.destroyed) this.call(inst, 'lateUpdate', dt);
        }
        if (this.pendingDestroy.length) {
            const due = this.pendingDestroy.filter((d) => d.at <= this.time.elapsed);
            this.pendingDestroy = this.pendingDestroy.filter((d) => d.at > this.time.elapsed);
            for (const d of due) this.destroy(d.owner, d.obj);
        }
        this.input.endFrame();
    }

    private runTimers() {
        for (const t of this.timers.slice()) {
            if (t.cancelled || t.at > this.time.elapsed) continue;
            const inst = this.instances.find((i) => i.script === t.owner);
            if (inst && (inst.destroyed || inst.broken)) {
                t.cancelled = true;
                continue;
            }
            try {
                t.fn();
            } catch (e: any) {
                if (inst) this.fail(inst, 'timer', e);
                t.cancelled = true;
            }
            if (t.every > 0) t.at += t.every;
            else t.cancelled = true;
        }
        this.timers = this.timers.filter((t) => !t.cancelled);
    }

    private call(inst: Instance, method: string, ...args: unknown[]) {
        const fn = (inst.script as any)[method];
        if (typeof fn !== 'function') return;
        try {
            fn.apply(inst.script, args);
        } catch (e) {
            this.fail(inst, method, e);
        }
    }

    private fail(inst: Instance, method: string, e: any) {
        const loc = scriptLocation(e);
        const node = this.store.node(inst.nodeId);
        this.report(inst.scriptId, inst.scriptName, node, method, loc?.line ?? 0, `${e?.name || 'Error'}: ${e?.message || e}`);
        if (method === 'update' || method === 'lateUpdate' || method === 'timer') inst.broken = true;
    }

    private report(script: string, scriptName: string, node: NodeDoc | undefined, method: string, line: number, message: string) {
        const issue: ScriptIssue = { script, scriptName, node: node?.name ?? '', method, line, message, time: this.time.elapsed };
        this.issues.push(issue);
        const where = `${scriptName}${line ? ':' + line : ''}`;
        const stopped = method === 'update' || method === 'lateUpdate' || method === 'timer' ? ' The script was stopped.' : '';
        console.error(`[${where}] ${method}() on "${issue.node}": ${message}.${stopped}`);
        this.pushLog('error', `[${where}] ${method}(): ${message}`);
        this.emit('issue', issue);
    }

    private pushLog(level: ScriptLog['level'], text: string) {
        this.logs.push({ level, text, time: this.time.elapsed });
        if (this.logs.length > 500) this.logs.shift();
    }

    // ----------------------------------------------------------------- input

    private bindInput() {
        const on = (target: EventTarget, type: string, fn: EventListener) => {
            target.addEventListener(type, fn);
            this.listeners.push([target, type, fn]);
        };
        on(window, 'blur', () => this.input.reset());
    }

    private unbindInput() {
        for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
        this.listeners = [];
    }

    /** Keyboard events routed here by the editor while the viewport has focus. */
    keyEvent(e: KeyboardEvent, down: boolean) {
        if (this.state === 'stopped') return;
        const key = this.input.keyEvent(e, down);
        if (e.repeat) return;
        for (const inst of this.instances.slice()) {
            if (!inst.broken && !inst.destroyed) this.call(inst, down ? 'onKeyDown' : 'onKeyUp', key);
        }
    }

    /** Pointer events routed here by the viewport while playing. */
    pointerEvent(type: 'down' | 'move' | 'up', x: number, y: number, button: number) {
        if (this.state === 'stopped') return;
        this.input.pointerMove(x, y);
        if (type === 'move') return;
        this.input.pointerButton(button, type === 'down');
        this.picker.update();
        const skip = (o: Object3D) => o === this.runtime.grid || o === this.runtime.camera.object3D;
        const hit = this.picker.pickObject(x, y, this.runtime.scene, skip);
        const info = { x, y, button, point: hit ? hit.point : ([0, 0, 0] as [number, number, number]) };
        const targets = hit ? this.instancesOn(hit.object) : [];
        if (type === 'down') {
            this.pointerTarget = hit ? { obj: hit.object, x, y } : null;
            for (const inst of targets) this.call(inst, 'onPointerDown', info);
        } else {
            for (const inst of targets) this.call(inst, 'onPointerUp', info);
            const t = this.pointerTarget;
            this.pointerTarget = null;
            if (t && hit && Math.hypot(t.x - x, t.y - y) < 8) {
                const clickTargets = this.instancesOn(t.obj).filter((i) => targets.includes(i));
                for (const inst of clickTargets) this.call(inst, 'onClick', info);
            }
        }
    }

    wheelEvent(delta: number) {
        if (this.state !== 'stopped') this.input.wheel(delta);
    }

    /** Script instances on an object or its nearest ancestor that has scripts. */
    private instancesOn(obj: Object3D): Instance[] {
        let o: Object3D | null = obj;
        while (o) {
            const list = this.instances.filter((i) => i.obj === o && !i.destroyed && !i.broken);
            if (list.length) return list;
            o = (o.transform.parent?.object3D as Object3D) ?? null;
        }
        return [];
    }

    // ------------------------------------------------------------ script API

    log(level: 'info' | 'warn' | 'error', script: Script, args: unknown[]) {
        const text = args
            .map((a) => {
                if (typeof a === 'string') return a;
                if (a instanceof Error) return a.message;
                try {
                    return JSON.stringify(a);
                } catch {
                    return String(a);
                }
            })
            .join(' ');
        const line = `[${script[CTX].scriptName} on ${script[CTX].nodeName}] ${text}`;
        this.pushLog(level, line);
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else {
            console.log(line);
            logInfo(line);
        }
    }

    find(name: string): Object3D | null {
        return this.findAll(name)[0] ?? null;
    }

    findAll(name: string): Object3D[] {
        const out: Object3D[] = [];
        for (const node of this.store.doc.nodes) {
            if (node.name !== name || this.sync.detached.has(node.id)) continue;
            const e = this.sync.entries.get(node.id);
            if (e) out.push(e.obj);
        }
        for (const obj of this.spawnedAll) if (obj.name === name) out.push(obj);
        return out;
    }

    getScript(target: Object3D | string, name?: string): Script | null {
        const obj = typeof target === 'string' ? this.find(target) : target;
        if (!obj) return null;
        const want = name?.replace(/\.js$/i, '').toLowerCase();
        const inst = this.instances.find(
            (i) =>
                i.obj === obj &&
                !i.destroyed &&
                (!want || i.scriptName.replace(/\.js$/i, '').toLowerCase() === want || i.script.constructor.name.toLowerCase() === want),
        );
        return inst?.script ?? null;
    }

    spawn(owner: Script, shape: Shape, opts: SpawnOptions = {}): Object3D {
        const kind = (['box', 'sphere', 'plane', 'cylinder', 'torus'] as Shape[]).includes(shape) ? shape : 'box';
        const obj = new Object3D();
        obj.name = opts.name ?? kind;
        const mr = obj.addComponent(MeshRenderer);
        mr.geometry = buildGeometry(defaultGeometry(kind));
        const mat = new LitMaterial(this.runtime.engine.context3D);
        mat.baseColor = hexToColor(opts.color ?? '#c8c8c8');
        mat.roughness = 0.5;
        mat.metallic = 0;
        mr.material = mat;
        mr.castShadow = true;
        mr.receiveShadow = true;
        const [px, py, pz] = opts.position ?? [0, 0, 0];
        const [rx, ry, rz] = opts.rotation ?? [0, 0, 0];
        const [sx, sy, sz] = opts.scale ?? [1, 1, 1];
        obj.x = px;
        obj.y = py;
        obj.z = pz;
        obj.rotationX = rx;
        obj.rotationY = ry;
        obj.rotationZ = rz;
        obj.scaleX = sx;
        obj.scaleY = sy;
        obj.scaleZ = sz;
        (opts.parent ?? this.runtime.scene).addChild(obj);
        this.recolored.add(mr);
        this.spawnedAll.add(obj);
        if (!this.spawnedBy.has(owner)) this.spawnedBy.set(owner, []);
        this.spawnedBy.get(owner)!.push(obj);
        return obj;
    }

    spawned(owner: Script): Object3D[] {
        const list = (this.spawnedBy.get(owner) ?? []).filter((o) => this.spawnedAll.has(o));
        this.spawnedBy.set(owner, list);
        return list.slice();
    }

    destroy(owner: Script, obj: Object3D, delay?: number) {
        if (!obj) return;
        if (delay && delay > 0) {
            this.pendingDestroy.push({ obj, owner, at: this.time.elapsed + delay });
            return;
        }
        // Scripts on the object and below it get onDestroy and stop running.
        const doomed = new Set<Object3D>();
        obj.traverse((o: Object3D) => doomed.add(o));
        for (const inst of this.instances) {
            if (!inst.destroyed && doomed.has(inst.obj)) {
                inst.destroyed = true;
                this.call(inst, 'onDestroy');
            }
        }
        this.instances = this.instances.filter((i) => !i.destroyed);
        obj.removeFromParent();
        const nodeId = this.sync.nodeIdOf(obj);
        const entry = nodeId ? this.sync.entries.get(nodeId) : null;
        if (entry && entry.obj === obj) {
            // Document objects come back when Play stops.
            this.sync.detached.add(nodeId!);
        } else {
            for (const o of doomed) this.spawnedAll.delete(o);
            try {
                obj.destroy();
            } catch { /* ignore */ }
        }
    }

    setColor(obj: Object3D, color: string, emissive: boolean, intensity: number) {
        if (!obj) return;
        const owner = this.sync.nodeIdOf(obj);
        const c = hexToColor(color);
        const visit = (o: Object3D) => {
            // Child objects of other document nodes keep their colors.
            if (o !== obj) {
                const id = this.sync.nodeIdOf(o);
                if (id && id !== owner && this.sync.entries.get(id)?.obj === o) return;
            }
            o.components.forEach((comp) => {
                if (!(comp instanceof RenderNode)) return;
                const r = comp as RenderNode;
                const src = r.materials?.[0];
                if (!src) return;
                let mat = src;
                if (!this.recolored.has(r)) {
                    // Materials can be shared (model files, other nodes): recolor a copy.
                    mat = cloneMaterial(src);
                    r.materials = [mat];
                    this.recolored.add(r);
                }
                if (emissive) {
                    mat.shader.setUniformColor('emissiveColor', c);
                    mat.shader.setUniformFloat('emissiveIntensity', intensity);
                } else {
                    const prev = mat.shader.getUniformColor('baseColor');
                    mat.shader.setUniformColor('baseColor', new Color(c.r, c.g, c.b, prev?.a ?? 1));
                }
            });
            for (const child of o.entityChildren as Object3D[]) if (child instanceof Object3D) visit(child);
        };
        visit(obj);
    }

    timer(owner: Script, seconds: number, fn: () => void, repeat: boolean): () => void {
        const s = Math.max(0.001, Number(seconds) || 0);
        const t: Timer = { owner, at: this.time.elapsed + s, every: repeat ? s : 0, fn, cancelled: false };
        this.timers.push(t);
        return () => {
            t.cancelled = true;
        };
    }
}

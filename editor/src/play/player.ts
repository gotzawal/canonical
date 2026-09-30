import { Camera3D, Color, LitMaterial, MeshRenderer, Object3D, RenderNode } from '@orillusion/core';
import { defaultGeometry } from '../core/defaults';
import { Emitter } from '../core/events';
import type { Checkpoint, Store } from '../core/store';
import type { NodeDoc, SceneDoc, ScriptDoc, ShaderDoc } from '../core/types';
import { hexToColor } from '../engine/color';
import { cloneMaterial } from '../engine/modelParts';
import type { Picker } from '../engine/picking';
import type { Runtime } from '../engine/runtime';
import { buildGeometry, type SceneSync } from '../engine/sync';
import { logInfo } from '../core/log';
import { AgentSystem, type AgentHost, type AIServices, type BlackboardApi } from './ai/agents';
import { SpeechQueue, type SayOptions } from './ai/speech';
import { scriptLocation, type ScriptCompiler } from './compiler';
import { Input } from './input';
import { Animations, type AnimatorApi } from './animation';
import { AudioSystem, type AudioApi, type SoundHandle, type SoundOptions } from './audio';
import { Characters, type Character } from './character';
import { bodyOf, loadPhysics, physicsLoaded, preloadPhysics, usesPhysics, Physics, type BodyApi, type PhysicsApi } from './physics';
import { PlayControls } from './playControls';
import { PlayerController } from './playerController';
import {
    CTX, Script, withContext, type ChatRequest, type PlayApi, type ScriptContext, type Shape, type SpawnOptions, type ScriptTime,
} from './script';

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

/** What the page around Play mode (the editor or the game player) gives it. */
export interface PlayerHost {
    /** Element the on-screen controls go into (the view). */
    controls?: HTMLElement;
    /** The agents' models, once they are set up. */
    aiServices?: () => AIServices | null;
    /** Language model for scripts (this.chat); games have none. */
    chat?: (req: ChatRequest) => Promise<string>;
}

interface PlayerEvents {
    state: PlayState;
    issue: ScriptIssue;
}

const MAX_DT = 0.1;

/**
 * Play mode: instantiates the scripts attached to nodes, runs their
 * lifecycle every frame and, on Stop, puts the document, its undo history
 * and the engine scene back the way they were (scripts and shaders changed
 * meanwhile are kept). Objects with an agent run their behavior trees in
 * the same frame loop (see play/ai/agents.ts).
 */
export class Player extends Emitter<PlayerEvents> implements PlayApi, AgentHost {
    state: PlayState = 'stopped';
    readonly input = new Input();
    readonly time: ScriptTime = { delta: 0, elapsed: 0, frame: 0 };
    readonly issues: ScriptIssue[] = [];
    readonly logs: ScriptLog[] = [];
    /** Behavior trees of the objects with an agent. */
    readonly agents: AgentSystem;
    /** Voice lines of scripts (this.say), one sentence at a time. */
    readonly speech = new SpeechQueue();

    private instances: Instance[] = [];
    /** What each script of this session sees; cut off at Stop, so code still running later (a setTimeout) cannot reach the editor scene. */
    private contexts: ScriptContext[] = [];
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
    private chats = new Set<AbortController>();
    /** The characters of this session, and the player's control of one of them. */
    private characters: Characters | null = null;
    /** The physics world of the session (play/physics.ts). */
    private world: Physics | null = null;
    /** The animated models of the session (play/animation.ts). */
    private animations: Animations | null = null;
    /** The sounds of the session (play/audio.ts). */
    private audio: AudioSystem | null = null;
    /** Play without sound (the assistant's play tests). */
    private muted = false;
    /** Stops so far: a Play waiting for Rapier starts only when no Stop came in between. */
    private runs = 0;
    private controller: PlayerController | null = null;
    /** The pointer that feeds the mouse of the scripts (the first one down). */
    private mousePointer: number | null = null;
    private controls: PlayControls | null = null;

    constructor(
        private runtime: Runtime,
        private store: Store,
        private sync: SceneSync,
        private picker: Picker,
        private compiler: ScriptCompiler,
        private host: PlayerHost = {},
    ) {
        super();
        this.agents = new AgentSystem(this, () => host.aiServices?.() ?? null);
        // Rapier loads before the first Play that needs it.
        preloadPhysics(store.doc);
        store.on('load', () => preloadPhysics(store.doc));
        // A body comes with an object's components (moving objects adds none).
        store.on('change', (hint) => {
            if (hint?.transform || hint?.env || hint?.meta || hint?.design || hint?.behavior) return;
            preloadPhysics(store.doc);
        });
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

    /** True when Play renders through a camera node or the player's camera instead of the editor camera. */
    get usesGameCamera(): boolean {
        return !!this.gameCamera;
    }

    /** The object of the player's character, if any. */
    get playerObject(): Object3D | null {
        return this.controller?.character.obj ?? null;
    }

    // --------------------------------------------------------------- control

    play() {
        if (this.state !== 'stopped') {
            if (this.state === 'paused') this.setState('playing');
            return;
        }
        // Physics loads with the scene; Play waits for it when it is not there yet.
        if (physicsLoaded() === undefined && usesPhysics(this.store.doc)) {
            const run = this.runs;
            void loadPhysics().then(() => run === this.runs && this.state === 'stopped' && this.play());
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
        this.setupCharacters();
        this.animations = new Animations(this.store, this.sync, this.characters?.list ?? []);
        this.setupAudio();
        this.setupPhysics();
        this.instantiate();
        // Blackboards exist before awake() / start(), so scripts can write their first facts there.
        try {
            this.agents.start();
        } catch (e: any) {
            // The scripts still run: Play must not stop half way into the game camera.
            console.error('[ai] the agents could not start', e);
            this.warn(`The agents could not start: ${e?.message || e}`);
        }
        // Agents near the player get their questions answered first (a script may name another object).
        if (this.controller) this.agents.player = this.controller.character.obj;
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
        // Running tasks are aborted first (their scripts get onTaskAbort), then scripts get onDestroy.
        this.agents.stop();
        this.speech.cancelAll();
        this.audio?.dispose();
        this.audio = null;
        for (const c of this.chats) c.abort();
        this.chats.clear();
        for (const inst of this.instances) {
            if (!inst.destroyed) this.call(inst, 'onDestroy');
        }
        this.world?.dispose();
        this.world = null;
        this.runs++;
        for (const ctx of this.contexts) {
            ctx.api = null;
            ctx.object3D = null;
        }
        this.contexts = [];
        this.offFrame?.();
        this.offFrame = null;
        this.unbindInput();
        this.instances = [];
        this.timers = [];
        this.spawnedBy.clear();
        this.pendingDestroy = [];
        this.pointerTarget = null;
        this.characters?.dispose();
        this.characters = null;
        this.animations = null;
        this.controller = null;
        this.mousePointer = null;
        this.controls?.stop();
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
        const checkpoint = this.checkpointState;
        this.checkpointState = null;
        // Code written while playing (Apply in the code panel, the assistant) is
        // kept; everything else goes back to how it was before Play.
        const code = checkpoint ? codeWrittenSince(JSON.parse(checkpoint.doc) as SceneDoc, this.store.doc) : null;
        if (checkpoint) this.store.restoreCheckpoint(checkpoint);
        this.runtime.invalidateEnvironment();
        this.sync.rebuild();
        this.input.reset();
        this.input.endFrame();
        this.setState('stopped');
        this.store.setPlaying(false);
        if (code) {
            this.store.commit('Keep Code Written in Play', (d) => {
                for (const s of code.scripts) {
                    const i = d.scripts.findIndex((x) => x.id === s.id);
                    if (i >= 0) d.scripts[i] = s;
                    else d.scripts.push(s);
                }
                for (const s of code.shaders) {
                    const i = d.shaders.findIndex((x) => x.id === s.id);
                    if (i >= 0) d.shaders[i] = s;
                    else d.shaders.push(s);
                }
            });
            const n = code.scripts.length + code.shaders.length;
            logInfo(`Kept ${n} script${n === 1 ? '' : 's'} or shader${n === 1 ? '' : 's'} changed while playing; the rest of the scene is back to how it was.`);
        }
    }

    /** Plays for `seconds`, stops, and returns what the scripts reported. */
    /** Plays for `seconds`, then stops and restores the scene; `signal` stops it early (and rejects with an AbortError). */
    async runFor(seconds: number, signal?: AbortSignal): Promise<{ logs: ScriptLog[]; issues: ScriptIssue[]; frames: number }> {
        if (this.state !== 'stopped') this.stop();
        if (usesPhysics(this.store.doc)) await loadPhysics();
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // A test run plays without sound.
        this.muted = true;
        try {
            this.play();
        } finally {
            this.muted = false;
        }
        await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, Math.max(0, seconds) * 1000);
            signal?.addEventListener('abort', done);
        });
        const result = { logs: this.logs.slice(), issues: this.issues.slice(), frames: this.time.frame };
        this.stop();
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return result;
    }

    private setState(state: PlayState) {
        this.state = state;
        this.animations?.pause(state === 'paused');
        this.audio?.pause(state === 'paused');
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

    /**
     * Every shown object with a character walks the level; the first one
     * the player controls is the player's, whose camera takes over the view
     * (unless it keeps the scene's camera).
     */
    private setupCharacters() {
        const nodes = this.store.doc.nodes.filter((n) => n.character && this.sync.entries.get(n.id)?.visible && !this.sync.detached.has(n.id));
        if (!nodes.length) return;
        const chars = (this.characters = new Characters(this.picker, this.sync, this.store));
        const own = nodes.map((n) => [n.id, ...this.store.descendants(n.id).map((d) => d.id)]);
        // Every character's own nodes leave the level before the first is placed: the level is collected once.
        chars.exclude(own.flat());
        const made = nodes.map((n, i) => chars.add(this.sync.entries.get(n.id)!.obj, n.character!, own[i], this.picker.bounds(n.id)?.min[1] ?? null));
        const players = nodes.filter((n) => n.player);
        if (!players.length) return;
        const cams = this.store.doc.nodes.filter((n) => n.camera);
        const fov = (cams.find((n) => n.camera!.main) ?? cams[0])?.camera?.fov ?? 60;
        const ctl = (this.controller = new PlayerController(made[nodes.indexOf(players[0])], players[0].player!, this.input, chars.level, () => this.runtime.activeCamera, fov));
        if (ctl.camera) {
            this.runtime.scene.addChild(ctl.camera.object3D);
            ctl.updateCamera();
            this.gameCamera = ctl.camera;
            this.runtime.setActiveCamera(ctl.camera);
        }
        if (this.host.controls) {
            this.controls ??= new PlayControls(this.host.controls, this.input, (x, y) => this.tap(x, y));
            this.controls.start({ jump: players[0].character!.jump > 0 });
        }
        if (players.length > 1) this.warn(`One player plays at a time: ${players[0].name} does; ${players.slice(1).map((n) => n.name).join(', ')} stand(s) still.`);
    }

    /** Shown objects with an Audio component play their clips (Play on Start ones at once). */
    private setupAudio() {
        const nodes = this.store.doc.nodes.filter((n) => n.audio && this.sync.entries.get(n.id)?.visible && !this.sync.detached.has(n.id));
        const scripted = this.store.doc.scripts.some((s) => /\bthis\.(playSound|audio|getAudio)\b/.test(s.code));
        const trees = JSON.stringify(this.store.doc.behaviors).includes('"play_sound"');
        if (!nodes.length && !scripted && !trees) return;
        try {
            this.audio = new AudioSystem(() => this.store.doc.assets, (text) => this.warn(text), { muted: this.muted });
        } catch (e: any) {
            this.warn(`Sound is not available in this browser: ${e?.message || e}`);
            return;
        }
        this.audio.onSound = (heard) => this.agents.hear(heard);
        for (const n of nodes) this.audio.add(this.sync.entries.get(n.id)!.obj, n.audio!);
    }

    private setupPhysics() {
        const R = physicsLoaded();
        if (!R || !usesPhysics(this.store.doc)) return;
        this.world = new Physics(R, {
            store: this.store,
            sync: this.sync,
            characters: () => this.characters?.list ?? [],
            notify: (obj, method, other) => {
                for (const inst of this.instances.filter((i) => i.obj === obj && !i.destroyed && !i.broken)) this.call(inst, method, other);
            },
        });
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
                const ctx: ScriptContext = { nodeId: node.id, nodeName: node.name, scriptName: compiled.name, object3D: entry.obj, api: this };
                this.contexts.push(ctx);
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

        // Controllers first (the player, then scripts and behavior trees), then every
        // character moves at once; lateUpdate sees where they went, the camera follows last.
        this.controller?.control(dt);
        for (const inst of this.instances.slice()) {
            if (!inst.broken && !inst.destroyed) this.call(inst, 'update', dt);
        }
        this.runTimers();
        this.agents.frame();
        this.characters?.update(dt);
        this.world?.step(dt);
        for (const inst of this.instances.slice()) {
            if (!inst.broken && !inst.destroyed) this.call(inst, 'lateUpdate', dt);
        }
        this.controller?.updateCamera();
        this.audio?.frame(this.runtime.activeCamera);
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
            // A destroyed script is gone from the instances: its timers end with it.
            const inst = this.instances.find((i) => i.script === t.owner);
            if (!inst || inst.destroyed || inst.broken) {
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
        // Destroyed during awake() or start() of another script: nothing more runs.
        if (inst.destroyed && method !== 'onDestroy') return;
        const fn = (inst.script as any)[method];
        if (typeof fn !== 'function') return;
        try {
            const r = fn.apply(inst.script, args);
            // An async method (async start, async onClick) fails later: report it like a throw.
            if (r && typeof r.then === 'function') {
                (r as Promise<unknown>).then(undefined, (e: any) => {
                    if (this.state !== 'stopped' && e?.name !== 'AbortError') this.fail(inst, method, e);
                });
            }
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
        on(window, 'blur', () => {
            this.input.reset();
            this.controls?.release();
        });
    }

    private unbindInput() {
        for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
        this.listeners = [];
    }

    /** Keyboard events routed here by the editor while the viewport has focus. */
    keyEvent(e: KeyboardEvent, down: boolean) {
        if (this.state === 'stopped') return;
        const key = this.input.keyEvent(e, down);
        // Paused scripts run nothing; this.input still follows the keys.
        if (e.repeat || this.state === 'paused') return;
        for (const inst of this.instances.slice()) {
            if (!inst.broken && !inst.destroyed) this.call(inst, down ? 'onKeyDown' : 'onKeyUp', key);
        }
    }

    /**
     * Pointer events routed here by the view while playing (`id` tells
     * pointers apart). While a player controller plays, touches go to the
     * on-screen controls: they move, look and tap.
     */
    pointerEvent(type: 'down' | 'move' | 'up' | 'cancel', x: number, y: number, button: number, id = 0, touch = false) {
        if (this.state === 'stopped') return;
        if (touch && this.controls?.active) {
            this.controls.pointer(type, id, x, y);
            return;
        }
        // While a pointer is down it is the scripts' mouse: a second finger does not move it.
        if (this.mousePointer !== null && id !== this.mousePointer) return;
        if (type === 'down') this.mousePointer = id;
        if (type === 'up' || type === 'cancel') this.mousePointer = null;
        if (type === 'cancel') type = 'up';
        this.input.pointerMove(x, y);
        if (type === 'move') return;
        this.input.pointerButton(button, type === 'down');
        if (this.state === 'paused') {
            this.pointerTarget = null;
            return;
        }
        this.picker.update();
        const skip = (o: Object3D) => o === this.runtime.grid || o === this.runtime.camera.object3D || this.runtime.gi.isHelper(o);
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

    /** A tap on a touch screen is a click for the scripts (the mouse jumps there, it does not drag). */
    private tap(x: number, y: number) {
        this.input.pointerMove(x, y, false);
        this.pointerEvent('down', x, y, 0, -1);
        this.pointerEvent('up', x, y, 0, -1);
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
        const kind = (['box', 'sphere', 'plane', 'cylinder', 'cone', 'torus', 'ramp', 'stairs', 'capsule'] as Shape[]).includes(shape) ? shape : 'box';
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
        mr.castGI = true;
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
        if (opts.body) {
            if (this.world) this.world.add(obj, bodyOf(opts.body), [mr], defaultGeometry(kind));
            else this.warn(`${obj.name} gets no body: physics is not available.`);
        }
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
        // Scripts on the object and below it get onDestroy and stop running; so do their trees.
        const doomed = new Set<Object3D>();
        obj.traverse((o: Object3D) => doomed.add(o));
        this.agents.removeObjects(doomed);
        // Destroyed characters stop; the player's camera stays where it was.
        this.characters?.remove(doomed);
        this.world?.remove(doomed);
        this.audio?.removeObjects(doomed);
        if (this.controller && doomed.has(this.controller.character.obj)) this.controller = null;
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
                    mat = cloneMaterial(src, this.runtime.engine.context3D);
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

    // ------------------------------------------------------------ agents

    doc() {
        return this.store.doc;
    }

    objectOf(nodeId: string): Object3D | null {
        if (this.sync.detached.has(nodeId)) return null;
        return this.sync.entries.get(nodeId)?.obj ?? null;
    }

    findObject(ref: string): Object3D | null {
        return this.objectOf(ref) ?? this.find(ref);
    }

    body(target: Object3D | string): BodyApi | null {
        const obj = typeof target === 'string' ? this.findObject(target) : target;
        return (obj && this.world?.api(obj)) ?? null;
    }

    physics(): PhysicsApi | null {
        return this.world;
    }

    animator(target: Object3D | string): AnimatorApi | null {
        const obj = typeof target === 'string' ? this.findObject(target) : target;
        return (obj && this.animations?.of(obj)) ?? null;
    }

    scriptsOn(obj: Object3D): Script[] {
        return this.instances.filter((i) => i.obj === obj && !i.destroyed && !i.broken).map((i) => i.script);
    }

    invoke(script: Script, method: string, args: unknown[]): { ok: true; value: unknown } | { ok: false } {
        const inst = this.instances.find((i) => i.script === script);
        const fn = (script as any)[method];
        if (!inst || typeof fn !== 'function') return { ok: false };
        try {
            return { ok: true, value: fn.apply(script, args) };
        } catch (e) {
            this.fail(inst, method, e);
            return { ok: false };
        }
    }

    warn(text: string) {
        console.warn(text);
        this.pushLog('warn', text);
    }

    /** A line a Model task speaks (the same voice queue as this.say). */
    speak(text: string) {
        void this.speech.say(text).catch(() => {});
    }

    blackboard(target: Object3D | string): BlackboardApi | null {
        return this.agents.blackboardApi(target);
    }

    setPlayer(obj: Object3D | null) {
        this.agents.player = obj;
    }

    /** The character of an object (or of the nearest object above it with one). */
    character(target: Object3D | string | null): Character | null {
        const obj = typeof target === 'string' ? this.findObject(target) : target;
        return this.characters?.of(obj) ?? null;
    }

    remember(text: string, tags: string[]): string | null {
        return this.agents.remember(text, tags);
    }

    memory(id: string): { id: string; text: string; tags: string[] } | null {
        const e = this.agents.memory?.get(String(id ?? ''));
        return e ? { id: e.id, text: e.text, tags: e.tags.slice() } : null;
    }

    saveMemories() {
        return this.agents.saveMemories();
    }

    loadMemories(items: unknown): number {
        return this.agents.loadMemories(items);
    }

    audioOf(target: Object3D | string): AudioApi | null {
        const obj = typeof target === 'string' ? this.findObject(target) : target;
        return this.audio?.api(obj) ?? null;
    }

    playSound(owner: Script, clip: string, opts: SoundOptions = {}): SoundHandle | null {
        if (!this.audio) {
            this.warn('Sounds play only when the scene has sound: import one or add one from the Library.');
            return null;
        }
        return this.audio.play(String(clip ?? ''), opts, owner.object3D ?? null);
    }

    /** Tells the agents' hearing about a sound the object made (footsteps, a door) without playing one. */
    noise(owner: Script, range: number, at?: Object3D | [number, number, number]) {
        const obj = owner.object3D;
        this.agents.hear({ at: at ? (Array.isArray(at) ? [at[0], at[1], at[2]] : worldOf(at)) : worldOf(obj), range: Math.max(0, Number(range) || 0), source: obj });
    }

    say(owner: Script, text: string, opts: SayOptions = {}): Promise<void> {
        return this.speech.say(String(text ?? ''), opts);
    }

    chat(owner: Script, req: ChatRequest): Promise<string> {
        const chat = this.host.chat;
        if (!chat) return Promise.reject(new Error('No language model is set up here: this.chat() works in the editor with an OpenRouter key.'));
        // Stop cancels the requests still open, along with the signal a task passed.
        const ctl = new AbortController();
        const outer = req.signal;
        if (outer?.aborted) ctl.abort();
        else outer?.addEventListener('abort', () => ctl.abort(), { once: true });
        this.chats.add(ctl);
        return chat({ ...req, signal: ctl.signal }).finally(() => this.chats.delete(ctl));
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

function worldOf(obj: Object3D): [number, number, number] {
    const w = obj.transform.worldPosition;
    return [w.x, w.y, w.z];
}

/** Scripts and shaders added or changed since `before` (copies), or null when there are none. */
function codeWrittenSince(before: SceneDoc, now: SceneDoc): { scripts: ScriptDoc[]; shaders: ShaderDoc[] } | null {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const scripts = now.scripts.filter((s) => !same(before.scripts.find((b) => b.id === s.id), s));
    const shaders = now.shaders.filter((s) => !same(before.shaders.find((b) => b.id === s.id), s));
    if (!scripts.length && !shaders.length) return null;
    return JSON.parse(JSON.stringify({ scripts, shaders }));
}

import { add, DEG, normalize, scale } from '../core/math';
import type { Vec3 } from '../core/types';
import { ROUTE_REACH } from '../design/walkRoute';
import type { Editor } from '../editor';
import { LevelRays } from '../engine/levelRays';
import { keyNames } from '../play/input';
import { CharacterMotor } from '../play/motor';
import { h } from '../ui/dom';
import { toast } from '../ui/overlays';

const WALK_SPEED = 1.5;
const RUN_SPEED = 4.5;
const GRAVITY = 9.8;
const LOOK = 0.12;

const KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', ' ', 'q', 'e']);

/**
 * Walk camera: first person at the brief's eye height, WASD and the mouse
 * (pointer lock), with the ground followed over steps and ramps and walls
 * blocking the way, so the level's scale and paths can be checked. Route
 * points of the play requirements are ticked when passed.
 */
export class WalkController {
    active = false;
    private motor: CharacterMotor;
    private lookYaw = 0;
    private lookPitch = 0;
    private keys = new Set<string>();
    private last = 0;
    private off: (() => void) | null = null;
    private listeners: [EventTarget, string, EventListener, boolean][] = [];
    private hud: HTMLElement;
    private hudText: HTMLElement;
    private start: Vec3 = [0, 0, 0];
    /** The level while walking: only what moves is boxed again, not every object for every ray. */
    private rays: LevelRays | null = null;
    /** The terrains: open ground, which only stops the body where too steep (as in Play). */
    private terrains = new Set<string>();

    constructor(private editor: Editor, private overlay: HTMLCanvasElement, viewportEl: HTMLElement) {
        const land = (id: string | undefined) => !!id && this.terrains.has(id);
        const cast = (ignore?: (id: string) => boolean) => (origin: Vec3, dir: Vec3, maxDist: number) => (this.rays ? this.rays.cast(origin, dir, maxDist, ignore) : editor.picker.raycast(origin, dir, maxDist, ignore));
        this.motor = new CharacterMotor(cast(), this.body(), [0, 0, 0], { has: land, cast: cast(land) });
        this.hudText = h('span');
        this.hud = h('div', { class: 'walk-hud', attrs: { hidden: true } }, this.hudText);
        viewportEl.appendChild(this.hud);
        editor.on('view', (view) => (view === 'walk' ? this.begin() : this.stop()));
    }

    private get specs() {
        return this.editor.store.doc.design.specs;
    }

    /** The body of the brief's player. */
    private body() {
        const s = this.specs;
        return { height: s.playerHeight, radius: s.playerRadius, stepHeight: s.stepHeight, maxSlope: s.maxSlope };
    }

    private get feet(): Vec3 {
        return this.motor.feet;
    }

    /** Starts walking (editor.setView('walk') calls it). */
    private begin() {
        if (this.active) return;
        const ed = this.editor;
        ed.pipeline.showShot(null);
        const cam = ed.store.camera;
        // Start on the floor under the orbit target (up to a step above it), not on a roof
        // or ceiling over it, facing the way the view faces. A target below every surface
        // starts on the one above it.
        const target = cam.target;
        this.rays = new LevelRays(ed.picker, ed.sync, ed.store, undefined, { track: true });
        this.terrains = new Set(ed.sync.terrains().map((t) => t.id));
        this.motor.body = this.body();
        const ground = this.motor.groundAt([target[0], target[1] + this.specs.stepHeight, target[2]], 200) ?? this.motor.groundAt([target[0], target[1] + 50, target[2]], 200);
        this.motor.feet = [target[0], ground ?? 0, target[2]];
        this.motor.vy = 0;
        this.start = [...this.feet] as Vec3;
        this.lookYaw = cam.yaw + 180;
        this.lookPitch = Math.max(-60, Math.min(60, -cam.pitch));
        this.keys.clear();
        this.active = true;
        this.last = performance.now();
        const on = (t: EventTarget, type: string, fn: EventListener, capture = false) => {
            t.addEventListener(type, fn, capture);
            this.listeners.push([t, type, fn, capture]);
        };
        on(window, 'keydown', (e) => this.key(e as KeyboardEvent, true), true);
        on(window, 'keyup', (e) => this.key(e as KeyboardEvent, false), true);
        on(window, 'blur', () => this.keys.clear());
        on(document, 'mousemove', (e) => this.look(e as MouseEvent));
        on(document, 'pointerlockchange', () => {
            if (document.pointerLockElement !== this.overlay && this.active) this.stop();
        });
        try {
            const req = this.overlay.requestPointerLock() as unknown as Promise<void> | undefined;
            req?.catch?.(() => {});
        } catch { /* pointer lock unavailable: keys still work */ }
        this.off = ed.runtime.onBeforeFrame(() => this.tick());
        this.hud.hidden = false;
    }

    private stop() {
        if (!this.active) return;
        this.active = false;
        this.off?.();
        this.off = null;
        this.rays?.dispose();
        this.rays = null;
        for (const [t, type, fn, capture] of this.listeners) t.removeEventListener(type, fn, capture);
        this.listeners = [];
        if (document.pointerLockElement === this.overlay) document.exitPointerLock();
        this.hud.hidden = true;
        // Back to orbiting a point a few meters ahead.
        const eye = this.eye();
        const fwd = this.forward();
        const distance = 3;
        this.editor.camera.jump({ ...this.editor.store.camera, target: add(eye, scale(fwd, distance)), distance, yaw: this.lookYaw + 180, pitch: -this.lookPitch });
        if (this.editor.view === 'walk') this.editor.setView('scene');
    }

    private key(e: KeyboardEvent, down: boolean) {
        // By where the key is (WASD with any input language: a Korean layout types "ㅈ" for W).
        const k = keyNames(e).map((n) => (n === 'space' ? ' ' : n)).find((n) => KEYS.has(n) || n === 'escape') ?? '';
        if (k === 'escape' && down) {
            e.preventDefault();
            e.stopPropagation();
            this.stop();
            return;
        }
        if (!KEYS.has(k) || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        if (down) this.keys.add(k);
        else this.keys.delete(k);
    }

    private look(e: MouseEvent) {
        if (document.pointerLockElement !== this.overlay) return;
        this.lookYaw -= e.movementX * LOOK;
        this.lookPitch = Math.max(-85, Math.min(85, this.lookPitch - e.movementY * LOOK));
    }

    private forward(): Vec3 {
        const y = this.lookYaw * DEG, p = this.lookPitch * DEG;
        return [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
    }

    private eye(): Vec3 {
        return [this.feet[0], this.feet[1] + this.specs.eyeHeight, this.feet[2]];
    }

    private tick() {
        const now = performance.now();
        const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
        this.last = now;
        if (!this.active) return;
        this.editor.picker.update();
        const k = this.keys;
        const mz = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
        const mx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
        if (k.has('q')) this.lookYaw += 90 * dt;
        if (k.has('e')) this.lookYaw -= 90 * dt;
        const y = this.lookYaw * DEG;
        const fwd: Vec3 = [Math.sin(y), 0, Math.cos(y)];
        const right: Vec3 = [-Math.cos(y), 0, Math.sin(y)];
        const speed = k.has('shift') ? RUN_SPEED : WALK_SPEED;
        let move = add(scale(fwd, mz), scale(right, mx));
        if (mx && mz) move = normalize(move);
        const d = scale(move, speed * dt);
        // Walls stop the body, steps and ramps lift it, gravity pulls it down (play/motor.ts).
        this.motor.step(dt, d, GRAVITY, k.has(' ') ? 3.2 : 0);
        if (this.feet[1] < this.start[1] - 100) {
            this.motor.feet = [...this.start] as Vec3;
            this.motor.vy = 0;
            toast('Fell out of the level; back to the start.', 'info');
        }

        const eye = this.eye();
        const look = this.forward();
        const dist = 0.05;
        this.editor.camera.jump({ ...this.editor.store.camera, target: add(eye, scale(look, dist)), distance: dist, yaw: this.lookYaw + 180, pitch: -this.lookPitch });
        this.checkRoute();
        this.updateHud();
    }

    private checkRoute() {
        const route = this.editor.store.doc.design.play.route;
        const reached = route.filter((p) => !p.visited && p.position && Math.hypot(p.position[0] - this.feet[0], p.position[2] - this.feet[2]) < ROUTE_REACH);
        if (!reached.length) return;
        const ids = reached.map((p) => p.id);
        this.editor.store.commit('Route Point Reached', (d) => {
            for (const p of d.design.play.route) if (ids.includes(p.id)) p.visited = true;
        }, { design: true });
        toast(`Reached ${reached.map((p) => p.name).join(', ')}.`, 'success', 2500);
    }

    private updateHud() {
        const route = this.editor.store.doc.design.play.route;
        const next = route.find((p) => !p.visited && p.position);
        const f = this.feet;
        const parts = [`Walking at eye height ${this.specs.eyeHeight.toFixed(2)} m`, `x ${f[0].toFixed(1)} y ${f[1].toFixed(2)} z ${f[2].toFixed(1)}`];
        if (next?.position) parts.push(`next: ${next.name} ${Math.hypot(next.position[0] - f[0], next.position[2] - f[2]).toFixed(1)} m`);
        parts.push('WASD move, mouse look, Shift run, Space jump, Esc stop');
        this.hudText.textContent = parts.join('  |  ');
    }
}

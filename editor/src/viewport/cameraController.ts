import { Vector3 } from '@orillusion/core';
import { add, clamp, DEG, len, rayPlane, rayAt, scale, sub } from '../core/math';
import type { Store } from '../core/store';
import type { CameraState, Vec3 } from '../core/types';
import type { Box, Picker } from '../engine/picking';
import type { Runtime } from '../engine/runtime';

interface Tween {
    from: CameraState;
    to: CameraState;
    start: number;
    duration: number;
}

/**
 * Orbit / pan / dolly camera for the viewport. The state lives in the store
 * (so it is saved with the scene) and is pushed to the engine camera.
 */
export class CameraController {
    private tween: Tween | null = null;
    private applied = '';

    constructor(private runtime: Runtime, private store: Store, private picker: Picker) {
        runtime.onFrame(() => this.update());
        store.on('camera', () => this.apply());
        this.apply();
    }

    /** An animated move is running. */
    get animating(): boolean {
        return !!this.tween;
    }

    get state(): CameraState {
        return this.store.camera;
    }

    position(state: CameraState = this.state): Vec3 {
        const yaw = state.yaw * DEG;
        const pitch = state.pitch * DEG;
        const dir: Vec3 = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
        return add(state.target, scale(dir, state.distance));
    }

    apply() {
        const s = this.state;
        const key = `${s.target.join(',')}|${s.yaw}|${s.pitch}|${s.distance}|${s.fov}`;
        if (key === this.applied) return;
        this.applied = key;
        const cam = this.runtime.camera;
        if (cam.fov !== s.fov) {
            cam.fov = s.fov;
            cam.updateProjection();
        }
        const p = this.position(s);
        cam.lookAt(new Vector3(p[0], p[1], p[2]), new Vector3(s.target[0], s.target[1], s.target[2]), Vector3.UP);
        this.picker.update();
    }

    private set(patch: Partial<CameraState>) {
        this.tween = null;
        const next = { ...this.state, ...patch };
        next.pitch = clamp(next.pitch, -89.5, 89.5);
        next.distance = clamp(next.distance, 0.05, 20000);
        next.yaw = ((next.yaw % 360) + 360) % 360;
        this.store.setCamera(next);
    }

    orbit(dx: number, dy: number) {
        this.set({ yaw: this.state.yaw - dx * 0.35, pitch: this.state.pitch + dy * 0.35 });
    }

    /** Drags the view so the point under `from` ends up under `to` (screen px). */
    pan(fromX: number, fromY: number, toX: number, toY: number) {
        this.picker.update();
        const s = this.state;
        const eye = this.position(s);
        const normal = sub(eye, s.target);
        const a = this.planeHit(fromX, fromY, s.target, normal);
        const b = this.planeHit(toX, toY, s.target, normal);
        if (!a || !b) return;
        const delta = sub(a, b);
        this.set({ target: add(s.target, delta) });
    }

    /** Zooms toward the screen point (x, y). `amount` > 0 zooms out. */
    dolly(amount: number, x?: number, y?: number) {
        this.picker.update();
        const s = this.state;
        const factor = Math.exp(amount);
        const distance = clamp(s.distance * factor, 0.05, 20000);
        let target = s.target;
        if (x !== undefined && y !== undefined && factor < 1) {
            const hit = this.picker.pick(x, y)?.point ?? this.planeHit(x, y, s.target, sub(this.position(s), s.target));
            if (hit) {
                const k = 1 - distance / s.distance;
                target = add(target, scale(sub(hit, target), k));
            }
        }
        this.set({ distance, target });
    }

    private planeHit(x: number, y: number, point: Vec3, normal: Vec3): Vec3 | null {
        const ray = this.picker.ray(x, y);
        const t = rayPlane(ray, point, normal) ?? rayPlane({ origin: ray.origin, dir: ray.dir }, point, scale(normal, -1));
        return t === null ? null : rayAt(ray, t);
    }

    /** Moves the camera at once (no animation). */
    jump(state: CameraState) {
        this.tween = null;
        this.store.setCamera(state);
        this.apply();
    }

    setView(yaw: number, pitch: number) {
        this.animateTo({ ...this.state, yaw, pitch });
    }

    /** Frames a world box, keeping the current viewing direction. */
    frame(box: Box | null, fallback?: Vec3) {
        const s = this.state;
        if (!box) {
            if (fallback) this.animateTo({ ...s, target: fallback, distance: Math.min(s.distance, 6) });
            return;
        }
        const center: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
        const radius = Math.max(0.25, len(sub(box.max, box.min)) / 2);
        const distance = radius / Math.sin((s.fov * DEG) / 2) * 1.1;
        this.animateTo({ ...s, target: center, distance });
    }

    animateTo(to: CameraState, duration = 260) {
        const from = { ...this.state, target: [...this.state.target] as Vec3 };
        // Take the short way around.
        let yaw = to.yaw;
        while (yaw - from.yaw > 180) yaw -= 360;
        while (yaw - from.yaw < -180) yaw += 360;
        this.tween = { from, to: { ...to, yaw }, start: performance.now(), duration };
    }

    private update() {
        const tw = this.tween;
        if (!tw) return;
        const t = clamp((performance.now() - tw.start) / tw.duration, 0, 1);
        const e = 1 - Math.pow(1 - t, 3);
        const mix = (a: number, b: number) => a + (b - a) * e;
        const next: CameraState = {
            target: [mix(tw.from.target[0], tw.to.target[0]), mix(tw.from.target[1], tw.to.target[1]), mix(tw.from.target[2], tw.to.target[2])],
            yaw: mix(tw.from.yaw, tw.to.yaw),
            pitch: mix(tw.from.pitch, tw.to.pitch),
            distance: Math.exp(mix(Math.log(tw.from.distance), Math.log(tw.to.distance))),
            fov: mix(tw.from.fov, tw.to.fov),
        };
        this.store.setCamera(next);
        if (t >= 1) this.tween = null;
    }
}

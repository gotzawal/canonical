// The built-in player controller (NodeDoc.player). In Play mode it moves
// its object with WASD, the arrow keys or the on-screen joystick, runs with
// Shift (or the joystick pushed to its edge), jumps with Space (or the jump
// button) and carries the camera: a mouse drag or a finger turns it, the
// wheel or a pinch brings a third person camera closer. The body walks
// through the level with ray casts (play/motor.ts).

import { Camera3D, Object3D, RenderNode, Vector3 } from '@orillusion/core';
import { DEG, invert, transformPoint } from '../core/math';
import type { PlayerDoc, Vec3 } from '../core/types';
import type { Input } from './input';
import { CharacterMotor, type CastFn } from './motor';

/** What a controller needs from Play mode. */
export interface ControllerHost {
    readonly input: Input;
    /** Ray casts against the level without the player's own objects. */
    readonly cast: CastFn;
}

/** Degrees the view turns per CSS pixel of drag at look speed 1. */
const LOOK_DEG_PER_PX = 0.22;
/** A fall this far below the start puts the player back at the start. */
const FALL_LIMIT = 60;
/** How fast the body turns toward where it walks, per second (0..1 blend per frame at 60 fps is about 0.25). */
const TURN_RATE = 12;

export class PlayerController {
    readonly motor: CharacterMotor;
    /** The camera it renders through; null when the scene's camera stays (view 'scene'). */
    readonly camera: Camera3D | null = null;
    /** Where the view looks: yaw around +Y from +Z and pitch above the horizon, degrees. */
    private yaw: number;
    private pitch: number;
    private distance: number;
    /** Height of the object's origin above its feet. */
    private offset: number;
    private start: Vec3;
    /** The way the body faces, degrees around +Y (its local +Z points there). */
    private facing: number;

    /**
     * `bottom` is the lowest point of the object's meshes in world space
     * (null for an object without meshes, whose origin is its feet).
     */
    constructor(readonly obj: Object3D, readonly doc: PlayerDoc, private host: ControllerHost, bottom: number | null, fov: number) {
        const m = obj.transform.worldMatrix.rawData;
        const origin: Vec3 = [m[12], m[13], m[14]];
        this.offset = bottom === null ? 0 : Math.max(0, origin[1] - bottom);
        this.start = [origin[0], origin[1] - this.offset, origin[2]];
        this.motor = new CharacterMotor(host.cast, { height: doc.height, radius: doc.radius, stepHeight: doc.stepHeight }, this.start);
        // The body's forward axis (+Z) in the world: the view starts behind it, looking the same way.
        const f = [m[8], m[10]];
        this.facing = Math.hypot(f[0], f[1]) > 1e-6 ? Math.atan2(f[0], f[1]) / DEG : 0;
        this.yaw = this.facing;
        this.pitch = doc.view === 'first' ? 0 : -15;
        this.distance = doc.distance;
        if (doc.view !== 'scene') {
            const holder = new Object3D();
            holder.name = 'PlayerCamera';
            this.camera = holder.addComponent(Camera3D);
            this.camera.perspective(fov, 1, 0.05, 2000);
        }
        // Standing where it was placed: settle onto the ground under it.
        if (doc.collide) {
            const ground = this.motor.groundAt([this.start[0], this.start[1] + doc.stepHeight + 0.3, this.start[2]], doc.stepHeight + 1.3);
            if (ground !== null) this.motor.feet[1] = ground;
        }
    }

    /** The camera's object, to add to the scene. */
    get cameraObject(): Object3D | null {
        return this.camera?.object3D ?? null;
    }

    /** Hides the body's meshes, so a first person view does not look out of its inside. */
    hideBody() {
        if (this.doc.view !== 'first') return;
        this.obj.traverse((o: Object3D) => {
            o.components.forEach((c) => {
                if (c instanceof RenderNode) c.enable = false;
            });
        });
    }

    /** Moves the body for this frame from the input. Runs before the scripts' update. */
    move(dt: number) {
        const d = this.doc;
        const input = this.host.input;
        // Scripts may have moved the object (a teleport): it is where its object is.
        const m = this.obj.transform.worldMatrix.rawData;
        const feet = this.motor.feet;
        feet[0] = m[12];
        feet[2] = m[14];
        if (Math.abs(m[13] - this.offset - feet[1]) > 1e-4) {
            feet[1] = m[13] - this.offset;
            this.motor.vy = 0;
        }

        this.look(dt);

        // Walk relative to the view: forward is where the camera looks.
        const x = input.axis('horizontal');
        const z = input.axis('vertical');
        const amount = Math.min(1, Math.hypot(x, z));
        const run = input.key('shift') || (input.stick.active && amount > 0.95);
        const speed = (run ? d.runSpeed : d.speed) * amount;
        const yaw = this.yaw * DEG;
        const fwd: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
        const right: Vec3 = [-Math.cos(yaw), 0, Math.sin(yaw)];
        let dir: Vec3 = [fwd[0] * z + right[0] * x, 0, fwd[2] * z + right[2] * x];
        const len = Math.hypot(dir[0], dir[2]);
        dir = len > 1e-6 ? [dir[0] / len, 0, dir[2] / len] : [0, 0, 0];
        const step: Vec3 = [dir[0] * speed * dt, 0, dir[2] * speed * dt];
        const jump = d.jump > 0 && input.keyDown('space') ? d.jump : 0;

        if (d.collide) {
            this.motor.step(dt, step, d.gravity, jump);
            if (feet[1] < this.start[1] - FALL_LIMIT) {
                this.motor.feet = [...this.start] as Vec3;
                this.motor.vy = 0;
            }
        } else {
            feet[0] += step[0];
            feet[2] += step[2];
        }

        // The body turns toward where it walks; in first person it faces where it looks.
        if (d.view === 'first') this.facing = this.yaw;
        else if (len > 1e-6 && speed > 0) {
            const want = Math.atan2(dir[0], dir[2]) / DEG;
            let delta = ((want - this.facing + 540) % 360) - 180;
            delta *= Math.min(1, TURN_RATE * dt);
            this.facing += delta;
        }
        this.place();
    }

    /** Turns the view from mouse drags, fingers and the wheel. */
    private look(dt: number) {
        const d = this.doc;
        const input = this.host.input;
        let dx = input.look.dx;
        let dy = input.look.dy;
        // A mouse drag with the left or right button turns the view (a click stays a click),
        // up to the frame it ends in, so a quick flick between two frames still counts.
        if (input.mouseButton(0) || input.mouseButton(2) || input.mouseUp(0) || input.mouseUp(2)) {
            dx += input.mouse.dx;
            dy += input.mouse.dy;
        }
        // Q / E turn too, for keyboards without a mouse at hand.
        const turnKeys = (input.key('q') ? 1 : 0) - (input.key('e') ? 1 : 0);
        const k = LOOK_DEG_PER_PX * d.lookSpeed;
        this.yaw -= dx * k - turnKeys * 90 * dt;
        this.yaw = ((this.yaw % 360) + 360) % 360;
        this.pitch -= (d.invertY ? -dy : dy) * k;
        this.pitch = d.view === 'first' ? Math.max(-85, Math.min(85, this.pitch)) : Math.max(-70, Math.min(40, this.pitch));
        const zoom = input.mouse.wheel * 0.0012 + input.look.zoom;
        if (zoom) this.distance = Math.max(0.8, Math.min(Math.max(1, d.distance * 3), this.distance * Math.exp(zoom)));
    }

    /** Puts the object where the body is, turned the way it faces. */
    private place() {
        const feet = this.motor.feet;
        const world: Vec3 = [feet[0], feet[1] + this.offset, feet[2]];
        const t = this.obj.transform;
        const parent = t.parent?.object3D;
        const local = parent && parent.transform.parent ? transformPoint(invert(parent.transform.worldMatrix.rawData) ?? new Float64Array(16), world) : world;
        this.obj.x = local[0];
        this.obj.y = local[1];
        this.obj.z = local[2];
        this.obj.rotationY = this.facing;
    }

    /** Places the camera behind the body or at its eyes. Runs after the scripts' lateUpdate. */
    updateCamera() {
        if (!this.camera) return;
        const d = this.doc;
        const m = this.obj.transform.worldMatrix.rawData;
        const feet: Vec3 = [m[12], m[13] - this.offset, m[14]];
        const yaw = this.yaw * DEG;
        const pitch = this.pitch * DEG;
        const look: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
        let eye: Vec3;
        let target: Vec3;
        if (d.view === 'first') {
            eye = [feet[0], feet[1] + d.eyeHeight, feet[2]];
            target = [eye[0] + look[0], eye[1] + look[1], eye[2] + look[2]];
        } else {
            // Orbit a point at the shoulders; walls between it and the camera pull the camera in.
            target = [feet[0], feet[1] + Math.min(d.eyeHeight, d.height * 0.9), feet[2]];
            let dist = this.distance;
            const back: Vec3 = [-look[0], -look[1], -look[2]];
            const hit = d.collide ? this.host.cast(target, back, dist + 0.25) : null;
            if (hit) dist = Math.max(0.3, hit.distance - 0.25);
            eye = [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist];
        }
        this.camera.lookAt(new Vector3(eye[0], eye[1], eye[2]), new Vector3(target[0], target[1], target[2]), Vector3.UP);
    }
}

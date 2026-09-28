// The player's control of its character (NodeDoc.player). WASD, the arrow
// keys or the on-screen joystick walk it the way the view looks, Shift (or
// the joystick at its edge) runs, Space (or the jump button) jumps. The
// camera follows it: a mouse drag, a finger or Q / E turn it, the wheel or
// a pinch bring a third person camera closer, and walls pull it in.

import { Camera3D, Object3D, RenderNode, Vector3 } from '@orillusion/core';
import { DEG } from '../core/math';
import type { PlayerDoc, Vec3 } from '../core/types';
import type { Character } from './character';
import type { Input } from './input';
import type { CastFn } from './motor';

/** Degrees the view turns per CSS pixel of drag at look speed 1. */
const LOOK_DEG_PER_PX = 0.22;

export class PlayerController {
    /** The camera it renders through; null when the scene's camera stays (view 'scene'). */
    readonly camera: Camera3D | null = null;
    /** Where the view looks: yaw around +y from +z and pitch above the horizon, degrees. */
    private yaw: number;
    private pitch: number;
    private distance: number;

    /** `cast`: the level without the characters; `view`: the camera Play renders through. */
    constructor(readonly character: Character, readonly doc: PlayerDoc, private input: Input, private cast: CastFn, private view: () => Camera3D, fov: number) {
        this.yaw = character.facing;
        this.pitch = doc.view === 'first' ? 0 : -15;
        this.distance = doc.distance;
        if (doc.view === 'scene') return;
        const holder = new Object3D();
        holder.name = 'PlayerCamera';
        this.camera = holder.addComponent(Camera3D);
        this.camera.perspective(fov, 1, 0.05, 2000);
        // Looking from its eyes, not out of its inside.
        if (doc.view === 'first') character.obj.traverse((o: Object3D) => o.components.forEach((c) => c instanceof RenderNode && (c.enable = false)));
    }

    /** Turns the view and tells the character where to walk. Runs before the scripts' update. */
    control(dt: number) {
        const input = this.input;
        const c = this.character;
        if (this.camera) this.look(dt);
        // Walking goes the way the view looks (an engine camera looks along its +z).
        const m = this.camera ? null : this.view().transform.worldMatrix.rawData;
        const yaw = m ? Math.atan2(m[8], m[10]) : this.yaw * DEG;
        const x = input.axis('horizontal');
        const z = input.axis('vertical');
        c.move(Math.sin(yaw) * z - Math.cos(yaw) * x, Math.cos(yaw) * z + Math.sin(yaw) * x);
        c.run = input.key('shift') || (input.stick.active && Math.hypot(x, z) > 0.95);
        if (input.keyDown('space')) c.jump();
        c.face = this.doc.view === 'first' ? this.yaw : null;
    }

    /** Turns the view from mouse drags, fingers, Q / E and the wheel. */
    private look(dt: number) {
        const d = this.doc;
        const input = this.input;
        let dx = input.look.dx;
        let dy = input.look.dy;
        // A drag with the left or right mouse button turns the view (a click stays a click),
        // up to the frame it ends in, so a quick flick between two frames still counts.
        if (input.mouseButton(0) || input.mouseButton(2) || input.mouseUp(0) || input.mouseUp(2)) {
            dx += input.mouse.dx;
            dy += input.mouse.dy;
        }
        const k = LOOK_DEG_PER_PX * d.lookSpeed;
        const keys = (input.key('q') ? 1 : 0) - (input.key('e') ? 1 : 0);
        this.yaw = (((this.yaw - dx * k + keys * 90 * dt) % 360) + 360) % 360;
        this.pitch -= (d.invertY ? -dy : dy) * k;
        this.pitch = d.view === 'first' ? Math.max(-85, Math.min(85, this.pitch)) : Math.max(-70, Math.min(40, this.pitch));
        const zoom = input.mouse.wheel * 0.0012 + input.look.zoom;
        if (zoom) this.distance = Math.max(0.8, Math.min(Math.max(1, d.distance * 3), this.distance * Math.exp(zoom)));
    }

    /** Places the camera behind the character or at its eyes. Runs after the scripts' lateUpdate. */
    updateCamera() {
        if (!this.camera) return;
        const c = this.character;
        const m = c.obj.transform.worldMatrix.rawData;
        const feet: Vec3 = [m[12], m[13] - c.offset, m[14]];
        const yaw = this.yaw * DEG;
        const pitch = this.pitch * DEG;
        const look: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
        let eye: Vec3;
        let target: Vec3;
        if (this.doc.view === 'first') {
            eye = [feet[0], feet[1] + c.doc.eyeHeight, feet[2]];
            target = [eye[0] + look[0], eye[1] + look[1], eye[2] + look[2]];
        } else {
            // Orbit a point at the shoulders; walls between it and the camera pull the camera in.
            target = [feet[0], feet[1] + Math.min(c.doc.eyeHeight, c.doc.height * 0.9), feet[2]];
            const back: Vec3 = [-look[0], -look[1], -look[2]];
            const hit = c.doc.collide ? this.cast(target, back, this.distance + 0.25) : null;
            const dist = hit ? Math.max(0.3, hit.distance - 0.25) : this.distance;
            eye = [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist];
        }
        this.camera.lookAt(new Vector3(eye[0], eye[1], eye[2]), new Vector3(target[0], target[1], target[2]), Vector3.UP);
    }
}

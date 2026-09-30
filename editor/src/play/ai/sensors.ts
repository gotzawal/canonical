// The agents' senses: the Sight and Hearing services of behavior trees.
// Each run looks or listens once and writes what it found to fact keys,
// so Conditions and Asks read perception like the facts scripts write.
// Positions go into object keys as marker objects (Move To walks to them).
//
// Sight looks from the agent's eyes at the player, the other characters or
// named objects within its range and field of view; with line of sight a
// level object between them hides the target. Hearing takes the sounds of
// the last second (AgentSystem.noises: 3D sounds that were played, the
// characters' footsteps, scripts' this.noise) that carry to the agent;
// level objects between halve how far a sound carries.

import type { Object3D } from '@orillusion/core';
import type { HearingServiceDoc, SightServiceDoc, Vec3 } from '../../core/types';

/** What the senses need from their agent (Agent in agents.ts). */
export interface Senser {
    readonly obj: Object3D;
    readonly name: string;
    now(): number;
    /** Where it looks and listens from. */
    eyes(): Vec3;
    /** The way it faces, degrees around y. */
    facing(): number;
    /** A point to look at on another object (a character's chest, else its origin). */
    aimPoint(obj: Object3D): Vec3;
    /** Distance to the first level object along a ray (the agent's own objects left out), or null. */
    castLevel(origin: Vec3, dir: Vec3, max: number): number | null;
    candidates(doc: SightServiceDoc): Object3D[];
    /** Sounds heard in the last second. */
    noises(): readonly { at: Vec3; range: number; source: Object3D | null; time: number }[];
    /** A marker object of the agent (created on first use). */
    marker(id: string): Object3D;
    /** Writes a fact key; a key that does not take the value is reported once. */
    writeFact(sensor: string, key: string, value: unknown): void;
}

interface SightState {
    target: Object3D | null;
    lastSeen: number;
}

interface HearingState {
    lastCheck: number;
    lastHeard: number;
}

const sight = new WeakMap<Senser, Map<string, SightState>>();
const hearing = new WeakMap<Senser, Map<string, HearingState>>();

function stateOf<T>(map: WeakMap<Senser, Map<string, T>>, s: Senser, id: string, make: () => T): T {
    let m = map.get(s);
    if (!m) map.set(s, (m = new Map()));
    let st = m.get(id);
    if (!st) m.set(id, (st = make()));
    return st;
}

/** Degrees from angle a to angle b, -180..180. */
const turn = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/** Nothing of the level between the two points. */
function clear(s: Senser, from: Vec3, to: Vec3, dist: number): boolean {
    if (dist < 0.3) return true;
    const dir: Vec3 = [(to[0] - from[0]) / dist, (to[1] - from[1]) / dist, (to[2] - from[2]) / dist];
    const hit = s.castLevel(from, dir, dist);
    return hit === null || hit >= dist - 0.3;
}

function place(marker: Object3D, p: Vec3) {
    marker.x = p[0];
    marker.y = p[1];
    marker.z = p[2];
}

export function see(s: Senser, d: SightServiceDoc) {
    const now = s.now();
    const st = stateOf(sight, s, d.id, () => ({ target: null, lastSeen: -Infinity }));
    const eye = s.eyes();
    const facing = s.facing();
    let best: Object3D | null = null;
    let bestDist = Infinity;
    for (const o of s.candidates(d)) {
        if (o === s.obj) continue;
        const p = s.aimPoint(o);
        const dist = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
        if (dist > d.range || dist >= bestDist) continue;
        if (d.fov < 360 && Math.hypot(p[0] - eye[0], p[2] - eye[2]) > 0.2) {
            const yaw = (Math.atan2(p[0] - eye[0], p[2] - eye[2]) * 180) / Math.PI;
            if (Math.abs(turn(facing, yaw)) > d.fov / 2) continue;
        }
        if (d.lineOfSight && !clear(s, eye, p, dist)) continue;
        best = o;
        bestDist = dist;
    }
    if (best) {
        st.target = best;
        st.lastSeen = now;
        if (d.output) s.writeFact(d.id, d.output, best);
        if (d.visible) s.writeFact(d.id, d.visible, true);
        if (d.distance) s.writeFact(d.id, d.distance, Math.round(bestDist * 10) / 10);
        if (d.position) {
            const w = best.transform.worldPosition;
            const m = s.marker(d.id);
            place(m, [w.x, w.y, w.z]);
            s.writeFact(d.id, d.position, m);
        }
        return;
    }
    if (d.visible) s.writeFact(d.id, d.visible, false);
    if (st.target && now - st.lastSeen > d.memory) {
        st.target = null;
        if (d.output) s.writeFact(d.id, d.output, null);
    }
}

export function hear(s: Senser, d: HearingServiceDoc) {
    const now = s.now();
    const st = stateOf(hearing, s, d.id, () => ({ lastCheck: now - 1, lastHeard: -Infinity }));
    const since = st.lastCheck;
    st.lastCheck = now;
    const ear = s.eyes();
    let best: { at: Vec3; source: Object3D | null } | null = null;
    let bestShare = Infinity;
    for (const n of s.noises()) {
        if (n.time <= since || n.source === s.obj) continue;
        let range = n.range * d.sensitivity;
        const dist = Math.hypot(n.at[0] - ear[0], n.at[1] - ear[1], n.at[2] - ear[2]);
        if (range <= 0 || dist > range) continue;
        if (d.walls && !clear(s, ear, n.at, dist)) {
            range *= 0.5;
            if (dist > range) continue;
        }
        // The loudest here: the nearest for how far it carries.
        const share = dist / range;
        if (share < bestShare) {
            bestShare = share;
            best = { at: n.at, source: n.source };
        }
    }
    if (best) {
        st.lastHeard = now;
        if (d.heard) s.writeFact(d.id, d.heard, true);
        if (d.source) s.writeFact(d.id, d.source, best.source);
        if (d.position) {
            const m = s.marker(d.id);
            place(m, best.at);
            s.writeFact(d.id, d.position, m);
        }
    } else if (d.heard && now - st.lastHeard > d.memory) s.writeFact(d.id, d.heard, false);
}

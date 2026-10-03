// Walks the route the way the player would, for the assistant (walk_route),
// which cannot hold the keys of the walk camera: the player's body (the
// motor of Play and the walk camera, play/motor.ts) goes from the start to
// each route point in turn, along the way the level check's grid finds for
// it (LevelGrid.path), and every route point it passes is reached, as
// walking past it with the walk camera does.

import type { Vec3 } from '../core/types';
import { CharacterMotor, type Body, type OpenGround } from '../play/motor';

/** A route point counts as reached within this distance (xz, meters), on foot and with the walk camera. */
export const ROUTE_REACH = 1.5;
/** Simulated frames a second. */
const FPS = 30;
/** A point of the way this close counts as passed (and the body stands right on it): the way's points are where the grid found the body can stand. */
const CORNER = 0.05;
/** Seconds without getting closer to the next corner or the point: stuck. */
const STUCK = 2;
/** Times a leg finds its way again from where it got stuck before it gives up. */
const RETRIES = 2;
/** A fall this far below where a leg began is a fall out of the level. */
const FALL = 60;
/** The trace keeps a point every this many meters walked. */
const TRACE_STEP = 0.5;

/** A ray against the level: what the motor needs, and the id of what it met to name it. */
export type WalkCast = (origin: Vec3, dir: Vec3, maxDist: number) => { distance: number; point: Vec3; normal?: Vec3; id?: string } | null;

export interface WalkPoint {
    id: string;
    name: string;
    point: Vec3;
}

export interface WalkBody extends Body {
    /** Meters a second. */
    speed: number;
    /** Downward acceleration, m/s². */
    gravity: number;
}

export interface WalkLeg {
    to: string;
    reached: boolean;
    /** Meters walked on the way. */
    walked: number;
    seconds: number;
    /** It had a way there (else it walked straight at the point). */
    planned: boolean;
    /** Where it stopped short and why: a wall or an object in the way (`by`), ground too steep, a fall, or no end. */
    stuck?: { at: Vec3; why: 'blocked' | 'steep' | 'fell' | 'too long'; by?: string; left: number };
}

export interface WalkResult {
    legs: WalkLeg[];
    /** Ids of the route points it came within reach of, on the way or as a goal. */
    passed: string[];
    /** The way it went (its feet), for the view. */
    trace: Vec3[];
    /** Where its legs ended short. */
    stops: Vec3[];
}

const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/**
 * Walks `body` from `start` to each of `targets` in turn, as a player
 * holding the keys toward it: through the corners `plan` gives (a way
 * around walls and up gentle slopes, ending within reach of the point),
 * straight at the point where it has none. A leg ends at its point, or
 * where the body got no closer for a while, fell or walked too long; the
 * next leg goes on from there, or from the last corner it passed when it
 * got stuck. `route` are the points ticked when passed.
 * `open`: the open ground (terrains), as the body walks it in Play. `pause`
 * lets the page breathe now and then.
 */
export async function walkRoute(
    cast: WalkCast,
    body: WalkBody,
    start: Vec3,
    targets: WalkPoint[],
    opts: { plan?: ((from: Vec3, to: Vec3) => Vec3[] | null | Promise<Vec3[] | null>) | null; route?: WalkPoint[]; open?: OpenGround; pause?: () => Promise<void> } = {},
): Promise<WalkResult> {
    const motor = new CharacterMotor(cast, body, start, opts.open);
    const dt = 1 / FPS;
    // Onto the ground under the start, as a character placed there stands.
    const ground = motor.groundAt([start[0], start[1] + body.stepHeight + 0.3, start[2]], body.stepHeight + 1.3);
    if (ground !== null) {
        motor.feet[1] = ground;
        motor.grounded = true;
    }
    const route = opts.route ?? targets;
    const passed = new Set<string>();
    const trace: Vec3[] = [[...motor.feet] as Vec3];
    const stops: Vec3[] = [];
    const legs: WalkLeg[] = [];
    const tick = () => {
        for (const p of route) if (!passed.has(p.id) && flat(p.point, motor.feet) < ROUTE_REACH) passed.add(p.id);
    };
    tick();
    let frames = 0;
    for (const t of targets) {
        const from = [...motor.feet] as Vec3;
        const corners = (await opts.plan?.(from, t.point)) ?? null;
        let path = [...(corners ?? [])];
        let retries = corners ? RETRIES : 0;
        /** The last corner of the way it stood on. */
        let passedCorner: Vec3 = from;
        let length = 0;
        [from, ...path, t.point].forEach((p, i, all) => i && (length += flat(all[i - 1], p)));
        const limit = Math.min(900, (3 * length) / Math.max(0.1, body.speed) + 15);
        let time = 0;
        let walked = 0;
        let best = Infinity;
        let since = 0;
        let last = trace[trace.length - 1];
        let end: WalkLeg['stuck'] | null = null;
        let arrived = false;
        for (;;) {
            let turned = false;
            while (path.length && flat(path[0], motor.feet) < CORNER) {
                passedCorner = path.shift()!;
                // On the point itself: the way's next move is judged from there.
                motor.feet[0] = passedCorner[0];
                motor.feet[2] = passedCorner[2];
                turned = true;
                best = Infinity;
                since = time;
            }
            // Within reach of the point it is there; it stops at the next corner of its way, where the next leg's way starts.
            arrived ||= flat(t.point, motor.feet) <= ROUTE_REACH;
            if (arrived && (turned || !path.length)) break;
            const aim = path[0] ?? t.point;
            const dist = flat(aim, motor.feet);
            // Getting closer to the next corner (or the point) is progress.
            if (dist < best - 0.1) {
                best = dist;
                since = time;
            } else if (time - since > STUCK) {
                // Off the way it planned (a corner it could not stand on): the way again from here.
                const again = retries-- > 0 ? await opts.plan?.([...motor.feet] as Vec3, t.point) : null;
                if (!again) {
                    end = blockage(motor, cast, body, aim, opts.open);
                    break;
                }
                path = [...again];
                best = Infinity;
                since = time;
                continue;
            }
            if (time > limit) {
                end = { at: [...motor.feet] as Vec3, why: 'too long', left: 0 };
                break;
            }
            const step = Math.min(body.speed * dt, dist);
            const before = [...motor.feet] as Vec3;
            // The way turns at its corners: the body looks for steep ground no farther than the next one.
            motor.step(dt, [((aim[0] - before[0]) / dist) * step, 0, ((aim[2] - before[2]) / dist) * step], body.gravity, 0, path.length ? dist : Infinity);
            walked += flat(motor.feet, before);
            time += dt;
            if (motor.feet[1] < from[1] - FALL) {
                end = { at: [...motor.feet] as Vec3, why: 'fell', left: 0 };
                motor.feet = [...from] as Vec3;
                motor.vy = 0;
                break;
            }
            tick();
            if (flat(motor.feet, last) >= TRACE_STEP) {
                last = [...motor.feet] as Vec3;
                trace.push(last);
            }
            if (++frames % 600 === 0) await opts.pause?.();
        }
        trace.push([...motor.feet] as Vec3);
        const leg: WalkLeg = { to: t.name, reached: !end, walked: round(walked), seconds: round(time), planned: !!corners };
        if (end) {
            end.at = end.at.map(round) as Vec3;
            end.left = round(flat(end.at, t.point));
            leg.stuck = end;
            stops.push(end.at);
            // Back on its way for the next leg, where it last stood on it.
            if (end.why !== 'fell' && corners) {
                motor.feet = [...passedCorner] as Vec3;
                motor.vy = 0;
                trace.push([...passedCorner] as Vec3);
            }
        } else passed.add(t.id);
        legs.push(leg);
    }
    return { legs, passed: route.filter((p) => passed.has(p.id)).map((p) => p.id), trace, stops };
}

/** Why the body got no closer to `aim`: ground too steep for it, or what stands in its way at knee height and above (open ground stops it only by its slope). */
function blockage(motor: CharacterMotor, cast: WalkCast, body: Body, aim: Vec3, open?: OpenGround): NonNullable<WalkLeg['stuck']> {
    const f = motor.feet;
    const d = flat(aim, f) || 1;
    const dir: Vec3 = [(aim[0] - f[0]) / d, 0, (aim[2] - f[2]) / d];
    const at = [...f] as Vec3;
    const ahead = Math.min(d, body.radius + 0.3);
    if (motor.ground([dir[0] * ahead, 0, dir[2] * ahead], d)?.steep) return { at, why: 'steep', left: 0 };
    for (const h of [body.stepHeight + 0.1, body.height * 0.5, body.height - 0.1]) {
        const hit = cast([f[0], f[1] + h, f[2]], dir, body.radius + 0.6);
        if (hit && !open?.has(hit.id)) return { at, why: 'blocked', ...(hit.id ? { by: hit.id } : {}), left: 0 };
    }
    return { at, why: 'blocked', left: 0 };
}

const round = (v: number) => Math.round(v * 100) / 100;

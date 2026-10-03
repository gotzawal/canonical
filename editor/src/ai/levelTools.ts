// The assistant's level tools: buildings from a floor plan (closed by
// construction), the level check (closed, walkable, compact) and the
// player (the built-in player controller module).

import { makeMeshNode, makeNode } from '../core/defaults';
import { invert, mat4, transformPoint } from '../core/math';
import { defaultCharacter, defaultPlayer, makeCharacterNode } from '../core/character';
import { Character, Player } from '../core/model';
import { patch, toolFields } from '../core/schema';
import type { NodeDoc, Vec3 } from '../core/types';
import { builtBounds, LevelGrid, runLevelCheck, scanLevel, summarize } from '../design/levelCheck';
import { assignSlot, upsertSlot } from '../design/materialSlots';
import { planBuilding, SIDES, snapRooms, type OpeningSpec, type RoomSpec, type Side } from '../design/rooms';
import { ROUTE_REACH, walkRoute, type WalkPoint } from '../design/walkRoute';
import { capture, lookCamera, resolvePlace } from './greyboxTools';
import { node, num, optStr, r3, rv, str, ToolError, tools, type Json, type ToolEnv } from './toolUtil';

const xz = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const side = { type: 'string', enum: SIDES, description: 'x_min / x_max: the wall at the room\'s lowest / highest x; z_min / z_max likewise.' };
const place = { type: ['array', 'string'], description: '[x, y, z], or the name / id of a route point, area or object.' };

export const levelTools = tools({
    build_rooms: {
        groups: ['objects'],
        description: 'Build rooms or a whole building from its floor plan, closed by construction: each room is a rectangle of wall centerlines (min and max [x, z]); rooms that share an edge share one wall, corners and junctions close without gaps or overlaps, doors and windows are cut into the walls, floors and ceilings close the rooms. Room edges less than 0.3 m apart are snapped together. Everything goes into one group. Use it for every building and interior instead of placing wall boxes one by one, then run check_level. Coordinates are in the parent\'s space (world space without a parent). For a floor above, give its rooms floor_y = lower floor_y + height + slab; the ceilings under them are left out, and a hole makes a stairwell.',
        params: {
            name: { type: 'string', description: 'Name of the group, e.g. "House".' },
            parent: { type: 'string', description: 'Object id or name to build under (the area group).' },
            floor_y: { type: 'number', description: 'Top of the floors (default 0.1: a little over a ground at 0, so the two do not flicker).' },
            height: { type: 'number', description: 'Clear height from floor to ceiling (default 3).' },
            wall_thickness: { type: 'number', description: 'Default 0.2.' },
            slab: { type: 'number', description: 'Thickness of floors and ceilings (default 0.2).' },
            rooms: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        min: { ...xz, description: '[x, z] of the corner with the lowest x and z (wall centerlines).' },
                        max: { ...xz, description: '[x, z] of the opposite corner.' },
                        floor_y: { type: 'number' },
                        height: { type: 'number' },
                        floor: { type: 'boolean', description: 'Default true.' },
                        ceiling: { type: 'boolean', description: 'Default true; false for courtyards and roofless ruins.' },
                        open: { type: 'array', items: side, description: 'Sides without a wall: to join the next room without a wall, or open to the outside.' },
                        doors: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    side,
                                    at: { type: 'number', description: 'Middle of the door along its wall as a coordinate (x on z_min / z_max walls, z on x_min / x_max walls); default the middle of the side.' },
                                    width: { type: 'number', description: 'Default the brief\'s door width.' },
                                    height: { type: 'number', description: 'Default the brief\'s door height.' },
                                },
                                required: ['side'],
                            },
                            description: 'A door between two rooms needs to be given once, by either room.',
                        },
                        windows: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { side, at: { type: 'number' }, width: { type: 'number', description: 'Default 1.2.' }, height: { type: 'number', description: 'Default 1.2.' }, sill: { type: 'number', description: 'Bottom above the floor, default 0.9.' } },
                                required: ['side'],
                            },
                        },
                        holes: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, description: 'Holes in the floor, [min x, min z, max x, max z] (stairwells).' },
                    },
                    required: ['name', 'min', 'max'],
                },
            },
            slots: {
                type: 'object',
                description: 'Material slots to link the pieces to (id or name; a new name adds the slot).',
                properties: { walls: { type: 'string' }, floors: { type: 'string' }, ceilings: { type: 'string' } },
            },
        },
        required: ['name', 'rooms'],
        run({ env, args, ed, store }) {
            const rooms = roomsFrom(env, args);
            const wall = args.wall_thickness !== undefined ? Math.min(2, Math.max(0.05, num(args.wall_thickness, 'wall_thickness'))) : 0.2;
            const slab = args.slab !== undefined ? Math.min(2, Math.max(0.05, num(args.slab, 'slab'))) : 0.2;
            const snapped = snapRooms(rooms, Math.max(0.3, wall * 1.5));
            checkOverlaps(rooms);
            const plan = planBuilding(rooms, { wall, slab });
            const parent = args.parent !== undefined && args.parent !== null && args.parent !== '' ? node(store.doc, args.parent) : null;
            if (parent?.prefab || parent?.prefabChild) throw new ToolError('A building cannot go into a prefab instance.');
            // The group sits at the middle of the plan, on its lowest floor.
            const x0 = Math.min(...rooms.map((r) => r.min[0])), x1 = Math.max(...rooms.map((r) => r.max[0]));
            const z0 = Math.min(...rooms.map((r) => r.min[1])), z1 = Math.max(...rooms.map((r) => r.max[1]));
            const origin: Vec3 = [round((x0 + x1) / 2), Math.min(...rooms.map((r) => r.floorY)), round((z0 + z1) / 2)];
            const groupName = str(args.name, 'name', 200).trim() || 'Building';
            const group = makeNode(ed.uniqueName(groupName, parent?.id ?? null), parent?.id ?? null, origin);
            const counts = new Map<string, number>();
            const ids = { walls: [] as string[], floors: [] as string[], ceilings: [] as string[] };
            const nodes: NodeDoc[] = [group];
            for (const p of plan.pieces) {
                const n = makeMeshNode('box', group.id);
                const k = counts.get(p.name) ?? 0;
                counts.set(p.name, k + 1);
                n.name = k ? `${p.name} (${k})` : p.name;
                n.mesh!.geometry = { type: 'box', width: p.size[0], height: p.size[1], depth: p.size[2] };
                n.position = [round(p.center[0] - origin[0]), round(p.center[1] - origin[1]), round(p.center[2] - origin[2])];
                nodes.push(n);
                ids[p.kind === 'wall' ? 'walls' : p.kind === 'floor' ? 'floors' : 'ceilings'].push(n.id);
            }
            // Floors lying on another surface at the same height flicker.
            const warnings = [...snapped, ...plan.warnings];
            const toWorld = parent ? (p: Vec3) => transformPoint(ed.picker.worldMatrix(parent.id) ?? mat4(), p) : (p: Vec3) => p;
            ed.picker.update();
            for (const r of rooms) {
                if (!r.floor) continue;
                const top = toWorld([(r.min[0] + r.max[0]) / 2, r.floorY, (r.min[1] + r.max[1]) / 2]);
                const hit = ed.picker.raycast([top[0], top[1] + 0.3, top[2]], [0, -1, 0], 0.4);
                if (hit && Math.abs(hit.point[1] - top[1]) < 0.02) {
                    warnings.push(`${r.name}: its floor lies on ${store.node(hit.id)?.name ?? 'another surface'} at the same height and will flicker; raise floor_y by a few centimeters (0.1 over a ground at 0).`);
                    break;
                }
            }
            store.commit('AI: Build Rooms', (d) => {
                d.nodes.push(...nodes);
            });
            const slots = (args.slots ?? {}) as Json;
            for (const [key, list] of [['walls', ids.walls], ['floors', ids.floors], ['ceilings', ids.ceilings]] as const) {
                const slot = slotRef(env, slots[key]);
                if (slot && list.length) assignSlot(ed.store, slot, list);
            }
            store.select([group.id]);
            return {
                data: {
                    group: { id: group.id, name: group.name },
                    rooms: rooms.map((r) => ({
                        name: r.name,
                        // The clear space inside the walls.
                        inside_min: rv([r.min[0] + wall / 2, r.min[1] + wall / 2]),
                        inside_max: rv([r.max[0] - wall / 2, r.max[1] - wall / 2]),
                        floor_y: r3(r.floorY),
                        height: r3(r.height),
                    })),
                    openings: plan.openings,
                    pieces: { walls: ids.walls.length, floors: ids.floors.length, ceilings: ids.ceilings.length },
                    ...(warnings.length ? { warnings } : {}),
                    note: 'The pieces are named Wall, <Room> Floor and <Room> Ceiling under the group. Check the result with check_level.',
                },
                summary: `${groupName}: ${rooms.length} room${rooms.length === 1 ? '' : 's'}, ${plan.pieces.length} pieces`,
            };
        },
    },
    check_level: {
        groups: ['read'],
        description: 'Check the level the way the player will meet it, with the player\'s body: seams between walls, floors and ceilings, gaps in walls, holes in roofs and floors, floating objects, route points out of reach (doors too narrow or low, steps too high, slopes steeper than the body\'s max slope, walls in the way), roofed rooms nobody can get into, and large empty spaces (compactness). Returns the findings with positions and a plan view image. A check of the whole level ticks the Level checklist item when it passes. Run it after building and fix what it finds; passages (doors) and windows it lists are fine.',
        params: {
            area: { type: 'string', description: 'Check only this area of the plan (id or name; its bounds).' },
            object: { type: 'string', description: 'Check only this object and what is under it (a building).' },
            step: { type: 'number', description: 'Grid spacing in meters (default 0.5; smaller finds narrower gaps and takes longer).' },
        },
        async run({ env, args, ed, store }) {
            if (ed.player.state !== 'stopped') throw new ToolError('Stop Play first: the check looks at the level as it is built.');
            if (ed.isolated) throw new ToolError('A prefab is being edited on its own: finish that first (Apply or Discard).');
            const d = store.doc.design;
            const areaRef = optStr(args.area, 'area', 200);
            const area = areaRef ? d.areas.find((a) => a.id === areaRef) ?? d.areas.find((a) => a.name.toLowerCase() === areaRef.toLowerCase()) : null;
            if (areaRef && !area) throw new ToolError(`No area "${areaRef}". Areas: ${d.areas.map((a) => a.name).join(', ') || 'none'}.`);
            const object = args.object !== undefined ? node(store.doc, args.object).id : null;
            const step = args.step !== undefined ? Math.min(2, Math.max(0.25, num(args.step, 'step'))) : undefined;
            let result;
            try {
                result = await runLevelCheck(ed, { area, object, step });
            } catch (e: any) {
                throw new ToolError(e?.message || String(e));
            }
            const r = result.report;
            const fixes: string[] = [];
            if (r.seams.length) fixes.push('Seams: move or resize the pieces so they touch or overlap a little (walls of build_rooms always meet).');
            if (r.openings.some((o) => o.kind.startsWith('gap'))) fixes.push('Gaps: a wall does not reach the floor or the ceiling there, or a piece is missing.');
            if (r.roofHoles.length || r.floorHoles.length) fixes.push('Holes: close them with a slab, unless the plan wants them (a courtyard, a stairwell).');
            if (r.unreachable.length || r.sealed.length) fixes.push(`Out of reach: add or widen a door (at least the body width plus a margin, as high as the door height), lower a step, or add stairs or a ramp; on a terrain, sculpt a path no steeper than ${r.body.maxSlope}° (the body's max slope) or smooth the slope.`);
            if (r.floating.length) fixes.push('Floating: rest it on what is below (or delete it).');
            if (r.empty.length) fixes.push('Empty spaces: make the rooms smaller or fill them as the plan says, so the space stays compact.');
            return {
                data: {
                    scope: result.scope,
                    summary: summarize(r),
                    ...r,
                    ...(fixes.length ? { how_to_fix: fixes } : {}),
                    ...(env.screenshots() ? { image: 'A plan view of the check is attached in the next message.' } : {}),
                },
                image: env.screenshots() ? result.map : undefined,
                summary: summarize(r),
            };
        },
    },
    walk_route: {
        groups: ['read'],
        description: 'Walk the route as the player would (the walk camera\'s keys are the user\'s): the player\'s body (its size, the steps and the slopes it climbs, the motor of Play and the walk camera) walks from the player (or the first route point) to each route point in turn, along the way check_level finds for it (around walls, up slopes it climbs), and every route point it passes counts as walked at eye height on the Level checklist. Returns each leg: reached, or where it got stuck and why (blocked by an object, ground too steep for the body\'s max slope, a fall, no way there); the view draws the way it went. With screenshots it attaches the eye-height view where it got stuck. Scripts do not run (a door a script opens stays shut): walk those in Play. Fix what stops it (check_level shows the level\'s problems) and walk again.',
        params: {
            points: { type: 'array', items: { type: 'string' }, description: 'Route point ids or names to walk to, in this order (default: every route point with a position, in the route\'s order).' },
            from: { ...place, description: 'Where to start (default: the player, else the first route point): [x, y, z], or the name / id of a route point, area or object.' },
            run: { type: 'boolean', description: 'Run instead of walking (default false).' },
            views: { type: 'string', enum: ['none', 'stuck', 'all'], description: 'Eye-height views to attach with screenshots: where it got stuck (default), at every point it reached too, or none.' },
        },
        async run({ env, args, ed, store }) {
            if (ed.player.state !== 'stopped') throw new ToolError('Stop Play first: the walk goes through the level as it is built.');
            if (ed.isolated) throw new ToolError('A prefab is being edited on its own: finish that first (Apply or Discard).');
            ed.picker.update();
            const doc = store.doc;
            const route = doc.design.play.route.filter((r) => r.position).map((r): WalkPoint => ({ id: r.id, name: r.name, point: [...r.position!] as Vec3 }));
            if (!route.length) throw new ToolError('The route has no points with a position: add them to the plan (update_design play.route) first.');
            const find = (ref: unknown) => {
                const want = String(ref ?? '').toLowerCase();
                const p = route.find((r) => r.id === ref) ?? route.find((r) => r.name.toLowerCase() === want);
                if (!p) throw new ToolError(`No route point "${ref}" with a position. Route points: ${route.map((r) => `${r.name} (${r.id})`).join(', ')}.`);
                return p;
            };
            const targets = Array.isArray(args.points) && args.points.length ? args.points.map(find) : route;
            // The player's body, else the brief's (as the walk camera has it).
            const playerNode = doc.nodes.find((n) => n.player && n.character && ed.sync.entries.get(n.id)?.visible);
            const c = playerNode?.character ?? defaultCharacter(doc.design.specs);
            const body = { height: c.height, radius: c.radius, stepHeight: c.stepHeight, maxSlope: c.maxSlope, gravity: c.gravity, speed: Math.max(0.5, args.run === true ? c.runSpeed : c.speed) };
            // Characters are not the level: they move in Play.
            const skip = new Set(doc.nodes.filter((n) => n.character).flatMap((n) => [n.id, ...store.descendants(n.id).map((d) => d.id)]));
            let start: Vec3 | null = null;
            if (args.from !== undefined && args.from !== null) start = resolvePlace(env, args.from, 'from').point;
            else if (playerNode) {
                const b = ed.picker.bounds(playerNode.id);
                if (b) start = [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2];
            }
            start ??= [...route[0].point] as Vec3;
            const level = scanLevel(ed, skip);
            // The way: over the level check's grid of what is built, the start and the route, with room around them.
            const region = builtBounds(level.objects) ?? { min: [...start] as Vec3, max: [...start] as Vec3 };
            for (const p of [start, ...route.map((r) => r.point)]) {
                for (let k = 0; k < 3; k++) {
                    region.min[k] = Math.min(region.min[k], p[k] - 3);
                    region.max[k] = Math.max(region.max[k], p[k] + 3);
                }
            }
            const grid = await LevelGrid.scan(level, region, 0.5, body);
            const lands = level.lands ?? new Set<string>();
            const result = await walkRoute(level.cast, body, start, targets, {
                plan: (a, b) => grid.path(a, b, ROUTE_REACH * 0.8),
                route,
                open: { has: (id) => !!id && lands.has(id), cast: (o, d, m) => level.cast(o, d, m, (id) => lands.has(id)) },
                pause: () => new Promise<void>((r) => setTimeout(r, 0)),
            });
            const fresh = result.passed.filter((id) => !doc.design.play.route.find((r) => r.id === id)?.visited);
            if (fresh.length) {
                store.commit('AI: Route Walked', (d) => {
                    for (const p of d.design.play.route) if (fresh.includes(p.id)) p.visited = true;
                }, { design: true });
            }
            ed.pipeline.walk = { trace: result.trace, stops: result.stops };
            const name = (id: string) => store.node(id)?.name ?? id;
            const legs = result.legs.map((l) => ({
                to: l.to,
                reached: l.reached,
                walked_m: l.walked,
                seconds: l.seconds,
                way: l.planned ? 'found' : 'none found, so straight at it',
                ...(l.stuck ? { stuck_at: rv(l.stuck.at), why: l.stuck.why, ...(l.stuck.by ? { blocked_by: name(l.stuck.by) } : {}), meters_left: l.stuck.left } : {}),
            }));
            // Eye-height views where it got stuck (and at the points it reached), looking where it was going.
            const images: string[] = [];
            const views = args.views === 'none' || args.views === 'all' ? args.views : 'stuck';
            if (env.screenshots() && views !== 'none') {
                const eye = (p: Vec3): Vec3 => [p[0], p[1] + c.eyeHeight, p[2]];
                const shots: { at: Vec3; toward: Vec3 }[] = [];
                result.legs.forEach((l, i) => {
                    const goal = targets[i].point;
                    if (l.stuck) shots.push({ at: l.stuck.at, toward: goal });
                    else if (views === 'all') shots.push({ at: goal, toward: targets[i + 1]?.point ?? goal });
                });
                for (const s of shots.slice(0, 4)) {
                    const from = eye(s.at);
                    const toward: Vec3 = Math.hypot(s.toward[0] - from[0], s.toward[2] - from[2]) > 0.5 ? [s.toward[0], from[1], s.toward[2]] : [from[0], from[1], from[2] + 1];
                    const image = await capture(env, lookCamera(from, toward, 60), 16 / 9).catch(() => null);
                    if (image) images.push(image);
                }
            }
            const reached = result.legs.filter((l) => l.reached).length;
            const visited = store.doc.design.play.route.filter((r) => r.visited).length;
            return {
                data: {
                    body: { height: body.height, radius: body.radius, step_height: body.stepHeight, max_slope: body.maxSlope, speed: body.speed },
                    from: rv(start),
                    legs,
                    passed: result.passed.map((id) => route.find((r) => r.id === id)!.name),
                    checklist: `${visited} of ${store.doc.design.play.route.length} route points walked`,
                    ...(images.length ? { images: 'Eye-height views where it got stuck (or at the points it reached) are attached in the next message, in the order of the legs.' } : {}),
                },
                images,
                summary: `${reached} of ${targets.length} reached`,
            };
        },
    },
    place_player: {
        groups: ['objects', 'play', 'code'],
        description: 'Place the player: a character (the brief\'s body size) that the built-in Player Controller moves. In Play it walks with WASD or the arrow keys (an on-screen joystick on touch screens), runs with Shift, jumps with Space, and a drag turns the camera (the wheel or a pinch zooms). It stands on the ground at `at`; a scene has one player, so an existing one moves there. Never write movement or camera scripts for the player; change its options here or with update_objects (the character and player fields).',
        params: {
            at: place,
            facing: { type: ['number', 'array', 'string'], description: 'Degrees around +Y (0 faces +z), or a point / name to face.' },
            ...toolFields(Player, ['view']),
            ...toolFields(Character, ['speed', 'runSpeed', 'jump']),
        },
        required: ['at'],
        run({ env, args, ed, store }) {
            const where = resolvePlace(env, args.at, 'at');
            const existing = store.doc.nodes.find((n) => n.player);
            const own = new Set(existing ? [existing.id, ...store.descendants(existing.id).map((n) => n.id)] : []);
            ed.picker.update();
            const p = where.point;
            // Down from a little above the point (an object's middle, not over its roof) to what is under it; a point under a terrain starts on it.
            const land = ed.sync.terrainHeightAt(p[0], p[2]);
            const start = Math.max(p[1], land ?? -Infinity) + 0.6;
            const hit = ed.picker.raycast([p[0], start, p[2]], [0, -1, 0], 60, (id) => own.has(id));
            const feet: Vec3 = [p[0], hit ? hit.point[1] : p[1], p[2]];
            let facing: number | undefined;
            if (args.facing !== undefined) {
                if (typeof args.facing === 'number') facing = args.facing;
                else {
                    const to = resolvePlace(env, args.facing, 'facing').point;
                    facing = (Math.atan2(to[0] - feet[0], to[2] - feet[2]) * 180) / Math.PI;
                }
            }
            const options = (n: NodeDoc) => {
                n.player = patch(Player, n.player ?? defaultPlayer(), { view: args.view }, '');
                n.character = patch(Character, n.character!, { speed: args.speed, run_speed: args.run_speed, jump: args.jump }, '');
            };
            if (existing) {
                // Its origin keeps its height over its feet.
                const b = ed.picker.bounds(existing.id);
                const m = ed.picker.worldMatrix(existing.id);
                const lift = b && m ? m[13] - b.min[1] : (existing.character?.height ?? 1.8) / 2;
                const world: Vec3 = [feet[0], feet[1] + lift, feet[2]];
                const parentWorld = existing.parent ? ed.picker.worldMatrix(existing.parent) : null;
                const local = parentWorld ? transformPoint(invert(parentWorld) ?? mat4(), world) : world;
                store.commit('AI: Place Player', (d) => {
                    const n = d.nodes.find((x) => x.id === existing.id)!;
                    n.position = [round(local[0]), round(local[1]), round(local[2])];
                    if (facing !== undefined) n.rotation = [n.rotation[0], round(facing), n.rotation[2]];
                    n.character ??= makeCharacterNode(d.design.specs).character;
                    options(n);
                }, { nodes: [existing.id] });
                return { data: { id: existing.id, name: existing.name, moved: true, feet: rv(feet), ...(hit ? {} : { note: 'No ground under that point: the player will fall. Place it over a floor.' }) }, summary: existing.name };
            }
            const n = makeCharacterNode(store.doc.design.specs, true);
            n.name = ed.uniqueName('Player', null);
            n.position = [round(feet[0]), round(feet[1] + n.character!.height / 2), round(feet[2])];
            if (facing !== undefined) n.rotation = [0, round(facing), 0];
            options(n);
            store.commit('AI: Place Player', (d) => {
                d.nodes.push(n);
            });
            return { data: { id: n.id, name: n.name, created: true, feet: rv(feet), ...(hit ? {} : { note: 'No ground under that point: the player will fall. Place it over a floor.' }) }, summary: n.name };
        },
    },
});

const sideOf = (v: unknown, what: string): Side => {
    if (!SIDES.includes(v as Side)) throw new ToolError(`${what} must be one of ${SIDES.join(', ')}.`);
    return v as Side;
};

function pair(v: unknown, what: string): [number, number] {
    if (!Array.isArray(v) || v.length !== 2) throw new ToolError(`${what} must be [x, z].`);
    return [num(v[0], what), num(v[1], what)];
}

/** Rooms from the tool's arguments, with the brief's door size as the default. */
function roomsFrom(env: ToolEnv, args: Json): RoomSpec[] {
    const specs = env.editor.store.doc.design.specs;
    const list: Json[] = Array.isArray(args.rooms) ? args.rooms : [];
    if (!list.length) throw new ToolError('rooms is empty.');
    if (list.length > 80) throw new ToolError('At most 80 rooms per call.');
    const floorY = args.floor_y !== undefined ? num(args.floor_y, 'floor_y') : 0.1;
    const height = args.height !== undefined ? num(args.height, 'height') : 3;
    return list.map((r, i) => {
        const name = str(r.name ?? `Room ${i + 1}`, 'room name', 100).trim() || `Room ${i + 1}`;
        const a = pair(r.min, `${name}: min`);
        const b = pair(r.max, `${name}: max`);
        const min: [number, number] = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
        const max: [number, number] = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        if (max[0] - min[0] < 0.6 || max[1] - min[1] < 0.6) throw new ToolError(`${name} is smaller than 0.6 m across.`);
        if (max[0] - min[0] > 500 || max[1] - min[1] > 500) throw new ToolError(`${name} is larger than 500 m.`);
        const h = r.height !== undefined ? num(r.height, `${name}: height`) : height;
        if (h < 1 || h > 60) throw new ToolError(`${name}: height must be 1 to 60 m.`);
        // Doors are the brief's size; windows 1.2 m square, 0.9 m above the floor.
        const opening = (o: Json, kind: 'door' | 'window'): OpeningSpec => {
            const d = kind === 'door' ? { width: specs.doorWidth, height: specs.doorHeight, sill: 0 } : { width: 1.2, height: 1.2, sill: 0.9 };
            const val = (k: 'at' | 'width' | 'height' | 'sill') => (o?.[k] !== undefined ? num(o[k], `${name}: ${kind} ${k}`) : undefined);
            return { side: sideOf(o?.side, `${name}: ${kind} side`), kind, at: val('at'), width: val('width') ?? d.width, height: val('height') ?? d.height, sill: kind === 'door' ? 0 : val('sill') ?? d.sill };
        };
        const list = (v: unknown) => (Array.isArray(v) ? v : []);
        const openings = [...list(r.doors).map((o) => opening(o, 'door')), ...list(r.windows).map((o) => opening(o, 'window'))];
        const holes = (Array.isArray(r.holes) ? r.holes : []).map((hole: unknown) => {
            if (!Array.isArray(hole) || hole.length !== 4) throw new ToolError(`${name}: a hole is [min x, min z, max x, max z].`);
            return hole.map((v) => num(v, `${name}: hole`)) as [number, number, number, number];
        });
        return {
            name,
            min,
            max,
            floorY: r.floor_y !== undefined ? num(r.floor_y, `${name}: floor_y`) : floorY,
            height: h,
            floor: r.floor !== false,
            ceiling: r.ceiling !== false,
            open: (Array.isArray(r.open) ? r.open : []).map((s: unknown) => sideOf(s, `${name}: open`)),
            openings,
            holes,
        };
    });
}

/** Refuses rooms that overlap (they touch along their edges, the wall between them). */
function checkOverlaps(rooms: RoomSpec[]) {
    for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
            const a = rooms[i], b = rooms[j];
            const y = Math.min(a.floorY + a.height, b.floorY + b.height) - Math.max(a.floorY, b.floorY);
            const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
            const dz = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
            if (y > 0.01 && dx > 0.01 && dz > 0.01) {
                throw new ToolError(`${a.name} and ${b.name} overlap by ${Math.round(dx * 100) / 100} x ${Math.round(dz * 100) / 100} m. Rooms touch along an edge (the wall between them); give them the same edge coordinate instead.`);
            }
        }
    }
}

function slotRef(env: ToolEnv, ref: unknown): string | null {
    if (ref === undefined || ref === null || ref === '') return null;
    const name = str(ref, 'slot', 200).trim();
    const slots = env.editor.store.doc.design.materials;
    const found = slots.find((s) => s.id === name) ?? slots.find((s) => s.name.toLowerCase() === name.toLowerCase());
    return (found ?? upsertSlot(env.editor.store, { name }, 'AI: Add Material Slot')).id;
}

function round(v: number): number {
    return Math.round(v * 1000) / 1000;
}

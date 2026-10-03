import { describe, expect, it } from 'vitest';
import type { RayHit } from '../../src/core/math';
import { groundHeight, groundNormal, rayTerrain, type TerrainSurface } from '../../src/core/terrain';
import { generateHeightmap } from '../../src/core/terrainGen';
import type { Vec3 } from '../../src/core/types';
import { builtBounds, checkLevel, LevelGrid, summarize, type LevelScan } from '../../src/design/levelCheck';
import { planBuilding, type OpeningSpec } from '../../src/design/rooms';
import { walkRoute } from '../../src/design/walkRoute';
import { CharacterMotor } from '../../src/play/motor';

interface Block {
    id: string;
    min: Vec3;
    max: Vec3;
}

/** Nearest hit of a ray on boxes, with the outward normal of the face it meets (from inside: the face it leaves by). */
function castBoxes(blocks: Block[], o: Vec3, dir: Vec3, maxDist: number, ignore?: (id: string) => boolean): RayHit | null {
    const n = Math.hypot(dir[0], dir[1], dir[2]);
    const d = dir.map((v) => v / n) as Vec3;
    let best: RayHit | null = null;
    for (const b of blocks) {
        if (ignore?.(b.id)) continue;
        let t0 = -Infinity, t1 = Infinity, a0 = 0, a1 = 0, miss = false;
        for (let i = 0; i < 3; i++) {
            if (Math.abs(d[i]) < 1e-12) {
                if (o[i] < b.min[i] || o[i] > b.max[i]) miss = true;
                continue;
            }
            const near = ((d[i] > 0 ? b.min[i] : b.max[i]) - o[i]) / d[i];
            const far = ((d[i] > 0 ? b.max[i] : b.min[i]) - o[i]) / d[i];
            if (near > t0) [t0, a0] = [near, i];
            if (far < t1) [t1, a1] = [far, i];
        }
        if (miss || t1 < Math.max(t0, 0)) continue;
        const inside = t0 < 0;
        const t = inside ? t1 : t0;
        if (t > maxDist || (best && t >= best.distance)) continue;
        const axis = inside ? a1 : a0;
        const normal: Vec3 = [0, 0, 0];
        normal[axis] = inside ? Math.sign(d[axis]) : -Math.sign(d[axis]);
        best = { distance: t, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], id: b.id, normal };
    }
    return best;
}

function scan(blocks: Block[]): LevelScan {
    return {
        objects: blocks.map((b) => ({ id: b.id, name: b.id, box: { min: b.min, max: b.max }, mesh: true })),
        cast: (o, d, m, ignore) => castBoxes(blocks, o, d, m, ignore),
        descendants: () => [],
    };
}

/** A terrain 40 m square: flat, then rising along +x at `deg` degrees from x = 0 to x = 10, then flat on top. */
function hillside(deg: number): TerrainSurface {
    const res = 161;
    const size = 40;
    const top = Math.tan((deg * Math.PI) / 180) * 10;
    const data = new Float32Array(res * res);
    for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
            const x = (i / (res - 1) - 0.5) * size;
            data[j * res + i] = (Math.min(Math.max(x, 0), 10) / 10) * (top / (top + 1));
        }
    }
    return { frame: { x: 0, y: 0, z: 0, sizeX: size, sizeZ: size, height: top + 1 }, map: { width: res, height: res, data } };
}

/** A terrain 40 m square with its heights from `height(x, z)` (meters, 0 to `top`), a sample every 0.25 m. */
function landOf(top: number, height: (x: number, z: number) => number): TerrainSurface {
    const res = 161;
    const size = 40;
    const data = new Float32Array(res * res);
    for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) data[j * res + i] = height((i / (res - 1) - 0.5) * size, (j / (res - 1) - 0.5) * size) / top;
    }
    return { frame: { x: 0, y: 0, z: 0, sizeX: size, sizeZ: size, height: top }, map: { width: res, height: res, data } };
}

/** Nearest hit on the boxes or the terrain (id "land"), as the level's rays meet them. */
function castLand(land: TerrainSurface, blocks: Block[], o: Vec3, dir: Vec3, maxDist: number, ignore?: (id: string) => boolean): RayHit | null {
    let best = castBoxes(blocks, o, dir, maxDist, ignore);
    if (ignore?.('land')) return best;
    const n = Math.hypot(dir[0], dir[1], dir[2]);
    const d = dir.map((v) => v / n) as Vec3;
    const t = rayTerrain(land, o, d, Math.min(maxDist, best?.distance ?? Infinity));
    if (t !== null && t >= 0) {
        const point: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
        best = { distance: t, point, id: 'land', normal: groundNormal(land, point[0], point[2]) };
    }
    return best;
}

function landScan(land: TerrainSurface, blocks: Block[] = []): LevelScan {
    return { ...scan(blocks), cast: (o, d, m, ignore) => castLand(land, blocks, o, d, m, ignore), lands: new Set(['land']) };
}

const ground: Block = { id: 'ground', min: [-10, -0.2, -10], max: [10, 0, 10] };

/** A 4 x 4 m room built by the room planner, as blocks. */
function room(openings: OpeningSpec[] = []): Block[] {
    const plan = planBuilding([{ name: 'Hall', min: [0, 0], max: [4, 4], floorY: 0, height: 3, floor: true, ceiling: true, open: [], openings, holes: [] }], { wall: 0.2, slab: 0.2 });
    return plan.pieces.map((p, i) => ({
        id: `${p.kind}${i}`,
        min: p.center.map((c, k) => c - p.size[k] / 2) as Vec3,
        max: p.center.map((c, k) => c + p.size[k] / 2) as Vec3,
    }));
}

const door: OpeningSpec = { side: 'z_min', kind: 'door', width: 1, height: 2.1, sill: 0 };
const body = { height: 1.8, radius: 0.35, stepHeight: 0.3 };
const region = { min: [-2, -1, -4.5] as Vec3, max: [6, 5, 6] as Vec3 };

function check(blocks: Block[], start: Vec3 | null = [2, 0, -3]) {
    return checkLevel(scan(blocks), { box: region, step: 0.5, body, start, targets: [{ name: 'inside', point: [2, 0, 2] }] });
}

describe('checkLevel', () => {
    it('finds a room with a door closed and walks in through the door', async () => {
        const { report } = await check([ground, ...room([door])]);
        expect(report.closed).toBe(true);
        expect(report.unreachable).toEqual([]);
        expect(report.sealed).toEqual([]);
        expect(report.openings.some((o) => o.kind === 'passage')).toBe(true);
        expect(report.stats.ceiling).toBe(3);
        expect(summarize(report)).toMatch(/^Closed and walkable/);
    });

    it('reports a room without a door as sealed and its inside out of reach', async () => {
        const { report } = await check([ground, ...room()]);
        expect(report.unreachable.map((u) => u.name)).toEqual(['inside']);
        expect(report.sealed.length).toBeGreaterThan(0);
        expect(report.ok).toBe(false);
    });

    it('reports walls that nearly meet and objects that float', async () => {
        const walls: Block[] = [
            { id: 'wallA', min: [-1, 0, 0], max: [1, 3, 0.2] },
            { id: 'wallB', min: [1.1, 0, 0], max: [3, 3, 0.2] },
            { id: 'crate', min: [4, 1.5, 4], max: [5, 2.5, 5] },
        ];
        const { report } = await check([ground, ...walls], null);
        expect(report.seams).toEqual([expect.objectContaining({ gap: 0.1 })]);
        expect(report.floating).toEqual([expect.objectContaining({ id: 'crate', gap: 1.51 })]);
        expect(report.notes.some((n) => /reach was not checked/.test(n))).toBe(true);
    });

    it('walks up a hillside no steeper than the max slope, on a fine grid and on the coarse grid of a large level', async () => {
        const top = Math.tan((25 * Math.PI) / 180) * 10;
        for (const step of [0.5, 2]) {
            const { report } = await checkLevel(landScan(hillside(25)), {
                box: { min: [-6, -1, -4], max: [16, top + 4, 4] },
                step,
                body: { ...body, maxSlope: 40 },
                start: [-4, 0, 0],
                targets: [{ name: 'hilltop', point: [14, top, 0] }],
            });
            expect(report.unreachable).toEqual([]);
            expect(report.stats.reachable).toBeGreaterThan(report.stats.walkable * 0.9);
        }
    });

    it('does not walk up a slope steeper than the max slope, nor a rock on the way', async () => {
        const top = Math.tan((55 * Math.PI) / 180) * 10;
        const steep = await checkLevel(landScan(hillside(55)), {
            box: { min: [-6, -1, -4], max: [16, top + 4, 4] },
            step: 0.5,
            body: { ...body, maxSlope: 40 },
            start: [-4, 0, 0],
            targets: [{ name: 'hilltop', point: [14, top, 0] }],
        });
        expect(steep.report.unreachable.map((u) => u.name)).toEqual(['hilltop']);
        // A wall of rock across a gentle slope stops the walk too.
        const top2 = Math.tan((20 * Math.PI) / 180) * 10;
        const rock: Block = { id: 'rock', min: [4, 0, -4.5], max: [5, 6, 4.5] };
        const walled = await checkLevel(landScan(hillside(20), [rock]), {
            box: { min: [-6, -1, -4], max: [16, top2 + 4, 4] },
            step: 0.5,
            body: { ...body, maxSlope: 40 },
            start: [-4, 0, 0],
            targets: [{ name: 'hilltop', point: [14, top2, 0] }],
        });
        expect(walled.report.unreachable.map((u) => u.name)).toEqual(['hilltop']);
    });

    it('leaves wide ground planes out of the built bounds', () => {
        const huge: Block = { id: 'plane', min: [-500, 0, -500], max: [500, 0, 500] };
        const b = builtBounds(scan([huge, ...room()]).objects)!;
        [...b.min, ...b.max].forEach((v, i) => expect(v).toBeCloseTo([-0.1, -0.2, -0.1, 4.1, 3.2, 4.1][i]));
    });
});

describe('CharacterMotor', () => {
    const level: Block[] = [ground, { id: 'step', min: [1, 0, -1], max: [3, 0.2, 1] }, { id: 'wall', min: [5, 0, -2], max: [5.2, 3, 2] }];
    const cast = (o: Vec3, d: Vec3, m: number) => castBoxes(level, o, d, m);

    it('climbs a low step and stops at a wall', () => {
        const motor = new CharacterMotor(cast, body, [0, 0, 0]);
        let top = 0;
        for (let i = 0; i < 200; i++) {
            motor.step(1 / 60, [0.05, 0, 0], 14);
            if (motor.feet[0] > 1.5 && motor.feet[0] < 2.5) top = Math.max(top, motor.feet[1]);
        }
        expect(top).toBeCloseTo(0.2);
        expect(motor.feet[0]).toBeLessThanOrEqual(5 - body.radius + 1e-6);
        expect(motor.feet[0]).toBeGreaterThan(4);
    });

    it('runs up a slope it climbs at a low frame rate, follows it down, and stops at a steeper one', () => {
        const land = hillside(30);
        const top = Math.tan((30 * Math.PI) / 180) * 10;
        const castHill = (o: Vec3, d: Vec3, m: number) => castLand(land, [], o, d, m);
        // Ten frames a second at a run: 0.6 m a step.
        const motor = new CharacterMotor(castHill, { ...body, maxSlope: 40 }, [-3, 0, 0]);
        for (let i = 0; i < 25; i++) motor.step(0.1, [0.6, 0, 0], 14);
        expect(motor.feet[0]).toBeCloseTo(12, 5);
        expect(motor.feet[1]).toBeCloseTo(top, 1);
        // Down again: it stays on the ground all the way.
        let air = 0;
        for (let i = 0; i < 25; i++) {
            motor.step(0.1, [-0.6, 0, 0], 14);
            if (!motor.grounded) air++;
        }
        expect(motor.feet[0]).toBeLessThan(0);
        expect(air).toBe(0);
        // Too steep for it: it stays at the foot.
        const cliff = hillside(55);
        const climber = new CharacterMotor((o, d, m) => castLand(cliff, [], o, d, m), { ...body, maxSlope: 40 }, [-3, 0, 0]);
        for (let i = 0; i < 200; i++) climber.step(1 / 60, [0.05, 0, 0], 14);
        expect(climber.feet[0]).toBeLessThan(0.5);
        expect(climber.feet[1]).toBeLessThan(0.6);
    });

    it('walks over a steep bank no higher than a step, and on down the ground falling away behind it', () => {
        // A bank 0.25 m high at about 60 degrees, a flat top 0.3 m long, then a slope down 1.5 m.
        const land = landOf(3, (x) => 1.5 + (x < 0 ? 0 : x < 0.15 ? (x / 0.15) * 0.25 : x < 0.45 ? 0.25 : Math.max(-1.5, 0.25 - (x - 0.45) * 1.2)));
        const motor = new CharacterMotor((o, d, m) => castLand(land, [], o, d, m), { ...body, maxSlope: 40 }, [-2, 1.5, 0]);
        for (let i = 0; i < 60; i++) motor.step(1 / 30, [0.1, 0, 0], 14);
        expect(motor.feet[0]).toBeGreaterThan(3);
        expect(motor.feet[1]).toBeCloseTo(0, 1);
    });

    it('jumps, falls back and lands', () => {
        const motor = new CharacterMotor(cast, body, [-5, 0, 0]);
        motor.step(1 / 60, [0, 0, 0], 14);
        expect(motor.grounded).toBe(true);
        motor.step(1 / 60, [0, 0, 0], 14, 4.5);
        let peak = 0;
        for (let i = 0; i < 120; i++) {
            motor.step(1 / 60, [0, 0, 0], 14);
            peak = Math.max(peak, motor.feet[1]);
        }
        expect(peak).toBeGreaterThan(0.5);
        expect(motor.grounded).toBe(true);
        expect(motor.feet[1]).toBeCloseTo(0);
    });
});

describe('walkRoute', () => {
    const walker = { ...body, maxSlope: 40, speed: 3, gravity: 14 };
    const point = (id: string, p: Vec3) => ({ id, name: id, point: p });

    it('walks into a room through its door around the walls, ticking the points it passes', async () => {
        const blocks = [ground, ...room([door])];
        const cast = (o: Vec3, d: Vec3, m: number) => castBoxes(blocks, o, d, m);
        const route = [point('porch', [2, 0, -2]), point('inside', [2, 0, 2]), point('corner', [3, 0, 3])];
        // The way in: through the middle of the door (x 2, z 0), as a navigation mesh would lead.
        const plan = (from: Vec3, to: Vec3) => (from[2] < 0 && to[2] > 0 ? [[2, 0, -0.6], [2, 0, 0.6], to] as Vec3[] : [to]);
        const r = await walkRoute(cast, walker, [-1, 0, -3], route.slice(1), { plan, route });
        expect(r.legs.map((l) => l.reached)).toEqual([true, true]);
        expect(r.legs[0].planned).toBe(true);
        expect(r.passed).toEqual(['porch', 'inside', 'corner']);
        expect(r.stops).toEqual([]);
    });

    it('goes around a cliff up the gentle way the grid finds, as the level check does', async () => {
        // A plateau 4 m high over x 0..10, z -6..10: a cliff on the west, a ramp of about 22 degrees up from the south (z -16 to -6).
        const land = landOf(5, (x, z) => {
            const across = x >= 0 && x <= 10 ? 1 : x < 0 ? Math.max(0, 1 + x / 1.5) : Math.max(0, 1 - (x - 10) / 1.5);
            const along = z >= -6 && z <= 10 ? 1 : z < -6 ? Math.max(0, 1 + (z + 6) / 10) : Math.max(0, 1 - (z - 10) / 1.5);
            return 4 * Math.min(across, along);
        });
        const level = landScan(land);
        const grid = await LevelGrid.scan(level, { min: [-18, -1, -19], max: [18, 8, 18] }, 0.5, { ...body, maxSlope: 40 });
        const way = await grid.path([-12, 0, 4], [5, 4, 4], 1.2);
        expect(way).not.toBeNull();
        // Around by the ramp in the south, not up the cliff in the west.
        expect(Math.min(...way!.map((p) => p[2]))).toBeLessThan(-6);
        const open = { has: (id: string | undefined) => id === 'land', cast: (o: Vec3, d: Vec3, m: number) => level.cast(o, d, m, (id) => id === 'land') };
        const r = await walkRoute((o, d, m) => level.cast(o, d, m), walker, [-12, 0, 4], [point('plateau', [5, 4, 4])], { plan: (a, b) => grid.path(a, b, 1.2), open });
        expect(r.legs[0].reached).toBe(true);
        expect(r.trace[r.trace.length - 1][1]).toBeCloseTo(4, 0);
        // The check agrees: the plateau is in reach.
        const { report } = await checkLevel(level, { box: { min: [-18, -1, -19], max: [18, 8, 18] }, step: 0.5, body: { ...body, maxSlope: 40 }, start: [-12, 0, 4], targets: [{ name: 'plateau', point: [5, 4, 4] }] });
        expect(report.unreachable).toEqual([]);
    });

    it('reaches every point of rough hills the level check reaches, along the grid\'s ways', async () => {
        const land: TerrainSurface = { frame: { x: 0, y: 0, z: 0, sizeX: 80, sizeZ: 80, height: 12 }, map: generateHeightmap({ shape: 'hills', resolution: 257, seed: 21, erosion: 0.5 }) };
        const level = { ...scan([]), cast: (o: Vec3, d: Vec3, m: number, ignore?: (id: string) => boolean) => castLand(land, [], o, d, m, ignore), lands: new Set(['land']) };
        const open = { has: (id: string | undefined) => id === 'land', cast: (o: Vec3, d: Vec3, m: number) => level.cast(o, d, m, (id) => id === 'land') };
        const grid = await LevelGrid.scan(level, { min: [-40, -1, -40], max: [40, 14, 40] }, 0.5, { ...body, maxSlope: 40 });
        const at = (x: number, z: number): Vec3 => [x, groundHeight(land, x, z), z];
        const start = at(0, 0);
        // Points the grid has a way to, around the hills.
        const points: { id: string; name: string; point: Vec3 }[] = [];
        for (let i = 0; points.length < 8 && i < 40; i++) {
            const p = at(30 * Math.cos(i * 2.4), 30 * Math.sin(i * 1.7));
            if (await grid.path(start, p, 1.2)) points.push(point(`p${points.length}`, p));
        }
        expect(points.length).toBe(8);
        const r = await walkRoute(level.cast, walker, start, points, { plan: (a, b) => grid.path(a, b, 1.2), open });
        expect(r.legs.filter((l) => !l.reached)).toEqual([]);
    });

    it('says what stopped it: a wall in the way, a slope too steep', async () => {
        const blocks = [ground, ...room()];
        const sealed = await walkRoute((o, d, m) => castBoxes(blocks, o, d, m), walker, [2, 0, -3], [point('inside', [2, 0, 2])]);
        expect(sealed.legs[0].reached).toBe(false);
        expect(sealed.legs[0].stuck).toMatchObject({ why: 'blocked' });
        expect(sealed.legs[0].stuck!.by).toMatch(/^wall/);
        expect(sealed.stops.length).toBe(1);
        const cliff = hillside(55);
        const top = Math.tan((55 * Math.PI) / 180) * 10;
        const steep = await walkRoute((o, d, m) => castLand(cliff, [], o, d, m), walker, [-4, 0, 0], [point('hilltop', [14, top, 0])]);
        expect(steep.legs[0].stuck).toMatchObject({ why: 'steep' });
        // A gentler one it walks up.
        const hill = hillside(30);
        const up = await walkRoute((o, d, m) => castLand(hill, [], o, d, m), walker, [-4, 0, 0], [point('hilltop', [14, Math.tan((30 * Math.PI) / 180) * 10, 0])]);
        expect(up.legs[0].reached).toBe(true);
    });
});

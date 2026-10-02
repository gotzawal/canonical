// What lies on and colors the ground around terrains, worked out from the
// scene SceneSync shows: contact maps (where things stand and grass grows),
// loose stones, the ground colors under grass and scattered rocks, and the
// water and rain that wet each terrain. All of it follows the scene, not
// the camera: a cheap signature of what it reads is checked each frame and
// the work runs only when that changes; the stones near the camera are the
// one part that follows the view.

import type { Context3D, Object3D, Vector4 } from '@orillusion/core';
import type { ClutterGround } from '../core/clutter';
import { patchNoise } from '../core/grass';
import { quatRotate } from '../core/math';
import { contactMap, covers, groundHeight, groundNormal, layerWeights, paintAt, type Contact, type Cover } from '../core/terrain';
import type { GrassDoc, NodeDoc, ScatterDoc } from '../core/types';
import type { Placement } from '../core/scatter';
import { GroundClutter } from './clutter';
import { hexToColor } from './color';
import { fieldFrame, hashString, type GrassField } from './grass';
import { objectWorldBox } from './rain';
import { linearOf } from './rockGround';
import type { ScatterPiece, ScatterView } from './scatter';
import type { TerrainView } from './terrain';

type ContactData = { width: number; height: number; data: Uint8Array };

/** A terrain as the ground details read it (SceneSync's terrain state). */
export interface GroundTerrain {
    view: TerrainView;
    /** Changes whenever its heights or place change. */
    version: number;
    /** Its paint as last loaded, or null. */
    paintData: ContactData | null;
    /** The height of water over it (set here), or null. */
    water?: number | null;
    /** What last made it wet (set here; '' to apply it again). */
    wet: string;
}

/** A scatter as the ground details read it. */
export interface GroundScatter {
    view: ScatterView;
    placements: Placement[];
    /** Its copies that are trees grown from rules, when it has some. */
    trees?: { trunks(): { center: number[]; size: number[] }[] } | null;
    /** What its soil and moss were last set from (set here). */
    groundKey?: string;
}

/** What the ground details read from the scene. */
export interface GroundHost {
    node(id: string): NodeDoc | undefined;
    /** Counts every change of the document. */
    version(): number;
    /** The terrains shown. */
    terrains(): GroundTerrain[];
    /** The grass fields (shown or not) and their objects' world matrices. */
    fields(): { id: string; grass: GrassField; matrix: ArrayLike<number>; visible: boolean }[];
    /** The scatters (shown or not). */
    scatters(): { id: string; state: GroundScatter; visible: boolean }[];
    /** The terrains of a ground object and of the objects under it. */
    groundTerrains(id: string): { id: string }[];
    /** A scatter source model's piece, once loaded. */
    piece(model: string, variant: number): ScatterPiece | null;
    /** The shown objects whose material shows what lies under them (water). */
    waters(): Object3D[];
    /** The shown rain boxes: their object, size and amount. */
    rains(): { obj: Object3D; size: number[]; amount: number }[];
    /** The weather: its rain everywhere (0 none) and wind. */
    weather(): { rain: number; wind: { speed: number; direction: number } };
    /** Where the terrain material shaders read lies. */
    place(): { frame: Vector4; level: Vector4 };
    /** Places grass again where its growth changed. */
    placeGrass(): void;
}

export class GroundDetails {
    private clutter: GroundClutter | null = null;
    private contactMaps = new Map<GroundTerrain, ContactData>();
    private contactsKey = '';
    private groundKey = '';
    private signature = NaN;
    /** Counts scatter placements (things on the ground follow them). */
    private scatterVersion = 0;

    constructor(private host: GroundHost, private scene: Object3D, private ctx: Context3D) {}

    /** What the ground was last worked out from (grass placement follows it). */
    get key(): string {
        return this.groundKey;
    }

    /** A scatter was placed again: what stands on the ground changed. */
    scattersPlaced() {
        this.scatterVersion++;
    }

    /** Works the ground out again on the next update, whatever changed. */
    touch() {
        this.signature = NaN;
    }

    /** Once a frame: the ground's details when what they read changed, and the stones near `eye` within `stones` meters. */
    update(eye: ArrayLike<number>, stones: number) {
        const terrains = this.host.terrains();
        const sig = this.signatureOf(terrains);
        if (sig !== this.signature) {
            this.signature = sig;
            if (terrains.length) this.updateWetness(terrains);
            this.updateDetails(terrains);
        }
        this.clutter?.update(eye, stones);
    }

    /** What the loose stones draw, for the Profiler; null with none. */
    report(): string | null {
        return this.clutter?.report() ?? null;
    }

    dispose() {
        this.clutter?.dispose();
        this.clutter = null;
    }

    /** A number that changes whenever anything the details read may have (not a hash of all of it: the document's version stands for the document). */
    private signatureOf(terrains: GroundTerrain[]): number {
        let h = mix(mix(this.host.version(), this.scatterVersion), terrains.length);
        for (const t of terrains) h = mix(mix(mix(h, t.version), t.view.material.meansVersion), t.wet ? 1 : 0);
        for (const w of this.host.waters()) {
            const p = w.transform.worldPosition;
            h = mix(mix(mix(h, p.x), p.y), p.z);
        }
        for (const r of this.host.rains()) {
            const p = r.obj.transform.worldPosition;
            h = mix(mix(h, p.x), p.z);
        }
        const w = this.host.weather();
        h = mix(mix(mix(h, w.rain), w.wind.speed), w.wind.direction);
        const place = this.host.place();
        for (const v of [place.frame.x, place.frame.z, place.frame.w, place.level.x, place.level.y, place.level.z]) h = mix(h, v);
        for (const f of this.host.fields()) h = mix(mix(mix(h, f.matrix[12]), f.matrix[14]), f.visible ? 1 : 0);
        for (const s of this.host.scatters()) h = mix(h, s.visible ? s.state.placements.length : -1);
        return h;
    }

    /**
     * Gives each terrain the water surface over it (the highest of the
     * planes whose shader shows what lies under them, water) and the rain
     * box over it with the most ground under it, which make it wet.
     */
    private updateWetness(terrains: GroundTerrain[]) {
        const waters: { min: number[]; max: number[] }[] = [];
        for (const obj of this.host.waters()) {
            const box = objectWorldBox(obj);
            if (box) waters.push(box);
        }
        const rains: { rect: [number, number, number, number]; amount: number }[] = this.host.rains().map((r) => {
            const q = r.obj.transform.worldPosition;
            return { rect: [q.x - r.size[0] / 2, q.z - r.size[2] / 2, q.x + r.size[0] / 2, q.z + r.size[2] / 2], amount: r.amount };
        });
        // The weather's rain falls everywhere.
        const weather = this.host.weather().rain;
        if (weather) rains.push({ rect: [-1e6, -1e6, 1e6, 1e6], amount: weather });
        for (const t of terrains) {
            const doc = this.host.node(t.view.id)?.terrain;
            if (!doc) continue;
            const f = t.view.frame;
            const x0 = f.x - f.sizeX / 2, z0 = f.z - f.sizeZ / 2, x1 = f.x + f.sizeX / 2, z1 = f.z + f.sizeZ / 2;
            const overlap = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(c, x1) - Math.max(a, x0)) * Math.max(0, Math.min(d, z1) - Math.max(b, z0));
            let water: number | null = null;
            for (const w of waters) if (overlap(w.min[0], w.min[2], w.max[0], w.max[2]) > 0) water = Math.max(water ?? -Infinity, w.max[1]);
            let rain: (typeof rains)[number] | null = null;
            let most = 0;
            for (const r of rains) {
                const a = overlap(...r.rect);
                if (a > most) {
                    most = a;
                    rain = r;
                }
            }
            const wet = { water: water === null ? null : Math.round(water * 1000) / 1000, shore: doc.wetShore, rain, puddles: doc.puddles };
            t.water = wet.water;
            const key = JSON.stringify(wet);
            if (key === t.wet) continue;
            t.wet = key;
            t.view.material.setWet(wet);
        }
    }

    /** Contact maps, loose stones, the ground colors under grass and the soil of scattered rocks, as far as what they read changed. */
    private updateDetails(terrains: GroundTerrain[]) {
        const land = [this.scatterVersion, ...terrains.map((t) => `${t.view.id}:${t.version}:${t.water}:${this.host.node(t.view.id)?.terrain?.layers.map((l) => [l.debris, l.grass])}`)].join('|');
        // What stands on the terrains and the grass covering them (the ground under far grass takes its color).
        const fields = this.grassOnTerrains(terrains);
        const contactsKey = land + JSON.stringify(fields.map(({ id, doc, m }) => [id, doc.size, doc.count, doc.maxSlope, doc.waterGap, doc.gaps, doc.patchSize, doc.bottomColor, doc.topColor, doc.dryness, doc.distance, Array.from(m, (v) => +v.toFixed(2))]));
        if (contactsKey !== this.contactsKey) {
            this.contactsKey = contactsKey;
            const contacts = this.scatterContacts();
            this.contactMaps.clear();
            for (const t of terrains) {
                const mine = fields.filter((f) => f.lands.includes(t));
                const map = contactMap(t.view.frame, contacts, 512, mine.map((f) => f.cover), (m) => this.contactMaps.set(t, m));
                t.view.material.setContacts(map);
                if (!map) this.contactMaps.delete(t);
                t.view.material.setGrass(mine.length ? grassTint(mine.map((f) => f.doc)) : null);
            }
        }
        const key = land + terrains.map((t) => t.view.material.meansVersion).join();
        if (key !== this.groundKey) {
            this.groundKey = key;
            this.clutter ??= new GroundClutter(this.scene, this.ctx);
            this.clutter.setGround(this.clutterGround(terrains), terrains[0]?.view.material.means ?? []);
            // Grass grows where the ground suits it now, its roots in the ground's colors.
            this.host.placeGrass();
            for (const f of this.host.fields()) {
                const doc = this.host.node(f.id)?.grass;
                if (!doc) continue;
                const frame = fieldFrame(f.matrix);
                const pts: [number, number][] = [];
                for (let i = 0; i < 16; i++) pts.push([frame.origin[0] + (((i % 4) + 0.5) / 4 - 0.5) * doc.size[0], frame.origin[2] + ((Math.floor(i / 4) + 0.5) / 4 - 0.5) * doc.size[1]]);
                const c = this.groundColor(terrains, pts);
                if (c) f.grass.setGroundColor(c);
            }
        }
        for (const s of this.host.scatters()) {
            const doc = this.host.node(s.id)?.scatter;
            if (doc) this.applyRockGround(s.state, doc, terrains);
        }
    }

    /** The grass fields on these terrains: their ground, and how densely they cover it (see Cover). */
    private grassOnTerrains(terrains: GroundTerrain[]): { id: string; doc: GrassDoc; m: ArrayLike<number>; lands: GroundTerrain[]; cover: Cover }[] {
        const out: { id: string; doc: GrassDoc; m: ArrayLike<number>; lands: GroundTerrain[]; cover: Cover }[] = [];
        for (const f of this.host.fields()) {
            const doc = f.visible ? this.host.node(f.id)?.grass : undefined;
            if (!doc?.ground) continue;
            const ids = new Set(this.host.groundTerrains(doc.ground).map((l) => l.id));
            const lands = terrains.filter((t) => ids.has(t.view.id));
            if (!lands.length) continue;
            const m = f.matrix;
            const { origin: o, x: ax, z: az } = fieldFrame(m);
            const [w, d] = doc.size;
            const grow = this.growth(lands, doc, hashString(f.id));
            // Full cover at about twenty blades a square meter, fading over the last meter of the field.
            const dense = Math.min(1, doc.count / Math.max(1, w * d) / 20);
            const reach = [Math.abs(ax[0]) * w + Math.abs(az[0]) * d, Math.abs(ax[2]) * w + Math.abs(az[2]) * d].map((r) => r / 2);
            const cover: Cover = {
                minX: o[0] - reach[0], maxX: o[0] + reach[0], minZ: o[2] - reach[1], maxZ: o[2] + reach[1],
                at: (x, z) => {
                    const u = (x - o[0]) * ax[0] + (z - o[2]) * ax[2], v = (x - o[0]) * az[0] + (z - o[2]) * az[2];
                    const edge = Math.min(w / 2 - Math.abs(u), d / 2 - Math.abs(v));
                    return edge <= 0 ? 0 : Math.min(1, edge) * dense * (grow ? grow(x, z) : 1);
                },
            };
            out.push({ id: f.id, doc, m, lands, cover });
        }
        return out;
    }

    /** Where scattered copies meet the ground: their trunks, rocks (wider than tall) with a ring of loose stones. */
    private scatterContacts(): Contact[] {
        const out: Contact[] = [];
        for (const s of this.host.scatters()) {
            const doc = s.visible ? this.host.node(s.id)?.scatter : undefined;
            if (!doc) continue;
            for (const p of s.state.placements) {
                const model = doc.sources[p.source]?.model;
                const piece = model ? this.host.piece(model, p.variant) : null;
                if (!piece) continue;
                const c = quatRotate(p.rotation, [piece.trunk.x * p.scale, 0, piece.trunk.z * p.scale]);
                const tall = (piece.max[1] - piece.min[1]) / Math.max(1e-6, piece.max[0] - piece.min[0], piece.max[2] - piece.min[2]);
                out.push({ x: p.position[0] + c[0], z: p.position[2] + c[2], r: piece.trunk.radius * p.scale, ring: tall < 1.5 ? 1 : 0 });
            }
            for (const t of s.state.trees?.trunks() ?? []) out.push({ x: t.center[0], z: t.center[2], r: t.size[0], ring: 0 });
        }
        return out;
    }

    /** The ground loose stones lie on: the terrains shown, their layers' Loose Stones, and rings around rocks; null with none. */
    private clutterGround(terrains: GroundTerrain[]): ClutterGround | null {
        const lands = terrains.flatMap((t) => {
            const doc = this.host.node(t.view.id)?.terrain;
            const ring = this.contactMaps.get(t);
            return doc && (doc.layers.some((l) => l.debris > 0) || ring) ? [{ t, doc, surface: t.view.surface, ring }] : [];
        });
        if (!lands.length) return null;
        const landAt = (x: number, z: number) => lands.find((l) => covers(l.surface, x, z));
        return {
            at: (x, z) => {
                const l = landAt(x, z);
                return l ? { y: groundHeight(l.surface, x, z), ny: groundNormal(l.surface, x, z)[1] } : null;
            },
            amount: (x, z) => {
                const l = landAt(x, z);
                if (!l) return { amount: 0, layer: 0 };
                const y = groundHeight(l.surface, x, z);
                const slope = (Math.acos(Math.min(1, groundNormal(l.surface, x, z)[1])) * 180) / Math.PI;
                const paint = l.t.paintData;
                const w = layerWeights(l.doc.layers, y, slope, paint ? paintAt(l.surface.frame, paint, x, z) : null);
                let amount = 0, layer = 0;
                w.forEach((v, i) => {
                    amount += v * (l.doc.layers[i]?.debris ?? 0);
                    if (v > w[layer]) layer = i;
                });
                if (l.ring) amount += (texel(l.ring, l.t.view.frame, x, z, 1) / 255) * 0.8;
                return { amount, layer };
            },
        };
    }

    /** The mean height of a scatter's copies, meters (what they sway over). */
    private scatterHeight(doc: ScatterDoc, st: GroundScatter): number {
        let sum = 0, n = 0;
        for (let k = 0; k < st.placements.length; k += Math.max(1, Math.floor(st.placements.length / 32))) {
            const p = st.placements[k];
            const model = doc.sources[p.source]?.model;
            const piece = model ? this.host.piece(model, p.variant) : null;
            if (piece) {
                sum += (piece.max[1] - piece.min[1]) * p.scale;
                n++;
            }
        }
        return n ? Math.max(0.1, sum / n) : 1;
    }

    /** The mean color (linear rgb) of the terrains' ground at these points, as their layers show there; null off them or before their colors are read. */
    private groundColor(terrains: GroundTerrain[], points: [number, number][]): number[] | null {
        const sum = [0, 0, 0];
        let n = 0;
        for (const [x, z] of points) {
            const t = terrains.find((t) => covers(t.view.surface, x, z));
            const w = t && t.view.material.means.length ? this.layersOn(t, x, z) : null;
            if (!t || !w) continue;
            w.forEach((v, i) => {
                const m = t.view.material.means[i];
                if (m) for (let c = 0; c < 3; c++) sum[c] += m[c] * v;
            });
            n++;
        }
        return n ? sum.map((v) => v / n) : null;
    }

    /** How much each layer of a terrain shows at (x, z) on its ground, or null without its document. */
    private layersOn(t: GroundTerrain, x: number, z: number): number[] | null {
        const doc = this.host.node(t.view.id)?.terrain;
        if (!doc) return null;
        const slope = (Math.acos(Math.min(1, groundNormal(t.view.surface, x, z)[1])) * 180) / Math.PI;
        return layerWeights(doc.layers, groundHeight(t.view.surface, x, z), slope, t.paintData ? paintAt(t.view.surface.frame, t.paintData, x, z) : null);
    }

    /**
     * How well a field's grass grows at (x, z): in its bare patches not at
     * all (Grass.gaps), and on these terrains as their layers let it
     * (TerrainLayer.grass), thinning toward its steepest slope, not under
     * what stands there (the contact map), not under water and bare a gap
     * above it.
     */
    growth(lands: GroundTerrain[], doc: GrassDoc, seed: number): ((x: number, z: number) => number) | undefined {
        const gaps = Math.min(1, Math.max(0, doc.gaps));
        if (!lands.length && !gaps) return undefined;
        const steep = Math.cos((doc.maxSlope * Math.PI) / 180), soft = Math.cos((doc.maxSlope * 0.66 * Math.PI) / 180);
        return (x, z) => {
            let bare = 1;
            if (gaps > 0) {
                const n = patchNoise(x, z, doc.patchSize * 3, seed ^ 0x3c6ef372);
                bare = Math.min(1, Math.max(0, (n - gaps * 0.9 + 0.08) / 0.16));
            }
            const t = lands.find((t) => covers(t.view.surface, x, z));
            if (!t || !bare) return bare;
            const ny = groundNormal(t.view.surface, x, z)[1];
            if (ny <= steep) return 0;
            bare *= Math.min(1, (ny - steep) / Math.max(1e-6, soft - steep));
            const land = this.host.node(t.view.id)?.terrain;
            const w = this.layersOn(t, x, z);
            let g = 0;
            w?.forEach((v, i) => (g += v * (land?.layers[i]?.grass ?? 1)));
            const c = this.contactMaps.get(t);
            if (c) g *= 1 - texel(c, t.view.frame, x, z, 0) / 255;
            if (t.water !== null && t.water !== undefined) {
                const y = groundHeight(t.view.surface, x, z);
                g *= Math.min(1, Math.max(0, (y - t.water - doc.waterGap) / 0.4));
            }
            return g * bare;
        };
    }

    /** A scatter's soil (the terrain's colors under its copies), moss and variation. */
    private applyRockGround(st: GroundScatter, doc: ScatterDoc, terrains: GroundTerrain[]) {
        const place = this.host.place();
        const wind = this.host.weather().wind;
        const key = JSON.stringify([doc.soil, doc.moss, doc.mossColor, doc.vary, doc.sway, wind, st.placements.length, this.groundKey, place.frame.x, place.frame.z, place.frame.w, place.level.x, place.level.y, place.level.z]);
        if (key === st.groundKey) return;
        st.groundKey = key;
        // The soil: the terrains' mean colors where the copies stand (a few of them).
        const step = Math.max(1, Math.floor(st.placements.length / 24));
        const soil = this.groundColor(terrains, st.placements.filter((_, k) => k % step === 0).map((p) => [p.position[0], p.position[2]]));
        const color = soil ? soil.map((v) => v * 0.85) : linearOf('#6a5c4c');
        st.view.ground.set({
            frame: [place.frame.x, place.frame.y, place.frame.z, place.frame.w],
            level: [place.level.x, place.level.y, place.level.z, doc.vary],
            soil: [color[0], color[1], color[2], soil ? doc.soil : 0],
            moss: [...linearOf(doc.mossColor), doc.moss],
            // The wind's way and strength (tops lean more in stronger wind), bent over the copies' mean height.
            sway: [Math.cos((wind.direction * Math.PI) / 180), Math.sin((wind.direction * Math.PI) / 180), doc.sway * Math.max(0.15, Math.min(2.5, wind.speed / 6)), this.scatterHeight(doc, st)],
        });
    }
}

/** One channel of a map over a terrain's frame at world (x, z), 0 off it. */
function texel(map: ContactData, f: { x: number; z: number; sizeX: number; sizeZ: number }, x: number, z: number, channel: number): number {
    const i = Math.floor(((x - f.x + f.sizeX / 2) / f.sizeX) * map.width), j = Math.floor(((z - f.z + f.sizeZ / 2) / f.sizeZ) * map.height);
    return i >= 0 && j >= 0 && i < map.width && j < map.height ? map.data[(j * map.width + i) * 4 + channel] : 0;
}

/** Folds a number into a running signature (exact for the integers and floats it is fed). */
function mix(h: number, v: number): number {
    return (h * 31 + (Number.isFinite(v) ? v : 7.31)) % 1e15;
}

/** The far color of the grass fields on a terrain (their blades' middle, dried in patches), and how far they reach. */
function grassTint(fields: GrassDoc[]): { color: number[]; distance: number } {
    const color = [0, 0, 0];
    let area = 0, distance = 0;
    for (const f of fields) {
        const a = f.size[0] * f.size[1];
        const lo = hexToColor(f.bottomColor), hi = hexToColor(f.topColor);
        const c = [lo.r + (hi.r - lo.r) * 0.6, lo.g + (hi.g - lo.g) * 0.6, lo.b + (hi.b - lo.b) * 0.6];
        // Its dry patches (as the grass shader makes them), on about a third of the field.
        const dry = f.dryness * 0.35;
        const tint = [1 + 0.35 * dry, 1 + 0.1 * dry, 1 - 0.55 * dry];
        for (let k = 0; k < 3; k++) color[k] += c[k] * tint[k] * a;
        area += a;
        distance = Math.max(distance, f.distance);
    }
    return { color: color.map((v) => v / Math.max(area, 1e-6)), distance };
}

// The assistant's reviews: lighting (Lighting stage), and the whole scene's
// cost at the end (Finish stage), each with measurements and advice on
// what to change. They read; the changes are made with the other tools,
// and set_texture_options, which sets how textures ship.

import type { PointShadowPass, ShadowPass } from '@orillusion/core';
import { spotMaxFaces } from '@orillusion/core';
import { assetSizes } from '../build/sizes';
import { shipsAsIs } from '../core/derived';
import { movesInPlay } from '../core/motion';
import { QUALITY, QUALITY_LEVELS, lightShadowSize, type QualityLevel } from '../core/quality';
import { assetRoles } from '../core/refs';
import type { NodeDoc, TextureCompression, TextureRole, Vec3 } from '../core/types';
import { instancingCandidates } from '../design/stages';
import type { Editor } from '../editor';
import { TEXTURE_CLASSES, type PassStats } from '../engine/gpuStats';
import { isHdr, sceneTextures, TEXTURE_SIDE_MAX } from '../engine/measure';
import { shadowCasters, shadowCost } from '../engine/shadows';
import { num, ToolError, tools } from './toolUtil';

const MIB = 1048576;
const mib = (bytes: number) => (bytes >= 10 * MIB ? Math.round(bytes / MIB) : Math.round((bytes / MIB) * 10) / 10);
const r2 = (v: number) => Math.round(v * 100) / 100;
const rv = (v: ArrayLike<number>): Vec3 => [r2(v[0]), r2(v[1]), r2(v[2])];

interface Caster {
    id: string;
    name: string;
    min: Vec3;
    max: Vec3;
    moves: boolean;
}

/** Shown objects that cast shadows, with their world boxes. */
function casters(ed: Editor): Caster[] {
    const doc = ed.store.doc;
    const moves = movesInPlay(doc);
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const shown = (n: NodeDoc) => {
        for (let p: NodeDoc | undefined = n; p; p = p.parent ? byId.get(p.parent) : undefined) if (!p.visible) return false;
        return true;
    };
    const out: Caster[] = [];
    for (const n of doc.nodes) {
        const casts = n.mesh ? n.mesh.castShadow : !!n.model;
        if (!casts || !shown(n)) continue;
        const box = ed.picker.bounds(n.id, false);
        if (box) out.push({ id: n.id, name: n.name, min: box.min, max: box.max, moves: moves(n.id) });
    }
    return out;
}

/** Distance from a point to a box. */
function boxDistance(p: ArrayLike<number>, c: Caster): number {
    let d = 0;
    for (let k = 0; k < 3; k++) {
        const e = Math.max(c.min[k] - p[k], 0, p[k] - c.max[k]);
        d += e * e;
    }
    return Math.sqrt(d);
}

/** What the level's shadow casters span: their box, center and widest horizontal side, meters. */
function extentOf(list: Caster[]) {
    if (!list.length) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of list) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], c.min[k]);
            max[k] = Math.max(max[k], c.max[k]);
        }
    }
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return { min: rv(min), max: rv(max), center: rv(center), across: r2(Math.max(max[0] - min[0], max[2] - min[2])) };
}

/** A light's shadow maps and their memory at a tier, alone (the directional array takes the largest map). */
function lightMaps(n: NodeDoc, level: QualityLevel): { text: string; bytes: number } {
    const l = n.light!;
    const tier = QUALITY[level];
    const s = l.shadow;
    if (l.type === 'directional') {
        const size = lightShadowSize('directional', s.resolution, tier);
        const maps = s.coverage === 'cascades' && tier.cascades ? s.cascades : 1;
        return { text: maps > 1 ? `${maps} cascades of ${size}` : `1 map of ${size}`, bytes: maps * size * size * 4 };
    }
    const size = 1 << Math.round(Math.log2(Math.min(2048, Math.max(64, lightShadowSize(l.type, s.resolution, tier)))));
    const faces = l.type === 'spot' ? spotMaxFaces((l.outerAngle / 2) * (Math.PI / 180)) : 6;
    return { text: `${faces} faces of ${size}`, bytes: faces * size * size * 4 };
}

export function lightingReport(ed: Editor) {
    const doc = ed.store.doc;
    const design = doc.design;
    const all = casters(ed);
    const level = extentOf(all);
    const advice: string[] = [];
    const lights = doc.nodes.filter((n) => n.light);
    const shadowed = lights.filter((n) => n.light!.castShadow && n.visible);
    const rows = lights.map((n) => {
        const l = n.light!;
        const entry = ed.sync.entries.get(n.id);
        const at = entry ? rv(entry.obj.transform.worldPosition as unknown as ArrayLike<number>) : n.position;
        const dir = entry?.light ? rv([entry.light.direction.x, entry.light.direction.y, entry.light.direction.z]) : null;
        const own: string[] = [];
        const row: Record<string, unknown> = {
            id: n.id,
            name: n.name,
            type: l.type,
            color: l.color,
            intensity: l.intensity,
            ...(l.type !== 'directional' ? { position: at, range: l.range } : {}),
            ...(l.type !== 'point' && dir ? { direction: dir } : {}),
            ...(l.type === 'spot' ? { cone: l.outerAngle } : {}),
            cast_shadow: l.castShadow,
            ...(n.visible ? {} : { hidden: true }),
        };
        if (!l.castShadow) return row;
        const s = l.shadow;
        const maps = lightMaps(n, 'high');
        row.shadow = l.type === 'directional' ? s : { resolution: s.resolution, update: s.update };
        row.maps = maps.text;
        row.mib = Object.fromEntries(QUALITY_LEVELS.map((q) => [q, mib(lightMaps(n, q).bytes)]));
        if (l.type === 'directional') {
            if (level) {
                const across = level.across;
                const d = Math.hypot(at[0] - level.center[0], at[2] - level.center[2]);
                row.level_across = across;
                if (s.coverage === 'area' && across > s.range) own.push(`The shadow casters span ${across} m but its map covers ${s.range} m around the light: raise range to about ${Math.ceil(across * 1.1)}, or cover the camera's surroundings (follow, or cascades for a large outdoor level).`);
                if (s.coverage === 'area' && d > s.range / 2) own.push(`Its object is ${Math.round(d)} m from the middle of the level, beyond half its range: move it over the play area, around ${JSON.stringify(level.center)}.`);
                if (s.coverage === 'cascades' && across < 80 && s.cascades > 2) own.push(`The level is ${across} m across: 2 cascades (or one map around the light) keep it as sharp at half the cost.`);
                if (s.coverage === 'cascades' && s.range > across * 1.5 && s.range > 80) own.push(`Range ${s.range} m is well past the level (${across} m): cascades spread over empty space; bring range near ${Math.ceil(across * 1.1)}.`);
            }
            if (s.resolution === 'high' && s.coverage === 'cascades') own.push('High resolution with cascades takes 64 MiB a cascade: medium is usually enough, the cascades already keep it sharp near the camera.');
        } else {
            const near = all.filter((c) => boxDistance(at, c) <= l.range);
            const moving = near.filter((c) => c.moves).length;
            row.reaches = { casters: near.length, moving };
            if (!near.length) own.push('Nothing that casts shadows is in its range: turn its shadows off.');
            else if (s.update === 'every_frame' && !moving) own.push('Nothing in its reach moves: update auto draws it only when something does.');
            else if (s.update === 'static' && moving) own.push(`${moving} object${moving > 1 ? 's' : ''} in its reach move in Play and cast no shadow from it with update static: use auto if their shadows matter here.`);
            if (s.resolution === 'high' && l.range < 4) own.push(`A ${l.range} m light has small shadows: medium or low resolution looks the same.`);
            if (l.type === 'spot' && l.outerAngle >= 90) own.push(`A ${l.outerAngle} degree cone needs ${spotMaxFaces((l.outerAngle / 2) * (Math.PI / 180))} shadow faces; a cone under 90 degrees needs at most 3.`);
            if (l.intensity <= 1 && l.range <= 3) own.push('A dim, short light: its shadows are barely seen; turn them off unless they matter.');
        }
        if (own.length) row.advice = own;
        return row;
    });

    const budget = design.budget;
    const mem = Object.fromEntries(QUALITY_LEVELS.map((q) => [q, mib(shadowCost(shadowCasters(doc), QUALITY[q]).bytes)])) as Record<QualityLevel, number>;
    if (shadowed.length > budget.shadowLights) advice.push(`${shadowed.length} lights cast shadows, over the budget of ${budget.shadowLights}: keep them for the key light and the lights where the player is; turn off the dim, small and far ones.`);
    if (mem.high > budget.shadowMemory) advice.push(`The shadow maps take ${mem.high} MiB at the high tier, over the budget of ${budget.shadowMemory} MiB: lower the resolution of the largest (see each light's mib), use fewer cascades, or fewer shadow-casting lights.`);
    if (!shadowed.some((n) => n.light!.type === 'directional') && lights.some((n) => n.light!.type === 'directional')) advice.push('No directional light casts shadows: outdoors the sun (the key light) usually should.');
    if (shadowed.filter((n) => n.light!.type !== 'directional').length > 8) advice.push('At most 8 point and spot lights get shadows; the others cast none.');

    const graph = ed.runtime.view.renderGraph;
    const dir = graph?.getPass<ShadowPass>('ShadowPass');
    const pts = graph?.getPass<PointShadowPass>('PointShadowPass');
    const frame = dir && pts ? {
        directional_maps: { size: dir.depth2DArrayTexture.width, layers: dir.depth2DArrayTexture.numberLayer, drawn_last_frame: dir.drawnMaps, kept: dir.keptMaps },
        point_spot_atlas: { width: pts.atlasTexture.width, height: pts.atlasTexture.height, faces_drawn_last_frame: pts.drawnFaces, kept: pts.keptFaces },
    } : undefined;

    return {
        note: 'The editor draws the high tier; built games pick a tier per device (low halves the maps again). Shadow maps are drawn again only when their light or something in them moves (update auto).',
        budget: { shadow_lights: budget.shadowLights, shadow_memory_mib: budget.shadowMemory },
        shadow_lights: shadowed.length,
        shadow_memory_mib: mem,
        ...(level ? { level: { casters: all.length, moving: all.filter((c) => c.moves).length, ...level } } : {}),
        lights: rows,
        ...(frame ? { frame } : {}),
        ...(advice.length ? { advice } : {}),
    };
}

/** Draws and triangles a frame above which the review advises cutting them (the editor's tier; phones manage far fewer). */
const DRAWS_HIGH = 1500;
const TRIANGLES_HIGH = 3e6;
/** Texture rows the review lists (those with something to change first). */
const TEXTURE_ROWS = 24;

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const sum = (list: number[]) => list.reduce((n, v) => n + v, 0);
const names = (list: { name: string }[], most = 4) => list.slice(0, most).map((x) => x.name).join(', ') + (list.length > most ? ` and ${list.length - most} more` : '');

/** The passes of the recent frames; timed on the GPU for a moment first when the device can and nothing times them already (the Profiler). */
async function recentPasses(ed: Editor): Promise<PassStats[] | null> {
    const stats = ed.runtime.stats;
    if (!stats) return null;
    if (stats.gpuTimed && !stats.profileGpu) {
        stats.profileGpu = true;
        try {
            await wait(1000);
        } finally {
            stats.profileGpu = false;
        }
    }
    return stats.passes(60);
}

export async function performanceReport(ed: Editor) {
    const doc = ed.store.doc;
    const budget = doc.design.budget;
    const env = doc.environment;
    const runtime = ed.runtime;
    const advice: string[] = [];

    // The frame: its rate against the budget, what it draws, and the passes that cost the most.
    const passes = await recentPasses(ed);
    const snap = runtime.stats?.snapshot(60);
    const fps = Math.round(runtime.fps);
    const limited = !!runtime.fpsLimit && runtime.fpsLimit < budget.fps;
    const frame: Record<string, unknown> = { fps, budget_fps: budget.fps, ...(runtime.fpsLimit ? { viewport_limit_fps: runtime.fpsLimit } : {}) };
    if (fps && fps < budget.fps * 0.95 && !limited) advice.push(`The view draws ${fps} fps, under the budget of ${budget.fps}: start with the costliest passes.`);
    if (snap && passes) {
        const cost = (p: PassStats) => Math.max(p.cpu, p.gpu ?? 0);
        const timed = passes.some((p) => p.gpu !== null);
        Object.assign(frame, {
            cpu_ms: { median: r2(snap.cpu.median), p95: r2(snap.cpu.p95) },
            ...(timed ? { gpu_ms: r2(sum(passes.map((p) => p.gpu ?? 0))) } : {}),
            draws: snap.peak.draws,
            triangles: snap.peak.triangles,
            render_passes: snap.peak.renderPasses,
            compute_passes: snap.peak.computePasses,
            costliest_passes: [...passes]
                .sort((a, b) => cost(b) - cost(a))
                .filter((p) => cost(p) >= 0.05 || p.draws >= 1)
                .slice(0, 6)
                .map((p) => ({ pass: p.name, cpu_ms: r2(p.cpu), ...(p.gpu !== null ? { gpu_ms: r2(p.gpu) } : {}), draws: Math.round(p.draws), triangles: Math.round(p.triangles) })),
        });
        if (snap.peak.draws > DRAWS_HIGH) advice.push(`${snap.peak.draws} draw calls a frame: put repeated objects under instancing groups, prefer models with fewer parts, and turn cast_shadow off on small objects (each caster is drawn again for every shadow map it is in).`);
        if (snap.peak.triangles > TRIANGLES_HIGH) advice.push(`${Math.round(snap.peak.triangles / 1e5) / 10} million triangles a frame: simpler models away from the play area, fewer grass blades, fewer shadow casters.`);
    }
    const memory = snap
        ? {
              total: mib(snap.memory.stable),
              textures: Object.fromEntries(TEXTURE_CLASSES.map((c) => [c, mib(snap.memory.textures[c].bytes)])),
              buffers: mib(sum(Object.entries(snap.memory.buffers).filter(([k]) => k !== 'staging').map(([, t]) => t.bytes))),
          }
        : undefined;

    // Textures: compressed, and no larger than their surfaces need.
    const textures = sceneTextures(doc, ed.derived);
    const rows = textures
        .map((t) => {
            const w = t.meta.width ?? 0;
            const h = t.meta.height ?? 0;
            const full = Math.max(w, h);
            // Compressed textures take about a byte a pixel on the GPU, others four; mip levels a third more.
            const pixels = full ? w * h * (t.side / full) ** 2 : 0;
            const issues: string[] = [];
            if (!t.compressed) issues.push(t.meta.compress?.mode === 'off' ? 'compression off' : 'no compressed copy yet');
            if (t.oversized) issues.push(t.need && t.side > t.need ? `ships at ${t.side} px, its surface needs ${t.need}` : `ships at ${t.side} px, over ${TEXTURE_SIDE_MAX}`);
            return {
                id: t.meta.id,
                name: t.meta.name,
                used_as: t.roles,
                pixels: [w, h],
                ships_px: t.side,
                compressed: t.compressed,
                ...(t.need ? { needs_px: t.need } : {}),
                gpu_mib: mib((pixels * (t.compressed ? 1 : 4) * 4) / 3),
                ...(issues.length ? { issues } : {}),
            };
        })
        .sort((a, b) => Number(!!b.issues) - Number(!!a.issues) || b.gpu_mib - a.gpu_mib);
    const uncompressed = textures.filter((t) => !t.compressed).map((t) => t.meta);
    const oversized = textures.filter((t) => t.oversized).map((t) => t.meta);
    if (uncompressed.length) advice.push(`${uncompressed.length} texture${uncompressed.length > 1 ? 's ship' : ' ships'} uncompressed (${names(uncompressed)}): set_texture_options with compression auto makes compressed copies (a quarter of the GPU memory or less).`);
    if (oversized.length) advice.push(`${oversized.length} texture${oversized.length > 1 ? 's are' : ' is'} larger than needed (${names(oversized)}): set_texture_options max_size to their needs_px (or ${TEXTURE_SIDE_MAX}).`);
    const hdri = env.sky === 'hdri' && env.skyHdri ? doc.assets.find((a) => a.id === env.skyHdri) : undefined;
    const sky = hdri ? { name: hdri.name, pixels: [hdri.width ?? 0, hdri.height ?? 0], download_mib: mib(hdri.size), note: 'An HDR sky ships as it is (the sky reads its full range).' } : undefined;
    if (hdri && (hdri.width ?? 0) > 2048) advice.push(`The HDRI sky is ${hdri.width} pixels wide (${mib(hdri.size)} MiB): a 1k or 2k one looks the same around the scene at a fraction of the download.`);

    // Shadows (review_lighting has each light's detail).
    const lighting = lightingReport(ed);
    advice.push(...(lighting.advice ?? []));
    for (const l of lighting.lights) if (Array.isArray(l.advice)) advice.push(`${l.name}: ${l.advice.join(' ')}`);

    // Instancing: objects repeated often, drawn one by one.
    const candidates = instancingCandidates(doc);
    for (const c of candidates.slice(0, 3)) advice.push(`${c.count} copies of ${c.name} are drawn one by one: put them under a group with instancing (one draw for all of them).`);

    // Effects: what runs every frame.
    const shown = doc.nodes.filter((n) => n.visible);
    const mirrors = shown.filter((n) => n.mirror);
    const emitters = shown.filter((n) => n.particles);
    const fields = shown.filter((n) => n.grass);
    const alive = sum(emitters.map((n) => Math.min(n.particles!.max, Math.ceil(n.particles!.rate * n.particles!.life[1]))));
    const blades = sum(fields.map((n) => n.grass!.count));
    const probes = env.gi.counts[0] * env.gi.counts[1] * env.gi.counts[2];
    const effects = {
        on: [
            env.fxaa && 'anti-aliasing',
            env.bloom.enable && 'bloom',
            env.ao.enable && 'ambient occlusion',
            env.ssr.enable && 'screen space reflections',
            env.fog.enable && `${env.fog.mode} fog`,
            env.godRays.enable && 'god rays',
            env.volumetricFog.enable && 'volumetric fog',
            env.gi.enable && `global illumination (${probes} probes${env.gi.realtime ? ', captured every frame' : ''})`,
            ...doc.renderGraph.posts.filter((p) => p.enabled).map((p) => `post effect ${doc.shaders.find((x) => x.id === p.shader)?.name ?? p.shader}`),
        ].filter(Boolean),
        ...(mirrors.length ? { mirrors: mirrors.map((n) => ({ name: n.name, resolution: n.mirror!.resolution })) } : {}),
        ...(emitters.length ? { particles: { emitters: emitters.length, alive_at_most: alive } } : {}),
        ...(fields.length ? { grass: { fields: fields.length, blades } } : {}),
    };
    if (env.gi.enable && env.gi.realtime) advice.push('Global illumination is captured every frame: turn realtime off unless lights or large objects move in Play (it is captured again after every change).');
    if (env.godRays.enable && env.volumetricFog.enable) advice.push('God rays and volumetric fog both march through the sun\'s shadow map every frame: one of them is usually enough.');
    if (mirrors.length > 2) advice.push(`${mirrors.length} mirrors each draw the scene again every frame: keep the one or two the player sees most.`);
    for (const n of mirrors) if (n.mirror!.resolution > 0.5) advice.push(`Mirror ${n.name} draws at ${n.mirror!.resolution} of the screen size: 0.5 looks nearly the same for far less.`);
    if (alive > 20000) advice.push(`Up to ${alive} particles alive at once: lower the rate, lifetime or max of the largest emitters.`);
    if (blades > 60000) advice.push(`${blades} grass blades: fewer, taller blades (or smaller fields where the player walks) keep the look for less.`);

    // Download: what a build ships for the assets.
    const sizes = await assetSizes(doc);
    const shipped = sum(sizes.map((a) => a.shipped));
    const pending = sizes.filter((a) => a.how === 'pending').length;
    const download = {
        assets_mib: mib(shipped),
        ...(pending ? { waiting_for_compression: pending } : {}),
        largest: sizes.slice(0, 6).map((a) => ({ name: a.name, kind: a.kind, mib: mib(a.shipped), ...(a.how === 'pending' ? { not_compressed_yet: true } : {}) })),
    };
    if (shipped > 100 * MIB) advice.push(`A built game downloads ${mib(shipped)} MiB of assets: start with the largest (sounds as .ogg or .mp3, models and textures compressed and no larger than needed).`);

    return {
        note: `Measured in the editor's view at the ${runtime.qualityLevel} graphics tier while nothing moves (shadow maps redraw only when something moves in them); Play adds scripts, physics and animation. Built games pick a tier per device (phones low: smaller maps, no ambient occlusion or god rays, lower resolution).`,
        frame,
        ...(memory ? { gpu_memory_mib: memory } : {}),
        textures: {
            count: textures.length,
            uncompressed: uncompressed.length,
            larger_than_needed: oversized.length,
            list: rows.slice(0, TEXTURE_ROWS),
            ...(rows.length > TEXTURE_ROWS ? { more: rows.length - TEXTURE_ROWS } : {}),
        },
        ...(sky ? { sky_hdri: sky } : {}),
        shadows: { shadow_lights: lighting.shadow_lights, memory_mib: lighting.shadow_memory_mib, budget: lighting.budget, ...(lighting.frame ? { maps: lighting.frame } : {}) },
        instancing: { groups: doc.nodes.filter((n) => n.instancing).length, ...(candidates.length ? { repeated_outside: candidates.slice(0, 8).map((c) => ({ name: c.name, copies: c.count })) } : {}) },
        effects,
        download,
        advice: advice.length ? advice : ['Nothing stands out: the scene is within its budgets.'],
    };
}

const COMPRESSIONS = ['auto', 'high', 'off'] as const;
const TEXTURE_ROLES: readonly string[] = ['color', 'normal', 'data'];

export const reviewTools = tools({
    review_lighting: {
        groups: ['read', 'lights'],
        description:
            'Review the lights: each light (type, color, intensity, where it is and points), whether it casts shadows and its shadow settings, what its shadow maps take (MiB at each graphics tier), what its shadow reaches (casters in range and how many move in Play) and advice (shadows that reach nothing, a sun whose map misses the level, resolutions and cascades that could drop, update modes that do not fit). Also the totals against the budget (shadow lights, shadow memory) and how the maps were drawn last frame. Use it before placing lights (the level\'s extent and where it is), and after, to check the plan.',
        run({ ed }) {
            const data = lightingReport(ed);
            return { data, summary: `${data.shadow_lights} shadow lights, ${data.shadow_memory_mib.high} MiB` };
        },
    },
    review_performance: {
        groups: ['read'],
        description:
            'Review what the scene costs, for the Finish stage: the frame rate against the budget, the engine\'s CPU time, draws and triangles, the costliest render passes (GPU time where the device can time them), GPU memory by kind, every texture (compressed or not, the size it ships at and the size its surface needs), the HDRI sky, shadow maps (totals and each light\'s advice from review_lighting), objects repeated outside instancing groups, the effects that run every frame (mirrors, particles, grass, GI) and the download size of a built game. Ends with advice on what to change; make the changes with the other tools (set_texture_options for textures) and review again.',
        async run({ ed }) {
            const data = await performanceReport(ed);
            return { data, summary: `${data.frame.fps} fps, ${data.advice.length} to look at` };
        },
    },
    set_texture_options: {
        groups: ['materials', 'effects'],
        description:
            'Set how textures ship in built games (several alike at once): compression auto (KTX2: ETC1S for colors, UASTC for normal and data maps, a quarter of the GPU memory or less), high (UASTC for colors too: sharper, larger download) or off (the file as it is), and max_size, the longest side in pixels a texture ships at (2048 by default; a material slot\'s textures need its tile times the texel density, review_performance says how much). A model\'s id sets the textures inside it. The compressed copies are made now, so the checklist and review_performance see them.',
        params: {
            textures: { type: 'array', items: { type: 'string' }, description: 'Texture (or model) asset ids, e.g. from review_performance.' },
            compression: { type: 'string', enum: [...COMPRESSIONS] },
            max_size: { type: 'integer', enum: [128, 256, 512, 1024, 2048, 4096] },
        },
        required: ['textures'],
        async run({ env, args, ed }) {
            const refs: unknown[] = Array.isArray(args.textures) ? args.textures : [];
            if (!refs.length || refs.length > 64) throw new ToolError('textures: give 1 to 64 asset ids.');
            const mode = args.compression === undefined ? undefined : COMPRESSIONS.find((m) => m === args.compression);
            if (args.compression !== undefined && !mode) throw new ToolError(`compression must be one of ${COMPRESSIONS.join(', ')}.`);
            const maxSize = args.max_size === undefined ? undefined : Math.round(num(args.max_size, 'max_size'));
            if (maxSize !== undefined && (maxSize < 64 || maxSize > 8192 || (maxSize & (maxSize - 1)) !== 0)) throw new ToolError('max_size must be a power of two from 64 to 8192.');
            if (!mode && !maxSize) throw new ToolError('Give compression, max_size or both.');
            const patch: Partial<TextureCompression> = { ...(mode ? { mode } : {}), ...(maxSize ? { maxSize } : {}) };
            const skipped: string[] = [];
            const set: string[] = [];
            for (const ref of refs) {
                const r = typeof ref === 'string' ? ref.trim() : '';
                const meta = ed.store.doc.assets.find((a) => a.id === r) ?? ed.store.doc.assets.find((a) => a.name === r);
                if (!meta || (meta.kind !== 'texture' && meta.kind !== 'model')) skipped.push(`${r}: not a texture or model asset`);
                else if (isHdr(meta)) skipped.push(`${meta.name}: an HDR sky image ships as it is`);
                else if (shipsAsIs(meta)) skipped.push(`${meta.name}: its file is compressed already${meta.width ? ` (${Math.max(meta.width, meta.height ?? 0)} px)` : ''} and ships as it is`);
                else {
                    ed.setTextureCompression(meta.id, patch);
                    set.push(meta.id);
                }
            }
            // The copies for the roles the scene uses them in, made now (a copy made before with the same options is kept).
            const roles = assetRoles(ed.store.doc);
            const results = await Promise.all(
                set.map(async (id) => {
                    const meta = ed.store.doc.assets.find((a) => a.id === id)!;
                    const want = meta.kind === 'model' ? ['model' as const] : [...(roles.get(id) ?? [])].filter((r): r is TextureRole => TEXTURE_ROLES.includes(r));
                    const copies = meta.compress?.mode === 'off' ? [] : await Promise.all(want.map((role) => ed.derived.ensure(meta, role, env.signal).catch((e) => {
                        if (e?.name === 'AbortError') throw e;
                        return null;
                    })));
                    const made = copies.filter((c) => !!c);
                    return {
                        id,
                        name: meta.name,
                        compression: meta.compress?.mode ?? 'auto',
                        max_size: meta.compress?.maxSize ?? 2048,
                        ...(meta.kind === 'texture' && made.length ? { ships_px: Math.max(...made.map((c) => Math.max(c.width, c.height))) } : {}),
                        ...(made.length ? { compressed_kb: Math.round(sum(made.map((c) => c.bytes)) / 1024) } : {}),
                        ...(!want.length ? { note: 'Not used by the scene: its copies are made when something uses it.' } : made.length < want.length && meta.compress?.mode !== 'off' ? { note: 'Some copies could not be made; the file ships for them.' } : {}),
                    };
                }),
            );
            return { data: { textures: results, ...(skipped.length ? { skipped } : {}) }, summary: `${results.length} set` };
        },
    },
});

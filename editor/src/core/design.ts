// The design section of a scene (SceneDoc.design): the planning pipeline's
// data. Defaults and repair of documents from files or older builds live
// here; the stage rules are in design/stages.ts.

import { clamp } from './math';
import { uid } from './ids';
import { Specs } from './model';
import { defaults, finite, hexOr as hex, isObj, list, repair, str } from './schema';
import type {
    AreaDoc, CameraState, CheckItemDoc, ConceptDoc, DesignDoc, DetailLevel, EffectItemDoc, LayoutDoc, MaterialSlotDoc, MoodDoc,
    NodeDoc, PaintoverDoc, ParamValue, PlayDoc, QuestionDoc, RoutePointDoc, SceneDoc, ShotCaptureDoc, ShotDoc, SightlineDoc,
    SnapshotDoc, SpecsDoc, StageDoc, StageId, StageStatus, Vec3,
} from './types';

export const STAGE_IDS: StageId[] = ['brief', 'level', 'light', 'material', 'effects', 'finish'];

export function stageIndex(id: StageId): number {
    return STAGE_IDS.indexOf(id);
}

export const defaultSpecs = (): SpecsDoc => defaults(Specs);

export function defaultMood(): MoodDoc {
    return {
        description: '',
        timeOfDay: '',
        keyLight: { azimuth: 35, elevation: 40, color: '#fff4e0', note: '' },
        palette: [],
    };
}

function defaultStages(): Record<StageId, StageDoc> {
    const out = {} as Record<StageId, StageDoc>;
    for (const id of STAGE_IDS) out[id] = { status: id === 'brief' ? 'active' : 'todo', checks: [] };
    return out;
}

export function defaultDesign(): DesignDoc {
    return {
        version: 1,
        id: uid('p'),
        brief: { text: '' },
        layout: { summary: '', size: null, connections: [] },
        areas: [],
        concepts: [],
        specs: defaultSpecs(),
        mood: defaultMood(),
        play: { route: [], sightlines: [], areaOrder: [], notes: '' },
        effects: [],
        materials: [],
        budget: { shadowLights: 4, fps: 60 },
        questions: [],
        shots: [],
        stage: 'brief',
        stages: defaultStages(),
        snapshots: [],
        memo: { text: '' },
    };
}

/** A new material slot (greybox gray until it gets a swatch). */
export function makeMaterialSlot(name: string): MaterialSlotDoc {
    return { id: uid('m'), name, description: '', swatch: null, color: '#808080', roughness: 0.8, metallic: 0, tile: 2 };
}

// ------------------------------------------------------------------ repair

const clampNum = (v: unknown, d: number, lo: number, hi: number) => clamp(finite(v, d), lo, hi);
const vec = (v: unknown): Vec3 | null =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : null;
const stageId = (v: any): StageId | null => (STAGE_IDS.includes(v) ? v : null);

/** Ids unique within one list; missing or repeated ids get a new one. */
function ids<T extends { id: string }>(items: T[], prefix: string): T[] {
    const seen = new Set<string>();
    for (const it of items) {
        if (!it.id || seen.has(it.id)) it.id = uid(prefix);
        seen.add(it.id);
    }
    return items;
}

function sanitizeCamera(v: any): CameraState {
    const d: CameraState = { target: [0, 0.5, 0], yaw: 35, pitch: 24, distance: 9, fov: 50 };
    if (!isObj(v)) return d;
    return {
        target: vec(v.target) ?? d.target,
        yaw: finite(v.yaw, d.yaw),
        pitch: clampNum(v.pitch, d.pitch, -89.5, 89.5),
        distance: clampNum(v.distance, d.distance, 0.05, 20000),
        fov: clampNum(v.fov, d.fov, 5, 150),
    };
}

function sanitizeParams(v: any): Record<string, ParamValue> | undefined {
    if (!isObj(v)) return undefined;
    const out: Record<string, ParamValue> = {};
    for (const [k, x] of Object.entries(v)) {
        if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
        else if (typeof x === 'string' || typeof x === 'boolean') out[k] = x;
    }
    return out;
}

/**
 * Repairs a design section. `assets` lists the project's asset ids:
 * references to missing images are kept (the image may come with a project
 * file later) but references that are not strings are dropped.
 */
export function sanitizeDesign(input: any): DesignDoc {
    const d = defaultDesign();
    if (!isObj(input)) return d;
    const out = d;
    out.id = str(input.id, '', 64) || d.id;

    const b = isObj(input.brief) ? input.brief : {};
    out.brief = { text: str(b.text, '', 200000) };
    if (b.skipped === true) out.brief.skipped = true;
    if (typeof b.structured === 'string') out.brief.structured = b.structured.slice(0, 200000);
    if (typeof b.structuredAt === 'string') out.brief.structuredAt = b.structuredAt;

    const l = isObj(input.layout) ? input.layout : {};
    out.layout = {
        summary: str(l.summary, '', 8000),
        size: vec(l.size),
        connections: list(l.connections)
            .filter(isObj)
            .map((c) => ({ from: str(c.from, '', 200), to: str(c.to, '', 200), kind: str(c.kind, '', 100) || undefined, note: str(c.note, '', 1000) || undefined }))
            .filter((c) => c.from && c.to),
    } satisfies LayoutDoc;

    out.areas = ids(
        list(input.areas).filter(isObj).map((a): AreaDoc => {
            const area: AreaDoc = {
                id: str(a.id, '', 64),
                name: str(a.name, 'Area', 200) || 'Area',
                description: str(a.description, '', 8000),
                objects: list(a.objects)
                    .filter(isObj)
                    .map((o) => {
                        const obj: AreaDoc['objects'][number] = { name: str(o.name, '', 200) };
                        if (typeof o.count === 'number' && o.count > 0) obj.count = Math.round(o.count);
                        if (typeof o.note === 'string' && o.note) obj.note = o.note.slice(0, 1000);
                        if (o.placed === true) obj.placed = true;
                        return obj;
                    })
                    .filter((o) => o.name),
            };
            if (typeof a.mood === 'string' && a.mood) area.mood = a.mood.slice(0, 4000);
            if (isObj(a.bounds)) {
                const center = vec(a.bounds.center);
                const size = vec(a.bounds.size);
                if (center && size) area.bounds = { center, size: size.map((s) => Math.max(0.1, Math.abs(s))) as Vec3 };
            }
            const rework = stageId(a.rework);
            if (rework) {
                area.rework = rework;
                if (typeof a.reworkNote === 'string') area.reworkNote = a.reworkNote.slice(0, 1000);
            }
            return area;
        }),
        'ar',
    );
    const areaIds = new Set(out.areas.map((a) => a.id));
    const areaRef = (v: any) => (typeof v === 'string' && areaIds.has(v) ? v : null);

    const seenConcepts = new Set<string>();
    out.concepts = list(input.concepts)
        .filter((c) => isObj(c) && typeof c.asset === 'string' && c.asset)
        .filter((c) => !seenConcepts.has(c.asset) && seenConcepts.add(c.asset))
        .map((c): ConceptDoc => ({
            asset: c.asset,
            area: areaRef(c.area),
            ...(typeof c.note === 'string' && c.note ? { note: c.note.slice(0, 2000) } : {}),
            ...(c.review === 'proposed' || c.review === 'approved' ? { review: c.review } : {}),
            ...(typeof c.prompt === 'string' && c.prompt ? { prompt: c.prompt.slice(0, 8000) } : {}),
        }));

    out.specs = repair(Specs, input.specs) ?? defaultSpecs();

    const m = isObj(input.mood) ? input.mood : {};
    const dm = defaultMood();
    const k = isObj(m.keyLight) ? m.keyLight : {};
    out.mood = {
        description: str(m.description, '', 8000),
        timeOfDay: str(m.timeOfDay, '', 200),
        keyLight: {
            azimuth: finite(k.azimuth, dm.keyLight.azimuth),
            elevation: clampNum(k.elevation, dm.keyLight.elevation, -90, 90),
            color: hex(k.color, dm.keyLight.color),
            note: str(k.note, '', 2000),
        },
        palette: list(m.palette).map((c) => hex(c, '')).filter(Boolean).slice(0, 16),
    };

    const p = isObj(input.play) ? input.play : {};
    out.play = {
        route: ids(
            list(p.route).filter(isObj).map((r): RoutePointDoc => {
                const pt: RoutePointDoc = { id: str(r.id, '', 64), name: str(r.name, 'Point', 200) || 'Point' };
                const area = areaRef(r.area);
                if (area) pt.area = area;
                const pos = vec(r.position);
                if (pos) pt.position = pos;
                if (typeof r.note === 'string' && r.note) pt.note = r.note.slice(0, 1000);
                if (r.visited === true) pt.visited = true;
                return pt;
            }),
            'rp',
        ),
        sightlines: ids(
            list(p.sightlines).filter(isObj).map((v): SightlineDoc => {
                const sl: SightlineDoc = { id: str(v.id, '', 64), from: str(v.from, '', 200), to: str(v.to, '', 200) };
                if (typeof v.note === 'string' && v.note) sl.note = v.note.slice(0, 1000);
                if (typeof v.ok === 'boolean') sl.ok = v.ok;
                return sl;
            }),
            'sl',
        ).filter((v) => v.from && v.to),
        areaOrder: list(p.areaOrder).filter((a) => typeof a === 'string' && areaIds.has(a)),
        notes: str(p.notes, '', 8000),
    } satisfies PlayDoc;

    out.effects = ids(
        list(input.effects).filter(isObj).map((e): EffectItemDoc => {
            const item: EffectItemDoc = { id: str(e.id, '', 64), name: str(e.name, '', 200) };
            const area = areaRef(e.area);
            if (area) item.area = area;
            if (typeof e.note === 'string' && e.note) item.note = e.note.slice(0, 1000);
            if (e.done === true) item.done = true;
            return item;
        }),
        'fx',
    ).filter((e) => e.name);

    out.materials = ids(
        list(input.materials).filter(isObj).map((ms): MaterialSlotDoc => ({
            id: str(ms.id, '', 64),
            name: str(ms.name, 'Material', 200) || 'Material',
            description: str(ms.description, '', 4000),
            swatch: typeof ms.swatch === 'string' && ms.swatch ? ms.swatch : null,
            color: hex(ms.color, '#ffffff'),
            roughness: clampNum(ms.roughness, 0.8, 0, 1),
            metallic: clampNum(ms.metallic, 0, 0, 1),
            tile: clampNum(ms.tile, 2, 0.01, 1000),
            ...(ms.flat === true ? { flat: true } : {}),
        })),
        'm',
    );

    const bud = isObj(input.budget) ? input.budget : {};
    out.budget = { shadowLights: Math.round(clampNum(bud.shadowLights, 4, 0, 64)), fps: clampNum(bud.fps, 60, 1, 240) };

    out.questions = ids(
        list(input.questions).filter(isObj).map((q): QuestionDoc => {
            const item: QuestionDoc = { id: str(q.id, '', 64), text: str(q.text, '', 2000), answer: str(q.answer, '', 8000) };
            const area = areaRef(q.area);
            if (area) item.area = area;
            if (typeof q.assumed === 'string' && q.assumed.trim()) item.assumed = q.assumed.slice(0, 2000);
            return item;
        }),
        'q',
    ).filter((q) => q.text);

    out.shots = ids(
        list(input.shots).filter(isObj).map((sh): ShotDoc => {
            const shot: ShotDoc = {
                id: str(sh.id, '', 64),
                name: str(sh.name, 'Shot', 200) || 'Shot',
                area: areaRef(sh.area),
                concept: typeof sh.concept === 'string' && sh.concept ? sh.concept : null,
                camera: sanitizeCamera(sh.camera),
                aspect: clampNum(sh.aspect, 16 / 9, 0.1, 10),
                paintovers: list(sh.paintovers)
                    .filter((po) => isObj(po) && typeof po.asset === 'string' && po.asset)
                    .map((po): PaintoverDoc => {
                        const item: PaintoverDoc = { asset: po.asset, source: po.source === 'upload' ? 'upload' : 'generated', at: str(po.at, '', 64) };
                        if (typeof po.model === 'string') item.model = po.model.slice(0, 200);
                        if (typeof po.prompt === 'string') item.prompt = po.prompt.slice(0, 8000);
                        if (typeof po.seed === 'number' && Number.isFinite(po.seed)) item.seed = po.seed;
                        const refs = list(po.refs).filter((r) => typeof r === 'string');
                        if (refs.length) item.refs = refs;
                        const params = sanitizeParams(po.params);
                        if (params && Object.keys(params).length) item.params = params;
                        if (typeof po.cost === 'number' && Number.isFinite(po.cost)) item.cost = po.cost;
                        return item;
                    }),
                target: typeof sh.target === 'string' && sh.target ? sh.target : null,
                history: list(sh.history)
                    .filter((hc) => isObj(hc) && typeof hc.asset === 'string' && stageId(hc.stage))
                    .map((hc): ShotCaptureDoc => ({
                        stage: hc.stage,
                        asset: hc.asset,
                        at: str(hc.at, '', 64),
                        ...(typeof hc.score === 'number' && Number.isFinite(hc.score) ? { score: hc.score } : {}),
                        ...(hc.manual === true ? { manual: true } : {}),
                        ...(hc.compare === 'gray' || hc.compare === 'color' ? { compare: hc.compare } : {}),
                    })),
            };
            if (sh.stale === true) shot.stale = true;
            if (sh.approved === true) shot.approved = true;
            const matched = [...new Set(list(sh.matched).filter((m): m is StageId => !!stageId(m)))];
            if (matched.length) shot.matched = matched;
            return shot;
        }),
        'sh',
    );

    out.stage = stageId(input.stage) ?? 'brief';
    const stages = isObj(input.stages) ? input.stages : {};
    for (const id of STAGE_IDS) {
        const st = isObj(stages[id]) ? stages[id] : {};
        const status: StageStatus = ['todo', 'active', 'done', 'recheck'].includes(st.status) ? st.status : 'todo';
        const doc: StageDoc = {
            status,
            checks: ids(
                list(st.checks).filter(isObj).map((c): CheckItemDoc => {
                    const item: CheckItemDoc = { id: str(c.id, '', 80), text: str(c.text, '', 1000), done: c.done === true };
                    if (c.by === 'user' || c.by === 'ai') item.by = c.by;
                    if (typeof c.note === 'string' && c.note) item.note = c.note.slice(0, 2000);
                    return item;
                }),
                'ck',
            ),
        };
        if (isObj(st.proposal) && typeof st.proposal.summary === 'string') {
            doc.proposal = { summary: st.proposal.summary.slice(0, 8000), at: str(st.proposal.at, '', 64) };
        }
        if (typeof st.doneAt === 'string') doc.doneAt = st.doneAt;
        if (typeof st.recheck === 'string' && st.recheck) doc.recheck = st.recheck.slice(0, 2000);
        if (typeof st.signature === 'string' && st.signature) doc.signature = st.signature.slice(0, 200);
        out.stages[id] = doc;
    }
    // Exactly the current stage is active (or done, once the last stage is
    // complete); stages before it can't be 'todo'.
    const cur = stageIndex(out.stage);
    STAGE_IDS.forEach((id, i) => {
        const st = out.stages[id];
        if (i === cur) st.status = st.status === 'done' && i === STAGE_IDS.length - 1 ? 'done' : 'active';
        else if (st.status === 'active') st.status = i < cur ? 'done' : 'todo';
        else if (i < cur && st.status === 'todo') st.status = 'done';
    });

    out.snapshots = ids(
        list(input.snapshots)
            .filter((sn) => isObj(sn) && typeof sn.asset === 'string' && sn.asset)
            .map((sn): SnapshotDoc => ({
                id: str(sn.id, '', 64),
                asset: sn.asset,
                name: str(sn.name, 'Version', 200) || 'Version',
                stage: stageId(sn.stage),
                at: str(sn.at, '', 64),
                assets: list(sn.assets).filter((a) => typeof a === 'string'),
                ...(typeof sn.thumb === 'string' && sn.thumb ? { thumb: sn.thumb } : {}),
                ...(sn.auto === true ? { auto: true } : {}),
            })),
        'sn',
    );

    const memo = isObj(input.memo) ? input.memo : {};
    out.memo = { text: str(memo.text, '', 12000) };
    if (typeof memo.at === 'string') out.memo.at = memo.at;
    if (input.detail === 'quick' || input.detail === 'detailed') out.detail = input.detail;
    const check = isObj(input.levelCheck) ? input.levelCheck : null;
    if (check && typeof check.signature === 'string') {
        out.levelCheck = { at: str(check.at, '', 64), ok: check.ok === true, signature: check.signature.slice(0, 200), summary: str(check.summary, '', 2000) };
    }
    return out;
}

// ----------------------------------------------------------------- queries

/** Every asset id the design section refers to (images, snapshots and what the snapshots use). */
export function designAssetIds(design: DesignDoc): Set<string> {
    const out = new Set<string>();
    for (const c of design.concepts) out.add(c.asset);
    for (const s of design.shots) {
        if (s.concept) out.add(s.concept);
        if (s.target) out.add(s.target);
        for (const p of s.paintovers) {
            out.add(p.asset);
            for (const r of p.refs ?? []) out.add(r);
        }
        for (const h of s.history) out.add(h.asset);
    }
    for (const m of design.materials) if (m.swatch) out.add(m.swatch);
    for (const sn of design.snapshots) {
        out.add(sn.asset);
        if (sn.thumb) out.add(sn.thumb);
        for (const a of sn.assets) out.add(a);
    }
    return out;
}

/**
 * The pipeline has started: there is a brief, a reference image or a
 * planned area (or it went past the Brief stage). Until then the Brief stage
 * is only where a project begins, and the first request of the user that
 * describes a scene becomes its brief.
 */
export function planStarted(design: DesignDoc): boolean {
    return design.stage !== 'brief' || !!design.brief.text.trim() || design.concepts.length > 0 || design.areas.length > 0;
}

/** The detail level in effect: the assistant decides the details unless the user asked to work them out together. */
export function detailLevel(design: DesignDoc): DetailLevel {
    return design.detail === 'detailed' ? 'detailed' : 'quick';
}

/** Objects that make up the level: everything but lights, cameras, effects (particles, grass) and the player, which may move without changing it. */
export function isLevelObject(n: NodeDoc): boolean {
    return !n.light && !n.camera && !n.particles && !n.grass && !n.player;
}

/**
 * A signature of the layout: where the level's objects are and what they
 * are, leaving out lights, cameras, effects and the player. When it changes
 * after the Layout step was done, that step is marked for a recheck. Hashed
 * field by field (no JSON): views ask for it after changes, on scenes of
 * thousands of objects.
 */
export function layoutSignature(doc: SceneDoc): string {
    let h = 5381;
    let count = 0;
    const text = (s: string) => {
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        h = ((h * 33) ^ 0x7c) >>> 0;
    };
    // To a tenth of a millimeter (or degree, or percent of scale).
    const num = (v: number) => {
        h = ((h * 33) ^ Math.round(v * 1e4)) >>> 0;
    };
    for (const n of doc.nodes) {
        if (!isLevelObject(n)) continue;
        count++;
        text(n.id);
        text(n.parent ?? '');
        num(n.visible ? 1 : 0);
        for (const v of n.position) num(v);
        for (const v of n.rotation) num(v);
        for (const v of n.scale) num(v);
        const g = n.mesh?.geometry as Record<string, unknown> | undefined;
        if (g) {
            for (const k in g) {
                const v = g[k];
                text(k);
                if (typeof v === 'number') num(v);
                else text(String(v));
            }
        }
        if (n.model) {
            text(n.model.asset);
            if (n.model.parts) text(JSON.stringify(n.model.parts));
        }
        if (n.prefab) text(n.prefab);
    }
    return `L${count}:${h.toString(36)}`;
}

/** A signature of the level's geometry: when it changes, a level check is stale. */
export function levelSignature(doc: SceneDoc): string {
    let h = 5381;
    const text = JSON.stringify(doc.nodes.map((n) => [n.id, n.parent, n.visible, n.position, n.rotation, n.scale, n.mesh?.geometry ?? null, n.model?.asset ?? null, n.model?.parts ?? null]));
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return `${doc.nodes.length}:${h.toString(36)}`;
}

export function areaName(design: DesignDoc, id: string | null | undefined): string {
    if (!id) return '';
    return design.areas.find((a) => a.id === id)?.name ?? id;
}

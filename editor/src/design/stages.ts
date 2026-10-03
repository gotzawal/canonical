// The pipeline's stages: what each one is for, the tools it is about, and
// the checklist that has to be done before moving on. Automatic items are
// computed from the document; the others are ticked by the assistant or the
// user. The assistant runs the stages; the user sees them as three steps
// (STEPS): layout, look and finish.

import { detailLevel, layoutSignature, levelSignature, planStarted, STAGE_IDS, stageIndex } from '../core/design';
import { hasColorGrade } from '../core/templates';
import type { CheckItemDoc, DesignDoc, NodeDoc, SceneDoc, StageId, StepId } from '../core/types';

/** Groups of assistant tools; each stage is about some of them (see ai/registry.ts). */
export type ToolGroup =
    | 'read'
    | 'design'
    | 'objects'
    | 'prefabs'
    | 'shots'
    | 'capture'
    | 'images'
    | 'concepts'
    | 'lights'
    | 'environment'
    | 'compare'
    | 'materials'
    | 'effects'
    | 'audio'
    | 'code'
    | 'play';

export const ALL_TOOL_GROUPS: ToolGroup[] = [
    'read', 'design', 'objects', 'prefabs', 'shots', 'capture', 'images', 'concepts', 'lights', 'environment', 'compare', 'materials', 'effects', 'audio', 'code', 'play',
];

export interface CheckResult {
    done: boolean;
    /** Short measurement, e.g. "3 of 5 placed". */
    detail?: string;
}

export interface CheckContext {
    doc: SceneDoc;
    design: DesignDoc;
    /** Frames per second measured in the editor, for the performance item. */
    fps?: number;
    /** The viewport's frame rate limit (0 or missing: none), which caps what `fps` can show. */
    fpsLimit?: number;
    /** GPU memory the scene's shadow maps take at the high tier, bytes (engine/shadows.ts); missing: not measured. */
    shadowBytes?: number;
    /** Textures the scene draws, how many have no compressed copy, and how many are larger than they need (their surface's tile times the texel density, or 2048). */
    textures?: { total: number; uncompressed: number; oversized: number };
}

const MIB = 1048576;
const mib = (bytes: number) => (bytes >= 10 * MIB ? Math.round(bytes / MIB) : Math.round((bytes / MIB) * 10) / 10);

/** The shadow maps are within the memory budget (measured by the editor). */
function shadowMemoryCheck({ design, shadowBytes }: CheckContext): CheckResult {
    if (shadowBytes === undefined) return { done: false, detail: 'not measured' };
    return { done: shadowBytes <= design.budget.shadowMemory * MIB, detail: `${mib(shadowBytes)} of ${design.budget.shadowMemory} MiB at the high tier` };
}

/** Copies an instancing group would draw together: at least this many of one shape and material, or of one model. */
export const INSTANCING_MIN = 10;

/**
 * Objects repeated often outside instancing groups: the same primitive
 * shape and material, or the same model asset (without part overrides),
 * shown, not under an instancing group, not a prefab's generated part.
 * Largest first.
 */
export function instancingCandidates(doc: SceneDoc, min = INSTANCING_MIN): { name: string; count: number; key: string }[] {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const grouped = (n: NodeDoc) => {
        for (let p = n.parent ? byId.get(n.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) if (p.instancing) return true;
        return false;
    };
    const groups = new Map<string, { name: string; count: number }>();
    for (const n of doc.nodes) {
        if (!n.visible || n.prefabChild || n.mirror || n.grass || grouped(n)) continue;
        const key = n.mesh ? 'mesh:' + JSON.stringify(n.mesh.geometry) + JSON.stringify(n.mesh.material) : n.model && !n.model.parts && !n.model.materials ? 'model:' + n.model.asset : '';
        if (!key) continue;
        const g = groups.get(key) ?? { name: n.name.replace(/[\s_-]*\d+$/, '') || n.name, count: 0 };
        g.count++;
        groups.set(key, g);
    }
    return Array.from(groups, ([key, g]) => ({ key, ...g })).filter((g) => g.count >= min).sort((a, b) => b.count - a.count);
}

export interface CheckDef {
    id: string;
    text: string;
    /** Computed items; items without it are ticked by hand. */
    auto?: (ctx: CheckContext) => CheckResult;
    /** Only the user can tick it (the assistant can only propose). */
    userOnly?: boolean;
    hint?: string;
}

export interface StageDef {
    id: StageId;
    title: string;
    /** Longer name shown in the stage header. */
    long: string;
    description: string;
    /** The tool groups of its work (they limit the assistant only when the AI settings say so). */
    tools: ToolGroup[];
    checks: CheckDef[];
    /** How shots are compared with their targets in this stage (lightness only, or color). */
    compare?: 'gray' | 'color';
    /** What marking a shot as matching means in this stage. */
    matchLabel?: string;
}

export interface CheckState {
    id: string;
    text: string;
    done: boolean;
    auto: boolean;
    custom: boolean;
    userOnly: boolean;
    detail?: string;
    note?: string;
    by?: 'user' | 'ai';
    hint?: string;
}

/** A name to match objects by: words in lower case, without the number of a copy ("Bench (2)" is a bench). */
const baseName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/ \d+$/, '');

/**
 * Objects of the brief that are placed: ticked, or as many shown scene
 * objects as it asks for carry its name. Each scene object counts once.
 */
export function placedObjects(doc: SceneDoc, design: DesignDoc): { total: number; placed: number } {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const shown = (n: NodeDoc | undefined): boolean => !n || (n.visible && shown(byId.get(n.parent ?? '')));
    const left = new Map<string, number>();
    for (const n of doc.nodes) {
        const key = baseName(n.name);
        if (shown(n)) left.set(key, (left.get(key) ?? 0) + 1);
    }
    let total = 0;
    let placed = 0;
    for (const area of design.areas) {
        for (const o of area.objects) {
            total++;
            const key = baseName(o.name);
            const want = Math.max(1, o.count ?? 1);
            const have = left.get(key) ?? 0;
            if (o.placed) placed++;
            else if (key && have >= want) {
                placed++;
                left.set(key, have - want);
            }
        }
    }
    return { total, placed };
}

export function shadowLights(doc: SceneDoc): number {
    return doc.nodes.filter((n) => n.light?.castShadow && n.visible).length;
}

const count = (done: number, total: number, noun: string) => `${done} of ${total} ${noun}`;

/** Every shot was marked as matching its target in `stage` (see Pipeline.markMatched). */
function shotsMatched(stage: StageId) {
    return ({ design }: CheckContext): CheckResult => {
        const shots = design.shots;
        if (!shots.length) return { done: false, detail: 'no shots' };
        const ok = shots.filter((s) => s.target && s.matched?.includes(stage)).length;
        const noTarget = shots.filter((s) => !s.target).length;
        return { done: ok === shots.length, detail: count(ok, shots.length, 'shots') + (noTarget ? `, ${noTarget} without a target` : '') };
    };
}

export const STAGES: StageDef[] = [
    {
        id: 'brief',
        title: 'Brief',
        long: 'Planning input',
        description:
            'What to make, in the user\'s words, with any planning document and reference images. The assistant decides how the scene is built (layout, size, how the areas connect), then structures the areas, specs, mood and play requirements. What the plan leaves open it decides, or asks about when you want to work out the details. It can draw reference images for you to look at.',
        tools: ['read', 'design', 'concepts'],
        checks: [
            {
                id: 'brief.layout',
                text: 'How the scene is built is decided (layout, size, connections)',
                auto: ({ design }) => ({ done: !!design.layout.summary.trim() }),
            },
            {
                id: 'brief.areas',
                text: 'Areas are listed',
                auto: ({ design }) => ({ done: design.areas.length > 0, detail: `${design.areas.length} area${design.areas.length === 1 ? '' : 's'}` }),
            },
            {
                id: 'brief.concepts',
                text: 'Every area has at least one reference image',
                auto: ({ design }) => {
                    const ok = design.areas.filter((a) => design.concepts.some((c) => c.area === a.id)).length;
                    return { done: design.areas.length > 0 && ok === design.areas.length, detail: count(ok, design.areas.length, 'areas') };
                },
            },
            {
                id: 'brief.mood',
                text: 'Every area has a mood',
                auto: ({ design }) => {
                    const global = !!design.mood.description.trim();
                    const ok = design.areas.filter((a) => global || !!a.mood?.trim()).length;
                    return { done: design.areas.length > 0 && ok === design.areas.length, detail: count(ok, design.areas.length, 'areas') };
                },
            },
            {
                id: 'brief.objects',
                text: 'Every area has its object list',
                auto: ({ design }) => {
                    const ok = design.areas.filter((a) => a.objects.length > 0).length;
                    return { done: design.areas.length > 0 && ok === design.areas.length, detail: count(ok, design.areas.length, 'areas') };
                },
            },
            {
                id: 'brief.questions',
                text: 'Open questions are answered (or go ahead with the assistant\'s assumption)',
                auto: ({ design }) => {
                    const waiting = design.questions.filter((q) => !q.answer.trim());
                    const open = waiting.filter((q) => !q.assumed?.trim()).length;
                    const assumed = waiting.length - open;
                    const detail = [open ? `${open} open` : '', assumed ? `${assumed} going with an assumption` : ''].filter(Boolean).join(', ');
                    return { done: open === 0, detail: detail || undefined };
                },
            },
            {
                id: 'brief.review',
                text: 'Reference images the assistant drew are reviewed',
                auto: ({ design }) => {
                    const proposed = design.concepts.filter((c) => c.review === 'proposed').length;
                    // Letting the assistant decide, the user reviews them when they like.
                    return { done: !proposed || detailLevel(design) === 'quick', detail: proposed ? `${proposed} waiting for review` : undefined };
                },
                hint: 'Keep or drop them in the chat, where they were drawn, or in the Design tab (Brief & Reference Images).',
            },
        ],
    },
    {
        id: 'level',
        title: 'Level',
        long: 'Level (greybox)',
        description:
            'Block out the level in one mid gray material: buildings and rooms closed by construction, primitives and prefabs, ramps and stairs, and the player to walk it in Play. The level check makes sure buildings are closed, the route is walkable and nothing floats. Many copies of one thing (trees, rocks, fence posts) go under one group with Instancing, so they draw together. An outdoor level stands on a terrain, sculpted with building sites and paths, with trees and large rocks scattered over it by rules. Frame a shot for every reference image, walk the route at eye height, then paint a reference image over each shot: the chosen one is what the look is compared with.',
        tools: ['read', 'design', 'objects', 'prefabs', 'shots', 'capture', 'images', 'concepts'],
        checks: [
            {
                id: 'level.objects',
                text: 'Every listed object is placed',
                auto: ({ doc, design }) => {
                    const { total, placed } = placedObjects(doc, design);
                    return { done: placed === total, detail: total ? count(placed, total, 'placed') : 'no object list' };
                },
            },
            {
                id: 'level.shots',
                text: 'Every reference image has a shot',
                auto: ({ design }) => {
                    const ok = design.concepts.filter((c) => design.shots.some((s) => s.concept === c.asset)).length;
                    return { done: ok === design.concepts.length && design.shots.length > 0, detail: count(ok, design.concepts.length, 'reference images') };
                },
            },
            {
                id: 'level.route',
                text: 'The route was walked at eye height',
                auto: ({ design }) => {
                    const r = design.play.route;
                    const ok = r.filter((p) => p.visited).length;
                    return { done: ok === r.length, detail: r.length ? count(ok, r.length, 'points') : 'no route' };
                },
                hint: 'Walk it with the walk camera (points are ticked as you pass them), or let the assistant walk it with the player\'s body (walk_route).',
            },
            {
                id: 'level.sightlines',
                text: 'Landmark sight lines are clear',
                auto: ({ design }) => {
                    const v = design.play.sightlines;
                    const ok = v.filter((s) => s.ok === true).length;
                    return { done: ok === v.length, detail: v.length ? count(ok, v.length, 'clear') : 'none listed' };
                },
                hint: 'Mark them in the Design tab, or let the assistant check them from eye height (check_sightline).',
            },
            {
                id: 'level.closed',
                text: 'The level check passes: buildings closed, route walkable, nothing floating',
                auto: ({ doc, design }) => {
                    const c = design.levelCheck;
                    if (!c) return { done: false, detail: 'not checked yet' };
                    if (c.signature !== levelSignature(doc)) return { done: false, detail: 'the level changed since the last check' };
                    return { done: c.ok, detail: c.summary };
                },
                hint: 'Check the level in the Design tab, or let the assistant run check_level.',
            },
            { id: 'level.play', text: 'Play check passed (scale, paths, heights)', hint: 'Walk it in Play, or let the assistant walk the route with the player\'s body (walk_route) and tick it.' },
            {
                id: 'level.paintovers',
                text: 'Every shot has a chosen reference image, painted over the greybox',
                auto: ({ design }) => {
                    const ok = design.shots.filter((s) => s.target && !s.stale).length;
                    return { done: design.shots.length > 0 && ok === design.shots.length, detail: count(ok, design.shots.length, 'shots') };
                },
            },
        ],
    },
    {
        id: 'light',
        title: 'Lighting',
        long: 'Lighting, pass 1',
        description:
            'Every surface is still gray, so only light is judged. Plan the key, fill and practical lights, then set the time of day (the sun) and the sky\'s brightness, the lights, exposure, shadows (each light its own: its size, when it is drawn again and, for the sun, one map, one around the camera or cascades for large outdoor levels) and GI. Compare each shot with its reference image in grayscale.',
        compare: 'gray',
        matchLabel: 'Values match the target',
        tools: ['read', 'design', 'lights', 'environment', 'capture', 'compare'],
        checks: [
            {
                id: 'light.values',
                text: 'Every shot matches its reference image in grayscale (value structure)',
                hint: 'Compare each shot in the shot bar and mark it; the score is only a reference, judge by eye.',
                auto: shotsMatched('light'),
            },
            { id: 'light.exposure', text: 'Exposure is settled' },
            {
                id: 'light.shadows',
                text: 'Shadow-casting lights are within the budget',
                auto: ({ doc, design }) => {
                    const n = shadowLights(doc);
                    return { done: n <= design.budget.shadowLights, detail: `${n} of ${design.budget.shadowLights}` };
                },
            },
            {
                id: 'light.plan',
                text: 'Each shadow earns its cost: its resolution, redraws and coverage fit the light\'s role',
                hint: 'review_lighting shows what each light\'s shadow reaches and takes, with advice.',
            },
            {
                id: 'light.shadowMemory',
                text: 'Shadow maps are within the memory budget',
                hint: 'Lower resolutions, fewer cascades or fewer shadow-casting lights bring it down (review_lighting).',
                auto: shadowMemoryCheck,
            },
        ],
    },
    {
        id: 'material',
        title: 'Materials',
        long: 'Materials and lighting, pass 2',
        description:
            'Fill every material slot with a swatch: search the shared library first and generate one only when nothing fits. Swatches are applied in world space (triplanar) with one roughness and metallic value per material. Give terrains their layers (by height and slope, or painted) and scatter small decoration over them, cover the ground with grass, and make water and mirrors (a Mirror component, the Water shader). Then correct light intensities and exposure for the new albedo.',
        compare: 'color',
        matchLabel: 'Colors match the target',
        tools: ['read', 'design', 'materials', 'lights', 'environment', 'capture', 'compare', 'images'],
        checks: [
            {
                id: 'material.slots',
                text: 'Every material slot is filled (a swatch, or meant as a plain color)',
                auto: ({ design }) => {
                    const m = design.materials;
                    const ok = m.filter((s) => !!s.swatch || s.flat).length;
                    return { done: m.length > 0 && ok === m.length, detail: m.length ? count(ok, m.length, 'slots') : 'no slots yet' };
                },
            },
            {
                id: 'material.terrain',
                text: 'Every terrain has its surface layers',
                auto: ({ doc }) => {
                    const lands = doc.nodes.filter((n) => n.terrain);
                    const bare = lands.filter((n) => !n.terrain!.layers.some((l) => l.slot || l.albedo));
                    return { done: !bare.length, detail: lands.length ? (bare.length ? `${bare.map((n) => n.name).slice(0, 3).join(', ')} without` : undefined) : 'no terrains' };
                },
                hint: 'In the terrain\'s inspector, add layers from the material slots (the first covers everything).',
            },
            {
                id: 'material.colors',
                text: 'Every shot matches its reference image in color',
                hint: 'Compare each shot in color in the shot bar and mark it.',
                auto: shotsMatched('material'),
            },
            { id: 'material.light2', text: 'Lighting pass 2 done (intensities and exposure)' },
        ],
    },
    {
        id: 'effects',
        title: 'Effects',
        long: 'Effects',
        description:
            'The sky\'s physical model (single scattering, or multiple scattering for deep sunsets, dusk and clouds), particles and post effects (fog, bloom, screen space reflections, vignette). Compare the shots with their reference images again, also in grayscale so the effects keep the value structure.',
        compare: 'gray',
        matchLabel: 'Value structure still holds',
        tools: ['read', 'design', 'effects', 'audio', 'environment', 'lights', 'code', 'play', 'capture', 'compare'],
        checks: [
            {
                id: 'effects.list',
                text: 'Every effect from the brief is done',
                auto: ({ design }) => {
                    const e = design.effects;
                    const ok = e.filter((x) => x.done).length;
                    return { done: ok === e.length, detail: e.length ? count(ok, e.length, 'effects') : 'none listed' };
                },
            },
            {
                id: 'effects.values',
                text: 'The grayscale comparison still holds',
                hint: 'Compare each shot in grayscale again and mark it.',
                auto: shotsMatched('effects'),
            },
            {
                id: 'effects.sky',
                text: 'The sky model suits the mood (single or multiple scattering, clouds)',
                hint: 'Scene tab > Sky Model: multiple scattering for sunsets, dusk and clouds. A solid color sky (interiors) needs no model.',
            },
            { id: 'effects.perf', text: 'Within the performance budget', hint: 'Check the frame rate in the status bar against the budget; the Profiler tab shows what a frame costs.' },
        ],
    },
    {
        id: 'finish',
        title: 'Finish',
        long: 'Finish',
        description: 'Final lighting pass and polish, then color grading (lift, gamma, gain and saturation as a post effect), and a review of what the scene costs: frame rate, shadow maps, textures, instancing, draws, effects and download size. Compare every shot with its reference image one last time and approve it.',
        compare: 'color',
        tools: [...ALL_TOOL_GROUPS],
        checks: [
            { id: 'finish.light', text: 'Final lighting pass and polish' },
            {
                id: 'finish.fps',
                text: 'The frame rate is within the budget',
                hint: 'Measured in the editor\'s viewport; the Profiler tab shows what a frame costs.',
                auto: ({ fps, fpsLimit, design }) => {
                    if (!fps) return { done: false, detail: 'not measured' };
                    const limited = !!fpsLimit && fpsLimit < design.budget.fps;
                    if (limited) return { done: false, detail: `the viewport is limited to ${fpsLimit} fps (View > Viewport Frame Rate), budget ${design.budget.fps}` };
                    return { done: fps >= design.budget.fps * 0.95, detail: `${Math.round(fps)} of ${design.budget.fps} fps` };
                },
            },
            { id: 'finish.shadowMemory', text: 'Shadow maps are within the memory budget', auto: shadowMemoryCheck },
            {
                id: 'finish.textures',
                text: 'Every texture is compressed and no larger than it needs to be',
                hint: 'review_performance lists them; set_texture_options compresses one or caps its size.',
                auto: ({ textures }) => {
                    if (!textures) return { done: false, detail: 'not measured' };
                    const { total, uncompressed, oversized } = textures;
                    const left = [uncompressed ? `${uncompressed} not compressed` : '', oversized ? `${oversized} larger than needed` : ''].filter(Boolean);
                    return { done: !uncompressed && !oversized, detail: total ? (left.join(', ') || `${total} compressed`) : 'no textures' };
                },
            },
            {
                id: 'finish.instancing',
                text: 'Objects repeated many times are drawn instanced',
                hint: `Put ${INSTANCING_MIN} or more copies of one shape and material (or one model) under a group with instancing.`,
                auto: ({ doc }) => {
                    const c = instancingCandidates(doc);
                    return { done: !c.length, detail: c.length ? c.slice(0, 3).map((g) => `${g.count} ${g.name}`).join(', ') + ' outside instancing' : undefined };
                },
            },
            {
                id: 'finish.review',
                text: 'Optimization review done: shadows, textures, draws, effects and download size',
                hint: 'review_performance measures them all and says what to change; tick it with a note on what you changed.',
            },
            {
                id: 'finish.grade',
                text: 'Color grading is set up',
                auto: ({ doc }) => ({ done: hasColorGrade(doc) }),
            },
            {
                id: 'finish.shots',
                text: 'Every shot was compared with its reference image and approved',
                auto: ({ design }) => {
                    const ok = design.shots.filter((s) => s.approved).length;
                    return { done: ok === design.shots.length, detail: design.shots.length ? count(ok, design.shots.length, 'approved') : 'no shots' };
                },
            },
        ],
    },
];

export function stageDef(id: StageId): StageDef {
    return STAGES[stageIndex(id)] ?? STAGES[0];
}

/** The checklist of a stage with every item's current state. */
export function evaluateStage(ctx: CheckContext, id: StageId): CheckState[] {
    const def = stageDef(id);
    const stored = new Map<string, CheckItemDoc>(ctx.design.stages[id].checks.map((c) => [c.id, c]));
    const out: CheckState[] = [];
    for (const c of def.checks) {
        const s = stored.get(c.id);
        if (c.auto) {
            const r = c.auto(ctx);
            out.push({ id: c.id, text: c.text, done: r.done, auto: true, custom: false, userOnly: !!c.userOnly, detail: r.detail, note: s?.note, hint: c.hint });
        } else {
            let detail: string | undefined;
            if (c.id === 'effects.perf' && ctx.fps) {
                const limited = ctx.fpsLimit && ctx.fpsLimit < ctx.design.budget.fps;
                detail = limited
                    ? `${Math.round(ctx.fps)} fps now, but the viewport is limited to ${ctx.fpsLimit} (View > Viewport Frame Rate), budget ${ctx.design.budget.fps}`
                    : `${Math.round(ctx.fps)} fps now, budget ${ctx.design.budget.fps}`;
            }
            out.push({ id: c.id, text: c.text, done: !!s?.done, auto: false, custom: false, userOnly: !!c.userOnly, detail, note: s?.note, by: s?.by, hint: c.hint });
        }
    }
    // Areas the brief changed after they were built have to be redone first.
    const rework = ctx.design.areas.filter((a) => a.rework && stageIndex(a.rework) <= stageIndex(id));
    if (rework.length && ctx.design.stage === id) {
        out.push({
            id: 'rework',
            text: 'Areas changed in the brief are reworked',
            done: false,
            auto: true,
            custom: false,
            userOnly: false,
            detail: rework.map((a) => `${a.name} from ${stageDef(a.rework!).title}`).join(', '),
        });
    }
    // Items the user or the assistant added.
    const known = new Set(def.checks.map((c) => c.id));
    for (const s of ctx.design.stages[id].checks) {
        if (known.has(s.id) || !s.text) continue;
        out.push({ id: s.id, text: s.text, done: s.done, auto: false, custom: true, userOnly: false, note: s.note, by: s.by });
    }
    return out;
}

export function stageProgress(ctx: CheckContext, id: StageId): { done: number; total: number; open: CheckState[]; items: CheckState[] } {
    const items = evaluateStage(ctx, id);
    const open = items.filter((i) => !i.done);
    return { done: items.length - open.length, total: items.length, open, items };
}

export function nextStage(id: StageId): StageId | null {
    const i = stageIndex(id);
    return i >= 0 && i + 1 < STAGE_IDS.length ? STAGE_IDS[i + 1] : null;
}

// ------------------------------------------------------------------ steps

/** The steps the user sees: the stages the assistant runs, in three parts. */
export interface StepDef {
    id: StepId;
    title: string;
    /** What the step makes, in a line. */
    hint: string;
    stages: StageId[];
}

export const STEPS: StepDef[] = [
    { id: 'layout', title: 'Layout', hint: 'The plan and the greybox: what goes where, at the right size', stages: ['brief', 'level'] },
    { id: 'look', title: 'Look', hint: 'Light, materials and effects', stages: ['light', 'material', 'effects'] },
    { id: 'finish', title: 'Finish', hint: 'A last lighting pass and the color grade', stages: ['finish'] },
];

export function stepOf(stage: StageId): StepDef {
    return STEPS.find((s) => s.stages.includes(stage)) ?? STEPS[0];
}

export type StepState = 'todo' | 'current' | 'done';

export interface StepProgress {
    step: StepDef;
    state: StepState;
    /** Why it needs another look: a stage of it to recheck, or the layout changed after it was done. */
    recheck?: string;
}

/**
 * Where the three steps stand. Before the pipeline starts every step is to
 * do; the current stage's step is current; once the last stage is complete
 * every step is done. `changed`: layoutChanged, when the caller has it.
 */
export function stepsProgress(doc: SceneDoc, design: DesignDoc = doc.design, changed = layoutChanged(doc, design)): StepProgress[] {
    const started = planStarted(design);
    const cur = stageIndex(design.stage);
    const allDone = design.stages[design.stage].status === 'done' && cur === STAGE_IDS.length - 1;
    return STEPS.map((step) => {
        const first = stageIndex(step.stages[0]);
        const last = stageIndex(step.stages[step.stages.length - 1]);
        const state: StepState = !started ? 'todo' : allDone || cur > last ? 'done' : cur >= first ? 'current' : 'todo';
        const rechecks = step.stages.filter((id) => design.stages[id].status === 'recheck' && design.stages[id].recheck).map((id) => design.stages[id].recheck!);
        if (step.id === 'layout' && changed) rechecks.unshift('The layout changed after it was done');
        return { step, state, ...(rechecks.length ? { recheck: rechecks.join('; ') } : {}) };
    });
}

/**
 * The level changed after the Level stage was done (the layout signature
 * it was completed with, or its level check last passed with, differs).
 * Nothing is refused for it: the stage is marked for a recheck until the
 * level check passes again.
 */
export function layoutChanged(doc: SceneDoc, design: DesignDoc = doc.design): boolean {
    const st = design.stages.level;
    return stageIndex(design.stage) > stageIndex('level') && !!st.signature && st.signature !== layoutSignature(doc);
}

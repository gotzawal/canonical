// The pipeline's stages: what each one is for, what the assistant may do in
// it, and the checklist that has to be done before moving on. Automatic
// items are computed from the document; the others are ticked by the user
// or proposed by the assistant.

import { STAGE_IDS, stageIndex } from '../core/design';
import type { CheckItemDoc, DesignDoc, SceneDoc, StageId } from '../core/types';

/** Groups of assistant tools; each stage allows some of them (see ai/tools.ts). */
export type ToolGroup =
    | 'read'
    | 'design'
    | 'objects'
    | 'prefabs'
    | 'shots'
    | 'capture'
    | 'images'
    | 'lights'
    | 'environment'
    | 'compare'
    | 'materials'
    | 'effects'
    | 'code'
    | 'play';

export const ALL_TOOL_GROUPS: ToolGroup[] = [
    'read', 'design', 'objects', 'prefabs', 'shots', 'capture', 'images', 'lights', 'environment', 'compare', 'materials', 'effects', 'code', 'play',
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
    /** Objects other than lights, cameras and effects stay where they are. */
    locksPlacement: boolean;
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

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Objects of the brief that are placed: ticked, or a scene object carries their name. */
export function placedObjects(doc: SceneDoc, design: DesignDoc): { total: number; placed: number } {
    const names = doc.nodes.map((n) => norm(n.name));
    let total = 0;
    let placed = 0;
    for (const area of design.areas) {
        for (const o of area.objects) {
            total++;
            const key = norm(o.name);
            if (o.placed || (key && names.some((n) => n === key || n.startsWith(key + ' ') || n.includes(key)))) placed++;
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
            'Give the planning document and concept images. The assistant decides how the scene is built (layout, size, how the areas connect), then structures the areas, specs, mood and play requirements and asks about anything missing.',
        locksPlacement: false,
        tools: ['read', 'design'],
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
                text: 'Every area has at least one concept image',
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
                text: 'Open questions are answered',
                auto: ({ design }) => {
                    const open = design.questions.filter((q) => !q.answer.trim()).length;
                    return { done: open === 0, detail: open ? `${open} open` : undefined };
                },
            },
        ],
    },
    {
        id: 'level',
        title: 'Level',
        long: 'Level (greybox)',
        description:
            'Block out the level in one mid gray material with primitives and prefabs, ramps, stairs and a player capsule for scale. Frame a shot for every concept, walk the route at eye height, then make a paintover per shot: the chosen one becomes the target image.',
        locksPlacement: false,
        tools: ['read', 'design', 'objects', 'prefabs', 'shots', 'capture', 'images'],
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
                text: 'Every concept has a shot',
                auto: ({ design }) => {
                    const ok = design.concepts.filter((c) => design.shots.some((s) => s.concept === c.asset)).length;
                    return { done: ok === design.concepts.length && design.shots.length > 0, detail: count(ok, design.concepts.length, 'concepts') };
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
                hint: 'Use the walk camera: points are ticked when you pass them.',
            },
            {
                id: 'level.sightlines',
                text: 'Landmark sight lines are clear',
                auto: ({ design }) => {
                    const v = design.play.sightlines;
                    const ok = v.filter((s) => s.ok === true).length;
                    return { done: ok === v.length, detail: v.length ? count(ok, v.length, 'clear') : 'none listed' };
                },
            },
            { id: 'level.play', text: 'Play check passed (scale, paths, heights)' },
            {
                id: 'level.paintovers',
                text: 'Every shot has a chosen paintover',
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
            'Placement is locked and every surface is gray, so only light is judged. Set the sky and time of day, key and fill lights, interior lights, exposure and GI. Compare each shot with its paintover in grayscale.',
        locksPlacement: true,
        compare: 'gray',
        matchLabel: 'Values match the target',
        tools: ['read', 'design', 'lights', 'environment', 'capture', 'compare'],
        checks: [
            {
                id: 'light.values',
                text: 'Every shot matches its paintover in grayscale (value structure)',
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
        ],
    },
    {
        id: 'material',
        title: 'Materials',
        long: 'Materials and lighting, pass 2',
        description:
            'Fill every material slot with a swatch: search the shared library first and generate one only when nothing fits. Swatches are applied in world space (triplanar) with one roughness and metallic value per material. Then correct light intensities and exposure for the new albedo.',
        locksPlacement: true,
        compare: 'color',
        matchLabel: 'Colors match the target',
        tools: ['read', 'design', 'materials', 'lights', 'environment', 'capture', 'compare', 'images'],
        checks: [
            {
                id: 'material.slots',
                text: 'Every material slot has a swatch',
                auto: ({ design }) => {
                    const m = design.materials;
                    const ok = m.filter((s) => !!s.swatch).length;
                    return { done: m.length > 0 && ok === m.length, detail: m.length ? count(ok, m.length, 'slots') : 'no slots yet' };
                },
            },
            {
                id: 'material.colors',
                text: 'Every shot matches its paintover in color',
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
        description: 'Particles and post effects (fog, bloom, vignette). Compare the shots with their paintovers again, also in grayscale so the effects keep the value structure.',
        locksPlacement: true,
        compare: 'gray',
        matchLabel: 'Value structure still holds',
        tools: ['read', 'design', 'effects', 'environment', 'lights', 'code', 'play', 'capture', 'compare'],
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
            { id: 'effects.perf', text: 'Within the performance budget', hint: 'Check the frame rate in the status bar against the budget.' },
        ],
    },
    {
        id: 'finish',
        title: 'Finish',
        long: 'Finish',
        description: 'Final lighting pass and polish, then color grading (lift, gamma, gain and saturation as a post effect). Compare every shot with its paintover one last time and approve it.',
        locksPlacement: false,
        compare: 'color',
        tools: [...ALL_TOOL_GROUPS],
        checks: [
            { id: 'finish.light', text: 'Final lighting pass and polish' },
            {
                id: 'finish.grade',
                text: 'Color grading is set up',
                auto: ({ doc }) => {
                    const graded = doc.renderGraph.posts.some((p) => p.enabled && /grad/i.test(doc.shaders.find((s) => s.id === p.shader)?.name ?? ''));
                    return { done: graded };
                },
            },
            {
                id: 'finish.shots',
                text: 'Every shot was compared with its paintover and approved',
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
            if (c.id === 'effects.perf' && ctx.fps) detail = `${Math.round(ctx.fps)} fps now, budget ${ctx.design.budget.fps}`;
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

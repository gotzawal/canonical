// The assistant's tools for the planning pipeline: reading and structuring
// the design, questions for the user, checklists and stage proposals.

import { STAGE_IDS, stageIndex } from '../core/design';
import { uid } from '../core/ids';
import type { AreaDoc, AreaObjectDoc, DesignDoc, StageId, Vec3 } from '../core/types';
import { evaluateStage, stageDef } from '../design/stages';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { hex, num, optStr, str, ToolError, v3, type Json } from './toolUtil';

function def(name: string, description: string, properties: Json = {}, required: string[] = []): ToolDef {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const SECTIONS = ['all', 'brief', 'layout', 'areas', 'concepts', 'specs', 'mood', 'play', 'effects', 'materials', 'budget', 'questions', 'shots', 'stages', 'snapshots', 'memo'];

export function designToolDefs(): ToolDef[] {
    return [
        def('read_design', 'Read the design section: the planning brief, the structure (layout, areas, specs, mood, play requirements, effects, material slots, budget), open questions, shots, the stages with their checklists, snapshots and the scene memo.', {
            section: { type: 'string', enum: SECTIONS, description: 'Default "all" (without the brief text; ask for "brief" to read it).' },
        }),
        def(
            'update_design',
            'Write the structured plan. Areas are matched by id or name and updated; new names add areas; remove: true deletes one. An area\'s objects list replaces the old one (placed flags of the same names are kept). Route, sight lines and area order replace the old ones when given. Effects are matched by id or name. After the brief stage, areas whose objects, bounds or mood change are flagged for rework.',
            {
                from_brief: { type: 'boolean', description: 'This structure comes from the current brief (marks the brief as structured).' },
                layout: {
                    type: 'object',
                    description: 'How the scene is built.',
                    properties: {
                        summary: { type: 'string', description: 'Kind of place, overall size, ground, where the areas sit and how they connect.' },
                        size: { ...vec3, description: 'Overall footprint x, height y, footprint z in meters.' },
                        connections: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string' }, note: { type: 'string' } }, required: ['from', 'to'] } },
                    },
                },
                areas: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            description: { type: 'string' },
                            objects: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' }, note: { type: 'string' }, placed: { type: 'boolean' } }, required: ['name'] } },
                            mood: { type: 'string', description: 'Only when it differs from the scene mood.' },
                            bounds: { type: ['object', 'null'], properties: { center: vec3, size: vec3 }, description: 'Rough placement: center on the ground and size x y z in meters.' },
                            rework_done: { type: 'boolean', description: 'Clear the rework flag once the area is redone.' },
                            remove: { type: 'boolean' },
                        },
                    },
                },
                concepts: {
                    type: 'array',
                    description: 'Map concept images (image asset ids) to areas; adds images that are not concepts yet (e.g. ones the user attached).',
                    items: { type: 'object', properties: { asset: { type: 'string' }, area: { type: ['string', 'null'] }, note: { type: 'string' }, remove: { type: 'boolean' } }, required: ['asset'] },
                },
                specs: {
                    type: 'object',
                    properties: {
                        player_height: { type: 'number' },
                        eye_height: { type: 'number' },
                        player_radius: { type: 'number' },
                        door_width: { type: 'number' },
                        door_height: { type: 'number' },
                        step_height: { type: 'number' },
                        max_slope: { type: 'number', description: 'Degrees.' },
                        notes: { type: 'string' },
                    },
                },
                mood: {
                    type: 'object',
                    properties: {
                        description: { type: 'string' },
                        time_of_day: { type: 'string' },
                        key_light: { type: 'object', properties: { azimuth: { type: 'number', description: 'Degrees around +Y from +Z.' }, elevation: { type: 'number' }, color: { type: 'string' }, note: { type: 'string' } } },
                        palette: { type: 'array', items: { type: 'string' } },
                    },
                },
                play: {
                    type: 'object',
                    properties: {
                        route: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, area: { type: 'string' }, position: vec3, note: { type: 'string' } }, required: ['name'] } },
                        sightlines: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, note: { type: 'string' }, ok: { type: ['boolean', 'null'] } }, required: ['from', 'to'] } },
                        area_order: { type: 'array', items: { type: 'string' } },
                        notes: { type: 'string' },
                    },
                },
                effects: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, area: { type: 'string' }, note: { type: 'string' }, done: { type: 'boolean' }, remove: { type: 'boolean' } }, required: ['name'] } },
                budget: { type: 'object', properties: { shadow_lights: { type: 'number' }, fps: { type: 'number' } } },
            },
        ),
        def('ask_user', 'Ask the user about something the brief leaves open instead of guessing. The questions show in the Design tab; answers come back in the editor context.', {
            questions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, area: { type: 'string' } }, required: ['text'] } },
            clear_answered: { type: 'boolean', description: 'Remove questions that were answered and used.' },
        }, ['questions']),
        def('update_checklist', 'Tick or untick checklist items of a stage (default: the current one) with a short note on what was checked, or add items. Automatic items follow the project and only take notes.', {
            stage: { type: 'string', enum: STAGE_IDS },
            items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string', description: 'New item (without id).' }, done: { type: 'boolean' }, note: { type: 'string' } } } },
        }, ['items']),
        def('propose_stage_complete', 'Propose completing the current stage once its checklist is done. The user reviews and approves; completing captures every shot and takes a snapshot.', {
            summary: { type: 'string', description: 'What was done and what was checked, a few lines.' },
        }, ['summary']),
    ];
}

// ------------------------------------------------------------------ runner

function areaRef(d: DesignDoc, ref: unknown): string | null {
    if (ref === undefined || ref === null || ref === '') return null;
    if (typeof ref !== 'string') throw new ToolError('area must be an area id or name.');
    const a = d.areas.find((x) => x.id === ref) ?? d.areas.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!a) throw new ToolError(`No area "${ref}". Areas: ${d.areas.map((x) => `${x.name} (${x.id})`).join(', ') || 'none yet'}.`);
    return a.id;
}

function objectsFrom(v: unknown, old: AreaObjectDoc[]): AreaObjectDoc[] {
    if (!Array.isArray(v)) throw new ToolError('objects must be an array.');
    return v.map((o: any) => {
        const name = str(o?.name, 'object name', 200).trim();
        if (!name) throw new ToolError('Every object needs a name.');
        const prev = old.find((x) => x.name.toLowerCase() === name.toLowerCase());
        const out: AreaObjectDoc = { name };
        if (o.count !== undefined) out.count = Math.max(1, Math.round(num(o.count, 'count')));
        if (o.note !== undefined) out.note = str(o.note, 'note', 1000);
        if (o.placed !== undefined ? o.placed === true : prev?.placed) out.placed = true;
        return out;
    });
}

function bounds(v: unknown): AreaDoc['bounds'] {
    if (v === null) return null;
    const b = v as Json;
    if (!b || typeof b !== 'object') throw new ToolError('bounds must be { center, size } or null.');
    const size = v3(b.size, 'bounds.size').map((x) => Math.max(0.1, Math.abs(x))) as Vec3;
    return { center: v3(b.center, 'bounds.center'), size };
}

/** Earlier of two stages (for rework flags). */
function earlier(a: StageId | null | undefined, b: StageId): StageId {
    return a && stageIndex(a) <= stageIndex(b) ? a : b;
}

function applyDesign(env: ToolEnv, d: DesignDoc, args: Json): { changed: string[]; rework: string[]; added: string[] } {
    const changed: string[] = [];
    const rework: string[] = [];
    const added: string[] = [];
    const structured = stageIndex(d.stage) > 0;

    if (args.layout !== undefined) {
        const l = args.layout as Json;
        if (l.summary !== undefined) d.layout.summary = str(l.summary, 'layout.summary', 8000).trim();
        if (l.size !== undefined) d.layout.size = l.size === null ? null : v3(l.size, 'layout.size');
        if (l.connections !== undefined) {
            if (!Array.isArray(l.connections)) throw new ToolError('layout.connections must be an array.');
            d.layout.connections = l.connections.map((c: Json) => ({
                from: str(c?.from, 'connection from', 200),
                to: str(c?.to, 'connection to', 200),
                ...(c.kind ? { kind: str(c.kind, 'kind', 100) } : {}),
                ...(c.note ? { note: str(c.note, 'note', 1000) } : {}),
            }));
        }
        changed.push('layout');
    }

    if (args.areas !== undefined) {
        if (!Array.isArray(args.areas)) throw new ToolError('areas must be an array.');
        for (const spec of args.areas as Json[]) {
            const byId = typeof spec.id === 'string' ? d.areas.find((a) => a.id === spec.id) : undefined;
            const byName = typeof spec.name === 'string' ? d.areas.find((a) => a.name.toLowerCase() === spec.name.trim().toLowerCase()) : undefined;
            let area = byId ?? byName;
            if (spec.remove) {
                if (!area) throw new ToolError(`No area "${spec.id ?? spec.name}" to remove.`);
                const id = area.id;
                d.areas = d.areas.filter((a) => a.id !== id);
                for (const c of d.concepts) if (c.area === id) c.area = null;
                changed.push(`removed ${area.name}`);
                continue;
            }
            if (!area) {
                const name = str(spec.name, 'area name', 200).trim();
                if (!name) throw new ToolError('A new area needs a name.');
                area = { id: uid('ar'), name, description: '', objects: [] };
                d.areas.push(area);
                added.push(name);
                if (structured) {
                    area.rework = 'level';
                    area.reworkNote = 'New area.';
                    rework.push(name);
                }
            }
            const a = area;
            const before = JSON.stringify([a.objects.map((o) => [o.name, o.count ?? 1]), a.bounds ?? null]);
            const moodBefore = a.mood ?? '';
            if (spec.name !== undefined && byId) a.name = str(spec.name, 'name', 200).trim() || a.name;
            if (spec.description !== undefined) a.description = str(spec.description, 'description', 8000).trim();
            if (spec.objects !== undefined) a.objects = objectsFrom(spec.objects, a.objects);
            if (spec.mood !== undefined) a.mood = optStr(spec.mood, 'mood', 4000)?.trim() || undefined;
            if (spec.bounds !== undefined) a.bounds = bounds(spec.bounds);
            if (spec.rework_done) {
                delete a.rework;
                delete a.reworkNote;
            }
            if (structured && !added.includes(a.name) && !spec.rework_done) {
                const after = JSON.stringify([a.objects.map((o) => [o.name, o.count ?? 1]), a.bounds ?? null]);
                if (after !== before) {
                    a.rework = earlier(a.rework, 'level');
                    a.reworkNote = 'Objects or placement changed in the brief.';
                    rework.push(a.name);
                } else if ((a.mood ?? '') !== moodBefore) {
                    a.rework = earlier(a.rework, 'light');
                    a.reworkNote = 'Mood changed in the brief.';
                    rework.push(a.name);
                }
            }
            changed.push(a.name);
        }
    }

    if (args.concepts !== undefined) {
        if (!Array.isArray(args.concepts)) throw new ToolError('concepts must be an array.');
        const assets = env.editor.store.doc.assets;
        for (const c of args.concepts as Json[]) {
            const asset = str(c.asset, 'concept asset', 64);
            const meta = assets.find((a) => a.id === asset);
            if (!meta || meta.kind !== 'image') throw new ToolError(`"${asset}" is not an image asset of the project.`);
            if (c.remove) {
                d.concepts = d.concepts.filter((x) => x.asset !== asset);
                continue;
            }
            let concept = d.concepts.find((x) => x.asset === asset);
            if (!concept) {
                concept = { asset, area: null };
                d.concepts.push(concept);
            }
            if (c.area !== undefined) concept.area = areaRef(d, c.area);
            if (c.note !== undefined) concept.note = optStr(c.note, 'note', 2000) || undefined;
        }
        changed.push('concepts');
    }

    if (args.specs !== undefined) {
        const sp = args.specs as Json;
        const map: [string, keyof DesignDoc['specs']][] = [
            ['player_height', 'playerHeight'], ['eye_height', 'eyeHeight'], ['player_radius', 'playerRadius'], ['door_width', 'doorWidth'],
            ['door_height', 'doorHeight'], ['step_height', 'stepHeight'], ['max_slope', 'maxSlope'],
        ];
        for (const [k, key] of map) if (sp[k] !== undefined) (d.specs as any)[key] = Math.max(0, num(sp[k], `specs.${k}`));
        if (sp.notes !== undefined) d.specs.notes = str(sp.notes, 'specs.notes', 8000);
        changed.push('specs');
    }

    if (args.mood !== undefined) {
        const m = args.mood as Json;
        if (m.description !== undefined) d.mood.description = str(m.description, 'mood.description', 8000).trim();
        if (m.time_of_day !== undefined) d.mood.timeOfDay = str(m.time_of_day, 'mood.time_of_day', 200).trim();
        if (m.key_light) {
            const k = m.key_light as Json;
            if (k.azimuth !== undefined) d.mood.keyLight.azimuth = num(k.azimuth, 'key_light.azimuth');
            if (k.elevation !== undefined) d.mood.keyLight.elevation = Math.max(-90, Math.min(90, num(k.elevation, 'key_light.elevation')));
            if (k.color !== undefined) d.mood.keyLight.color = hex(k.color, 'key_light.color');
            if (k.note !== undefined) d.mood.keyLight.note = str(k.note, 'key_light.note', 2000);
        }
        if (m.palette !== undefined) {
            if (!Array.isArray(m.palette)) throw new ToolError('mood.palette must be an array of colors.');
            d.mood.palette = m.palette.slice(0, 16).map((c: unknown) => hex(c, 'palette color'));
        }
        changed.push('mood');
    }

    if (args.play !== undefined) {
        const p = args.play as Json;
        if (p.route !== undefined) {
            if (!Array.isArray(p.route)) throw new ToolError('play.route must be an array.');
            const old = d.play.route;
            d.play.route = p.route.map((r: Json) => {
                const name = str(r.name, 'route point name', 200).trim() || 'Point';
                const prev = old.find((x) => (r.id && x.id === r.id) || x.name.toLowerCase() === name.toLowerCase());
                return {
                    id: prev?.id ?? uid('rp'),
                    name,
                    ...(r.area !== undefined ? { area: areaRef(d, r.area) } : prev?.area ? { area: prev.area } : {}),
                    ...(r.position !== undefined ? { position: r.position === null ? null : v3(r.position, 'route position') } : prev?.position ? { position: prev.position } : {}),
                    ...(r.note ? { note: str(r.note, 'note', 1000) } : {}),
                    ...(prev?.visited ? { visited: true } : {}),
                };
            });
        }
        if (p.sightlines !== undefined) {
            if (!Array.isArray(p.sightlines)) throw new ToolError('play.sightlines must be an array.');
            const old = d.play.sightlines;
            d.play.sightlines = p.sightlines.map((v: Json) => {
                const from = str(v.from, 'sightline from', 200);
                const to = str(v.to, 'sightline to', 200);
                const prev = old.find((x) => (v.id && x.id === v.id) || (x.from === from && x.to === to));
                const ok = v.ok !== undefined ? v.ok : prev?.ok;
                return { id: prev?.id ?? uid('sl'), from, to, ...(v.note ? { note: str(v.note, 'note', 1000) } : prev?.note ? { note: prev.note } : {}), ...(typeof ok === 'boolean' ? { ok } : {}) };
            });
        }
        if (p.area_order !== undefined) {
            if (!Array.isArray(p.area_order)) throw new ToolError('play.area_order must be an array.');
            d.play.areaOrder = p.area_order.map((a: unknown) => areaRef(d, a)).filter((a: string | null): a is string => !!a);
        }
        if (p.notes !== undefined) d.play.notes = str(p.notes, 'play.notes', 8000);
        changed.push('play');
    }

    if (args.effects !== undefined) {
        if (!Array.isArray(args.effects)) throw new ToolError('effects must be an array.');
        for (const e of args.effects as Json[]) {
            const name = str(e.name, 'effect name', 200).trim();
            const cur = d.effects.find((x) => (e.id && x.id === e.id) || x.name.toLowerCase() === name.toLowerCase());
            if (e.remove) {
                if (cur) d.effects = d.effects.filter((x) => x !== cur);
                continue;
            }
            const item = cur ?? { id: uid('fx'), name };
            if (!cur) d.effects.push(item);
            if (name) item.name = name;
            if (e.area !== undefined) item.area = areaRef(d, e.area);
            if (e.note !== undefined) item.note = optStr(e.note, 'note', 1000) || undefined;
            if (e.done !== undefined) item.done = e.done === true || undefined;
        }
        changed.push('effects');
    }

    if (args.budget !== undefined) {
        const b = args.budget as Json;
        if (b.shadow_lights !== undefined) d.budget.shadowLights = Math.max(0, Math.round(num(b.shadow_lights, 'budget.shadow_lights')));
        if (b.fps !== undefined) d.budget.fps = Math.max(1, num(b.fps, 'budget.fps'));
        changed.push('budget');
    }

    if (args.from_brief) {
        d.brief.structured = d.brief.text;
        d.brief.structuredAt = new Date().toISOString();
    }
    return { changed, rework, added };
}

function readDesign(env: ToolEnv, section: string): Json {
    const ed = env.editor;
    const doc = ed.store.doc;
    const d = doc.design;
    const all = section === 'all';
    const want = (k: string) => all || section === k;
    const out: Json = {};
    const assetName = (id: string) => doc.assets.find((a) => a.id === id)?.name;
    if (section === 'brief') out.brief = { text: d.brief.text || '(empty)', structured: !!d.brief.structuredAt && d.brief.structured === d.brief.text, skipped: !!d.brief.skipped };
    else if (all) out.brief = { characters: d.brief.text.length, structured: !!d.brief.structuredAt && d.brief.structured === d.brief.text, note: 'Read section "brief" for the text.' };
    if (want('layout')) out.layout = d.layout;
    if (want('areas')) {
        out.areas = d.areas.map((a) => ({
            ...a,
            concepts: d.concepts.filter((c) => c.area === a.id).map((c) => c.asset),
        }));
    }
    if (want('concepts')) {
        out.concepts = d.concepts.map((c) => {
            const meta = doc.assets.find((a) => a.id === c.asset);
            return { asset: c.asset, name: meta?.name, area: c.area, note: c.note, size: meta?.width ? `${meta.width}x${meta.height}` : undefined };
        });
    }
    if (want('specs')) out.specs = d.specs;
    if (want('mood')) out.mood = d.mood;
    if (want('play')) out.play = d.play;
    if (want('effects')) out.effects = d.effects;
    if (want('materials')) out.material_slots = d.materials;
    if (want('budget')) out.budget = d.budget;
    if (want('questions')) out.questions = d.questions;
    if (want('shots')) {
        out.shots = d.shots.map((s) => ({
            id: s.id,
            name: s.name,
            area: s.area,
            concept: s.concept,
            target: s.target,
            stale: s.stale || undefined,
            approved: s.approved || undefined,
            aspect: Math.round(s.aspect * 1000) / 1000,
            fov: Math.round(s.camera.fov * 10) / 10,
            paintovers: s.paintovers.map((p) => ({ asset: p.asset, source: p.source, model: p.model, prompt: p.prompt?.slice(0, 200) })),
            history: s.history.map((h) => ({ stage: h.stage, asset: h.asset, at: h.at, score: h.score, manual: h.manual })),
        }));
    }
    if (want('stages')) {
        const ctx = { doc, design: d, fps: ed.runtime.fps };
        out.current_stage = d.stage;
        out.stages = STAGE_IDS.map((id) => ({
            id,
            title: stageDef(id).long,
            status: d.stages[id].status,
            ...(d.stages[id].recheck ? { recheck: d.stages[id].recheck } : {}),
            ...(d.stages[id].proposal ? { proposal: d.stages[id].proposal } : {}),
            ...(id === d.stage || all ? { checklist: evaluateStage(ctx, id).map((i) => ({ id: i.id, text: i.text, done: i.done, automatic: i.auto || undefined, user_only: i.userOnly || undefined, detail: i.detail, note: i.note })) } : {}),
        }));
    }
    if (want('snapshots')) out.snapshots = d.snapshots.map((s) => ({ id: s.id, name: s.name, stage: s.stage, at: s.at }));
    if (want('memo')) out.memo = d.memo;
    if (want('concepts') || want('shots')) out.asset_names = Object.fromEntries([...d.concepts.map((c) => c.asset), ...d.shots.flatMap((s) => [s.target, s.concept]).filter((x): x is string => !!x)].map((id) => [id, assetName(id)]));
    return out;
}

/** Runs a design tool; null when `name` is not one. */
export async function runDesignTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult | null> {
    const ed = env.editor;
    const store = ed.store;
    switch (name) {
        case 'read_design': {
            const section = typeof args.section === 'string' && SECTIONS.includes(args.section) ? args.section : 'all';
            return { data: readDesign(env, section), summary: section };
        }
        case 'update_design': {
            // Validate on a copy so a bad field changes nothing.
            const draft = JSON.parse(JSON.stringify(store.doc.design)) as DesignDoc;
            const result = applyDesign(env, draft, args);
            store.commit('AI: Update Design', (d) => {
                d.design = draft;
            }, { design: true });
            return {
                data: {
                    ok: true,
                    updated: result.changed,
                    ...(result.added.length ? { added_areas: result.added } : {}),
                    ...(result.rework.length ? { flagged_for_rework: result.rework } : {}),
                    areas: draft.areas.map((a) => ({ id: a.id, name: a.name })),
                },
                summary: result.changed.slice(0, 6).join(', ') || 'no change',
            };
        }
        case 'ask_user': {
            const list: Json[] = Array.isArray(args.questions) ? args.questions : [];
            if (!list.length && !args.clear_answered) throw new ToolError('questions is empty.');
            const added: { id: string; text: string }[] = [];
            store.commit('AI: Questions', (d) => {
                if (args.clear_answered) d.design.questions = d.design.questions.filter((q) => !q.answer.trim());
                for (const q of list) {
                    const text = str(q.text, 'question text', 2000).trim();
                    if (!text || d.design.questions.some((x) => x.text === text)) continue;
                    const item = { id: uid('q'), text, answer: '', ...(q.area ? { area: areaRef(d.design, q.area) } : {}) };
                    d.design.questions.push(item);
                    added.push({ id: item.id, text });
                }
            }, { design: true });
            return { data: { ok: true, asked: added, note: 'The questions show in the Design tab. Tell the user what you need in your answer too.' }, summary: `${added.length} question${added.length === 1 ? '' : 's'}` };
        }
        case 'update_checklist': {
            const d = store.doc.design;
            const stage: StageId = STAGE_IDS.includes(args.stage) ? args.stage : d.stage;
            const items: Json[] = Array.isArray(args.items) ? args.items : [];
            if (!items.length) throw new ToolError('items is empty.');
            const defs = stageDef(stage).checks;
            const results: Json[] = [];
            store.commit('AI: Checklist', (doc) => {
                const st = doc.design.stages[stage];
                for (const it of items) {
                    const note = it.note !== undefined ? optStr(it.note, 'note', 2000) : undefined;
                    if (!it.id) {
                        const text = str(it.text, 'item text', 1000).trim();
                        if (!text) throw new ToolError('A new item needs text.');
                        const id = uid('ck');
                        st.checks.push({ id, text, done: it.done === true, by: 'ai', ...(note ? { note } : {}) });
                        results.push({ id, added: text });
                        continue;
                    }
                    const builtIn = defs.find((c) => c.id === it.id);
                    const stored = st.checks.find((c) => c.id === it.id);
                    if (!builtIn && !stored) throw new ToolError(`No checklist item "${it.id}" in ${stage}. Read the stages with read_design.`);
                    if (builtIn?.userOnly && it.done === true) throw new ToolError(`"${builtIn.text}" can only be ticked by the user.`);
                    if (builtIn?.auto) {
                        // Automatic: the project decides; keep the note.
                        if (note !== undefined) {
                            if (stored) stored.note = note || undefined;
                            else st.checks.push({ id: builtIn.id, text: '', done: false, ...(note ? { note } : {}) });
                        }
                        results.push({ id: it.id, automatic: true });
                        continue;
                    }
                    if (stored) {
                        if (it.done !== undefined) stored.done = it.done === true;
                        stored.by = 'ai';
                        if (note !== undefined) stored.note = note || undefined;
                    } else st.checks.push({ id: it.id, text: '', done: it.done === true, by: 'ai', ...(note ? { note } : {}) });
                    results.push({ id: it.id, done: it.done === true });
                }
            }, { design: true });
            const prog = ed.pipeline.progress(stage);
            return { data: { ok: true, results, checklist: `${prog.done}/${prog.total}`, open: prog.open.map((i) => ({ id: i.id, text: i.text, detail: i.detail })) }, summary: `${prog.done}/${prog.total} done` };
        }
        case 'propose_stage_complete': {
            const summary = str(args.summary, 'summary', 8000).trim();
            if (!summary) throw new ToolError('summary is empty.');
            const prog = ed.pipeline.progress();
            ed.pipeline.propose(summary);
            return {
                data: {
                    ok: true,
                    note: 'The user was asked to review and complete the stage.',
                    ...(prog.open.length ? { still_open: prog.open.map((i) => i.text) } : {}),
                },
                summary: stageDef(store.doc.design.stage).title,
            };
        }
    }
    return null;
}

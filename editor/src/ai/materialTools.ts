// The assistant's material tools: material slots (named surfaces shown with
// the world space triplanar shader), linking objects to them, and the
// swatch library of this browser: search it first, generate a swatch only
// when nothing fits.

import { contactSheet } from '../core/images';
import type { MaterialSlotDoc } from '../core/types';
import { assignSlot, slotUsers, upsertSlot, useSwatch, type SlotPatch } from '../design/materialSlots';
import { imageModelId } from '../design/paintover';
import { generateSwatches, searchSwatches, swatchIdOf, swatchPrompt, tagsFrom } from '../design/swatches';
import { MAX_IMAGES } from './images';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { hex, node, num, optStr, r3, str, ToolError, type Json } from './toolUtil';

function def(name: string, description: string, properties: Json = {}, required: string[] = []): ToolDef {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** Tools that spend credits; left out when image generation is off. */
export const PAID_MATERIAL_TOOLS = new Set(['generate_swatch']);

export function materialToolDefs(): ToolDef[] {
    return [
        def('set_material_slot', 'Add or change a material slot: a named surface of the level (plaster, cobblestone, oak planks). Objects linked to it (assign_material_slot) render with the world space triplanar shader, so its swatch shows at its real size: tile is the size of one texture tile in meters. One roughness and one metallic value per slot. Mark slots meant as a plain color (painted metal, glass) with flat.', {
            slot: { type: 'string', description: 'Id or name of the slot to change; leave out to add one.' },
            name: { type: 'string' },
            description: { type: 'string', description: 'Material, color, wear: what a swatch has to show.' },
            color: { type: 'string', description: '#rrggbb; multiplies the swatch (white shows it as it is).' },
            roughness: { type: 'number' },
            metallic: { type: 'number' },
            tile: { type: 'number', description: 'Meters per texture tile.' },
            flat: { type: 'boolean', description: 'A plain color, no swatch needed.' },
        }),
        def('assign_material_slot', 'Link objects to a material slot; their material follows the slot from then on. Parts of prefab instances link the matching part of the prefab (every instance follows).', {
            slot: { type: 'string', description: 'Slot id or name.' },
            objects: { type: 'array', items: { type: 'string' }, description: 'Object ids or names.' },
        }, ['slot', 'objects']),
        def('search_swatches', 'Search the swatch library of this browser (shared by every project) by words against names and tags. A contact sheet of the results is attached (numbered like the list). Search before generating.', {
            query: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 16 },
        }, ['query']),
        def('use_swatch', 'Put a library swatch on a material slot. The slot takes the swatch\'s tile size (its real size), roughness and metallic where the swatch has them, and white as its color.', {
            slot: { type: 'string', description: 'Slot id or name.' },
            swatch: { type: 'string', description: 'Swatch id from search_swatches.' },
        }, ['slot', 'swatch']),
        def('generate_swatch', 'Generate swatches for a slot with the image model when the library has nothing that fits: a flat, evenly lit, tileable albedo from the slot\'s description, matched to the concepts and paintovers given as references. Results are processed (crop, shading evened out, seams blended, brightness within sRGB 30-240) and added to the library; use_swatch puts one on the slot. Costs credits.', {
            slot: { type: 'string', description: 'Slot id or name.' },
            prompt: { type: 'string', description: 'Leave out for the default built from the slot.' },
            references: { type: 'array', items: { type: 'string' }, description: 'Concept or paintover asset ids to match; default: the first shot targets.' },
            count: { type: 'integer', minimum: 1, maximum: MAX_IMAGES, description: 'Default 2.' },
        }, ['slot']),
    ];
}

function findSlot(env: ToolEnv, ref: unknown): MaterialSlotDoc {
    const slots = env.editor.store.doc.design.materials;
    const r = typeof ref === 'string' ? ref.trim() : '';
    const slot = slots.find((s) => s.id === r) ?? slots.find((s) => s.name.toLowerCase() === r.toLowerCase());
    if (!slot) throw new ToolError(`No material slot "${r}". Slots: ${slots.map((s) => `${s.name} (${s.id})`).join(', ') || 'none yet'}.`);
    return slot;
}

function slotSummary(env: ToolEnv, s: MaterialSlotDoc) {
    const doc = env.editor.store.doc;
    const meta = s.swatch ? doc.assets.find((a) => a.id === s.swatch) : undefined;
    return {
        id: s.id,
        name: s.name,
        swatch: s.swatch ? swatchIdOf(meta) ?? s.swatch : null,
        color: s.color,
        roughness: r3(s.roughness),
        metallic: r3(s.metallic),
        tile: r3(s.tile),
        ...(s.flat ? { flat: true } : {}),
        objects: slotUsers(doc, s.id).length,
    };
}

export async function runMaterialTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult | null> {
    const ed = env.editor;
    switch (name) {
        case 'set_material_slot': {
            const existing = args.slot !== undefined ? findSlot(env, args.slot) : undefined;
            if (!existing && !(typeof args.name === 'string' && args.name.trim())) throw new ToolError('Give a name for the new slot.');
            const patch: SlotPatch = {};
            if (args.name !== undefined) patch.name = str(args.name, 'name', 200);
            if (args.description !== undefined) patch.description = str(args.description, 'description', 4000);
            if (args.color !== undefined) patch.color = hex(args.color, 'color');
            if (args.roughness !== undefined) patch.roughness = num(args.roughness, 'roughness');
            if (args.metallic !== undefined) patch.metallic = num(args.metallic, 'metallic');
            if (args.tile !== undefined) patch.tile = num(args.tile, 'tile');
            if (args.flat !== undefined) patch.flat = !!args.flat;
            const slot = upsertSlot(ed, { ...(existing ? { id: existing.id } : {}), ...patch }, existing ? 'AI: Edit Material Slot' : 'AI: Add Material Slot');
            return { data: slotSummary(env, slot), summary: slot.name };
        }
        case 'assign_material_slot': {
            const slot = findSlot(env, args.slot);
            const ids = (Array.isArray(args.objects) ? args.objects : []).map((r: unknown) => node(ed.store.doc, r).id);
            if (!ids.length) throw new ToolError('objects is empty.');
            const meshes = ids.filter((id) => ed.store.node(id)?.mesh || ed.store.node(id)?.prefab);
            if (!meshes.length) throw new ToolError('None of these objects has a mesh (lights, cameras, groups and models have no slot).');
            const n = assignSlot(ed, slot.id, meshes);
            return { data: { ok: true, slot: slot.name, linked: n, skipped: ids.length - meshes.length }, summary: `${n} to ${slot.name}` };
        }
        case 'search_swatches': {
            const query = str(args.query, 'query', 400);
            const limit = args.limit !== undefined ? Math.max(1, Math.min(16, Math.round(num(args.limit, 'limit')))) : 8;
            const found = await searchSwatches(query, limit);
            const list = found.map(({ swatch: s, score }, i) => ({ n: i + 1, id: s.id, name: s.name, tags: s.tags, tile: s.tile, color: s.color, ...(s.roughness !== undefined ? { roughness: s.roughness } : {}), source: s.source, match: Math.round(score * 100) / 100 }));
            const images = list.length && env.screenshots() ? [await contactSheet(found.map((f) => f.swatch.blob))] : [];
            return {
                data: { query, results: list, ...(list.length ? {} : { note: 'Nothing matches. Try other words, or generate_swatch.' }) },
                images,
                summary: `${list.length} found`,
            };
        }
        case 'use_swatch': {
            const slot = findSlot(env, args.slot);
            const id = str(args.swatch, 'swatch', 64).trim();
            const updated = await useSwatch(ed, slot.id, id).catch((e) => {
                throw new ToolError(e?.message || String(e));
            });
            return { data: slotSummary(env, updated), summary: `${updated.name}` };
        }
        case 'generate_swatch': {
            if (!env.allowImages()) throw new ToolError('Image generation is turned off in the AI settings.');
            const slot = findSlot(env, args.slot);
            const doc = ed.store.doc;
            let refs: string[] = (Array.isArray(args.references) ? args.references : []).filter((r: unknown): r is string => typeof r === 'string');
            for (const r of refs) if (!doc.assets.some((a) => a.id === r && a.kind === 'image')) throw new ToolError(`"${r}" is not an image asset of the project.`);
            if (!refs.length && args.references === undefined) {
                const targets = doc.design.shots.map((s) => s.target).filter((x): x is string => !!x);
                refs = (targets.length ? targets : doc.design.concepts.map((c) => c.asset)).slice(0, 2);
            }
            const count = args.count !== undefined ? Math.max(1, Math.min(MAX_IMAGES, Math.round(num(args.count, 'count')))) : 2;
            const prompt = optStr(args.prompt, 'prompt', 4000)?.trim() || swatchPrompt(slot, refs.length > 0);
            const res = await generateSwatches(
                { prompt, refs, count, model: imageModelId(), params: {}, seed: null, name: slot.name, tags: tagsFrom(`${slot.name} ${slot.description}`), tile: slot.tile, roughness: slot.roughness, metallic: slot.metallic },
                { signal: env.signal },
            );
            const images = res.swatches.length && env.screenshots() ? [await contactSheet(res.swatches.map((s) => s.blob))] : [];
            return {
                data: {
                    slot: slot.name,
                    swatches: res.swatches.map((s, i) => ({ n: i + 1, id: s.id, color: s.color })),
                    ...(res.cost != null ? { cost_usd: Number(res.cost.toFixed(4)) } : {}),
                    ...(res.dropped.length ? { left_out: res.dropped } : {}),
                    ...(res.errors.length ? { failed_requests: res.errors } : {}),
                    note: 'Added to the library. Put the best one on the slot with use_swatch.',
                },
                images,
                summary: `${res.swatches.length} for ${slot.name}`,
            };
        }
    }
    return null;
}

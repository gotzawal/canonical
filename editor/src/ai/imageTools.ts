// The assistant's image tools: paintovers of shots with the image model set
// in the AI settings, choosing a shot's target, and what the image model
// accepts. Generation costs credits and can be switched off in the settings.

import { assetImageDataUrl } from '../core/images';
import type { ShotDoc } from '../core/types';
import { defaultPaintoverPrompt, generatePaintovers, imageModelId, lastOptions, optionsForShot } from '../design/paintover';
import { conceptPrompt, generateConcepts, type ConceptView } from '../design/concepts';
import { notices } from '../ui/notify';
import { describeSpec, listImageModels, MAX_IMAGES, modelParams, OWN_PARAMS, takesImages } from './images';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { def, num, optStr, ToolError, type Json } from './toolUtil';

/** Tools that spend credits on images; left out when the settings forbid it. */
export const PAID_IMAGE_TOOLS = new Set(['generate_paintover', 'generate_concept']);

export function imageToolDefs(): ToolDef[] {
    return [
        def('generate_paintover', 'Make paintovers of a shot: a fresh greybox capture of the shot and its concept image go to the image model, which keeps the composition and paints the style and mood over it. The results are added to the shot and attached for you to look at; the user chooses the target. Costs credits: make one or two unless asked for more.', {
            shot: { type: 'string', description: 'Shot id or name.' },
            prompt: { type: 'string', description: 'Instruction for the image model. Leave it out for the default (keep the composition, take style and mood from the concept and the plan).' },
            count: { type: 'integer', minimum: 1, maximum: MAX_IMAGES, description: 'Images to make (default 1).' },
            seed: { type: 'integer' },
            options: { type: 'object', description: 'Image model options such as aspect_ratio or resolution (image_model_info lists them). Leave it out for the defaults; the aspect ratio follows the shot.' },
            references: { type: 'array', items: { type: 'string' }, description: 'More reference image asset ids (other concepts or paintovers), sent after the capture and the concept.' },
        }, ['shot']),
        def('generate_concept', 'Draw concept images of the design with the image model, so the user can review how it will look before and while it is built: an area from outside or inside, an overview of the whole place, or a floor plan. They are added as concepts of the area, proposed until the user approves them in the Design tab; approved concepts are the references for shots and paintovers. With capture, a capture of the greybox (the current view or a shot) is painted over, keeping its shapes. Costs credits: one or two per area.', {
            area: { type: 'string', description: 'Area id or name; leave out for the whole place.' },
            view: { type: 'string', enum: ['exterior', 'interior', 'overview', 'plan'], description: 'Default exterior.' },
            instructions: { type: 'string', description: 'What to show or change, added to the default instruction built from the plan.' },
            prompt: { type: 'string', description: 'A whole instruction instead of the default.' },
            count: { type: 'integer', minimum: 1, maximum: 4, description: 'Default 1.' },
            references: { type: 'array', items: { type: 'string' }, description: 'Image asset ids to match (other concepts, paintovers).' },
            capture: { type: 'string', description: '"view" for the current view of the greybox, or a shot id or name.' },
        }),
        def('choose_paintover', 'Make one of a shot\'s paintovers its target, the image every later comparison of the shot uses. Only when the user asked you to choose or lets you decide the details (detail level quick): then pick the one that keeps the blockout\'s composition best. Otherwise ask them to pick one (Design tab, the shot\'s Paintover button).', {
            shot: { type: 'string', description: 'Shot id or name.' },
            paintover: { type: 'string', description: 'Asset id of the paintover.' },
        }, ['shot', 'paintover']),
        def('image_model_info', 'The image model set for paintovers and swatches: whether it takes reference images, and the options it accepts with their allowed values.'),
    ];
}

function findShot(env: ToolEnv, ref: unknown): ShotDoc {
    const shots = env.editor.store.doc.design.shots;
    const r = typeof ref === 'string' ? ref.trim() : '';
    const shot = shots.find((s) => s.id === r) ?? shots.find((s) => s.name.toLowerCase() === r.toLowerCase());
    if (!shot) throw new ToolError(`No shot "${r}". Shots: ${shots.map((s) => `${s.name} (${s.id})`).join(', ') || 'none'}.`);
    return shot;
}

export async function runImageTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult | null> {
    const ed = env.editor;
    switch (name) {
        case 'generate_paintover': {
            if (!env.allowImages()) throw new ToolError('Image generation is turned off in the AI settings.');
            const shot = findShot(env, args.shot);
            const model = imageModelId();
            const models = await listImageModels().catch(() => []);
            const info = models.find((m) => m.id === model);
            const extra: string[] = (Array.isArray(args.references) ? args.references : []).filter((r: unknown): r is string => typeof r === 'string');
            for (const r of extra) {
                if (!ed.store.doc.assets.some((a) => a.id === r && a.kind === 'image')) throw new ToolError(`"${r}" is not an image asset.`);
            }
            const options = args.options && typeof args.options === 'object' && !Array.isArray(args.options) ? (args.options as Json) : {};
            const params = { ...optionsForShot(info, shot, lastOptions(model).params), ...options };
            const count = args.count !== undefined ? Math.max(1, Math.min(MAX_IMAGES, Math.round(num(args.count, 'count')))) : 1;
            const prompt = optStr(args.prompt, 'prompt', 4000)?.trim() || defaultPaintoverPrompt(ed.store.doc.design, shot);
            const res = await generatePaintovers(ed, shot.id, {
                model,
                prompt,
                count,
                seed: args.seed !== undefined && args.seed !== null ? Math.round(num(args.seed, 'seed')) : null,
                params,
                stream: false,
                extra,
            }, { signal: env.signal });
            const images: string[] = [];
            if (env.screenshots()) {
                for (const p of res.paintovers) {
                    const url = await assetImageDataUrl(p.asset, 1024);
                    if (url) images.push(url);
                }
            }
            return {
                data: {
                    shot: shot.name,
                    model,
                    paintovers: res.paintovers.map((p) => ({ asset: p.asset, seed: p.seed ?? null })),
                    ...(res.cost != null ? { cost_usd: Number(res.cost.toFixed(4)) } : {}),
                    ...(res.dropped.length ? { options_left_out: res.dropped } : {}),
                    ...(res.errors.length ? { failed_requests: res.errors } : {}),
                    note: ed.store.doc.design.detail === 'quick'
                        ? `${images.length ? 'The new paintovers are attached in this order. ' : ''}The user lets you decide: make the one that keeps the blockout's composition best the target (choose_paintover).`
                        : images.length
                          ? 'The new paintovers are attached in this order. Say which one keeps the blockout\'s composition best; the user chooses the target.'
                          : 'The user chooses the target in the Design tab.',
                },
                images,
                summary: `${res.paintovers.length} for ${shot.name}`,
            };
        }
        case 'generate_concept': {
            if (!env.allowImages()) throw new ToolError('Image generation is turned off in the AI settings.');
            const d = ed.store.doc.design;
            const ref = optStr(args.area, 'area', 200);
            const area = ref ? d.areas.find((a) => a.id === ref) ?? d.areas.find((a) => a.name.toLowerCase() === ref.toLowerCase()) ?? null : null;
            if (ref && !area) throw new ToolError(`No area "${ref}". Areas: ${d.areas.map((a) => a.name).join(', ') || 'none yet'}.`);
            const view = (['exterior', 'interior', 'overview', 'plan'].includes(args.view) ? args.view : 'exterior') as ConceptView;
            const count = args.count !== undefined ? Math.max(1, Math.min(4, Math.round(num(args.count, 'count')))) : 1;
            const prompt = optStr(args.prompt, 'prompt', 4000)?.trim() || conceptPrompt(d, area, view, optStr(args.instructions, 'instructions', 2000) ?? '');
            const references: string[] = (Array.isArray(args.references) ? args.references : []).filter((r: unknown): r is string => typeof r === 'string');
            for (const r of references) {
                if (!ed.store.doc.assets.some((a) => a.id === r && a.kind === 'image')) throw new ToolError(`"${r}" is not an image asset.`);
            }
            const capture = typeof args.capture === 'string' && args.capture.trim() ? (args.capture.trim() === 'view' ? 'view' : findShot(env, args.capture).id) : null;
            const res = await generateConcepts(ed, { area, view, prompt, count, references, capture, signal: env.signal });
            const images: string[] = [];
            if (env.screenshots()) {
                for (const c of res.concepts) {
                    const url = await assetImageDataUrl(c.asset, 1024);
                    if (url) images.push(url);
                }
            }
            if (res.concepts.length) {
                notices.show({
                    kind: 'review',
                    key: 'concept-review',
                    icon: 'image',
                    title: `${res.concepts.length} concept image${res.concepts.length === 1 ? '' : 's'} to review`,
                    body: `${area ? area.name : 'The whole place'}, ${view}. Approve or reject ${res.concepts.length === 1 ? 'it' : 'them'} in the Design tab.`,
                    actions: [{ label: 'Review', primary: true, run: () => ed.emit('show-design', undefined) }],
                });
            }
            return {
                data: {
                    concepts: res.concepts.map((c) => c.asset),
                    area: area?.name ?? null,
                    view,
                    model: res.model,
                    ...(res.cost != null ? { cost_usd: Number(res.cost.toFixed(4)) } : {}),
                    ...(res.dropped.length ? { left_out: res.dropped } : {}),
                    ...(res.errors.length ? { failed_requests: res.errors } : {}),
                    note: `${images.length ? 'The images are attached in this order. Say in a line or two what they show and whether they fit the plan. ' : ''}They are proposed: the user approves or rejects them in the Design tab.${d.detail === 'quick' ? ' The user lets you decide, so go on with them meanwhile.' : ''}`,
                },
                images,
                summary: `${res.concepts.length} for ${area?.name ?? 'the whole place'}`,
            };
        }
        case 'choose_paintover': {
            const shot = findShot(env, args.shot);
            const asset = typeof args.paintover === 'string' ? args.paintover.trim() : '';
            if (!shot.paintovers.some((p) => p.asset === asset)) {
                throw new ToolError(`"${asset}" is not a paintover of ${shot.name}. Its paintovers: ${shot.paintovers.map((p) => p.asset).join(', ') || 'none yet'}.`);
            }
            ed.pipeline.choosePaintover(shot.id, asset);
            return { data: { ok: true, shot: shot.name, target: asset }, summary: shot.name };
        }
        case 'image_model_info': {
            const model = imageModelId();
            const models = await listImageModels().catch(() => []);
            const info = models.find((m) => m.id === model);
            if (!info) return { data: { model, note: models.length ? 'This model is not in the image model list; pick another in the AI settings.' : 'The image model list is unavailable.' } };
            const options: Record<string, string> = {};
            for (const [k, spec] of Object.entries(modelParams(info))) if (!OWN_PARAMS.has(k)) options[k] = describeSpec(spec);
            const specs = modelParams(info);
            return {
                data: {
                    model,
                    name: info.name,
                    takes_reference_images: takesImages(info),
                    seed: !!specs.seed,
                    images_per_request: specs.n?.type === 'range' ? Math.min(MAX_IMAGES, specs.n.max) : 1,
                    options,
                    generation_allowed: env.allowImages(),
                },
                summary: model,
            };
        }
    }
    return null;
}

// The assistant's image tools: paintovers of shots with the image model set
// in the AI settings, choosing a shot's target, and what the image model
// accepts. Generation costs credits and can be switched off in the settings.

import { assetImageDataUrl } from '../core/images';
import type { ShotDoc } from '../core/types';
import { defaultPaintoverPrompt, generatePaintovers, imageModelId, lastOptions, optionsForShot } from '../design/paintover';
import { describeSpec, listImageModels, MAX_IMAGES, modelParams, OWN_PARAMS, takesImages } from './images';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { num, optStr, ToolError, type Json } from './toolUtil';

function def(name: string, description: string, properties: Json = {}, required: string[] = []): ToolDef {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** Tools that spend credits on images; left out when the settings forbid it. */
export const PAID_IMAGE_TOOLS = new Set(['generate_paintover']);

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
        def('choose_paintover', 'Make one of a shot\'s paintovers its target, the image every later comparison of the shot uses. Only when the user asked you to choose; otherwise ask them to pick one (Design tab, the shot\'s Paintover button).', {
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
                    note: images.length
                        ? 'The new paintovers are attached in this order. Say which one keeps the blockout\'s composition best; the user chooses the target.'
                        : 'The user chooses the target in the Design tab.',
                },
                images,
                summary: `${res.paintovers.length} for ${shot.name}`,
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

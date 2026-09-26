// Paintovers: a shot's greybox capture and its concept image go to an image
// model, which keeps the composition and paints the style and mood over it
// (or the user uploads one drawn by hand). The chosen paintover becomes the
// shot's target: every later comparison uses it, while the concept stays as
// the record of the original idea.

import { putDesignImage } from '../core/assets';
import { assetImageDataUrl, compactImage, imageExt } from '../core/images';
import type { DesignDoc, PaintoverDoc, ParamValue, ShotDoc } from '../core/types';
import type { Editor } from '../editor';
import {
    checkParams, closestAspect, DEFAULT_IMAGE_MODEL, generateImages, listImageModels, modelParams, takesImages,
    type ImageModel,
} from '../ai/images';
import { aiSettings } from '../ai/settings';

export interface PaintoverSettings {
    model: string;
    prompt: string;
    /** Images to make, 1 to 10. */
    count: number;
    seed: number | null;
    /** Options from the model's supported parameters. */
    params: Record<string, ParamValue>;
    /** Partial images while generating (models that stream). */
    stream: boolean;
    /** More reference images (asset ids), after the capture and the concept. */
    extra: string[];
}

export interface PaintoverRun {
    paintovers: PaintoverDoc[];
    /** Credits spent, when reported. */
    cost: number | null;
    /** Requests that failed while others worked. */
    errors: string[];
    /** Options the model does not take, left out. */
    dropped: string[];
    /** The greybox capture sent as the first reference. */
    capture: string;
}

/** The image model to use: the one set in the AI settings, else the default. */
export function imageModelId(): string {
    return aiSettings.value.imageModel.trim() || DEFAULT_IMAGE_MODEL;
}

/** The default instruction: keep the blockout's composition, take style and mood from the concept and the brief. */
export function defaultPaintoverPrompt(design: DesignDoc, shot: ShotDoc): string {
    const area = design.areas.find((a) => a.id === shot.area);
    const mood = design.mood;
    const lines = [
        'Paint over the first image, a gray blockout render of a game level, so it shows how the finished scene should look.',
        'Keep its composition exactly: the camera, perspective and horizon, and the position, size and silhouette of every shape. Do not add, remove or move large forms.',
        shot.concept
            ? 'Take the art style, materials, colors, lighting and mood from the second image (the concept art).'
            : 'Invent materials, colors and lighting that fit the description below.',
    ];
    if (area) lines.push(`Place: ${area.name}${area.description ? `, ${area.description}` : ''}.${area.mood ? ` Mood here: ${area.mood}.` : ''}`);
    else if (design.layout.summary) lines.push(`Place: ${design.layout.summary}`);
    const moodBits = [
        mood.description,
        mood.timeOfDay ? `time of day: ${mood.timeOfDay}` : '',
        mood.keyLight.note ? `key light: ${mood.keyLight.note}` : '',
    ].filter(Boolean);
    if (moodBits.length) lines.push(`Mood: ${moodBits.join('; ')}.`);
    if (mood.palette.length) lines.push(`Palette: ${mood.palette.join(', ')}.`);
    lines.push('One finished illustration, no text, captions or frames.');
    return lines.join('\n');
}

// ------------------------------------------------------------ remembered

const OPTIONS_KEY = 'canonical-editor/image-options';

interface Remembered {
    count?: number;
    stream?: boolean;
    params?: Record<string, Record<string, ParamValue>>;
}

function remembered(): Remembered {
    try {
        const v = JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}');
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

/** Options last used with a model (count, streaming and its parameters). */
export function lastOptions(model: string): { count: number; stream: boolean; params: Record<string, ParamValue> } {
    const r = remembered();
    return { count: r.count ?? 2, stream: r.stream ?? false, params: { ...(r.params?.[model] ?? {}) } };
}

export function rememberOptions(model: string, count: number, stream: boolean, params: Record<string, ParamValue>) {
    const r = remembered();
    const all = { ...(r.params ?? {}), [model]: params };
    try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify({ count, stream, params: all }));
    } catch { /* ignore */ }
}

/** Starting options for a shot: remembered ones, with the aspect ratio of the shot where the model has one. */
export function optionsForShot(model: ImageModel | undefined, shot: ShotDoc, params: Record<string, ParamValue>): Record<string, ParamValue> {
    const specs = modelParams(model);
    const out: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(params)) if (specs[k] || !model) out[k] = v;
    const ratio = specs.aspect_ratio;
    const size = specs.size;
    if (ratio?.type === 'enum') {
        const v = closestAspect(ratio.values, shot.aspect);
        if (v) out.aspect_ratio = v;
    } else if (size?.type === 'enum') {
        // Models that take pixel sizes ("1536x1024"): keep a size shaped like
        // the shot, else take the one shaped most like it.
        const kept = typeof out.size === 'string' && sizeAspectError(out.size, shot.aspect) < 0.02 ? out.size : null;
        const v = kept ?? closestAspect(size.values, shot.aspect);
        if (v && /\d\s*x\s*\d/.test(v)) out.size = v;
    }
    return out;
}

function sizeAspectError(v: string, aspect: number): number {
    const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(v);
    return m ? Math.abs(Math.log(Number(m[1]) / Number(m[2]) / aspect)) : Infinity;
}

// ------------------------------------------------------------- generate

/**
 * Captures the shot (unless `capture` names an existing capture), sends it
 * with the concept and the extra references, and adds the results to the
 * shot's paintovers. Nothing is chosen: the user picks the target.
 */
export async function generatePaintovers(
    editor: Editor,
    shotId: string,
    settings: PaintoverSettings,
    opts: { signal?: AbortSignal; capture?: string | null; onPartial?: (index: number, url: string) => void; onProgress?: (done: number, total: number) => void } = {},
): Promise<PaintoverRun> {
    const key = aiSettings.apiKey;
    if (!key) throw new Error('Add an OpenRouter key in the AI settings first.');
    const pipeline = editor.pipeline;
    const shot = pipeline.shot(shotId);
    if (!shot) throw new Error('No such shot.');
    const models = await listImageModels().catch(() => [] as ImageModel[]);
    const model = models.find((m) => m.id === settings.model);
    if (models.length && !model) throw new Error(`"${settings.model}" is not an image model on OpenRouter.`);
    if (model && !takesImages(model)) throw new Error(`${model.name || model.id} does not take reference images. Pick a model that edits images (image to image).`);

    const doc = () => editor.store.doc;
    let capture = opts.capture && doc().assets.some((a) => a.id === opts.capture) ? opts.capture : null;
    if (!capture) capture = (await pipeline.captureShotAsset(shotId, 'paintover-ref')).id;
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const refs = [...new Set([capture, shot.concept, ...settings.extra].filter((id): id is string => !!id && doc().assets.some((a) => a.id === id && a.kind === 'image')))];
    const references: string[] = [];
    for (const id of refs) {
        const url = await assetImageDataUrl(id, 1536);
        if (url) references.push(url);
    }
    const { params, dropped } = checkParams(model, settings.params);
    const result = await generateImages(
        key,
        model,
        { model: settings.model, prompt: settings.prompt, references, count: settings.count, seed: settings.seed, params, stream: settings.stream },
        { signal: opts.signal, onPartial: opts.onPartial, onProgress: opts.onProgress },
    );
    const at = new Date().toISOString();
    const stem = fileStem(shot.name);
    const start = shot.paintovers.length;
    const metas = [];
    const paintovers: PaintoverDoc[] = [];
    for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        const blob = await compactImage(img.blob);
        const meta = await putDesignImage(blob, `${stem}-paintover-${start + i + 1}.${imageExt(blob.type)}`);
        metas.push(meta);
        paintovers.push({
            asset: meta.id,
            source: 'generated',
            at,
            model: settings.model,
            prompt: settings.prompt,
            seed: img.seed,
            refs,
            ...(Object.keys(params).length ? { params } : {}),
            cost: img.cost,
        });
    }
    editor.store.commit('Generate Paintovers', (d) => {
        d.assets.push(...metas);
        d.design.shots.find((s) => s.id === shotId)?.paintovers.push(...paintovers);
    }, { design: true });
    return { paintovers, cost: result.cost, errors: result.errors, dropped, capture };
}

/** Adds an image drawn by hand as a paintover; it becomes the target when the shot has none. */
export async function uploadPaintover(editor: Editor, shotId: string, file: Blob & { name?: string }): Promise<PaintoverDoc> {
    const shot = editor.pipeline.shot(shotId);
    if (!shot) throw new Error('No such shot.');
    const meta = await putDesignImage(file, file.name || `${fileStem(shot.name)}-paintover.${imageExt(file.type)}`);
    const po: PaintoverDoc = { asset: meta.id, source: 'upload', at: new Date().toISOString() };
    editor.store.commit('Upload Paintover', (d) => {
        d.assets.push(meta);
        const s = d.design.shots.find((x) => x.id === shotId);
        if (!s) return;
        s.paintovers.push(po);
        if (!s.target) {
            s.target = meta.id;
            delete s.stale;
        }
    }, { design: true });
    return po;
}

/** Credits spent on paintovers in this project, where reported. */
export function paintoverSpend(design: DesignDoc): number {
    let sum = 0;
    for (const s of design.shots) for (const p of s.paintovers) sum += p.cost ?? 0;
    return sum;
}

function fileStem(name: string): string {
    return name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shot';
}

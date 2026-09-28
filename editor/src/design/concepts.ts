// Concept art the image model draws from the plan, so the user can review
// the design before and while it is built: an area from outside or inside,
// the whole place from above, or a floor plan. References (other concepts,
// a capture of the greybox) keep the pictures consistent with what exists.
// Generated concepts are proposed until the user approves them.

import { putDesignImage } from '../core/assets';
import { assetImageDataUrl, blobToDataUrl, compactImage, imageExt } from '../core/images';
import type { AreaDoc, AssetMeta, ConceptDoc, DesignDoc, ParamValue } from '../core/types';
import type { Editor } from '../editor';
import { checkParams, closestAspect, generateImages, listImageModels, modelParams, takesImages, type ImageModel } from '../ai/images';
import { aiSettings } from '../ai/settings';
import { imageModelId } from './paintover';

export type ConceptView = 'exterior' | 'interior' | 'overview' | 'plan';

export const CONCEPT_VIEWS: Record<ConceptView, string> = {
    exterior: 'An eye-level view from outside, the way the player first sees the place: its silhouette, entrances and surroundings.',
    interior: 'A view inside at eye height: the room closed in by its walls, floor and ceiling, its doors, and what furnishes it.',
    overview: 'A high three-quarter view over the whole place, showing how its parts sit and connect.',
    plan: 'A clean top-down floor plan: thick dark walls closing every room, gaps for the doors, furniture as simple shapes.',
};

/** The default instruction: the view, the area and the plan, drawn buildable and to scale. */
export function conceptPrompt(design: DesignDoc, area: AreaDoc | null, view: ConceptView, instructions = ''): string {
    const lines = ['Concept art for a 3D game level, drawn so the design can be reviewed before it is built.', CONCEPT_VIEWS[view]];
    if (area) {
        lines.push(`Place: ${area.name}${area.description ? `, ${area.description}` : ''}.`);
        if (area.objects.length) lines.push(`It has: ${area.objects.map((o) => (o.count && o.count > 1 ? `${o.count} x ${o.name}` : o.name)).join(', ')}.`);
        if (area.mood) lines.push(`Mood here: ${area.mood}.`);
    }
    if (design.layout.summary) lines.push(`The whole place: ${design.layout.summary}`);
    const mood = [design.mood.description, design.mood.timeOfDay ? `time of day: ${design.mood.timeOfDay}` : '', design.mood.keyLight.note ? `key light: ${design.mood.keyLight.note}` : ''].filter(Boolean);
    if (mood.length) lines.push(`Mood: ${mood.join('; ')}.`);
    if (design.mood.palette.length) lines.push(`Palette: ${design.mood.palette.join(', ')}.`);
    lines.push(`Keep it buildable: clear shapes at a believable scale (a person is ${design.specs.playerHeight} m tall, doors are ${design.specs.doorWidth} m wide), closed and compact rooms, nothing floating.`);
    if (instructions.trim()) lines.push(instructions.trim());
    lines.push(view === 'plan' ? 'One drawing, no text or labels.' : 'One finished illustration, no text, captions, labels or frames.');
    return lines.join('\n');
}

export interface ConceptRun {
    concepts: ConceptDoc[];
    model: string;
    cost: number | null;
    errors: string[];
    /** Options or references left out, and why. */
    dropped: string[];
}

export interface ConceptSettings {
    area: AreaDoc | null;
    view: ConceptView;
    prompt: string;
    count: number;
    /** More reference images (asset ids): other concepts, paintovers. */
    references: string[];
    /** A capture of the greybox to paint from first: the current view, or a shot's id. */
    capture: 'view' | string | null;
    signal?: AbortSignal;
}

/** Draws concepts and adds them to the plan as proposed concepts of the area. */
export async function generateConcepts(editor: Editor, s: ConceptSettings): Promise<ConceptRun> {
    const key = aiSettings.apiKey;
    if (!key) throw new Error('Add an OpenRouter key in the AI settings first.');
    const model = imageModelId();
    const models = await listImageModels().catch(() => [] as ImageModel[]);
    const info = models.find((m) => m.id === model);
    if (models.length && !info) throw new Error(`"${model}" is not an image model on OpenRouter.`);
    const store = editor.store;
    const dropped: string[] = [];
    const aspect = s.view === 'plan' ? 1 : 16 / 9;

    // A capture of the greybox as it is comes first: the concept keeps its shapes and composition.
    let capture: string | null = null;
    if (s.capture) {
        const shot = s.capture === 'view' ? null : editor.pipeline.shot(s.capture);
        if (s.capture !== 'view' && !shot) throw new Error(`No shot "${s.capture}".`);
        const blob = shot ? await editor.pipeline.captureShot(shot.id, 1280) : await editor.pipeline.captureCamera(editor.pipeline.viewAsShot(aspect), aspect, 1280);
        capture = await blobToDataUrl(blob);
    }
    const refs = [...new Set(s.references)].filter((id) => store.doc.assets.some((a) => a.id === id && a.kind === 'image'));
    let references: string[] = [];
    if ((capture || refs.length) && info && !takesImages(info)) dropped.push(`reference images (${info.name || info.id} draws from the text only)`);
    else references = [...(capture ? [capture] : []), ...(await Promise.all(refs.map((id) => assetImageDataUrl(id, 1536)))).filter((u): u is string => !!u)];
    if (s.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const raw: Record<string, ParamValue> = {};
    const specs = modelParams(info);
    if (specs.aspect_ratio?.type === 'enum') {
        const v = closestAspect(specs.aspect_ratio.values, aspect);
        if (v) raw.aspect_ratio = v;
    } else if (specs.size?.type === 'enum') {
        const v = closestAspect(specs.size.values, aspect);
        if (v && /\d\s*x\s*\d/.test(v)) raw.size = v;
    }
    const checked = checkParams(info, raw);
    dropped.push(...checked.dropped);
    const result = await generateImages(key, info, { model, prompt: s.prompt, references, count: s.count, params: checked.params }, { signal: s.signal });

    const stem = (s.area?.name ?? 'scene').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scene';
    const metas: AssetMeta[] = [];
    const concepts: ConceptDoc[] = [];
    for (let i = 0; i < result.images.length; i++) {
        const blob = await compactImage(result.images[i].blob);
        const meta = await putDesignImage(blob, `${stem}-concept-${s.view}-${i + 1}.${imageExt(blob.type)}`);
        metas.push(meta);
        concepts.push({ asset: meta.id, area: s.area?.id ?? null, review: 'proposed', prompt: s.prompt, ...(capture ? { note: 'Drawn over a capture of the greybox.' } : {}) });
    }
    store.commit('Generate Concepts', (d) => {
        d.assets.push(...metas);
        d.design.concepts.push(...concepts);
    }, { design: true });
    return { concepts, model, cost: result.cost, errors: result.errors, dropped };
}

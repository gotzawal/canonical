// Short text descriptions of the project for the assistant: sent with every
// request (the pipeline state and the scene memo) and used to refresh the
// memo. Details stay behind the read_design tool.

import { areaName, STAGE_IDS, stageIndex } from '../core/design';
import type { SceneDoc } from '../core/types';
import { placedObjects, stageDef, stageProgress } from './stages';

const clip = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 3) + '...' : t;
};

/** Pipeline state: current stage, its checklist and the stages around it. */
export function pipelineSummary(doc: SceneDoc, fps?: number): string[] {
    const design = doc.design;
    const lines: string[] = [];
    const def = stageDef(design.stage);
    const st = design.stages[design.stage];
    const prog = stageProgress({ doc, design, fps }, design.stage);
    lines.push(`Pipeline stage ${stageIndex(design.stage) + 1}/${STAGE_IDS.length}: ${def.long}${st.status === 'done' ? ' (complete)' : ''}. Checklist ${prog.done}/${prog.total} done.`);
    if (prog.open.length) lines.push(`Open items: ${prog.open.map((i) => `[${i.id}] ${i.text}${i.detail ? ` (${i.detail})` : ''}`).join('; ')}`);
    if (st.proposal) lines.push(`You proposed completing this stage; waiting for the user to approve.`);
    const others = STAGE_IDS.filter((id) => id !== design.stage && design.stages[id].status !== 'todo').map((id) => `${stageDef(id).title} ${design.stages[id].status}${design.stages[id].recheck ? ` (${clip(design.stages[id].recheck!, 80)})` : ''}`);
    if (others.length) lines.push(`Other stages: ${others.join(', ')}`);
    if (def.locksPlacement && !design.unlocked) lines.push('Placement is locked in this stage: only lights, cameras and effects may move.');
    return lines;
}

/** The plan in a few lines (the brief and details come from read_design). */
export function designSummary(doc: SceneDoc): string[] {
    const d = doc.design;
    const lines: string[] = [];
    if (!d.brief.text.trim() && !d.areas.length) {
        lines.push(d.brief.skipped ? 'No planning brief (the user works without one).' : 'No planning brief yet.');
        return lines;
    }
    if (d.brief.text.trim()) {
        const changed = d.brief.structured !== undefined && d.brief.structured !== d.brief.text;
        lines.push(`Brief: ${d.brief.text.length} characters${changed ? ', edited since it was structured' : d.brief.structuredAt ? '' : ', not structured yet'}.`);
    }
    if (d.layout.summary) lines.push(`Layout: ${clip(d.layout.summary, 300)}`);
    if (d.areas.length) {
        const { total, placed } = placedObjects(doc, d);
        lines.push(
            `Areas (${d.areas.length}, ${placed}/${total} objects placed): ` +
                d.areas
                    .map((a) => {
                        const concepts = d.concepts.filter((c) => c.area === a.id).length;
                        return `${a.name} [id ${a.id}, ${a.objects.length} objects, ${concepts} concept${concepts === 1 ? '' : 's'}${a.rework ? `, rework from ${a.rework}` : ''}]`;
                    })
                    .join('; '),
        );
    }
    if (d.mood.description || d.mood.timeOfDay) lines.push(`Mood: ${clip([d.mood.timeOfDay, d.mood.description].filter(Boolean).join(' - '), 200)}`);
    const unassigned = d.concepts.filter((c) => !c.area).length;
    if (d.concepts.length) lines.push(`Concept images: ${d.concepts.length}${unassigned ? ` (${unassigned} not mapped to an area)` : ''}.`);
    if (d.shots.length) {
        lines.push(
            `Shots: ` +
                d.shots
                    .map((s) => `${s.name} [id ${s.id}${s.area ? `, ${areaName(d, s.area)}` : ''}${s.target ? ', target set' : ', no target'}${s.stale ? ', stale' : ''}${s.approved ? ', approved' : ''}]`)
                    .join('; '),
        );
    }
    if (d.materials.length) lines.push(`Material slots: ${d.materials.map((m) => `${m.name} [id ${m.id}${m.swatch ? '' : ', empty'}]`).join('; ')}`);
    const open = d.questions.filter((q) => !q.answer.trim());
    const answered = d.questions.filter((q) => q.answer.trim());
    if (open.length) lines.push(`Questions waiting for the user: ${open.map((q) => clip(q.text, 100)).join(' | ')}`);
    if (answered.length) lines.push(`Answered questions: ${answered.map((q) => `${clip(q.text, 80)} -> ${clip(q.answer, 120)}`).join(' | ')}`);
    return lines;
}

/** Scene memo: the running context the assistant keeps for itself across sessions. */
export function memoLines(doc: SceneDoc): string[] {
    const memo = doc.design.memo;
    if (!memo.text.trim()) return [];
    return [`Scene memo${memo.at ? ` (updated ${memo.at.slice(0, 16).replace('T', ' ')})` : ''}:`, memo.text.trim()];
}

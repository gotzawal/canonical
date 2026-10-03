// The level check from the Design tab: runs it and shows the plan view with
// the findings, and hands them to the assistant to fix.

import type { Editor } from '../editor';
import { runLevelCheck, summarize, type LevelReport } from '../design/levelCheck';
import { h } from './dom';
import { lightbox, modal, toast } from './overlays';
import { button } from './widgets';

let running = false;

const at = (p: number[]) => `(${p[0]}, ${p[2]})`;

/** Findings as short lines, worst first. */
export function reportLines(r: LevelReport): string[] {
    const out: string[] = [];
    for (const s of r.seams) out.push(`Seam of ${Math.round(s.gap * 100)} cm between ${s.a} and ${s.b} at ${at(s.at)}`);
    for (const o of r.openings) if (o.kind === 'gap_low' || o.kind === 'gap_high') out.push(`Gap in a wall ${o.kind === 'gap_low' ? 'at the floor' : 'under the ceiling'} at ${at(o.at)}, about ${o.width} m wide`);
    for (const hole of r.roofHoles) out.push(`Hole in a roof at ${at(hole.at)}, ${hole.area} m²`);
    for (const hole of r.floorHoles) out.push(`Hole in a floor at ${at(hole.at)}, ${hole.area} m²`);
    for (const u of r.unreachable) out.push(`${u.name} cannot be reached on foot`);
    for (const s of r.sealed) out.push(`A roofed space of ${s.area} m² at ${at(s.at)} has no way in`);
    for (const f of r.floating) out.push(`${f.name} floats${f.gap !== null ? ` ${f.gap} m above what is below it` : ' in the air'}`);
    for (const e of r.empty) out.push(`${e.indoor ? 'Empty room space' : 'Empty ground'} of about ${e.size[0]} x ${e.size[1]} m around ${at(e.at)}`);
    for (const o of r.openings) if (o.kind === 'passage' || o.kind === 'window') out.push(`${o.kind === 'passage' ? 'Passage' : 'Window'} at ${at(o.at)}, about ${o.width} m wide (fine)`);
    out.push(...r.notes);
    return out;
}

export async function openLevelCheck(editor: Editor) {
    if (running) return;
    if (editor.player.state !== 'stopped') {
        toast('Stop Play first: the check looks at the level as it is built.', 'info');
        return;
    }
    if (editor.isolated) {
        toast('Finish editing the prefab first (Apply or Discard).', 'info');
        return;
    }
    running = true;
    toast('Checking the level...', 'info', 2000);
    let result;
    try {
        result = await runLevelCheck(editor);
    } catch (e: any) {
        toast(e?.message || String(e), 'error');
        return;
    } finally {
        running = false;
    }
    const r = result.report;
    const lines = reportLines(r);
    const img = h('img', { class: 'level-map', attrs: { src: result.map, alt: 'Plan view of the level check' } });
    img.addEventListener('click', () => lightbox(result.map, 'Level check'));
    const stats = r.stats;
    // Where the body it walked with is set: the player's Character, else the brief's specs.
    const player = editor.store.doc.nodes.some((n) => n.player && n.character);
    const walker = `Walked with ${player ? 'the player\'s body (its Character in the inspector)' : 'the brief\'s body (Design tab, Specs)'}: steps up to ${r.body.stepHeight} m, slopes up to ${r.body.maxSlope}°.`;
    const body = h(
        'div',
        { class: 'level-check' },
        h('div', { class: `design-note ${r.ok ? 'ok' : 'warn'}`, text: summarize(r) }),
        img,
        h('ul', { class: 'level-findings' }, lines.slice(0, 40).map((l) => h('li', { text: l }))),
        h('div', {
            class: 'muted small',
            text: `Walkable ${stats.walkable} m²${stats.reachable !== null ? `, reached ${stats.reachable} m²` : ''}, roofed ${stats.indoor} m²${stats.ceiling !== null ? `, ceilings about ${stats.ceiling} m high` : ''}; built ${stats.footprint[0]} x ${stats.footprint[1]} m. Grid ${r.region.step} m. ${walker}`,
        }),
    );
    const m = modal('Level check', body, { cls: 'level-check-dialog' });
    if (!r.ok || r.empty.length) {
        m.footer.append(
            button('Ask the AI to fix these', () => {
                m.close();
                editor.askAI(`The level check found: ${summarize(r)} Run check_level, fix what it finds (keep passages and windows) and check again.`, true);
            }, 'primary', 'sparkle'),
        );
    }
    m.footer.append(button('Close', () => m.close()));
}

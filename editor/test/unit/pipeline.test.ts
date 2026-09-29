import { describe, expect, it } from 'vitest';
import { allowedGroups, type ToolEnv } from '../../src/ai/toolUtil';
import { detailLevel, layoutSignature, planStarted, sanitizeDesign } from '../../src/core/design';
import { makeLightNode, makeMeshNode, newScene } from '../../src/core/defaults';
import type { SceneDoc } from '../../src/core/types';
import { pipelineSummary } from '../../src/design/context';
import { ALL_TOOL_GROUPS, layoutChanged, stageDef, stepOf, stepsProgress } from '../../src/design/stages';

/** What allowedGroups reads of the tool environment. */
function env(doc: SceneDoc, limitTools: boolean): ToolEnv {
    return { limitTools: () => limitTools, editor: { pipeline: { design: doc.design } } } as unknown as ToolEnv;
}

/** A scene whose Level stage is done, in the Lighting stage, its layout recorded when Level was completed. */
function afterLevel(): SceneDoc {
    const doc = newScene();
    doc.design.brief.text = 'A cabin by a lake';
    doc.design.stages.brief.status = 'done';
    doc.design.stages.level.status = 'done';
    doc.design.stages.level.signature = layoutSignature(doc);
    doc.design.stage = 'light';
    doc.design.stages.light.status = 'active';
    return doc;
}

describe('tools by stage', () => {
    it('limits nothing unless the AI settings ask for it', () => {
        const doc = afterLevel();
        expect([...allowedGroups(env(doc, false))].sort()).toEqual([...ALL_TOOL_GROUPS].sort());
    });

    it('limits nothing before the project started, also when the start screen was just closed', () => {
        const doc = newScene();
        expect(planStarted(doc.design)).toBe(false);
        expect(allowedGroups(env(doc, true)).has('objects')).toBe(true);
        doc.design.brief.skipped = true;
        expect(allowedGroups(env(doc, true)).has('objects')).toBe(true);
    });

    it('limits the tools to the stage once the project started, when asked to', () => {
        const doc = newScene();
        doc.design.brief.text = 'A castle courtyard';
        expect(planStarted(doc.design)).toBe(true);
        expect([...allowedGroups(env(doc, true))].sort()).toEqual([...stageDef('brief').tools].sort());
    });
});

describe('the pipeline in steps', () => {
    it('decides the details by default', () => {
        const doc = newScene();
        expect(detailLevel(doc.design)).toBe('quick');
        doc.design.detail = 'detailed';
        expect(detailLevel(doc.design)).toBe('detailed');
    });

    it('shows the stages as three steps', () => {
        expect(stepOf('brief').id).toBe('layout');
        expect(stepOf('level').id).toBe('layout');
        expect(stepOf('material').id).toBe('look');
        expect(stepOf('finish').id).toBe('finish');
        const fresh = newScene();
        expect(stepsProgress(fresh).map((s) => s.state)).toEqual(['todo', 'todo', 'todo']);
        const doc = afterLevel();
        expect(stepsProgress(doc).map((s) => s.state)).toEqual(['done', 'current', 'todo']);
        doc.design.stage = 'finish';
        doc.design.stages.finish.status = 'done';
        expect(stepsProgress(doc).map((s) => s.state)).toEqual(['done', 'done', 'done']);
    });

    it('marks the layout for a recheck when the level changes after it was done, not when a light moves', () => {
        const doc = afterLevel();
        const sun = doc.nodes.find((n) => n.light)!;
        sun.rotation = [10, 20, 30];
        doc.nodes.push(makeLightNode('point'));
        expect(layoutChanged(doc)).toBe(false);
        expect(stepsProgress(doc)[0].recheck).toBeUndefined();

        const cube = doc.nodes.find((n) => n.name === 'Cube')!;
        cube.position = [3, 0.5, 0];
        expect(layoutChanged(doc)).toBe(true);
        expect(stepsProgress(doc)[0].recheck).toMatch(/layout changed/);
        expect(pipelineSummary(doc).join('\n')).toMatch(/Layout needs a recheck/);

        // A passing level check records the level as it is: the mark goes.
        doc.design.stages.level.signature = layoutSignature(doc);
        expect(layoutChanged(doc)).toBe(false);
        doc.nodes.push(makeMeshNode('box'));
        expect(layoutChanged(doc)).toBe(true);
    });

    it('tells the assistant that nothing limits it before the project started', () => {
        const lines = pipelineSummary(newScene()).join('\n');
        expect(lines).toMatch(/not started/);
        expect(lines).toMatch(/Detail level: quick/);
        expect(lines).not.toMatch(/Placement is locked/);
    });

    it('keeps what the stages recorded and the version pictures in files, and drops the old placement lock', () => {
        const doc = afterLevel();
        const input = JSON.parse(JSON.stringify(doc.design));
        input.unlocked = true;
        input.snapshots = [{ id: 'sn1', asset: 'a1', name: 'After: a cabin', stage: 'light', at: '2026-01-01T00:00:00Z', assets: [], thumb: 'a2', auto: true }];
        const design = sanitizeDesign(input);
        expect(design.stages.level.signature).toBe(doc.design.stages.level.signature);
        expect(design.snapshots[0]).toMatchObject({ thumb: 'a2', auto: true });
        expect('unlocked' in design).toBe(false);
    });
});

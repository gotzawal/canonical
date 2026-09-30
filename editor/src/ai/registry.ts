// The assistant's tools in one list. toolDefs() gives the model the tools
// the detail level and AI settings offer (and the current stage, when the
// settings limit the tools by stage); runTool() runs one and refuses what is
// not offered. Each tool is an entry of its module's list (see Tool in
// toolUtil.ts): its name, arguments, groups, needs and handler.

import { detailLevel } from '../core/design';
import { stageDef, type ToolGroup } from '../design/stages';
import { behaviorTools } from './behaviorTools';
import { codeTools } from './codeTools';
import { designTools } from './designTools';
import { effectTools } from './effectTools';
import { greyboxTools } from './greyboxTools';
import { imageTools } from './imageTools';
import { levelTools } from './levelTools';
import { materialTools } from './materialTools';
import type { ToolDef } from '../openrouter/client';
import { sceneTools } from './sceneTools';
import { allowedGroups, definition, ToolError, type Json, type Tool, type ToolEnv, type ToolResult } from './toolUtil';

export const TOOLS: Tool[] = [...sceneTools, ...codeTools, ...designTools, ...greyboxTools, ...imageTools, ...materialTools, ...effectTools, ...behaviorTools, ...levelTools];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** What a tool works on, for the usage statistics: its first group (null for an unknown tool). */
export function toolWork(name: string): ToolGroup | null {
    return BY_NAME.get(name)?.groups[0] ?? null;
}

/** Why a tool is not offered now ('' when it is). */
function unavailable(env: ToolEnv, t: Tool, allowed = allowedGroups(env)): string {
    if (!t.groups.some((g) => allowed.has(g))) {
        const stage = stageDef(env.editor.pipeline.design.stage);
        return `${t.name} belongs to another stage, and the AI settings limit your tools to the ${stage.title} stage. Tell the user what you would do; they can turn the limit off in the AI settings.`;
    }
    if (t.needs === 'play' && !env.allowPlay()) return 'Play is turned off in the AI settings.';
    if (t.needs === 'screenshots' && !env.screenshots()) return 'Screenshots are turned off in the AI settings.';
    if (t.needs === 'images' && !env.allowImages()) return 'Image generation is turned off in the AI settings.';
    const quick = detailLevel(env.editor.store.doc.design) === 'quick';
    if (t.detail === 'detailed' && quick) return 'The user wants you to decide the details yourself: decide, write your choice into the plan and go on.';
    if (t.detail === 'quick' && !quick) return 'Only the user judges this, unless they let you decide the details (detail level quick).';
    return '';
}

/** The definitions of the tools offered now. */
export function toolDefs(env: ToolEnv): ToolDef[] {
    const allowed = allowedGroups(env);
    return TOOLS.filter((t) => !unavailable(env, t, allowed)).map(definition);
}

/** Runs one tool call against the editor; an error goes back to the model as the result. */
export async function runTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult> {
    try {
        const t = BY_NAME.get(name);
        if (!t) throw new ToolError(`Unknown tool "${name}".`);
        const why = unavailable(env, t);
        if (why) throw new ToolError(why);
        const ed = env.editor;
        return await t.run({ args, env, ed, store: ed.store, doc: () => ed.store.doc });
    } catch (e: any) {
        // A stopped request stops here; the agent reports it.
        if (e?.name === 'AbortError') throw e;
        const message = e instanceof ToolError ? e.message : `${e?.name || 'Error'}: ${e?.message || e}`;
        if (!(e instanceof ToolError)) console.error('[ai] tool failed', name, e);
        return { data: { error: message }, summary: 'error' };
    }
}

// What the assistant's tools are made of (ai/registry.ts lists them): the
// tool entry, what a tool gets and returns, and argument parsing.

import { tidy } from '../core/math';
import { InputError as ToolError } from '../core/schema';
import type { Store } from '../core/store';
import type { DetailLevel, NodeDoc, ParamValue, SceneDoc, Vec3 } from '../core/types';
import { ALL_TOOL_GROUPS, stageDef, type ToolGroup } from '../design/stages';
import type { Editor } from '../editor';
import { normalizeHex } from '../engine/color';
import type { ToolDef } from './openrouter';

export type Json = Record<string, any>;

export interface ToolEnv {
    editor: Editor;
    allowPlay(): boolean;
    screenshots(): boolean;
    /** The pipeline stage limits the tools. */
    stageTools(): boolean;
    /** Tools may spend credits on images. */
    allowImages(): boolean;
    /** Aborts long tools (image generation) when the request is stopped. */
    signal?: AbortSignal;
}

export interface ToolResult {
    /** JSON-able result sent back to the model. */
    data: unknown;
    /** A data: URL image to show the model (vision models only). */
    image?: string;
    /** More images to show the model. */
    images?: string[];
    /** Short line for the chat log. */
    summary?: string;
    /** Buttons for the user to answer with in the chat (the assistant waits for the answer). */
    choice?: ToolChoice;
}

/** A question with buttons shown in the chat; a button sends its label as the user's answer. */
export interface ToolChoice {
    /** What picking an option also sets: 'detail' sets the plan's detail level to the option's value. */
    kind: 'detail';
    question: string;
    options: { value: string; label: string }[];
}

/** What a tool's handler gets: its arguments, the editor and the request's settings. */
export interface ToolCall {
    args: Json;
    env: ToolEnv;
    ed: Editor;
    store: Store;
    /** The document now (every commit replaces it). */
    doc(): SceneDoc;
}

/** One tool of the assistant: what the model is told about it, when it is offered, and what it does. */
export interface Tool {
    name: string;
    description: string;
    /** The arguments' properties (JSON schema) and the required ones. */
    params?: Json;
    required?: string[];
    /**
     * Pipeline groups that offer it (see design/stages.ts): a tool is offered
     * when the current stage allows one of them; 'read' is in every stage.
     */
    groups: ToolGroup[];
    /** Offered only when the AI settings allow playing, screenshots, or image generation (costs credits). */
    needs?: 'play' | 'screenshots' | 'images';
    /** Offered only at this detail level: questions when the user refines, own judgments when the assistant decides. */
    detail?: DetailLevel;
    run(call: ToolCall): ToolResult | Promise<ToolResult>;
}

/** A module's tools, by name. */
export const tools = (byName: Record<string, Omit<Tool, 'name'>>): Tool[] => Object.entries(byName).map(([name, t]) => ({ name, ...t }));

/** The definition the model gets. */
export const definition = (t: Tool): ToolDef => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.params ?? {}, required: t.required ?? [] } },
});

/** Groups the assistant may use now: the stage's, or all of them when the stage does not limit tools. */
export function allowedGroups(env: ToolEnv): Set<ToolGroup> {
    if (!env.stageTools()) return new Set(ALL_TOOL_GROUPS);
    const design = env.editor.pipeline.design;
    // Working without a brief: the pipeline has not started, so the Brief stage limits nothing.
    if (design.stage === 'brief' && design.brief.skipped) return new Set(ALL_TOOL_GROUPS);
    return new Set(stageDef(design.stage).tools);
}

/** An error the model caused (bad arguments); its message goes back to the model. */
export { ToolError };

export const r3 = (v: number) => tidy(v, 3);
export const rv = (v: number[]) => v.map(r3);

let colorCtx: CanvasRenderingContext2D | null = null;
export function hex(v: unknown, what = 'color'): string {
    if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${what} must be a color string like "#ff8800".`);
    const s = v.trim();
    if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return normalizeHex(s.startsWith('#') ? s : '#' + s);
    colorCtx ??= document.createElement('canvas').getContext('2d');
    if (colorCtx) {
        colorCtx.fillStyle = '#010203';
        colorCtx.fillStyle = s;
        const out = String(colorCtx.fillStyle);
        if (out !== '#010203' && /^#[0-9a-f]{6}$/i.test(out)) return out;
    }
    throw new ToolError(`"${s}" is not a color.`);
}

export function num(v: unknown, what: string): number {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`${what} must be a number.`);
    return n;
}

export function v3(v: unknown, what: string): Vec3 {
    if (!Array.isArray(v) || v.length !== 3) throw new ToolError(`${what} must be an array of 3 numbers.`);
    return [num(v[0], what), num(v[1], what), num(v[2], what)];
}

export function params(v: unknown): Record<string, ParamValue> {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError('params must be an object.');
    const out: Record<string, ParamValue> = {};
    for (const [k, x] of Object.entries(v as Json)) {
        if (typeof x === 'number' || typeof x === 'boolean') out[k] = x;
        else if (typeof x === 'string') out[k] = /^#?[0-9a-f]{6}$/i.test(x) ? hex(x) : x;
        else if (Array.isArray(x) && x.every((n) => typeof n === 'number')) out[k] = x;
        else throw new ToolError(`params.${k} has an unsupported value.`);
    }
    return out;
}

export function node(doc: SceneDoc, ref: unknown): NodeDoc {
    if (typeof ref !== 'string' || !ref) throw new ToolError('Missing object id.');
    const n = doc.nodes.find((x) => x.id === ref) ?? doc.nodes.find((x) => x.name === ref);
    if (!n) throw new ToolError(`No object "${ref}". Call get_scene for the ids.`);
    return n;
}

export function script(doc: SceneDoc, ref: unknown) {
    if (typeof ref !== 'string') throw new ToolError('Missing script id or name.');
    const want = ref.toLowerCase().replace(/\.js$/, '');
    const s = doc.scripts.find((x) => x.id === ref) ?? doc.scripts.find((x) => x.name.toLowerCase().replace(/\.js$/, '') === want);
    if (!s) throw new ToolError(`No script "${ref}".`);
    return s;
}

export function shader(doc: SceneDoc, ref: unknown) {
    if (typeof ref !== 'string') throw new ToolError('Missing shader id or name.');
    const want = ref.toLowerCase().replace(/\.wgsl$/, '');
    const s = doc.shaders.find((x) => x.id === ref) ?? doc.shaders.find((x) => x.name.toLowerCase().replace(/\.wgsl$/, '') === want);
    if (!s) throw new ToolError(`No shader "${ref}".`);
    return s;
}

export function str(v: unknown, what: string, max = 20000): string {
    if (typeof v !== 'string') throw new ToolError(`${what} must be a string.`);
    return v.slice(0, max);
}

/** Optional string: undefined stays undefined. */
export function optStr(v: unknown, what: string, max = 20000): string | undefined {
    return v === undefined || v === null ? undefined : str(v, what, max);
}

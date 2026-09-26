// Argument parsing shared by the assistant's tools.

import { tidy } from '../core/math';
import type { NodeDoc, ParamValue, SceneDoc, Vec3 } from '../core/types';
import { normalizeHex } from '../engine/color';

export type Json = Record<string, any>;

/** An error the model caused (bad arguments); its message goes back to the model. */
export class ToolError extends Error {}

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

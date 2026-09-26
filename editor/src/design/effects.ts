// Post effects the Effects and Finish stages add: a vignette and the lift /
// gamma / gain color grade, each a post shader in the render graph that
// stays editable like any other (Render Graph panel, code editor).

import { LGG_CODE, SHADER_TEMPLATES } from '../core/templates';
import type { ParamValue, ShaderDoc } from '../core/types';
import type { Editor } from '../editor';

const GRADE_NAME = 'ColorGrade.wgsl';
const VIGNETTE_NAME = 'Vignette.wgsl';

function findShader(editor: Editor, name: string, marker: string): ShaderDoc | undefined {
    const shaders = editor.store.doc.shaders.filter((s) => s.kind === 'post');
    return shaders.find((s) => s.code.includes(marker)) ?? shaders.find((s) => s.name === name);
}

/** The post effect running `shader`, added (and the shader created) when missing. Returns the post id. */
function ensurePost(editor: Editor, name: string, marker: string, code: string): string | null {
    let shader = findShader(editor, name, marker);
    if (!shader) shader = editor.createShader({ name: name.replace(/\.wgsl$/, ''), kind: 'post', lighting: 'unlit', code, open: false });
    const existing = editor.store.doc.renderGraph.posts.find((p) => p.shader === shader!.id);
    if (existing) {
        if (!existing.enabled) editor.updatePostEffect(existing.id, { enabled: true }, 'Enable Post Effect');
        return existing.id;
    }
    return editor.addPostEffect(shader.id);
}

/** Adds (or updates) the lift / gamma / gain color grade; values are [r, g, b, all]. */
export function addColorGrade(editor: Editor, values: { lift?: number[]; gamma?: number[]; gain?: number[]; saturation?: number } = {}): string | null {
    const id = ensurePost(editor, GRADE_NAME, 'lift, gamma and gain', LGG_CODE);
    if (!id) return null;
    const params: Record<string, ParamValue> = {};
    if (values.lift) params.lift = vec4(values.lift, 0);
    if (values.gamma) params.gamma = vec4(values.gamma, 1);
    if (values.gain) params.gain = vec4(values.gain, 1);
    if (values.saturation !== undefined) params.saturation = values.saturation;
    if (Object.keys(params).length) {
        const cur = editor.store.doc.renderGraph.posts.find((p) => p.id === id);
        editor.updatePostEffect(id, { params: { ...(cur?.params ?? {}), ...params } }, 'Color Grade');
    }
    return id;
}

/** Adds (or turns on) a vignette. */
export function addVignette(editor: Editor, strength?: number): string | null {
    const code = SHADER_TEMPLATES.find((t) => t.id === 'vignette')!.code;
    const id = ensurePost(editor, VIGNETTE_NAME, 'smoothstep(materialUniform.radius', code);
    if (id && strength !== undefined) {
        const cur = editor.store.doc.renderGraph.posts.find((p) => p.id === id);
        editor.updatePostEffect(id, { params: { ...(cur?.params ?? {}), strength } }, 'Vignette');
    }
    return id;
}

/** [r, g, b, all] from 1 to 4 numbers: one number sets `all`. */
function vec4(v: number[], neutral: number): number[] {
    const n = v.filter((x) => Number.isFinite(x));
    if (n.length === 1) return [neutral, neutral, neutral, n[0]];
    if (n.length === 3) return [n[0], n[1], n[2], neutral];
    return [n[0] ?? neutral, n[1] ?? neutral, n[2] ?? neutral, n[3] ?? neutral];
}

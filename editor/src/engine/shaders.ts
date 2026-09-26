import {
    BlendMode, Color, Engine3D, GPUTextureFormat, Material, PassType, PostBase, Preprocessor, RenderShaderPass,
    RenderTexture, Shader, ShaderLib, Vector4, View3D, ViewQuad,
} from '@orillusion/core';
import { Emitter } from '../core/events';
import type { Store } from '../core/store';
import type { ParamValue, ShaderDoc, ShaderKind } from '../core/types';
import { hexToColor, normalizeHex } from './color';
import type { Runtime } from './runtime';

// Custom shaders are WGSL written against the engine's shader library. The
// user writes `frag()` (and optionally `vert()`) for materials, or
// `post(uv)` for post effects; this module wraps that in the includes,
// uniform struct and bindings the engine expects, validates the result on
// the GPU, and only hands valid versions to the renderer so a typo never
// breaks the viewport.

export type ShaderPropType = 'float' | 'color' | 'vec4' | 'texture';

export interface ShaderProperty {
    name: string;
    type: ShaderPropType;
    default: ParamValue;
    min?: number;
    max?: number;
    /** 1-based line of the declaration in the user code. */
    line: number;
}

export interface ShaderMessage {
    /** 1-based line in the user code; 0 when the message has no position. */
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning';
}

export interface ShaderStatus {
    state: 'idle' | 'compiling' | 'ok' | 'error';
    messages: ShaderMessage[];
    /** Properties of the last version that compiled. */
    props: ShaderProperty[];
    /** Increases every time a new version is handed to the renderer. */
    version: number;
}

interface CompiledShader {
    /** ShaderLib key of this version. */
    name: string;
    kind: ShaderKind;
    lighting: 'lit' | 'unlit';
    props: ShaderProperty[];
    version: number;
    /** The code has its own vertex function (it may move vertices). */
    hasVert: boolean;
}

interface ShaderEntry {
    key: string;
    status: ShaderStatus;
    valid: CompiledShader | null;
    pending: Promise<void> | null;
    queued: ShaderDoc | null;
}

interface ShaderEvents {
    /** Status (and possibly the valid version) of a shader changed. */
    status: string;
    /** A new valid version of a shader is available. */
    compiled: string;
}

const USER_BEGIN = 'fn canonical_user_code_begin() {}';
const TEXTURE_DEFAULTS = ['white', 'black', 'gray', 'normal'] as const;

/** Uniform struct of the engine's PBR material, which the lighting code reads. */
const ENGINE_FIELDS = `
    baseColor: vec4<f32>,
    emissiveColor: vec4<f32>,
    materialF0: vec4<f32>,
    specularColor: vec4<f32>,
    envIntensity: f32,
    normalScale: f32,
    roughness: f32,
    metallic: f32,
    ao: f32,
    roughness_min: f32,
    roughness_max: f32,
    metallic_min: f32,
    metallic_max: f32,
    emissiveIntensity: f32,
    alphaCutoff: f32,
    ior: f32,
    clearcoatColor: vec4<f32>,
    clearcoatWeight: f32,
    clearcoatFactor: f32,
    clearcoatRoughnessFactor: f32,
    clearcoatIor: f32,
    transmissionFactor: f32,
    thicknessFactor: f32,
    attenuationDistance: f32,
    transmissionAlphaMode: f32,
    attenuationColor: vec4<f32>,
    baseMapOffsetSize: vec4<f32>,
    normalMapOffsetSize: vec4<f32>,
    emissiveMapOffsetSize: vec4<f32>,
    roughnessMapOffsetSize: vec4<f32>,
    metallicMapOffsetSize: vec4<f32>,
    aoMapOffsetSize: vec4<f32>,`;

const RESERVED = new Set([
    ...ENGINE_FIELDS.split(/[\s,]+/).filter((s) => s.endsWith(':')).map((s) => s.slice(0, -1)),
    'baseMap', 'normalMap', 'maskMap', 'emissiveMap', 'aoMap', 'shadowBias', 'x', 'y', 'width', 'height',
    'fn', 'let', 'var', 'const', 'struct', 'return', 'if', 'else', 'for', 'loop', 'while', 'true', 'false',
    'f32', 'i32', 'u32', 'bool', 'vec2', 'vec3', 'vec4', 'mat4x4', 'texture', 'sampler', 'discard',
]);

// ------------------------------------------------------------------- parse

export interface ParsedShader {
    props: ShaderProperty[];
    errors: ShaderMessage[];
    /** User code with comments removed and #include lines blanked, line count preserved. */
    body: string;
    includes: string[];
    hasVert: boolean;
    hasEntry: boolean;
}

/** Reads `// @property` declarations and prepares the code for wrapping. */
export function parseShader(code: string, kind: ShaderKind): ParsedShader {
    const props: ShaderProperty[] = [];
    const errors: ShaderMessage[] = [];
    const includes: string[] = [];
    const lines = code.replace(/\r\n?/g, '\n').split('\n');
    const seen = new Set<string>();
    lines.forEach((text, i) => {
        const m = /^\s*\/\/\s*@prop(?:erty)?\b(.*)$/.exec(text);
        if (!m) return;
        const line = i + 1;
        const parts = m[1].trim().split(/\s+/).filter(Boolean);
        const [name, type, ...rest] = parts;
        const fail = (message: string) => errors.push({ line, column: 1, message, severity: 'error' });
        if (!name || !type) return fail('Expected "// @property <name> <float|color|vec4|texture> [default]".');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return fail(`"${name}" is not a valid property name.`);
        if (RESERVED.has(name) || name.startsWith('__')) return fail(`"${name}" is a reserved name, pick another one.`);
        if (seen.has(name)) return fail(`Property "${name}" is declared twice.`);
        let prop: ShaderProperty | null = null;
        if (type === 'float' || type === 'int') {
            const nums = rest.map(Number);
            if (nums.some((n) => !Number.isFinite(n))) return fail(`Expected numbers after "${type}".`);
            prop = { name, type: 'float', default: nums[0] ?? 0, line };
            if (nums.length >= 3) {
                prop.min = Math.min(nums[1], nums[2]);
                prop.max = Math.max(nums[1], nums[2]);
            }
        } else if (type === 'color') {
            const hex = rest[0] ?? '#ffffff';
            if (!/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return fail(`"${hex}" is not a #rrggbb color.`);
            prop = { name, type: 'color', default: normalizeHex(hex.startsWith('#') ? hex : '#' + hex), line };
        } else if (type === 'vec4') {
            const nums = rest.map(Number);
            if (nums.some((n) => !Number.isFinite(n))) return fail('Expected up to four numbers after "vec4".');
            prop = { name, type: 'vec4', default: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0], line };
        } else if (type === 'texture') {
            const d = (rest[0] ?? 'white').toLowerCase();
            if (!(TEXTURE_DEFAULTS as readonly string[]).includes(d)) return fail(`Texture default must be one of ${TEXTURE_DEFAULTS.join(', ')}.`);
            prop = { name, type: 'texture', default: d, line };
        } else {
            return fail(`Unknown property type "${type}". Use float, color, vec4 or texture.`);
        }
        seen.add(name);
        props.push(prop);
    });

    // Strip comments but keep every line break so error lines still match.
    let body = '';
    const src = lines.join('\n');
    for (let i = 0; i < src.length;) {
        if (src[i] === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
        } else if (src[i] === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end < 0 ? src.length : end + 2;
            body += src.slice(i, stop).replace(/[^\n]/g, '');
            i = stop;
        } else {
            body += src[i++];
        }
    }
    body = body
        .split('\n')
        .map((l) => {
            const inc = /^\s*#include\s+["<]([^">]+)[">]/.exec(l);
            if (inc) {
                includes.push(inc[1]);
                return '';
            }
            return l;
        })
        .join('\n');

    const hasVert = /\bfn\s+vert\s*\(/.test(body);
    const entry = kind === 'post' ? /\bfn\s+post\s*\(/ : /\bfn\s+frag\s*\(/;
    const hasEntry = entry.test(body);
    if (!hasEntry) {
        errors.push({
            line: 0,
            column: 0,
            severity: 'error',
            message: kind === 'post' ? 'Missing "fn post(uv: vec2f) -> vec4f".' : 'Missing "fn frag()".',
        });
    }
    return { props, errors, body, includes, hasVert, hasEntry };
}

function structFields(props: ShaderProperty[]): string {
    // Vectors first, then scalars: the engine packs uniforms back to back,
    // so this order keeps every vec4 on a 16 byte boundary.
    const vecs = props.filter((p) => p.type === 'color' || p.type === 'vec4').map((p) => `    ${p.name}: vec4<f32>,`);
    const floats = props.filter((p) => p.type === 'float').map((p) => `    ${p.name}: f32,`);
    return [...vecs, ...floats].join('\n');
}

function textureBindings(props: ShaderProperty[]): string {
    return props
        .filter((p) => p.type === 'texture')
        .map((p) => `@group(1) @binding(auto) var ${p.name}Sampler: sampler;\n@group(1) @binding(auto) var ${p.name}: texture_2d<f32>;`)
        .join('\n');
}

/** Full shader source as registered in ShaderLib. */
export function buildSource(doc: Pick<ShaderDoc, 'kind' | 'lighting'>, parsed: ParsedShader): string {
    const includes = parsed.includes.map((n) => `#include "${n}"`).join('\n');
    if (doc.kind === 'post') {
        const fields = structFields(parsed.props) || '    canonical_pad: vec4<f32>,';
        return [
            '#include "GlobalUniform"',
            includes,
            'struct FragmentOutput {',
            '    @location(auto) o_Target: vec4<f32>',
            '};',
            '@group(1) @binding(auto) var baseMapSampler: sampler;',
            '@group(1) @binding(auto) var baseMap: texture_2d<f32>;',
            textureBindings(parsed.props),
            'struct MaterialUniform {',
            fields,
            '};',
            '@group(2) @binding(0) var<uniform> materialUniform: MaterialUniform;',
            'fn sceneColor(uv: vec2f) -> vec4f { return textureSampleLevel(baseMap, baseMapSampler, uv, 0.0); }',
            'fn getTime() -> f32 { return globalUniform.time * 0.001; }',
            'fn screenSize() -> vec2f { return vec2f(globalUniform.windowWidth, globalUniform.windowHeight); }',
            '@fragment',
            'fn main(@location(auto) fragUV: vec2<f32>) -> FragmentOutput {',
            '    var uv = fragUV;',
            '    uv.y = 1.0 - uv.y;',
            '    return FragmentOutput(post(uv));',
            '}',
            USER_BEGIN,
            parsed.body,
        ].join('\n');
    }
    const lit = doc.lighting === 'lit';
    return [
        '#include "Common_vert"',
        '#include "Common_frag"',
        lit ? '#include "BxDF_frag"' : '#include "UnLit_frag"',
        '#include "PhysicMaterialUniform_frag"',
        includes,
        'struct MaterialUniform {',
        ENGINE_FIELDS,
        structFields(parsed.props),
        '};',
        '@group(1) @binding(auto) var baseMapSampler: sampler;',
        '@group(1) @binding(auto) var baseMap: texture_2d<f32>;',
        textureBindings(parsed.props),
        'fn getTime() -> f32 { return globalUniform.time * 0.001; }',
        parsed.hasVert ? '' : 'fn vert(inputData: VertexAttributes) -> VertexOutput { ORI_Vert(inputData); return ORI_VertexOut; }',
        USER_BEGIN,
        parsed.body,
    ].join('\n');
}

/** Defines the engine sets on a custom material pass. */
function materialDefines(lighting: 'lit' | 'unlit'): Record<string, boolean> {
    return lighting === 'lit' ? { USE_CUSTOMUNIFORM: true, USE_BRDF: true } : { USE_CUSTOMUNIFORM: true };
}

// ------------------------------------------------------------------ manager

let shaderSerial = 0;

/**
 * Compiles shader assets, keeps the last valid version of each and builds
 * materials / post effects from it.
 */
export class ShaderManager extends Emitter<ShaderEvents> {
    private entries = new Map<string, ShaderEntry>();

    constructor(private runtime: Runtime, private store: Store) {
        super();
        const check = () => this.syncAll();
        store.on('change', (hint) => {
            if (!hint?.nodes && !hint?.env) check();
        });
        store.on('load', check);
        check();
    }

    status(id: string): ShaderStatus {
        return this.entries.get(id)?.status ?? { state: 'idle', messages: [], props: [], version: 0 };
    }

    /** Properties of the last valid version, or of the source when it never compiled. */
    props(id: string): ShaderProperty[] {
        const e = this.entries.get(id);
        if (e?.valid) return e.valid.props;
        const doc = this.store.doc.shaders.find((s) => s.id === id);
        return doc ? parseShader(doc.code, doc.kind).props : [];
    }

    version(id: string): number {
        return this.entries.get(id)?.valid?.version ?? 0;
    }

    isValid(id: string): boolean {
        return !!this.entries.get(id)?.valid;
    }

    /** The valid version moves vertices, so it cannot share the depth prepass. */
    movesVertices(id: string): boolean {
        return !!this.entries.get(id)?.valid?.hasVert;
    }

    /** Resolves once every shader whose source changed has been compiled. */
    async whenIdle(): Promise<void> {
        for (;;) {
            const pending = Array.from(this.entries.values()).map((e) => e.pending).filter(Boolean);
            if (!pending.length) return;
            await Promise.all(pending);
        }
    }

    private syncAll() {
        const docs = this.store.doc.shaders;
        const alive = new Set(docs.map((d) => d.id));
        for (const id of Array.from(this.entries.keys())) {
            if (!alive.has(id)) this.entries.delete(id);
        }
        for (const doc of docs) this.ensure(doc);
    }

    /** Starts a compile when the shader's source differs from the last one seen. */
    ensure(doc: ShaderDoc) {
        const key = `${doc.kind}|${doc.lighting}|${doc.code}`;
        let e = this.entries.get(doc.id);
        if (!e) {
            e = { key: '', status: { state: 'idle', messages: [], props: [], version: 0 }, valid: null, pending: null, queued: null };
            this.entries.set(doc.id, e);
        }
        if (e.key === key) return;
        e.key = key;
        if (e.pending) {
            e.queued = { ...doc };
            return;
        }
        this.run(doc.id, e, { ...doc });
    }

    private run(id: string, e: ShaderEntry, doc: ShaderDoc) {
        e.status = { ...e.status, state: 'compiling' };
        this.emit('status', id);
        e.pending = this.compile(id, e, doc)
            .catch((err) => {
                console.error('[editor] shader compile failed', err);
                e.status = { ...e.status, state: 'error', messages: [{ line: 0, column: 0, severity: 'error', message: String(err?.message || err) }] };
            })
            .finally(() => {
                e.pending = null;
                this.emit('status', id);
                const next = e.queued;
                e.queued = null;
                if (next && this.entries.get(id) === e) this.run(id, e, next);
            });
    }

    /**
     * Wraps, preprocesses and compiles a shader on the GPU and maps the
     * compiler messages back to the user's lines. Nothing is registered.
     */
    async analyze(doc: Pick<ShaderDoc, 'kind' | 'lighting' | 'code' | 'name'>): Promise<{ messages: ShaderMessage[]; parsed: ParsedShader; source: string }> {
        const parsed = parseShader(doc.code, doc.kind);
        if (parsed.errors.length) return { messages: parsed.errors, parsed, source: '' };
        const source = buildSource(doc, parsed);
        const defines: Record<string, boolean> = doc.kind === 'post' ? {} : materialDefines(doc.lighting);
        let final: string;
        try {
            final = Preprocessor.parse(source, { ...defines });
            final = Preprocessor.parse(final, { ...defines });
        } catch (err: any) {
            return { messages: [{ line: 0, column: 0, severity: 'error', message: `Preprocessor: ${err?.message || err}` }], parsed, source };
        }
        const finalLines = final.split('\n');
        const begin = finalLines.findIndex((l) => l.includes('canonical_user_code_begin'));
        const device = this.runtime.engine.context3D.device;
        device.pushErrorScope('validation');
        const module = device.createShaderModule({ label: `editor shader ${doc.name}`, code: final });
        const info = await module.getCompilationInfo();
        await device.popErrorScope();
        const messages: ShaderMessage[] = [];
        for (const m of info.messages) {
            if (m.type === 'info') continue;
            const userLine = begin >= 0 && m.lineNum > begin + 1 ? m.lineNum - (begin + 1) : 0;
            messages.push({
                line: userLine,
                column: userLine ? m.linePos : 0,
                severity: m.type === 'error' ? 'error' : 'warning',
                message: userLine ? m.message : `${m.message} (in generated code: ${(finalLines[m.lineNum - 1] ?? '').trim()})`,
            });
        }
        return { messages, parsed, source };
    }

    private async compile(id: string, e: ShaderEntry, doc: ShaderDoc) {
        const { messages, parsed, source } = await this.analyze(doc);
        if (messages.some((m) => m.severity === 'error')) {
            e.status = { ...e.status, state: 'error', messages };
            return;
        }
        const version = ++shaderSerial;
        const name = `canonical_shader_${id}_${version}`.replace(/[^A-Za-z0-9_]/g, '_');
        ShaderLib.register(name, source);
        e.valid = { name, kind: doc.kind, lighting: doc.lighting, props: parsed.props, version, hasVert: parsed.hasVert };
        e.status = { state: 'ok', messages, props: parsed.props, version };
        this.emit('compiled', id);
    }

    // ------------------------------------------------------------ materials

    /** A new material for a material shader, or null when it has no valid version yet. */
    createMaterial(id: string): Material | null {
        const valid = this.entries.get(id)?.valid;
        if (!valid || valid.kind !== 'material') return null;
        const ctx = this.runtime.engine.context3D;
        const res = Engine3D.resFor(ctx);
        const shader = new Shader();
        const pass = new RenderShaderPass(valid.name, valid.name);
        pass.setShaderEntry('VertMain', 'FragMain');
        pass.passType = PassType.COLOR;
        shader.addRenderPass(pass);
        const state = pass.shaderState;
        const lit = valid.lighting === 'lit';
        state.acceptShadow = lit;
        state.castShadow = true;
        state.receiveEnv = lit;
        state.acceptGI = false;
        state.useLight = lit;
        for (const [k, v] of Object.entries(materialDefines(valid.lighting))) shader.setDefine(k, v);

        shader.setUniformFloat('shadowBias', 0.00035);
        shader.setUniformColor('baseColor', new Color(1, 1, 1, 1));
        shader.setUniformColor('emissiveColor', new Color(0, 0, 0, 1));
        shader.setUniformVector4('materialF0', new Vector4(0.04, 0.04, 0.04, 1));
        shader.setUniformColor('specularColor', new Color(1, 1, 1, 1));
        for (const [k, v] of Object.entries({
            envIntensity: 1, normalScale: 1, roughness: 0.5, metallic: 0, ao: 1, roughness_min: 0, roughness_max: 1,
            metallic_min: 0, metallic_max: 1, emissiveIntensity: 1, alphaCutoff: 0, ior: 1.5, clearcoatWeight: 0,
            clearcoatFactor: 0, clearcoatRoughnessFactor: 0, clearcoatIor: 1.5, transmissionFactor: 0,
            thicknessFactor: 0, attenuationDistance: 1e20, transmissionAlphaMode: 0,
        })) {
            shader.setUniformFloat(k, v);
        }
        shader.setUniformColor('clearcoatColor', new Color(1, 1, 1, 1));
        shader.setUniformColor('attenuationColor', new Color(1, 1, 1, 1));
        for (const k of ['baseMapOffsetSize', 'normalMapOffsetSize', 'emissiveMapOffsetSize', 'roughnessMapOffsetSize', 'metallicMapOffsetSize', 'aoMapOffsetSize']) {
            shader.setUniformVector4(k, new Vector4(0, 0, 1, 1));
        }
        shader.setTexture('baseMap', res.whiteTexture);
        shader.setTexture('normalMap', res.normalTexture);
        shader.setTexture('maskMap', res.maskTexture);
        applyProps(shader, valid.props, {}, ctx);

        const mat = new Material();
        mat.name = 'Custom Shader';
        mat.shader = shader;
        return mat;
    }

    /** A post effect instance for a post shader, or null when it has no valid version yet. */
    createPost(id: string, instanceId: string): EditorPost | null {
        const valid = this.entries.get(id)?.valid;
        if (!valid || valid.kind !== 'post') return null;
        const clsName = `CanonicalPost_${instanceId}_${valid.version}`.replace(/[^A-Za-z0-9_]/g, '_');
        // PostPass keys its chain by constructor name, so every instance
        // needs a class of its own.
        const Cls = class extends EditorPost {};
        Object.defineProperty(Cls, 'name', { value: clsName });
        return new Cls(valid.name, valid.props, valid.version);
    }
}

/**
 * Writes property values (falling back to their defaults) into a shader.
 * Texture properties may name a built-in texture (white, black, gray,
 * normal) or a texture asset id; asset textures are returned so the caller
 * can load them, and get a white placeholder until then.
 */
export function applyProps(shader: Shader, props: ShaderProperty[], values: Record<string, ParamValue>, ctx?: any): { name: string; asset: string }[] {
    const res = Engine3D.resFor(ctx);
    const assets: { name: string; asset: string }[] = [];
    for (const p of props) {
        const v = values[p.name] ?? p.default;
        if (p.type === 'float') {
            const n = typeof v === 'number' ? v : Number(v);
            shader.setUniformFloat(p.name, Number.isFinite(n) ? n : 0);
        } else if (p.type === 'color') {
            shader.setUniformColor(p.name, hexToColor(typeof v === 'string' ? v : String(p.default)));
        } else if (p.type === 'vec4') {
            const a = Array.isArray(v) ? v : (p.default as number[]);
            shader.setUniformVector4(p.name, new Vector4(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0));
        } else if (p.type === 'texture') {
            const which = typeof v === 'string' && v ? v : String(p.default);
            if (which === 'black') shader.setTexture(p.name, res.blackTexture);
            else if (which === 'gray') shader.setTexture(p.name, res.grayTexture);
            else if (which === 'normal') shader.setTexture(p.name, res.normalTexture);
            else {
                if (!shader.getTexture(p.name)) shader.setTexture(p.name, res.whiteTexture);
                if (which !== 'white') assets.push({ name: p.name, asset: which });
            }
        }
    }
    return assets;
}

/**
 * Mirrors LitMaterial.alphaMode for materials built from custom shaders:
 * blended materials go to the transparent queue and stop writing depth.
 */
export function setBlended(mat: Material, blend: boolean) {
    const pass = mat.shader.getDefaultColorShader();
    const state = pass.shaderState;
    if (!!state.transparent === blend) return;
    state.transparent = blend;
    state.blendMode = blend ? BlendMode.NORMAL : BlendMode.NONE;
    state.depthWriteEnabled = !blend;
    pass.renderOrder = blend ? 3000 : 0;
    (mat as any)._notifyRenderClassificationDirty?.();
}

// ------------------------------------------------------------------- posts

/** Full screen post effect running a custom post shader. */
export class EditorPost extends PostBase {
    postQuad: ViewQuad | null = null;
    renderTexture: RenderTexture | null = null;
    private values: Record<string, ParamValue> = {};

    constructor(readonly shaderName: string, readonly props: ShaderProperty[], readonly version: number) {
        super();
    }

    protected createResource(_view: View3D) {
        const [w, h] = this._boundCtx!.presentationSize;
        const key = this.constructor.name;
        this.renderTexture = this.createRTTexture(key, w, h, GPUTextureFormat.rgba16float);
        this.postQuad = this.createViewQuad(key, this.shaderName, this.renderTexture);
        if (!this.props.some((p) => p.type !== 'texture')) this.postQuad.quadShader.setUniformVector4('canonical_pad', new Vector4());
        this.writeValues();
    }

    /** Called with the texture assets the current values need; see applyProps. */
    onTextures: (assets: { name: string; asset: string }[]) => void = () => {};

    setValues(values: Record<string, ParamValue>) {
        this.values = { ...values };
        this.writeValues();
    }

    setTexture(name: string, texture: any) {
        this.postQuad?.quadShader.setTexture(name, texture);
    }

    private writeValues() {
        if (!this.postQuad) return;
        const assets = applyProps(this.postQuad.quadShader, this.props, this.values, this._boundCtx);
        if (assets.length) this.onTextures(assets);
    }

    public onResize() {
        const [w, h] = this._boundCtx!.presentationSize;
        this.renderTexture?.resize(w, h);
    }

    public render(view: View3D, command: GPUCommandEncoder) {
        if (!this.postQuad) return;
        const ctx = this._boundCtx!;
        const last = ctx.gpuContext.lastRenderPassState.getLastRenderTexture(ctx);
        this.postQuad.renderToViewQuad(view, this.postQuad, command, last);
    }
}

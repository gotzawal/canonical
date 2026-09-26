import * as core from '@orillusion/core';
import { Emitter } from '../core/events';
import type { Store } from '../core/store';
import type { ParamValue, ScriptDoc } from '../core/types';
import { Script, LIFECYCLE, withContext } from './script';

// Scripts are ES module-like JavaScript. The compiler turns `import` /
// `export` into plain code (only '@orillusion/core' and 'canonical' can be
// imported), wraps it in a function and evaluates it through an injected
// <script> element, which gives syntax errors and stack traces real line
// numbers (the source URL is canonical-script/<id>/<name>).

export type ScriptClass = new () => Script;

export interface ScriptDiagnostic {
    /** 1-based line in the user's code, 0 when unknown. */
    line: number;
    column: number;
    message: string;
}

export type FieldType = 'number' | 'boolean' | 'string' | 'color' | 'vec3';

export interface ScriptField {
    name: string;
    type: FieldType;
    default: ParamValue;
}

export interface CompiledScript {
    id: string;
    name: string;
    code: string;
    cls: ScriptClass | null;
    className: string;
    error: ScriptDiagnostic | null;
    fields: ScriptField[];
    /** Lifecycle methods the class implements. */
    methods: string[];
    /** Reading the fields failed (a field initializer threw). */
    fieldError: string;
    /** Not evaluated because scripts are paused (see ScriptCompiler.trusted). */
    paused: boolean;
}

interface CompilerEvents {
    /** A script was (re)compiled; payload is its id. */
    compiled: string;
    /** Scripts were paused (false) or allowed to run (true). */
    trust: boolean;
}

export const PAUSED_MESSAGE = 'Scripts from an opened scene file are paused. Choose "Enable Scripts" to run them.';

const MODULES: Record<string, () => any> = {
    '@orillusion/core': () => core,
    canonical: () => ({ Script, default: Script }),
    '@canonical/script': () => ({ Script, default: Script }),
};

const SOURCE_PREFIX = 'canonical-script/';
let defineSerial = 0;
const registry = new Map<string, Function>();
(window as any).__canonical_define = (token: string, factory: Function) => registry.set(token, factory);

/** Rewrites import / export statements; keeps the line count unchanged. */
export function transformModule(code: string): { code: string; defaultName: string | null; error: ScriptDiagnostic | null } {
    let error: ScriptDiagnostic | null = null;
    const lineAt = (index: number) => code.slice(0, index).split('\n').length;
    let out = code.replace(/^[ \t]*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2[ \t]*;?/gm, (m, clause: string, _q, mod: string, offset: number) => {
        const lines = '\n'.repeat((m.match(/\n/g) || []).length);
        if (!(mod in MODULES)) {
            error ??= { line: lineAt(offset), column: 1, message: `Cannot import "${mod}". Scripts can import from '@orillusion/core' and 'canonical'.` };
            return lines;
        }
        const src = `__import(${JSON.stringify(mod)})`;
        const parts: string[] = [];
        let rest = clause.trim();
        const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(rest);
        if (ns) return `const ${ns[1]} = ${src};` + lines;
        const def = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(rest);
        if (def) {
            parts.push(`const ${def[1]} = ${src}.default ?? ${src};`);
            rest = rest.slice(def[0].length).trim();
        }
        const named = /^\{([\s\S]*)\}$/.exec(rest);
        if (named) {
            const specs = named[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => s.replace(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/, '$1: $2'));
            parts.push(`const { ${specs.join(', ')} } = ${src};`);
        } else if (rest) {
            error ??= { line: lineAt(offset), column: 1, message: `Unsupported import: ${m.trim()}` };
        }
        return parts.join(' ') + lines;
    });
    out = out.replace(/^[ \t]*import\s+(['"])[^'"]+\1[ \t]*;?/gm, '');
    let defaultName: string | null = null;
    out = out.replace(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/, (_m, name: string) => {
        defaultName = name;
        return `class ${name}`;
    });
    out = out.replace(/\bexport\s+default\s+/, '__exports.default = ');
    out = out.replace(/\bexport\s+(?=(class|function|const|let|var|async)\b)/g, '');
    return { code: out, defaultName, error };
}

/** Maps an error's stack to a line in a script's source. */
export function scriptLocation(err: unknown): { id: string; name: string; line: number; column: number } | null {
    const stack = (err as any)?.stack;
    if (typeof stack !== 'string') return null;
    const re = new RegExp(SOURCE_PREFIX.replace('/', '\\/') + '([^/\\s]+)\\/([^:\\s)]+):(\\d+):(\\d+)');
    const m = re.exec(stack);
    if (!m) return null;
    // Line 1 of the generated source is the wrapper header.
    return { id: m[1], name: decodeURIComponent(m[2]), line: Math.max(0, Number(m[3]) - 1), column: Number(m[4]) };
}

function evaluate(doc: ScriptDoc, body: string): { factory: Function | null; error: ScriptDiagnostic | null } {
    const token = `s${++defineSerial}`;
    const file = `${SOURCE_PREFIX}${encodeURIComponent(doc.id)}/${encodeURIComponent(doc.name || 'script.js')}`;
    const source =
        `__canonical_define(${JSON.stringify(token)}, function (__import, Script, __exports) {"use strict";\n` +
        `${body}\n});\n//# sourceURL=${file}`;
    let syntax: ScriptDiagnostic | null = null;
    const onError = (e: ErrorEvent) => {
        syntax = {
            line: Math.max(0, (e.lineno || 1) - 1),
            column: e.colno || 0,
            message: String(e.message || e.error || 'Syntax error').replace(/^Uncaught /, '').replace(/^SyntaxError: Failed to execute 'appendChild' on 'Node': /, 'SyntaxError: '),
        };
        e.stopImmediatePropagation();
        e.preventDefault();
    };
    window.addEventListener('error', onError, true);
    const el = document.createElement('script');
    el.textContent = source;
    try {
        document.head.appendChild(el);
    } finally {
        el.remove();
        window.removeEventListener('error', onError, true);
    }
    if (syntax) return { factory: null, error: syntax };
    const factory = registry.get(token) ?? null;
    registry.delete(token);
    if (factory) return { factory, error: null };
    // Inline scripts blocked (e.g. by a Content Security Policy): fall back to Function.
    try {
        const fn = new Function('__import', 'Script', '__exports', `"use strict";\n${body}\n//# sourceURL=${file}`);
        return { factory: fn, error: null };
    } catch (e: any) {
        return { factory: null, error: { line: 0, column: 0, message: String(e?.message || e) } };
    }
}

function fieldType(v: unknown): FieldType | null {
    if (typeof v === 'number') return Number.isFinite(v) ? 'number' : null;
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'string') return /^#[0-9a-f]{6}$/i.test(v) ? 'color' : 'string';
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'vec3';
    return null;
}

/**
 * Compiles scripts when their source changes and keeps the results.
 *
 * Compiling runs the script's top-level code in this page, which also holds
 * the user's OpenRouter key. Scripts of a scene opened from a file are
 * therefore paused (never evaluated) until the user enables them.
 */
export class ScriptCompiler extends Emitter<CompilerEvents> {
    private cache = new Map<string, CompiledScript>();
    private _trusted: boolean;

    constructor(private store: Store, trusted = true) {
        super();
        this._trusted = trusted;
        store.on('change', (hint) => {
            if (!hint?.nodes && !hint?.env && !hint?.meta) this.check();
        });
        store.on('load', () => this.check());
        this.check();
    }

    /** False while scripts are paused. */
    get trusted(): boolean {
        return this._trusted;
    }

    setTrusted(trusted: boolean) {
        if (trusted === this._trusted) return;
        this._trusted = trusted;
        this.cache.clear();
        this.emit('trust', trusted);
        this.check();
    }

    private check() {
        const alive = new Set<string>();
        for (const doc of this.store.doc.scripts) {
            alive.add(doc.id);
            this.get(doc.id);
        }
        for (const id of Array.from(this.cache.keys())) if (!alive.has(id)) this.cache.delete(id);
    }

    /** The compiled form of a script, compiling it first when the source changed. */
    get(id: string): CompiledScript | null {
        const doc = this.store.doc.scripts.find((s) => s.id === id);
        if (!doc) return null;
        const cached = this.cache.get(id);
        if (cached && cached.code === doc.code && cached.name === doc.name) return cached;
        const compiled = this.compile(doc);
        this.cache.set(id, compiled);
        this.emit('compiled', id);
        return compiled;
    }

    compile(doc: ScriptDoc): CompiledScript {
        const result: CompiledScript = {
            id: doc.id,
            name: doc.name,
            code: doc.code,
            cls: null,
            className: '',
            error: null,
            fields: [],
            methods: [],
            fieldError: '',
            paused: false,
        };
        if (!this._trusted) {
            result.paused = true;
            result.error = { line: 0, column: 0, message: PAUSED_MESSAGE };
            return result;
        }
        const t = transformModule(doc.code);
        if (t.error) {
            result.error = t.error;
            return result;
        }
        const last = Array.from(t.code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\s+extends\b/g)).pop()?.[1];
        const fallback = t.defaultName ?? last;
        const body =
            t.code +
            `\n;return __exports.default !== undefined ? __exports.default : ${fallback ? `(typeof ${fallback} !== 'undefined' ? ${fallback} : undefined)` : 'undefined'};`;
        const { factory, error } = evaluate(doc, body);
        if (error || !factory) {
            result.error = error ?? { line: 0, column: 0, message: 'The script could not be loaded.' };
            return result;
        }
        let cls: any;
        try {
            cls = factory((mod: string) => MODULES[mod]?.(), Script, {});
        } catch (e: any) {
            const loc = scriptLocation(e);
            result.error = { line: loc?.line ?? 0, column: loc?.column ?? 0, message: `${e?.name || 'Error'}: ${e?.message || e}` };
            return result;
        }
        if (typeof cls !== 'function' || !(cls.prototype instanceof Script)) {
            result.error = { line: 0, column: 0, message: 'Export a class that extends Script, e.g. "export default class Spin extends Script { ... }".' };
            return result;
        }
        result.cls = cls;
        result.className = cls.name || '';
        result.methods = LIFECYCLE.filter((m) => typeof cls.prototype[m] === 'function');
        try {
            const probe = withContext({ nodeId: '', nodeName: '', scriptName: doc.name, object3D: null, api: null }, () => new cls());
            for (const key of Object.keys(probe)) {
                const v = (probe as any)[key];
                const type = fieldType(v);
                if (type) result.fields.push({ name: key, type, default: Array.isArray(v) ? v.slice() : v });
            }
        } catch (e: any) {
            result.fieldError = `Could not read the fields: ${e?.message || e}`;
        }
        return result;
    }
}

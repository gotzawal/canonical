// Fields of the data model and what the editor derives from them. The scene's
// objects and settings are written once, as zod schemas in core/model.ts,
// with the constructors below. From a schema come:
// - its TypeScript type (z.output),
// - the repair of documents from files and older builds: parse() never
//   fails on an object, a value that does not fit becomes the default and a
//   number out of range is clamped (defaults() is parse({})),
// - the assistant's tool arguments: toolSchema() for the JSON schema,
//   patch() to apply them,
// - the inspector's fields (ui/schemaFields.ts), from the metadata here.

import { z } from 'zod';
import { clamp } from './math';

/** What the inspector and the assistant know about a field besides its type. */
export interface FieldMeta extends z.GlobalMeta {
    /** Inspector label; the key in words when missing. */
    title?: string;
    /** What the field means: the inspector's hint and the tool argument's description. */
    description?: string;
    /** Inspector number fields: drag step and shown decimals; a slider between min and max. */
    step?: number;
    precision?: number;
    slider?: boolean;
    /** Enum fields: a label per value for the inspector. */
    labels?: Record<string, string>;
    /** Set by the constructors: how the inspector shows the field. */
    kind?: FieldKind;
}

export type FieldKind = 'number' | 'int' | 'bool' | 'enum' | 'color' | 'vec2' | 'vec3' | 'range' | 'text' | 'asset' | 'params';

/** Bad input from outside (a tool argument): its message is for whoever sent it. */
export class InputError extends Error {}

// ------------------------------------------------------------ repair helpers

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const str = (v: unknown, d = '', max = Infinity): string => (typeof v === 'string' ? v.slice(0, max) : d);
export const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
export const HEX = /^#[0-9a-f]{6}$/i;
export const hexOr = (v: unknown, d: string): string => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
export const vecOr = <T extends number[]>(v: unknown, d: [...T]): T => (Array.isArray(v) && v.length === d.length ? d.map((x, i) => finite(v[i], x)) : [...d]) as T;

// -------------------------------------------------------------- constructors

const meta = <S extends z.ZodType>(s: S, kind: FieldKind, m: FieldMeta): S => s.meta({ ...m, kind });

/** A number within [min, max]: out of range it is clamped, not a number it is the default. */
export function num(d: number, min = -Infinity, max = Infinity, m: FieldMeta = {}) {
    let s = z.number();
    if (min > -Infinity) s = s.min(min);
    if (max < Infinity) s = s.max(max);
    return meta(s.catch((c) => clamp(finite(c?.value, d), min, max)), 'number', m);
}

/** A whole number within [min, max], rounded when it is not one. */
export function int(d: number, min = -Infinity, max = Infinity, m: FieldMeta = {}) {
    let s = z.int();
    if (min > -Infinity) s = s.min(min);
    if (max < Infinity) s = s.max(max);
    return meta(s.catch((c) => Math.round(clamp(finite(c?.value, d), min, max))), 'int', m);
}

export const bool = (d: boolean, m: FieldMeta = {}) => meta(z.boolean().catch(d), 'bool', m);

export const oneOf = <const T extends readonly [string, ...string[]]>(values: T, d: T[number], m: FieldMeta = {}) =>
    meta(z.enum(values).catch(d), 'enum', m);

/** A #rrggbb color. */
export const color = (d: string, m: FieldMeta = {}) =>
    meta(z.string().regex(HEX).catch((c) => hexOr(c?.value, d)), 'color', { ...m, description: `${m.description ? m.description + ' ' : ''}#rrggbb (CSS color names also work).` });

export const vec3 = (d: [number, number, number], m: FieldMeta = {}) =>
    meta(z.tuple([z.number(), z.number(), z.number()]).catch((c) => vecOr(c?.value, d)), 'vec3', m);

export const vec2 = (d: [number, number], m: FieldMeta = {}) => meta(z.tuple([z.number(), z.number()]).catch((c) => vecOr(c?.value, d)), 'vec2', m);

/** [lowest, highest] within [min, max]. */
export function range(d: [number, number], min: number, max: number, m: FieldMeta = {}) {
    const n = z.number().min(min).max(max);
    const fix = (v: unknown): [number, number] => {
        const [a, b] = vecOr(v, d).map((x) => clamp(x, min, max));
        return a <= b ? [a, b] : [b, a];
    };
    return meta(z.tuple([n, n]).overwrite(fix).catch((c) => fix(c?.value)), 'range', m);
}

/** Text of at most `max` characters. */
export const text = (d: string, max = 2000, m: FieldMeta = {}) => meta(z.string().max(max).catch((c) => str(c?.value, d, max)), 'text', m);

/** An asset id, or null for none. */
export const asset = (m: FieldMeta = {}) => meta(z.string().min(1).nullable().catch(null), 'asset', m);

/** Values of a script's or shader's properties by name: numbers, text, booleans or number lists. */
const paramValue = z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]);
export const params = (m: FieldMeta = {}) =>
    meta(
        z.record(z.string(), paramValue).catch((c) =>
            Object.fromEntries(Object.entries(isObj(c?.value) ? c.value : {}).filter(([, v]) => paramValue.safeParse(v).success)),
        ),
        'params',
        m,
    );

/**
 * Some fields of a component as optional changes (a model slot's changes of
 * its material): missing keeps what there is, a value that does not fit is
 * dropped.
 */
export function optionalFields<S extends z.ZodRawShape, K extends keyof S & string>(shape: S, keys: readonly K[]) {
    return Object.fromEntries(keys.map((k) => [k, strict(shape[k] as unknown as z.ZodType).optional().catch(undefined)])) as unknown as { [P in K]: z.ZodOptional<S[P]> };
}

/** Objects by key (a model's changes by slot); values that are not objects are dropped. */
export const records = <S extends z.ZodType>(s: S) =>
    z.record(z.string(), s).catch((c) => Object.fromEntries(Object.entries(isObj(c?.value) ? c.value : {}).filter(([, v]) => isObj(v)).map(([k, v]) => [k, s.parse(v)])));

/** A group of fields inside a component (the bloom settings of the environment): missing, it has its defaults. */
export function group<S extends z.ZodRawShape>(shape: S, m: FieldMeta = {}) {
    const o = z.object(shape);
    return o.catch(() => o.parse({})).meta(m);
}

// --------------------------------------------------------------- derivations

/** Every field at its default. */
export const defaults = <S extends z.ZodType>(s: S): z.output<S> => s.parse({});

/** A component read from a file: repaired, or undefined when it is not an object. */
export const repair = <S extends z.ZodType>(s: S, raw: unknown): z.output<S> | undefined => (isObj(raw) ? s.parse(raw) : undefined);

/** What a field is when it is missing: its default (for optional fields too). */
export const fieldDefault = (s: z.ZodType): unknown => (s instanceof z.ZodOptional ? (s.unwrap() as z.ZodType) : s).safeParse(undefined).data;

/** A field's schema without its fallback, optional and metadata wrappers. */
export function inner(s: z.ZodType): z.ZodType {
    for (;;) {
        if (s instanceof z.ZodCatch || s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap() as z.ZodType;
        else return s;
    }
}

/** The metadata of a field: of its outermost schema that has some. */
export function fieldMeta(s: z.ZodType): FieldMeta {
    for (;;) {
        const m = z.globalRegistry.get(s);
        if (m) return m as FieldMeta;
        if (s instanceof z.ZodCatch || s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap() as z.ZodType;
        else return {};
    }
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/** An object with its keys (and those of the objects in it) in snake_case, as tool arguments name them. */
export function snakeKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(snakeKeys);
    if (!isObj(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]));
}
const camel = (k: string) => k.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/**
 * The schema tool arguments are checked against: no fallbacks, every field
 * optional (also in groups), no fields it does not have. Nullable fields
 * stay nullable.
 */
function strict(s: z.ZodType): z.ZodType {
    let out: z.ZodType;
    if (s instanceof z.ZodCatch || s instanceof z.ZodOptional) out = strict(s.unwrap() as z.ZodType);
    else if (s instanceof z.ZodNullable) out = strict(s.unwrap() as z.ZodType).nullable();
    else if (s instanceof z.ZodObject) out = z.strictObject(Object.fromEntries(Object.entries(s.shape as Record<string, z.ZodType>).map(([k, f]) => [k, strict(f).optional()])));
    else return s;
    // The description stays with the field.
    const m = z.globalRegistry.get(s);
    return m ? out.meta(m) : out;
}

const KEEP = new Set(['type', 'properties', 'items', 'enum', 'minimum', 'maximum', 'description', 'anyOf', 'minItems', 'maxItems']);

/** A JSON schema for the assistant: snake_case properties, standard keywords only, tuples as arrays. */
function forTools(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(forTools);
    if (!isObj(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v as object).map(([p, s]) => [snake(p), forTools(s)]));
        else if (k === 'prefixItems') out.items = forTools((v as unknown[])[0]);
        else if (KEEP.has(k) && !(k === 'items' && 'prefixItems' in node)) out[k] = forTools(v);
    }
    return out;
}

/** The JSON schema of a component's (or group's) fields as tool arguments: snake_case, every field optional. */
export function toolSchema(s: z.ZodType, description?: string): Record<string, any> {
    const out = forTools(z.toJSONSchema(strict(s), { io: 'input', unrepresentable: 'any' })) as Record<string, any>;
    if (description) out.description = description;
    return out;
}

/** The tool schemas of some fields of a component, to spread into a tool's properties. */
export function toolFields(s: z.ZodObject, keys: string[]): Record<string, any> {
    const props = toolSchema(s).properties as Record<string, any>;
    return Object.fromEntries(keys.map((k) => [snake(k), props[snake(k)]]));
}

/** Deep merge of plain objects (arrays and other values replace). */
function merge(a: unknown, b: unknown): unknown {
    if (!isObj(a) || !isObj(b)) return b;
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = merge(a[k], v);
    return out;
}

/** snake_case keys to camelCase, in groups too; colors go through `hex`. */
function fromTool(s: z.ZodType, v: unknown, what: string, hex?: (v: unknown, what: string) => string): unknown {
    const i = inner(s);
    if (i instanceof z.ZodObject && isObj(v)) {
        const shape = i.shape as Record<string, z.ZodType>;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
            const key = camel(k);
            out[key] = shape[key] ? fromTool(shape[key], x, `${what}.${k}`, hex) : x;
        }
        return out;
    }
    return hex && typeof v === 'string' && fieldMeta(s).kind === 'color' ? hex(v, what) : v;
}

/**
 * Applies the assistant's change to a component: snake_case keys, only the
 * fields it names (groups merge). A value of the wrong type is an
 * InputError naming the argument (`what`); a number out of range is
 * clamped. `hex` reads colors (names too).
 */
export function patch<S extends z.ZodObject>(s: S, current: z.output<S>, args: unknown, what: string, hex?: (v: unknown, what: string) => string): z.output<S> {
    if (!isObj(args)) throw new InputError(`${what} must be an object.`);
    const input = fromTool(s, args, what, hex);
    const bad = strict(s).safeParse(input).error?.issues.find((i) => i.code !== 'too_big' && i.code !== 'too_small');
    if (bad) {
        const where = [what, ...bad.path.map((p) => snake(String(p)))].filter(Boolean).join('.') || 'the arguments';
        if (bad.code !== 'unrecognized_keys') throw new InputError(`${where}: ${bad.message}`);
        // The fields there are, for a name the assistant guessed.
        let at = inner(s);
        for (const p of bad.path) at = inner((at as z.ZodObject).shape[String(p)] as z.ZodType);
        throw new InputError(`${where} has no ${bad.keys.map(snake).join(', ')}; its fields are ${Object.keys((at as z.ZodObject).shape).map(snake).join(', ')}.`);
    }
    return s.parse(merge(current, input));
}

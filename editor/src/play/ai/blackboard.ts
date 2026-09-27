// An agent's blackboard: its values by key, with a write version per key and
// the metadata of AI answers. Versions and answers are play state only; the
// schema (the format) has neither.

import type { Object3D } from '@orillusion/core';
import { typeDefault, valueFits } from '../../core/behavior/nodeTypes';
import type { BlackboardKeyDoc, BlackboardKeyOwner, BlackboardSchemaDoc, BlackboardValue } from '../../core/types';

/** What an AI key's value is based on. */
export interface AnswerMeta {
    /** Probability of the chosen answer (0..1). */
    confidence: number;
    /** Where it came from: the provider (e.g. "laya/webgpu"), with the cache hit. */
    source: string;
    /** Play time of the write, seconds. */
    at: number;
    /** Play time the value last changed (an answer that repeats the value keeps it). */
    since: number;
    /** Ask node id and the request's number. */
    node: string;
    seq: number;
}

/** Runtime value: object keys hold engine objects. */
export type RuntimeValue = BlackboardValue | Object3D;

export class BlackboardError extends Error {}

/** Turns object references (node ids or names) into engine objects. */
export type ObjectResolver = (ref: string) => Object3D | null;

export class Blackboard {
    private values = new Map<string, RuntimeValue>();
    private versions = new Map<string, number>();
    private answers = new Map<string, AnswerMeta>();
    private keyMap: Map<string, BlackboardKeyDoc>;
    /** Raised by every change, to notice any change cheaply. */
    revision = 0;

    constructor(
        readonly schema: BlackboardSchemaDoc,
        overrides: Record<string, BlackboardValue>,
        private resolve: ObjectResolver,
    ) {
        this.keyMap = new Map(schema.keys.map((k) => [k.name, k]));
        for (const k of schema.keys) {
            const o = Object.hasOwn(overrides, k.name) ? overrides[k.name] : undefined;
            this.values.set(k.name, this.initial(k, o !== undefined && valueFits(k, o) ? o : undefined));
            this.versions.set(k.name, 0);
        }
    }

    /**
     * A key's starting value: the override, the schema default, the type's
     * default. A key none of them fits (an enum without values) starts empty
     * instead of stopping Play; validation reports it.
     */
    private initial(k: BlackboardKeyDoc, override?: BlackboardValue): RuntimeValue {
        for (const v of [override, k.default, typeDefault(k.type, k.values)]) {
            if (v === undefined) continue;
            try {
                return this.coerce(k, v);
            } catch { /* try the next one */ }
        }
        return k.type === 'enum' || k.type === 'string' ? '' : k.type === 'bool' ? false : k.type === 'object' ? null : 0;
    }

    get keys(): BlackboardKeyDoc[] {
        return this.schema.keys;
    }

    key(name: string): BlackboardKeyDoc | undefined {
        return this.keyMap.get(name);
    }

    has(name: string): boolean {
        return this.keyMap.has(name);
    }

    get(name: string): RuntimeValue | undefined {
        return this.values.get(name);
    }

    /** Write version of a key: 0 until the first change, then raised by every change. */
    version(name: string): number {
        return this.versions.get(name) ?? 0;
    }

    /** The answer an AI key's value came from, or undefined while it has its default. */
    answer(name: string): AnswerMeta | undefined {
        return this.answers.get(name);
    }

    /** A value converted to the key's type; throws a BlackboardError when it does not fit. */
    coerce(key: BlackboardKeyDoc, v: unknown): RuntimeValue {
        switch (key.type) {
            case 'bool':
                if (typeof v !== 'boolean') throw new BlackboardError(`"${key.name}" is a bool key; got ${describe(v)}.`);
                return v;
            case 'number':
                if (typeof v !== 'number' || !Number.isFinite(v)) throw new BlackboardError(`"${key.name}" is a number key; got ${describe(v)}.`);
                return v;
            case 'probability':
                if (typeof v !== 'number' || !Number.isFinite(v)) throw new BlackboardError(`"${key.name}" is a probability key (0..1); got ${describe(v)}.`);
                return Math.min(1, Math.max(0, v));
            case 'enum':
                if (typeof v !== 'string' || !key.values?.some((x) => x.value === v)) {
                    throw new BlackboardError(`"${key.name}" is an enum key: use one of ${key.values?.map((x) => x.value).join(', ')}; got ${describe(v)}.`);
                }
                return v;
            case 'string':
                if (v === null || v === undefined) return '';
                if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new BlackboardError(`"${key.name}" is a string key; got ${describe(v)}.`);
                return String(v);
            case 'object': {
                if (v === null || v === undefined || v === '') return null;
                if (typeof v === 'string') return this.resolve(v);
                if (typeof v === 'object' && (v as any).transform) return v as Object3D;
                throw new BlackboardError(`"${key.name}" is an object key: give an object, its name or id, or null; got ${describe(v)}.`);
            }
        }
    }

    /**
     * Writes a value. `owner` is who writes: a key only accepts its owner
     * (scripts write facts, Set Key and script tasks tree keys, Ask AI keys).
     * Returns true when the value changed; the key's version is raised then.
     */
    write(name: string, value: unknown, owner: BlackboardKeyOwner, answer?: Omit<AnswerMeta, 'since'>): boolean {
        const key = this.keyMap.get(name);
        if (!key) throw new BlackboardError(`No key "${name}" in blackboard "${this.schema.name}". Keys: ${this.schema.keys.map((k) => k.name).join(', ')}.`);
        if (key.owner !== owner) {
            const who = key.owner === 'fact' ? 'scripts (it is a fact key)' : key.owner === 'ai' ? 'its Ask (it is an AI key)' : 'the tree (Set Key and script tasks)';
            throw new BlackboardError(`"${name}" is written by ${who}.`);
        }
        const v = this.coerce(key, value);
        const same = Object.is(this.values.get(name), v);
        if (answer) {
            const prev = this.answers.get(name);
            this.answers.set(name, { ...answer, since: same && prev ? prev.since : answer.at });
        }
        if (same) return false;
        this.values.set(name, v);
        this.versions.set(name, this.version(name) + 1);
        this.revision++;
        return true;
    }

    /** Back to the schema default (AI keys lose their answer). */
    reset(name: string) {
        const key = this.keyMap.get(name);
        if (!key) return;
        this.answers.delete(name);
        const v = this.initial(key);
        if (Object.is(this.values.get(name), v)) return;
        this.values.set(name, v);
        this.versions.set(name, this.version(name) + 1);
        this.revision++;
    }

    /** A value as JSON: objects become their names. */
    plain(name: string): BlackboardValue {
        return plainValue(this.values.get(name));
    }

    /** Every value as JSON, for the debug view and logs. */
    snapshot(names?: string[]): Record<string, BlackboardValue> {
        const out: Record<string, BlackboardValue> = {};
        for (const k of names ?? this.schema.keys.map((x) => x.name)) if (this.keyMap.has(k)) out[k] = this.plain(k);
        return out;
    }
}

export function plainValue(v: RuntimeValue | undefined): BlackboardValue {
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object') return (v as Object3D).name || 'object';
    return v as BlackboardValue;
}

function describe(v: unknown): string {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '...' : v);
    if (typeof v === 'object') return (v as any).transform ? `object "${(v as any).name}"` : 'an object';
    return String(v);
}

import type { AssetMeta, ParamValue } from '../core/types';
import type { ShaderProperty } from '../engine/shaders';
import { h } from './dom';
import {
    CheckboxField, ColorField, EditHooks, NumberField, SelectField, SliderField, TextField, Vec3Field, row,
} from './widgets';
import type { FieldType, ScriptField } from '../play/compiler';

/** Widget rows for a custom shader's declared properties. */
export function shaderParamRows(
    props: ShaderProperty[],
    values: Record<string, ParamValue>,
    hooks: (name: string, label: string) => EditHooks<ParamValue>,
    textures: AssetMeta[],
    watch?: (fn: (values: Record<string, ParamValue>) => void) => void,
): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const p of props) {
        const label = pretty(p.name);
        const value = values[p.name] ?? p.default;
        const hk = hooks(p.name, label);
        if (p.type === 'float') {
            const v = typeof value === 'number' ? value : Number(p.default) || 0;
            if (p.min !== undefined && p.max !== undefined) {
                const f = new SliderField({ value: v, min: p.min, max: p.max, step: (p.max - p.min) / 200, precision: 3, ...(hk as EditHooks<number>) });
                watch?.((vals) => f.set(num(vals[p.name], p.default)));
                rows.push(row(label, f.el, p.name));
            } else {
                const f = new NumberField({ value: v, step: 0.01, precision: 3, ...(hk as EditHooks<number>) });
                watch?.((vals) => f.set(num(vals[p.name], p.default)));
                rows.push(row(label, f.el, p.name));
            }
        } else if (p.type === 'color') {
            const f = new ColorField({ value: typeof value === 'string' ? value : String(p.default), ...(hk as EditHooks<string>) });
            watch?.((vals) => f.set(typeof vals[p.name] === 'string' ? (vals[p.name] as string) : String(p.default)));
            rows.push(row(label, f.el, p.name));
        } else if (p.type === 'vec4') {
            const arr = (Array.isArray(value) ? value : (p.default as number[])).slice(0, 4);
            while (arr.length < 4) arr.push(0);
            const fields = arr.map(
                (n, i) =>
                    new NumberField({
                        value: n,
                        step: 0.01,
                        precision: 3,
                        className: 'axis-' + 'xyzw'[i],
                        begin: () => hk.begin?.(),
                        input: (x) => {
                            arr[i] = x;
                            hk.input?.(arr.slice());
                        },
                        end: () => hk.end?.(),
                        commit: (x) => {
                            arr[i] = x;
                            hk.commit?.(arr.slice());
                        },
                    }),
            );
            watch?.((vals) => {
                const a = Array.isArray(vals[p.name]) ? (vals[p.name] as number[]) : (p.default as number[]);
                fields.forEach((f, i) => {
                    arr[i] = a[i] ?? 0;
                    f.set(arr[i]);
                });
            });
            rows.push(row(label, h('div', { class: 'vec4' }, fields.map((f) => f.el)), p.name));
        } else if (p.type === 'texture') {
            const options = [
                { value: 'white', label: 'White' },
                { value: 'black', label: 'Black' },
                { value: 'gray', label: 'Gray' },
                { value: 'normal', label: 'Flat Normal' },
                ...textures.map((t) => ({ value: t.id, label: t.name })),
            ];
            const f = new SelectField<string>(options, typeof value === 'string' ? value : String(p.default), (v) => hk.commit?.(v));
            watch?.((vals) => f.set(typeof vals[p.name] === 'string' ? (vals[p.name] as string) : String(p.default)));
            rows.push(row(label, f.el, p.name));
        }
    }
    return rows;
}

/** Widget rows for a script's public fields. */
export function scriptFieldRows(
    fields: ScriptField[],
    values: Record<string, ParamValue>,
    hooks: (name: string, label: string, type: FieldType) => EditHooks<ParamValue>,
    watch?: (fn: (values: Record<string, ParamValue>) => void) => void,
): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const f of fields) {
        const label = pretty(f.name);
        const value = values[f.name] ?? f.default;
        const hk = hooks(f.name, label, f.type);
        const get = (vals: Record<string, ParamValue>) => vals[f.name] ?? f.default;
        if (f.type === 'number') {
            const w = new NumberField({ value: typeof value === 'number' ? value : 0, step: 0.05, precision: 3, ...(hk as EditHooks<number>) });
            watch?.((vals) => w.set(num(get(vals), 0)));
            rows.push(row(label, w.el, f.name));
        } else if (f.type === 'boolean') {
            const w = new CheckboxField(!!value, (v) => hk.commit?.(v));
            watch?.((vals) => w.set(!!get(vals)));
            rows.push(row(label, w.el, f.name));
        } else if (f.type === 'color') {
            const w = new ColorField({ value: String(value), ...(hk as EditHooks<string>) });
            watch?.((vals) => w.set(String(get(vals))));
            rows.push(row(label, w.el, f.name));
        } else if (f.type === 'string') {
            const w = new TextField(String(value), (v) => hk.commit?.(v));
            watch?.((vals) => w.set(String(get(vals))));
            rows.push(row(label, w.el, f.name));
        } else if (f.type === 'vec3') {
            const v = (Array.isArray(value) ? value : (f.default as number[])) as [number, number, number];
            const w = new Vec3Field({ value: v, step: 0.05, precision: 3, ...(hk as EditHooks<[number, number, number]>) });
            watch?.((vals) => w.set(get(vals) as [number, number, number]));
            rows.push(row(label, w.el, f.name));
        }
    }
    return rows;
}

function num(v: ParamValue | undefined, d: ParamValue): number {
    return typeof v === 'number' ? v : typeof d === 'number' ? d : 0;
}

/** "stripeColor" -> "Stripe Color". */
export function pretty(name: string): string {
    const s = name.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

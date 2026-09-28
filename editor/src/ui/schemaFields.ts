// Inspector rows made from a component's schema (core/model.ts): a number
// box or slider, checkbox, list, color or vector field per field, with the
// label, hint and range the schema gives it.

import { z } from 'zod';
import { fieldDefault, fieldMeta, inner } from '../core/schema';
import { CheckboxField, ColorField, NumberField, SelectField, SliderField, Vec2Field, Vec3Field, row, type EditHooks } from './widgets';

/** A field's label: its title, or the key in words ("runSpeed" is "Run Speed"). */
export const fieldLabel = (key: string, title?: string) => title ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

type Value = any;

interface Control {
    el: HTMLElement;
    set(v: Value): void;
}

/**
 * Rows for `keys` of a component, showing `value` (a missing optional field
 * shows its default); `hooks(key, label)` writes a field to the selection.
 * `set` shows another value (after changes).
 */
export function schemaRows(
    schema: z.ZodObject,
    keys: readonly string[],
    value: Record<string, Value>,
    hooks: (key: string, label: string) => EditHooks<Value>,
): { rows: HTMLElement[]; set(value: Record<string, Value>): void } {
    const shape = schema.shape as Record<string, z.ZodType>;
    const controls = keys.map((key) => {
        const field = shape[key];
        const m = fieldMeta(field);
        const label = fieldLabel(key, m.title);
        const shown = (v: Record<string, Value>) => v[key] ?? fieldDefault(field);
        const c = control(inner(field), m, shown(value), () => hooks(key, label));
        return { c, shown, row: row(label, c.el, m.description) };
    });
    return {
        rows: controls.map((c) => c.row),
        set: (v) => controls.forEach(({ c, shown }) => c.set(shown(v))),
    };
}

function control(s: z.ZodType, m: ReturnType<typeof fieldMeta>, value: Value, hooks: () => EditHooks<Value>): Control {
    switch (m.kind) {
        case 'number':
        case 'int': {
            const n = s as z.ZodNumber;
            const min = n.minValue ?? undefined;
            const max = n.maxValue ?? undefined;
            const whole = m.kind === 'int';
            if (m.slider && min !== undefined && max !== undefined && Number.isFinite(min) && Number.isFinite(max)) {
                return new SliderField({ value, min, max, step: m.step ?? (max - min) / 100, precision: m.precision ?? 2, ...hooks() });
            }
            return new NumberField({ value, min, max, step: m.step ?? (whole ? 1 : 0.05), precision: m.precision ?? (whole ? 0 : 2), ...hooks() });
        }
        case 'bool':
            return new CheckboxField(value, (v) => hooks().commit!(v));
        case 'enum': {
            const options = (s as z.ZodEnum).options.map((v) => ({ value: String(v), label: m.labels?.[String(v)] ?? fieldLabel(String(v)) }));
            return new SelectField(options, value, (v) => hooks().commit!(v));
        }
        case 'color':
            return new ColorField({ value, ...hooks() });
        case 'vec3':
            return new Vec3Field({ value, step: m.step ?? 0.05, precision: m.precision ?? 2, ...hooks() });
        case 'vec2':
        case 'range':
            return new Vec2Field({ value, step: m.step ?? 0.05, precision: m.precision ?? 2, labels: m.kind === 'range' ? ['Min', 'Max'] : undefined, ...hooks() });
    }
    throw new Error(`The inspector has no field for a ${m.kind ?? 'plain'} schema field.`);
}

import type { ParamValue } from '../core/types';
import { describeSpec, type ParamSpec } from '../ai/images';
import { h } from './dom';

const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * A form field for one parameter an image model lists (enum: a list,
 * range: a number, boolean: on / off), writing into `params`. Empty means
 * the model's default and leaves the key out.
 */
export function optionField(key: string, spec: ParamSpec, params: Record<string, ParamValue>): HTMLElement {
    const label = h('span', { text: humanize(key), title: `${key}: ${describeSpec(spec)}` });
    const set = (v: ParamValue | null) => {
        if (v === null || v === '') delete params[key];
        else params[key] = v;
    };
    let control: HTMLElement;
    if (spec.type === 'enum' || spec.type === 'boolean') {
        const values = spec.type === 'enum' ? spec.values.map(String) : ['true', 'false'];
        const sel = h('select', { class: 'select' });
        sel.appendChild(h('option', { text: 'Model default', attrs: { value: '' } }));
        for (const v of values) sel.appendChild(h('option', { text: spec.type === 'boolean' ? (v === 'true' ? 'On' : 'Off') : v, attrs: { value: v } }));
        const cur = params[key];
        sel.value = cur === undefined ? '' : String(cur);
        if (sel.value !== String(cur ?? '')) sel.value = '';
        sel.addEventListener('change', () => {
            if (!sel.value) return set(null);
            if (spec.type === 'boolean') return set(sel.value === 'true');
            set(spec.values.find((x) => String(x) === sel.value) ?? sel.value);
        });
        sel.addEventListener('keydown', (e) => e.stopPropagation());
        control = sel;
    } else {
        const whole = Number.isInteger(spec.min) && Number.isInteger(spec.max);
        const input = h('input', { class: 'text po-num', attrs: { type: 'number', min: spec.min, max: spec.max, step: whole ? 1 : 'any', placeholder: `default (${describeSpec(spec)})` } });
        const cur = params[key];
        if (typeof cur === 'number') input.value = String(cur);
        input.addEventListener('change', () => set(input.value.trim() === '' ? null : Math.min(spec.max, Math.max(spec.min, Number(input.value)))));
        input.addEventListener('keydown', (e) => e.stopPropagation());
        control = input;
    }
    return h('label', { class: 'po-field' }, label, control);
}

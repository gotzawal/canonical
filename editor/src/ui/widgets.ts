import { h } from './dom';
import { icon } from './icons';
import { normalizeHex } from '../engine/color';

export function formatNumber(v: number, precision = 3): string {
    if (!Number.isFinite(v)) return '0';
    const s = v.toFixed(precision);
    return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}

/** Live-edit callbacks. `begin`/`end` bracket a continuous edit (drag). */
export interface EditHooks<T> {
    begin?(): void;
    input?(v: T): void;
    end?(): void;
    commit?(v: T): void;
}

export interface NumberOpts extends EditHooks<number> {
    value: number;
    step?: number;
    min?: number;
    max?: number;
    precision?: number;
    suffix?: string;
    className?: string;
}

/**
 * Numeric input. Drag horizontally to scrub (Shift = x10, Alt = x0.1),
 * click to type, arrow keys to nudge. Scrubs report begin/input/end,
 * typed values report commit.
 */
export class NumberField {
    readonly el: HTMLInputElement;
    private value: number;
    private opts: NumberOpts;

    constructor(opts: NumberOpts) {
        this.opts = opts;
        this.value = opts.value;
        this.el = h('input', {
            class: 'num ' + (opts.className ?? ''),
            attrs: { type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off' },
        });
        this.render();
        this.bind();
    }

    get(): number {
        return this.value;
    }

    set(v: number) {
        this.value = v;
        if (document.activeElement !== this.el) this.render();
    }

    private clamp(v: number): number {
        const { min, max } = this.opts;
        if (min !== undefined && v < min) v = min;
        if (max !== undefined && v > max) v = max;
        return v;
    }

    private render() {
        this.el.value = formatNumber(this.value, this.opts.precision ?? 3) + (this.opts.suffix ?? '');
    }

    private bind() {
        const el = this.el;
        let startX = 0, startValue = 0, scrubbing = false, pointer = -1, moved = 0;

        el.addEventListener('pointerdown', (e) => {
            if (document.activeElement === el || e.button !== 0) return;
            e.preventDefault();
            pointer = e.pointerId;
            startX = e.clientX;
            startValue = this.value;
            scrubbing = false;
            moved = 0;
            el.setPointerCapture(e.pointerId);
        });
        el.addEventListener('pointermove', (e) => {
            if (e.pointerId !== pointer) return;
            const dx = e.clientX - startX;
            moved = Math.max(moved, Math.abs(dx));
            if (!scrubbing && moved < 3) return;
            if (!scrubbing) {
                scrubbing = true;
                document.body.classList.add('scrubbing');
                this.opts.begin?.();
            }
            const step = (this.opts.step ?? 0.1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
            const next = this.clamp(round(startValue + dx * step, this.opts.precision ?? 3));
            if (next !== this.value) {
                this.value = next;
                this.render();
                this.opts.input?.(next);
            }
        });
        const finish = (e: PointerEvent) => {
            if (e.pointerId !== pointer) return;
            pointer = -1;
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
            if (scrubbing) {
                scrubbing = false;
                document.body.classList.remove('scrubbing');
                this.opts.end?.();
            } else {
                el.focus();
                el.select();
            }
        };
        el.addEventListener('pointerup', finish);
        el.addEventListener('pointercancel', finish);

        el.addEventListener('focus', () => {
            el.value = formatNumber(this.value, 6);
        });
        el.addEventListener('blur', () => this.commitText());
        el.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                this.commitText();
                el.blur();
            } else if (e.key === 'Escape') {
                this.render();
                el.blur();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const step = (this.opts.step ?? 0.1) * 10 * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
                const next = this.clamp(round(this.value + (e.key === 'ArrowUp' ? step : -step), this.opts.precision ?? 3));
                this.value = next;
                el.value = formatNumber(next, 6);
                this.opts.commit?.(next);
            }
        });
    }

    private commitText() {
        const text = this.el.value.replace(this.opts.suffix ?? '\u0000', '').trim();
        const parsed = evaluate(text);
        if (parsed === null) {
            this.render();
            return;
        }
        const next = this.clamp(parsed);
        const changed = next !== this.value;
        this.value = next;
        this.render();
        if (changed) this.opts.commit?.(next);
    }
}

function round(v: number, precision: number): number {
    const f = Math.pow(10, Math.max(precision, 0) + 1);
    return Math.round(v * f) / f;
}

/** Parses numbers and simple arithmetic (+ - * / parentheses) without eval. */
export function evaluate(src: string): number | null {
    const s = src.replace(/,/g, '.').replace(/\s+/g, '');
    if (!s) return null;
    let i = 0;
    const peek = () => s[i];
    const expr = (): number => {
        let v = term();
        while (peek() === '+' || peek() === '-') {
            const op = s[i++];
            const r = term();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    };
    const term = (): number => {
        let v = factor();
        while (peek() === '*' || peek() === '/') {
            const op = s[i++];
            const r = factor();
            v = op === '*' ? v * r : v / r;
        }
        return v;
    };
    const factor = (): number => {
        if (peek() === '-') {
            i++;
            return -factor();
        }
        if (peek() === '+') {
            i++;
            return factor();
        }
        if (peek() === '(') {
            i++;
            const v = expr();
            if (peek() !== ')') throw new Error('paren');
            i++;
            return v;
        }
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
        if (!m) throw new Error('number');
        i += m[0].length;
        return parseFloat(m[0]);
    };
    try {
        const v = expr();
        return i === s.length && Number.isFinite(v) ? v : null;
    } catch {
        return null;
    }
}

export interface Vec3Opts extends EditHooks<[number, number, number]> {
    value: [number, number, number];
    step?: number;
    precision?: number;
    suffix?: string;
}

export class Vec3Field {
    readonly el: HTMLElement;
    private fields: NumberField[];
    private value: [number, number, number];

    constructor(opts: Vec3Opts) {
        this.value = [...opts.value] as [number, number, number];
        this.fields = [0, 1, 2].map(
            (i) =>
                new NumberField({
                    value: opts.value[i],
                    step: opts.step,
                    precision: opts.precision,
                    suffix: opts.suffix,
                    className: 'axis-' + 'xyz'[i],
                    begin: () => opts.begin?.(),
                    input: (v) => {
                        this.value[i] = v;
                        opts.input?.([...this.value] as [number, number, number]);
                    },
                    end: () => opts.end?.(),
                    commit: (v) => {
                        this.value[i] = v;
                        opts.commit?.([...this.value] as [number, number, number]);
                    },
                }),
        );
        this.el = h(
            'div',
            { class: 'vec3' },
            this.fields.map((f, i) => h('label', { class: 'vec3-item' }, h('span', { class: 'axis-tag axis-' + 'xyz'[i], text: 'XYZ'[i] }), f.el)),
        );
    }

    set(v: [number, number, number]) {
        this.value = [...v] as [number, number, number];
        this.fields.forEach((f, i) => f.set(v[i]));
    }
}

export interface Vec2Opts extends EditHooks<[number, number]> {
    value: [number, number];
    step?: number;
    precision?: number;
    labels?: [string, string];
}

/** Two numbers side by side, e.g. texture tiling. */
export class Vec2Field {
    readonly el: HTMLElement;
    private fields: NumberField[];
    private value: [number, number];

    constructor(opts: Vec2Opts) {
        this.value = [...opts.value] as [number, number];
        const labels = opts.labels ?? ['U', 'V'];
        this.fields = [0, 1].map(
            (i) =>
                new NumberField({
                    value: opts.value[i],
                    step: opts.step,
                    precision: opts.precision,
                    className: 'axis-' + 'xy'[i],
                    begin: () => opts.begin?.(),
                    input: (v) => {
                        this.value[i] = v;
                        opts.input?.([...this.value] as [number, number]);
                    },
                    end: () => opts.end?.(),
                    commit: (v) => {
                        this.value[i] = v;
                        opts.commit?.([...this.value] as [number, number]);
                    },
                }),
        );
        this.el = h(
            'div',
            { class: 'vec3 vec2' },
            this.fields.map((f, i) => h('label', { class: 'vec3-item' }, h('span', { class: 'axis-tag axis-' + 'xy'[i], text: labels[i] }), f.el)),
        );
    }

    set(v: [number, number]) {
        this.value = [...v] as [number, number];
        this.fields.forEach((f, i) => f.set(v[i]));
    }
}

export interface ColorOpts extends EditHooks<string> {
    value: string;
}

export class ColorField {
    readonly el: HTMLElement;
    private picker: HTMLInputElement;
    private text: HTMLInputElement;
    private live = false;

    constructor(private opts: ColorOpts) {
        this.picker = h('input', { class: 'color-swatch', attrs: { type: 'color' } });
        this.text = h('input', { class: 'color-hex', attrs: { type: 'text', spellcheck: 'false', maxlength: 7 } });
        this.el = h('div', { class: 'color-field' }, this.picker, this.text);
        this.set(opts.value);
        this.picker.addEventListener('input', () => {
            if (!this.live) {
                this.live = true;
                opts.begin?.();
            }
            this.text.value = this.picker.value;
            opts.input?.(this.picker.value);
        });
        this.picker.addEventListener('blur', () => {
            if (this.live) {
                this.live = false;
                opts.end?.();
            }
        });
        this.picker.addEventListener('change', () => {
            this.text.value = this.picker.value;
            if (this.live) {
                opts.input?.(this.picker.value);
                this.live = false;
                opts.end?.();
            } else {
                opts.commit?.(this.picker.value);
            }
        });
        const commitText = () => {
            const v = this.text.value.trim();
            if (!/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
                this.text.value = this.picker.value;
                return;
            }
            const hex = normalizeHex(v.startsWith('#') ? v : '#' + v);
            this.text.value = hex;
            if (hex !== this.picker.value) {
                this.picker.value = hex;
                opts.commit?.(hex);
            }
        };
        this.text.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                commitText();
                this.text.blur();
            }
        });
        this.text.addEventListener('blur', commitText);
    }

    set(hex: string) {
        const v = normalizeHex(hex);
        if (this.live) return;
        this.picker.value = v;
        if (document.activeElement !== this.text) this.text.value = v;
    }
}

export interface SliderOpts extends EditHooks<number> {
    value: number;
    min: number;
    max: number;
    step?: number;
    precision?: number;
}

export class SliderField {
    readonly el: HTMLElement;
    private range: HTMLInputElement;
    private num: NumberField;
    private live = false;

    constructor(opts: SliderOpts) {
        const step = opts.step ?? (opts.max - opts.min) / 100;
        this.range = h('input', { class: 'range', attrs: { type: 'range', min: opts.min, max: opts.max, step } });
        this.range.value = String(opts.value);
        this.num = new NumberField({
            value: opts.value,
            step: step / 4,
            min: opts.min,
            max: undefined,
            precision: opts.precision ?? 2,
            begin: opts.begin,
            input: (v) => {
                this.range.value = String(v);
                opts.input?.(v);
            },
            end: opts.end,
            commit: (v) => {
                this.range.value = String(v);
                opts.commit?.(v);
            },
        });
        this.range.addEventListener('input', () => {
            if (!this.live) {
                this.live = true;
                opts.begin?.();
            }
            const v = parseFloat(this.range.value);
            this.num.set(v);
            opts.input?.(v);
        });
        this.range.addEventListener('change', () => {
            if (this.live) {
                this.live = false;
                opts.end?.();
            }
        });
        this.el = h('div', { class: 'slider-field' }, this.range, this.num.el);
    }

    set(v: number) {
        if (!this.live) this.range.value = String(v);
        this.num.set(v);
    }

    get(): number {
        return this.num.get();
    }
}

export class CheckboxField {
    readonly el: HTMLLabelElement;
    private box: HTMLInputElement;

    constructor(value: boolean, onChange: (v: boolean) => void, text = '') {
        this.box = h('input', { attrs: { type: 'checkbox' } });
        this.box.checked = value;
        this.box.addEventListener('change', () => onChange(this.box.checked));
        this.el = h('label', { class: 'check' }, this.box, h('span', { class: 'check-mark' }), text ? h('span', { class: 'check-text', text }) : null);
    }

    set(v: boolean) {
        this.box.checked = v;
    }
}

export class SelectField<T extends string> {
    readonly el: HTMLSelectElement;

    constructor(options: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
        this.el = h('select', { class: 'select' }, options.map((o) => h('option', { text: o.label, attrs: { value: o.value } })));
        this.el.value = value;
        this.el.addEventListener('change', () => onChange(this.el.value as T));
        this.el.addEventListener('keydown', (e) => e.stopPropagation());
    }

    set(v: T) {
        this.el.value = v;
    }
}

export class TextField {
    readonly el: HTMLInputElement;

    constructor(value: string, onCommit: (v: string) => void, placeholder = '') {
        this.el = h('input', { class: 'text', attrs: { type: 'text', spellcheck: 'false', placeholder } });
        this.el.value = value;
        let original = value;
        this.el.addEventListener('focus', () => (original = this.el.value));
        const commit = () => {
            if (this.el.value !== original) {
                original = this.el.value;
                onCommit(this.el.value);
            }
        };
        this.el.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') this.el.blur();
            if (e.key === 'Escape') {
                this.el.value = original;
                this.el.blur();
            }
        });
        this.el.addEventListener('blur', commit);
    }

    set(v: string) {
        if (document.activeElement !== this.el) this.el.value = v;
    }
}

export function row(label: string, control: Node, hint?: string): HTMLElement {
    return h('div', { class: 'row' }, h('div', { class: 'row-label', text: label, title: hint || label }), h('div', { class: 'row-control' }, control));
}

const COLLAPSE_KEY = 'canonical-editor/collapsed';
let collapsed: Record<string, boolean> = {};
try {
    collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
} catch { /* ignore */ }

/** Collapsible inspector section; remembers its open state. */
export function section(key: string, title: string, iconName: string | null, body: Node[], actions: Node[] = []): HTMLElement {
    const el = h('section', { class: 'section' + (collapsed[key] ? ' collapsed' : '') });
    const header = h(
        'header',
        {
            class: 'section-header',
            on: {
                click: (e) => {
                    if ((e.target as HTMLElement).closest('.section-actions')) return;
                    el.classList.toggle('collapsed');
                    collapsed[key] = el.classList.contains('collapsed');
                    try {
                        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
                    } catch { /* ignore */ }
                },
            },
        },
        icon('chevronDown', 14, 'section-caret'),
        iconName ? icon(iconName, 15) : null,
        h('span', { class: 'section-title', text: title }),
        h('div', { class: 'section-actions' }, actions),
    );
    el.append(header, h('div', { class: 'section-body' }, body));
    return el;
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
    return h('button', { class: 'icon-btn ' + cls, title, attrs: { type: 'button', 'aria-label': title }, on: { click: onClick } }, icon(name, 16));
}

export function button(label: string, onClick: (e: MouseEvent) => void, cls = '', iconName?: string): HTMLButtonElement {
    return h('button', { class: 'btn ' + cls, attrs: { type: 'button' }, on: { click: onClick } }, iconName ? icon(iconName, 15) : null, h('span', { text: label }));
}

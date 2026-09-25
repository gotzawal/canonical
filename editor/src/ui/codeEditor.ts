import { h } from './dom';

// A small code editor without dependencies: a transparent <textarea> for
// input (so selection, IME, undo and accessibility come from the browser)
// on top of a syntax highlighted <pre> that follows its scroll position.

export type CodeLanguage = 'js' | 'wgsl';

export interface Diagnostic {
    /** 1-based line; 0 when the problem has no position. */
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning';
}

export interface CodeEditorOptions {
    language: CodeLanguage;
    value: string;
    onChange?(value: string): void;
    /** Ctrl/Cmd+S or Ctrl/Cmd+Enter. */
    onSave?(value: string): void;
}

const LINE_HEIGHT = 18;
const PAD_Y = 8;
const INDENT = '    ';

const JS_KEYWORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export',
    'extends', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return',
    'static', 'super', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield', 'async', 'await', 'get', 'set',
]);
const JS_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'this', 'NaN', 'Infinity']);

const WGSL_KEYWORDS = new Set([
    'fn', 'let', 'var', 'const', 'struct', 'return', 'if', 'else', 'for', 'loop', 'while', 'break', 'continue',
    'discard', 'switch', 'case', 'default', 'override', 'alias', 'continuing', 'uniform', 'storage', 'private',
    'function', 'workgroup', 'read', 'write', 'read_write',
]);
const WGSL_CONSTANTS = new Set(['true', 'false']);
const WGSL_TYPE = /^(f32|f16|i32|u32|bool|vec[234][fhiu]?|mat[234]x[234][fh]?|array|atomic|ptr|sampler|sampler_comparison|texture_[a-z0-9_]+)$/;

const TOKEN = {
    js: /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(`(?:\\[\s\S]|[^\\`])*`?|'(?:\\.|[^\\'\n])*'?|"(?:\\.|[^\\"\n])*"?)|(\b(?:0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)\b)|([A-Za-z_$][\w$]*)(\s*\()?|(\S)/g,
    wgsl: /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(#[A-Za-z_]+[^\n]*)|(\b(?:0x[0-9a-fA-F]+[iu]?|\d+\.?\d*(?:e[+-]?\d+)?[fhiu]?|\.\d+(?:e[+-]?\d+)?[fh]?)\b)|(@[A-Za-z_]\w*)|([A-Za-z_]\w*)(\s*\()?|(\S)/g,
};

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(cls: string, text: string): string {
    return `<span class="tk-${cls}">${esc(text)}</span>`;
}

/** Syntax highlighted HTML for `code`. */
export function highlight(code: string, lang: CodeLanguage): string {
    let out = '';
    let last = 0;
    const re = new RegExp(TOKEN[lang].source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
        if (m.index > last) out += esc(code.slice(last, m.index));
        last = re.lastIndex;
        if (lang === 'js') {
            const [, comment, str, num, ident, call, other] = m;
            if (comment) out += span('comment', comment);
            else if (str) out += span('string', str);
            else if (num) out += span('number', num);
            else if (ident) {
                const cls = JS_KEYWORDS.has(ident)
                    ? 'keyword'
                    : JS_CONSTANTS.has(ident)
                      ? 'constant'
                      : call
                        ? 'function'
                        : /^[A-Z]/.test(ident)
                          ? 'type'
                          : 'ident';
                out += span(cls, ident) + (call ? esc(call) : '');
            } else if (other) out += /[{}()[\]]/.test(other) ? span('bracket', other) : esc(other);
        } else {
            const [, comment, pre, num, attr, ident, call, other] = m;
            if (comment) out += span(/^\/\/\s*@prop/.test(comment) ? 'annotation' : 'comment', comment);
            else if (pre) out += span('preproc', pre);
            else if (num) out += span('number', num);
            else if (attr) out += span('attr', attr);
            else if (ident) {
                const cls = WGSL_KEYWORDS.has(ident)
                    ? 'keyword'
                    : WGSL_CONSTANTS.has(ident)
                      ? 'constant'
                      : WGSL_TYPE.test(ident)
                        ? 'type'
                        : call
                          ? 'function'
                          : /^(ORI_|materialUniform|globalUniform)/.test(ident)
                            ? 'engine'
                            : 'ident';
                out += span(cls, ident) + (call ? esc(call) : '');
            } else if (other) out += /[{}()[\]]/.test(other) ? span('bracket', other) : esc(other);
        }
    }
    if (last < code.length) out += esc(code.slice(last));
    // A trailing newline needs a character after it to take up a line.
    return out + '\n';
}

export class CodeEditor {
    readonly el: HTMLElement;
    readonly input: HTMLTextAreaElement;
    private pre: HTMLElement;
    private content: HTMLElement;
    private markers: HTMLElement;
    private gutter: HTMLElement;
    private gutterInner: HTMLElement;
    private lines = 0;
    private raf = 0;
    private diagnostics: Diagnostic[] = [];

    constructor(private opts: CodeEditorOptions) {
        this.input = h('textarea', {
            class: 'code-input',
            attrs: { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': 'Code' },
        });
        this.input.value = opts.value;
        this.pre = h('pre', { class: 'code-highlight', attrs: { 'aria-hidden': 'true' } });
        this.markers = h('div', { class: 'code-markers' });
        this.content = h('div', { class: 'code-content' }, this.markers, this.pre);
        this.gutterInner = h('div', { class: 'code-gutter-inner' });
        this.gutter = h('div', { class: 'code-gutter' }, this.gutterInner);
        this.el = h('div', { class: 'code-editor lang-' + opts.language }, this.gutter, h('div', { class: 'code-scroller' }, this.content, this.input));

        this.input.addEventListener('input', () => {
            this.schedule();
            this.opts.onChange?.(this.input.value);
        });
        this.input.addEventListener('scroll', () => this.syncScroll());
        this.input.addEventListener('keydown', (e) => this.onKey(e));
        this.render();
    }

    get value(): string {
        return this.input.value;
    }

    /** Replaces the text (clears the browser undo history). */
    setValue(v: string) {
        if (v === this.input.value) return;
        const { selectionStart, selectionEnd, scrollTop } = this.input;
        this.input.value = v;
        this.input.selectionStart = Math.min(selectionStart, v.length);
        this.input.selectionEnd = Math.min(selectionEnd, v.length);
        this.input.scrollTop = scrollTop;
        this.render();
    }

    setDiagnostics(list: Diagnostic[]) {
        this.diagnostics = list;
        this.renderMarkers();
        this.renderGutter(true);
    }

    focus() {
        this.input.focus({ preventScroll: true });
    }

    /** Puts the caret at the start of `line` and scrolls it into view. */
    revealLine(line: number, column = 1) {
        const lines = this.input.value.split('\n');
        const l = Math.max(1, Math.min(lines.length, line));
        let pos = 0;
        for (let i = 0; i < l - 1; i++) pos += lines[i].length + 1;
        pos += Math.max(0, Math.min(lines[l - 1].length, column - 1));
        this.input.focus({ preventScroll: true });
        this.input.setSelectionRange(pos, pos);
        const top = (l - 1) * LINE_HEIGHT;
        const view = this.input.clientHeight;
        if (top < this.input.scrollTop || top > this.input.scrollTop + view - LINE_HEIGHT * 2) {
            this.input.scrollTop = Math.max(0, top - view / 3);
        }
        this.syncScroll();
    }

    private schedule() {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = 0;
            this.render();
        });
    }

    private render() {
        this.pre.innerHTML = highlight(this.input.value, this.opts.language);
        this.renderGutter();
        this.renderMarkers();
        this.syncScroll();
    }

    private renderGutter(force = false) {
        const count = this.input.value.split('\n').length;
        if (count === this.lines && !force) return;
        this.lines = count;
        const bad = new Map<number, Diagnostic>();
        for (const d of this.diagnostics) {
            if (d.line > 0 && (!bad.has(d.line) || d.severity === 'error')) bad.set(d.line, d);
        }
        const rows: string[] = [];
        for (let i = 1; i <= count; i++) {
            const d = bad.get(i);
            rows.push(d ? `<div class="gl ${d.severity}" title="${esc(d.message)}">${i}</div>` : `<div class="gl">${i}</div>`);
        }
        this.gutterInner.innerHTML = rows.join('');
        this.gutter.style.width = `${Math.max(3, String(count).length) + 3}ch`;
    }

    private renderMarkers() {
        const html: string[] = [];
        const seen = new Set<number>();
        for (const d of this.diagnostics) {
            if (d.line <= 0 || seen.has(d.line)) continue;
            seen.add(d.line);
            html.push(`<div class="code-marker ${d.severity}" style="top:${PAD_Y + (d.line - 1) * LINE_HEIGHT}px"></div>`);
        }
        this.markers.innerHTML = html.join('');
    }

    private syncScroll() {
        const { scrollTop, scrollLeft } = this.input;
        this.content.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
        this.gutterInner.style.transform = `translateY(${-scrollTop}px)`;
    }

    // --------------------------------------------------------------- editing

    private insert(text: string) {
        // execCommand keeps the edit on the textarea's native undo stack.
        if (!document.execCommand('insertText', false, text)) {
            const { selectionStart: a, selectionEnd: b, value } = this.input;
            this.input.value = value.slice(0, a) + text + value.slice(b);
            this.input.selectionStart = this.input.selectionEnd = a + text.length;
            this.input.dispatchEvent(new Event('input'));
        }
    }

    /** Selects whole lines covering the selection; returns their text. */
    private selectLines(): { start: number; end: number; text: string } {
        const { selectionStart, selectionEnd, value } = this.input;
        const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
        let end = value.indexOf('\n', selectionEnd - (selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? 1 : 0));
        if (end < 0) end = value.length;
        return { start, end, text: value.slice(start, end) };
    }

    private replaceLines(mapper: (line: string) => string) {
        const { start, end, text } = this.selectLines();
        const next = text.split('\n').map(mapper).join('\n');
        if (next === text) return;
        this.input.setSelectionRange(start, end);
        this.insert(next);
        this.input.setSelectionRange(start, start + next.length);
    }

    private onKey(e: KeyboardEvent) {
        e.stopPropagation();
        const mod = e.ctrlKey || e.metaKey;
        const ta = this.input;
        const { selectionStart: a, selectionEnd: b, value } = ta;
        if (mod && (e.key === 's' || e.key === 'Enter')) {
            e.preventDefault();
            this.opts.onSave?.(value);
            return;
        }
        if (mod && e.key === '/') {
            e.preventDefault();
            const { text } = this.selectLines();
            const lines = text.split('\n');
            const allCommented = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
            this.replaceLines((l) => (allCommented ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1// ') : l));
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            const multi = value.slice(a, b).includes('\n');
            if (e.shiftKey) this.replaceLines((l) => l.replace(/^( {1,4}|\t)/, ''));
            else if (multi) this.replaceLines((l) => (l.length ? INDENT + l : l));
            else {
                const col = a - (value.lastIndexOf('\n', a - 1) + 1);
                this.insert(' '.repeat(4 - (col % 4)));
            }
            return;
        }
        if (e.key === 'Enter' && !e.altKey) {
            e.preventDefault();
            const lineStart = value.lastIndexOf('\n', a - 1) + 1;
            const indent = /^[ \t]*/.exec(value.slice(lineStart, a))![0];
            const before = value.slice(lineStart, a).trimEnd();
            const after = value[b];
            const opens = /[{([]$/.test(before);
            if (opens && after && /[})\]]/.test(after)) {
                this.insert('\n' + indent + INDENT + '\n' + indent);
                const caret = a + 1 + indent.length + INDENT.length;
                ta.setSelectionRange(caret, caret);
            } else {
                this.insert('\n' + indent + (opens ? INDENT : ''));
            }
            return;
        }
        if ((e.key === '}' || e.key === ')' || e.key === ']') && a === b) {
            const lineStart = value.lastIndexOf('\n', a - 1) + 1;
            const lead = value.slice(lineStart, a);
            if (lead.length >= 4 && /^\s+$/.test(lead)) {
                e.preventDefault();
                ta.setSelectionRange(a - 4, a);
                this.insert(e.key);
            }
            return;
        }
        if (e.key === 'Escape') ta.blur();
    }
}

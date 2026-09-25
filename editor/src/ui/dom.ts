type Child = Node | string | number | null | undefined | false;

export interface Props {
    class?: string;
    style?: Partial<CSSStyleDeclaration> | string;
    text?: string;
    html?: string;
    title?: string;
    attrs?: Record<string, string | number | boolean>;
    dataset?: Record<string, string>;
    on?: { [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void };
}

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (props) {
        if (props.class) el.className = props.class;
        if (typeof props.style === 'string') el.style.cssText = props.style;
        else if (props.style) Object.assign(el.style, props.style);
        if (props.text !== undefined) el.textContent = props.text;
        if (props.html !== undefined) el.innerHTML = props.html;
        if (props.title) el.title = props.title;
        if (props.attrs) {
            for (const [k, v] of Object.entries(props.attrs)) {
                if (v === false) continue;
                el.setAttribute(k, v === true ? '' : String(v));
            }
        }
        if (props.dataset) Object.assign(el.dataset, props.dataset);
        if (props.on) {
            for (const [type, fn] of Object.entries(props.on)) el.addEventListener(type, fn as EventListener);
        }
    }
    append(el, children);
    return el;
}

export function append(el: Element, children: (Child | Child[])[]) {
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
}

export function clear(el: Element) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file']);

/** True when keyboard input should go to a text field instead of editor shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
    return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Formats a shortcut like "Mod+Z" for the current platform. */
export function shortcutLabel(s: string): string {
    return s
        .replace(/Mod/g, isMac ? 'Cmd' : 'Ctrl')
        .replace(/Shift/g, 'Shift')
        .replace(/\+/g, isMac ? '' : '+')
        .replace(/Cmd/g, isMac ? '⌘' : 'Cmd')
        .replace(/Shift/g, isMac ? '⇧' : 'Shift');
}

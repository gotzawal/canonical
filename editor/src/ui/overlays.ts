import { clear, h, shortcutLabel } from './dom';
import { icon } from './icons';

// ----------------------------------------------------------------- layers

// Menus, popovers, dialogs and enlarged images stack up. Escape and clicks
// outside go to the topmost only, a modal one keeps the keyboard (Tab stays
// inside, the page behind takes no shortcuts), and closing one gives the
// focus back to where it was.

interface Layer {
    el: HTMLElement;
    close(): void;
    modal: boolean;
    /** Clicks here do not count as outside (the button that opened it). */
    keep?(target: Node): boolean;
    back: Element | null;
}

const layers: Layer[] = [];

/** Puts an overlay on top; the returned function takes it off (call it from its close). */
function pushLayer(layer: Omit<Layer, 'back'>): () => void {
    const l: Layer = { ...layer, back: document.activeElement };
    layers.push(l);
    return () => {
        const i = layers.indexOf(l);
        if (i < 0) return;
        layers.splice(i, 1);
        const focus = document.activeElement;
        if (l.back instanceof HTMLElement && l.back.isConnected && (!focus || focus === document.body || !focus.isConnected || l.el.contains(focus))) l.back.focus({ preventScroll: true });
    };
}

/** A dialog or an enlarged image is open: the page behind it takes no shortcuts. */
export function modalOpen(): boolean {
    return layers.some((l) => l.modal);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

document.addEventListener(
    'keydown',
    (e) => {
        const top = layers[layers.length - 1];
        if (!top) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            top.close();
        } else if (e.key === 'Tab' && top.modal) {
            const items = Array.from(top.el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
            const first = items[0];
            const last = items[items.length - 1];
            const at = document.activeElement;
            if (first && (!top.el.contains(at) || (e.shiftKey ? at === first : at === last))) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
            }
        }
    },
    true,
);

document.addEventListener(
    'pointerdown',
    (e) => {
        // Every open menu or popover the click is outside of closes, down to a modal layer.
        const t = e.target as Node;
        for (let i = layers.length - 1; i >= 0; i--) {
            const l = layers[i];
            if (l.modal || l.el.contains(t) || l.keep?.(t)) break;
            l.close();
        }
    },
    true,
);

// ------------------------------------------------------------------ menus

export interface MenuItem {
    label?: string;
    icon?: string;
    shortcut?: string;
    action?: () => void;
    enabled?: () => boolean;
    checked?: () => boolean;
    separator?: boolean;
    submenu?: MenuItem[];
}

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeMenus() {
    openMenu?.close();
    openMenu = null;
}

window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());

/** Arrow keys move through a menu's items; right and left open and leave a submenu. */
function menuKeys(box: HTMLElement, list: HTMLElement) {
    list.addEventListener('keydown', (e) => {
        const items = Array.from(list.children).filter((c): c is HTMLButtonElement => c instanceof HTMLButtonElement && !c.disabled);
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const sub = (document.activeElement as HTMLElement | null)?.querySelector<HTMLElement>(':scope > .submenu');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        else if (e.key === 'ArrowRight' && sub) {
            (document.activeElement as HTMLElement).dispatchEvent(new PointerEvent('pointerenter'));
            sub.querySelector<HTMLElement>('button:not([disabled])')?.focus();
        } else if (e.key === 'ArrowLeft' && box.classList.contains('submenu')) {
            box.style.display = '';
            (box.parentElement as HTMLElement).focus();
        } else return;
        e.preventDefault();
        e.stopPropagation();
    });
}

/**
 * A menu: a (glass) box around a list that scrolls. A box that blurs what is
 * behind it is the containing block of its fixed submenus, so it must not
 * scroll too, or it would clip them.
 */
function renderItems(items: MenuItem[], close: () => void): HTMLElement {
    const list = h('div', { class: 'menu-list', attrs: { role: 'menu' } });
    const box = h('div', { class: 'menu' }, list);
    menuKeys(box, list);
    for (const item of items) {
        if (item.separator) {
            list.appendChild(h('div', { class: 'menu-sep' }));
            continue;
        }
        const enabled = item.enabled ? item.enabled() : true;
        const checked = item.checked?.();
        const el = h(
            'button',
            {
                class: 'menu-item' + (enabled ? '' : ' disabled') + (item.submenu ? ' has-sub' : ''),
                attrs: { type: 'button', role: 'menuitem', disabled: !enabled },
            },
            h('span', { class: 'menu-icon' }, checked ? icon('check', 14) : item.icon ? icon(item.icon, 15) : null),
            h('span', { class: 'menu-label', text: item.label ?? '' }),
            item.shortcut ? h('span', { class: 'menu-shortcut', text: shortcutLabel(item.shortcut) }) : null,
            item.submenu ? icon('chevron', 12, 'menu-sub-caret') : null,
        );
        if (checked !== undefined) el.classList.toggle('checked', checked);
        if (item.submenu) {
            const sub = renderItems(item.submenu, close);
            sub.classList.add('submenu');
            el.appendChild(sub);
            // Next to its item, flipped or shifted to stay on screen. It is
            // fixed, so the menu around it can scroll without clipping it.
            // Touch has no hover: a tap opens it (only once the tap is over, which a submenu
            // flipped over its item would take otherwise), and it stays until another opens.
            const open = () => {
                for (const other of list.querySelectorAll<HTMLElement>(':scope > .has-sub > .submenu')) if (other !== sub) other.style.display = '';
                sub.style.display = 'flex';
                // Measured at 0, 0 of its containing block: the window, or the glass menu around it.
                sub.style.left = sub.style.top = '0px';
                const o = sub.getBoundingClientRect();
                const r = el.getBoundingClientRect();
                const x = r.right + o.width + 6 <= window.innerWidth ? r.right : Math.max(6, r.left - o.width);
                const y = Math.max(6, Math.min(r.top - 6, window.innerHeight - o.height - 6));
                sub.style.left = x - o.left + 'px';
                sub.style.top = y - o.top + 'px';
            };
            el.addEventListener('pointerenter', (e) => {
                if (e.pointerType !== 'touch') open();
            });
            el.addEventListener('click', (e) => {
                if (!sub.contains(e.target as Node)) open();
            });
            el.addEventListener('pointerleave', (e) => {
                if (e.pointerType !== 'touch') sub.style.display = '';
            });
        } else if (enabled) {
            el.addEventListener('click', () => {
                close();
                item.action?.();
            });
        }
        list.appendChild(el);
    }
    return box;
}

/** Shows a floating menu at a screen position (context menus). */
export function showMenu(items: MenuItem[], x: number, y: number) {
    closeMenus();
    const close = () => {
        el.remove();
        pop();
        if (openMenu?.el === el) openMenu = null;
    };
    const el = renderItems(items, close);
    el.classList.add('floating');
    document.body.appendChild(el);
    const pop = pushLayer({ el, close, modal: false });
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    el.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
    openMenu = { el, close };
}

export function menubar(menus: { label: string; items: () => MenuItem[] }[]): HTMLElement {
    const bar = h('nav', { class: 'menubar', attrs: { role: 'menubar' } });
    let active: HTMLElement | null = null;
    const open = (btn: HTMLElement, items: MenuItem[], keyboard = false) => {
        closeMenus();
        const close = () => {
            el.remove();
            pop();
            btn.classList.remove('open');
            if (openMenu?.el === el) openMenu = null;
            active = null;
        };
        const el = renderItems(items, close);
        el.classList.add('floating', 'dropdown');
        document.body.appendChild(el);
        const pop = pushLayer({ el, close, modal: false, keep: (t) => bar.contains(t) });
        const r = btn.getBoundingClientRect();
        el.style.left = Math.max(6, Math.min(r.left, window.innerWidth - el.offsetWidth - 6)) + 'px';
        el.style.top = r.bottom + 2 + 'px';
        el.style.maxHeight = window.innerHeight - r.bottom - 8 + 'px';
        btn.classList.add('open');
        active = btn;
        openMenu = { el, close };
        if (keyboard) el.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    };
    // Where the bar has no room for its menus (foldMenubar), one button holds them all.
    const all = h('button', { class: 'menubar-item menubar-all', title: 'Menu', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Menu' } }, icon('menu', 16));
    all.addEventListener('click', (e) => {
        if (active === all) closeMenus();
        else open(all, menus.map((m) => ({ label: m.label, submenu: m.items() })), e.detail === 0);
    });
    bar.appendChild(all);
    for (const m of menus) {
        const btn = h('button', { class: 'menubar-item', text: m.label, attrs: { type: 'button', 'aria-haspopup': 'menu' } });
        btn.addEventListener('click', (e) => {
            if (active === btn) closeMenus();
            // Opened with the keyboard (Enter, Space): the first item takes the focus.
            else open(btn, m.items(), e.detail === 0);
        });
        btn.addEventListener('pointerenter', () => {
            if (active && active !== btn) open(btn, m.items());
        });
        bar.appendChild(btn);
    }
    return bar;
}

/**
 * Folds a menubar into its one Menu button while the bar it is in has no
 * room for every menu (a phone, the steps beside the scene's name, a large
 * font), and unfolds it once the free space (`spacers`) holds them again.
 * The bar is measured, so whatever crowds it folds it: the menus never run
 * under the buttons beside them.
 */
export function foldMenubar(bar: HTMLElement, slot: HTMLElement, spacers: HTMLElement[]) {
    /** The bar's width with every menu, from when it last showed them. */
    let full = 0;
    const fit = () => {
        if (!bar.classList.contains('folded')) {
            full = bar.offsetWidth;
            if (full > slot.clientWidth + 1) {
                // A menu open from the bar loses the button it hangs from.
                if (bar.querySelector('.open')) closeMenus();
                bar.classList.add('folded');
            }
        } else if (full && spacers.reduce((sum, el) => sum + el.offsetWidth, 0) >= full - bar.offsetWidth + 8) {
            if (bar.querySelector('.open')) closeMenus();
            bar.classList.remove('folded');
            // Measured again: still too wide folds it back before it is drawn.
            fit();
        }
    };
    fit();
    // Folding resizes what is watched: it happens in the next frame, not in the
    // observer's callback (where it would be a loop the browser reports).
    let frame = 0;
    const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(fit);
    });
    for (const el of [slot, ...spacers]) observer.observe(el);
}

// ----------------------------------------------------------------- toasts

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info', timeout = 3200) {
    if (!toastHost) {
        toastHost = h('div', { class: 'toasts', attrs: { 'aria-live': 'polite' } });
        document.body.appendChild(toastHost);
    }
    const el = h('div', { class: 'toast ' + kind }, icon(kind === 'error' ? 'alert' : 'info', 15), h('span', { text: message }));
    toastHost.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    const remove = () => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 200);
    };
    el.addEventListener('click', remove);
    setTimeout(remove, kind === 'error' ? Math.max(timeout, 6000) : timeout);
}

// ---------------------------------------------------------------- dialogs

export interface DialogButton {
    label: string;
    primary?: boolean;
    danger?: boolean;
    value?: string;
}

export function dialog(title: string, body: Node | string, buttons: DialogButton[] = [{ label: 'Close', primary: true }]): Promise<string | null> {
    closeMenus();
    return new Promise((resolve) => {
        const content = typeof body === 'string' ? h('p', { text: body }) : body;
        const footer = h('footer', { class: 'dialog-footer' });
        const backdrop = h('div', { class: 'dialog-backdrop' });
        const box = h(
            'div',
            { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } },
            h('header', { class: 'dialog-header' }, h('h2', { text: title }), h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => done(null) } }, icon('close', 16))),
            h('div', { class: 'dialog-body' }, content),
            footer,
        );
        backdrop.appendChild(box);
        const done = (v: string | null) => {
            backdrop.remove();
            pop();
            resolve(v);
        };
        const pop = pushLayer({ el: backdrop, close: () => done(null), modal: true });
        backdrop.addEventListener('pointerdown', (e) => {
            if (e.target === backdrop) done(null);
        });
        let focus: HTMLButtonElement | null = null;
        let safe: HTMLButtonElement | null = null;
        for (const b of buttons) {
            const btn = h('button', {
                class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
                text: b.label,
                attrs: { type: 'button' },
                on: { click: () => done(b.value ?? b.label) },
            });
            if (b.primary) focus = btn;
            else if (!b.danger) safe ??= btn;
            footer.appendChild(btn);
        }
        document.body.appendChild(backdrop);
        // A destructive choice is never the default: Enter in a danger dialog cancels.
        const danger = buttons.some((b) => b.danger);
        (focus ?? (danger ? safe : null) ?? (footer.lastElementChild as HTMLElement | null))?.focus();
    });
}

/** Asks for a line of text (a link, a name); null when cancelled or left empty. */
export async function promptText(title: string, label: string, opts: { value?: string; placeholder?: string; ok?: string } = {}): Promise<string | null> {
    const input = h('input', { class: 'text', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: opts.placeholder ?? '' } });
    input.value = opts.value ?? '';
    const body = h('label', { class: 'prompt-field' }, h('span', { class: 'muted small', text: label }), input);
    const ok = opts.ok ?? 'OK';
    const answer = dialog(title, body, [{ label: 'Cancel' }, { label: ok, primary: true, value: 'ok' }]);
    // Enter answers, and the editor's shortcuts stay out of the field.
    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (input.closest('.dialog')?.querySelector('.btn.primary') as HTMLButtonElement | null)?.click();
    });
    requestAnimationFrame(() => input.focus());
    return (await answer) === 'ok' ? input.value.trim() || null : null;
}

export interface Modal {
    readonly box: HTMLElement;
    readonly footer: HTMLElement;
    close(): void;
    readonly closed: boolean;
}

/**
 * A dialog that stays open while the user works in it: its buttons do not
 * close it. The X, Escape or `close()` do, unless `canClose` says no.
 */
export function modal(title: string, content: Node, opts: { cls?: string; canClose?: () => boolean; onClose?: () => void } = {}): Modal {
    closeMenus();
    const footer = h('footer', { class: 'dialog-footer' });
    const backdrop = h('div', { class: 'dialog-backdrop' });
    let closed = false;
    const tryClose = () => {
        if (opts.canClose && !opts.canClose()) return;
        close();
    };
    const box = h(
        'div',
        { class: 'dialog ' + (opts.cls ?? ''), attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } },
        h('header', { class: 'dialog-header' }, h('h2', { text: title }), h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: tryClose } }, icon('close', 16))),
        h('div', { class: 'dialog-body' }, content),
        footer,
    );
    backdrop.appendChild(box);
    const close = () => {
        if (closed) return;
        closed = true;
        backdrop.remove();
        pop();
        opts.onClose?.();
    };
    const pop = pushLayer({ el: backdrop, close: tryClose, modal: true });
    document.body.appendChild(backdrop);
    return {
        box,
        footer,
        close,
        get closed() {
            return closed;
        },
    };
}

/** Shows an image large over everything; a click or Escape closes it. */
export function lightbox(src: string, caption = '') {
    const img = h('img', { attrs: { src, alt: caption } });
    const el = h('div', { class: 'lightbox', attrs: { role: 'dialog', 'aria-label': caption || 'Image' } }, img, caption ? h('div', { class: 'lightbox-caption', text: caption }) : null);
    const close = () => {
        el.remove();
        pop();
    };
    const pop = pushLayer({ el, close, modal: true });
    el.addEventListener('click', close);
    document.body.appendChild(el);
}

export function confirmDialog(title: string, message: string, ok = 'OK', danger = false): Promise<boolean> {
    return dialog(title, message, [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', primary: !danger, danger }]).then((v) => v === 'ok');
}

export function replaceChildren(el: HTMLElement, ...nodes: Node[]) {
    clear(el);
    el.append(...nodes);
}

// --------------------------------------------------------------- popovers

let openPopover: { el: HTMLElement; close: () => void } | null = null;

/** A floating panel under `anchor` (over it when there is no room below); closes on outside clicks and Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, cls = '', onClose?: () => void): () => void {
    openPopover?.close();
    closeMenus();
    const el = h('div', { class: 'popover ' + cls }, content);
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    el.style.left = Math.max(6, Math.min(r.left, window.innerWidth - pr.width - 6)) + 'px';
    const below = r.bottom + 4 + pr.height <= window.innerHeight - 6;
    el.style.top = (below ? r.bottom + 4 : Math.max(6, Math.min(r.top - pr.height - 4, window.innerHeight - pr.height - 6))) + 'px';
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        el.remove();
        pop();
        if (openPopover?.el === el) openPopover = null;
        onClose?.();
    };
    const pop = pushLayer({ el, close, modal: false, keep: (t) => anchor.contains(t) });
    openPopover = { el, close };
    return close;
}

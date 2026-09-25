import { clear, h, shortcutLabel } from './dom';
import { icon } from './icons';

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

document.addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.menubar-item')) {
        closeMenus();
    }
}, true);
window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());

function renderItems(items: MenuItem[], close: () => void): HTMLElement {
    const list = h('div', { class: 'menu', attrs: { role: 'menu' } });
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
        } else if (enabled) {
            el.addEventListener('click', () => {
                close();
                item.action?.();
            });
        }
        list.appendChild(el);
    }
    return list;
}

/** Shows a floating menu at a screen position (context menus). */
export function showMenu(items: MenuItem[], x: number, y: number) {
    closeMenus();
    const close = () => {
        el.remove();
        if (openMenu?.el === el) openMenu = null;
    };
    const el = renderItems(items, close);
    el.classList.add('floating');
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    el.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
    el.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
    openMenu = { el, close };
}

export function menubar(menus: { label: string; items: () => MenuItem[] }[]): HTMLElement {
    const bar = h('nav', { class: 'menubar', attrs: { role: 'menubar' } });
    let active: HTMLElement | null = null;
    const open = (btn: HTMLElement, items: MenuItem[]) => {
        closeMenus();
        const close = () => {
            el.remove();
            btn.classList.remove('open');
            if (openMenu?.el === el) openMenu = null;
            active = null;
        };
        const el = renderItems(items, close);
        el.classList.add('floating', 'dropdown');
        document.body.appendChild(el);
        const r = btn.getBoundingClientRect();
        el.style.left = r.left + 'px';
        el.style.top = r.bottom + 2 + 'px';
        btn.classList.add('open');
        active = btn;
        openMenu = { el, close };
    };
    for (const m of menus) {
        const btn = h('button', { class: 'menubar-item', text: m.label, attrs: { type: 'button' } });
        btn.addEventListener('click', () => {
            if (active === btn) closeMenus();
            else open(btn, m.items());
        });
        btn.addEventListener('pointerenter', () => {
            if (active && active !== btn) open(btn, m.items());
        });
        bar.appendChild(btn);
    }
    return bar;
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
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            resolve(v);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                done(null);
            }
        };
        document.addEventListener('keydown', onKey, true);
        backdrop.addEventListener('pointerdown', (e) => {
            if (e.target === backdrop) done(null);
        });
        let focus: HTMLButtonElement | null = null;
        for (const b of buttons) {
            const btn = h('button', {
                class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
                text: b.label,
                attrs: { type: 'button' },
                on: { click: () => done(b.value ?? b.label) },
            });
            if (b.primary) focus = btn;
            footer.appendChild(btn);
        }
        document.body.appendChild(backdrop);
        (focus ?? footer.lastElementChild as HTMLElement | null)?.focus();
    });
}

export function confirmDialog(title: string, message: string, ok = 'OK', danger = false): Promise<boolean> {
    return dialog(title, message, [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', primary: !danger, danger }]).then((v) => v === 'ok');
}

export function replaceChildren(el: HTMLElement, ...nodes: Node[]) {
    clear(el);
    el.append(...nodes);
}

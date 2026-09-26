// Page notifications: cards in the corner of the editor for events that
// need the user's attention (the assistant finished, a save checkpoint).
// Every kind can be switched off from its card ("Don't show this
// notification") or from the bell menu, and optionally also arrives as a
// system notification while the tab is in the background.

import { Emitter } from '../core/events';
import { h } from './dom';
import { icon } from './icons';
import { toast } from './overlays';

export type NoticeKind = 'ai-done' | 'checkpoint' | 'stage';

export const NOTICE_KINDS: { kind: NoticeKind; label: string; hint: string }[] = [
    { kind: 'ai-done', label: 'AI finished', hint: 'When the assistant finishes a request' },
    { kind: 'checkpoint', label: 'Save checkpoints', hint: 'Asks to save the project after a stretch of work' },
    { kind: 'stage', label: 'Stage proposals', hint: 'When the assistant proposes completing a stage' },
];

export interface NoticeAction {
    label: string;
    primary?: boolean;
    run: () => void | Promise<void>;
}

export interface NoticeOptions {
    kind: NoticeKind;
    title: string;
    body?: string;
    icon?: string;
    actions?: NoticeAction[];
    /** Closes by itself after this many ms; 0 keeps it until answered. */
    timeout?: number;
    /** A card with the same key is replaced instead of stacked. */
    key?: string;
}

export interface Notice {
    close(): void;
    /** Changes the text of an open card. */
    update(patch: { title?: string; body?: string }): void;
    readonly closed: boolean;
}

interface NotifyPrefs {
    disabled: Partial<Record<NoticeKind, boolean>>;
    /** Also show system notifications while the page is hidden. */
    system: boolean;
}

const PREFS_KEY = 'canonical-editor/notifications';

function loadPrefs(): NotifyPrefs {
    try {
        const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        return { disabled: raw && typeof raw.disabled === 'object' ? raw.disabled : {}, system: raw?.system === true };
    } catch {
        return { disabled: {}, system: false };
    }
}

class NotificationCenter extends Emitter<{ prefs: NotifyPrefs }> {
    prefs: NotifyPrefs = loadPrefs();
    private host: HTMLElement | null = null;
    private open = new Map<string, Notice>();

    enabled(kind: NoticeKind): boolean {
        return !this.prefs.disabled[kind];
    }

    setEnabled(kind: NoticeKind, on: boolean) {
        const disabled = { ...this.prefs.disabled };
        if (on) delete disabled[kind];
        else disabled[kind] = true;
        this.save({ ...this.prefs, disabled });
    }

    get systemSupported(): boolean {
        return typeof Notification !== 'undefined';
    }

    /** Turns system notifications on (asking the browser for permission) or off. */
    async setSystem(on: boolean): Promise<boolean> {
        if (on) {
            if (!this.systemSupported) {
                toast('This browser has no system notifications.', 'error');
                return false;
            }
            let perm = Notification.permission;
            if (perm === 'default') perm = await Notification.requestPermission();
            if (perm !== 'granted') {
                toast('Notifications are blocked for this site in the browser settings.', 'error');
                this.save({ ...this.prefs, system: false });
                return false;
            }
        }
        this.save({ ...this.prefs, system: on });
        return true;
    }

    private save(prefs: NotifyPrefs) {
        this.prefs = prefs;
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch { /* ignore */ }
        this.emit('prefs', prefs);
    }

    /** Shows a notification; null when the user switched this kind off. */
    show(opts: NoticeOptions): Notice | null {
        if (!this.enabled(opts.kind)) return null;
        if (opts.key) this.open.get(opts.key)?.close();
        if (!this.host) {
            this.host = h('div', { class: 'notices', attrs: { 'aria-live': 'polite' } });
            // Inside #app the cards can keep clear of the side panel (--right-w).
            (document.getElementById('app') ?? document.body).appendChild(this.host);
        }
        const title = h('div', { class: 'notice-title', text: opts.title });
        const body = h('div', { class: 'notice-body', text: opts.body ?? '' });
        body.hidden = !opts.body;
        const box = h('input', { attrs: { type: 'checkbox' } });
        const mute = h('label', { class: 'notice-mute' }, box, h('span', { text: "Don't show this notification" }));
        box.addEventListener('change', () => {
            this.setEnabled(opts.kind, !box.checked);
            if (box.checked) toast('Turned off. The bell menu at the top turns it back on.', 'info', 4000);
        });
        let closed = false;
        let timer = 0;
        const card = h('div', { class: 'notice ' + opts.kind, attrs: { role: 'status' } });
        const close = () => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            card.classList.remove('show');
            setTimeout(() => card.remove(), 180);
            if (opts.key && this.open.get(opts.key) === notice) this.open.delete(opts.key);
        };
        const actions = h('div', { class: 'notice-actions' });
        for (const a of opts.actions ?? []) {
            const b = h('button', { class: 'btn small' + (a.primary ? ' primary' : ''), text: a.label, attrs: { type: 'button' } });
            b.addEventListener('click', async () => {
                close();
                await a.run();
            });
            actions.appendChild(b);
        }
        card.append(
            h(
                'div',
                { class: 'notice-head' },
                icon(opts.icon ?? 'info', 16),
                title,
                h('button', { class: 'icon-btn notice-close', title: 'Close', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: close } }, icon('close', 14)),
            ),
            body,
            actions.childElementCount ? actions : null,
            mute,
        );
        // Hovering keeps a timed card open.
        card.addEventListener('pointerenter', () => clearTimeout(timer));
        card.addEventListener('pointerleave', () => {
            if (opts.timeout) timer = window.setTimeout(close, 2500);
        });
        this.host.appendChild(card);
        requestAnimationFrame(() => card.classList.add('show'));
        if (opts.timeout) timer = window.setTimeout(close, opts.timeout);
        const notice: Notice = {
            close,
            update: (patch) => {
                if (patch.title !== undefined) title.textContent = patch.title;
                if (patch.body !== undefined) {
                    body.textContent = patch.body;
                    body.hidden = !patch.body;
                }
            },
            get closed() {
                return closed;
            },
        };
        if (opts.key) this.open.set(opts.key, notice);
        this.system(opts);
        return notice;
    }

    /** A system notification when the page is not in front. */
    private system(opts: NoticeOptions) {
        if (!this.prefs.system || !this.systemSupported || Notification.permission !== 'granted') return;
        if (document.visibilityState === 'visible' && document.hasFocus()) return;
        try {
            const n = new Notification(opts.title, { body: opts.body ?? '', tag: opts.key ?? opts.kind, icon: new URL('favicon.svg', document.baseURI).href });
            n.onclick = () => {
                window.focus();
                n.close();
            };
        } catch (e) {
            console.warn('[editor] system notification failed', e);
        }
    }
}

export const notices = new NotificationCenter();

// Page notifications: cards in the corner of the editor for events that
// need the user's attention (the assistant finished, images to look at).
// Every kind can be switched off from its card ("Don't show this
// notification") or from the bell menu, and optionally also arrives as a
// system notification while the tab is in the background.

import { Emitter } from '../core/events';
import { readLocal, writeLocal } from '../core/local';
import type { NoticeKind, NoticeOptions } from '../core/messages';
import { h } from './dom';
import { icon } from './icons';
import { mascotAvatar } from './mascot';
import { toast } from './overlays';

export const NOTICE_KINDS: { kind: NoticeKind; label: string; hint: string }[] = [
    { kind: 'ai-done', label: 'AI finished', hint: 'When the assistant finishes a request' },
    { kind: 'stage', label: 'Steps to approve', hint: 'When the assistant asks you to approve a finished step' },
    { kind: 'review', label: 'Reference images', hint: 'When the assistant drew reference images for you to look at' },
    { kind: 'model', label: 'AI models', hint: 'When agents need a model that is not downloaded yet' },
];

interface NotifyPrefs {
    disabled: Partial<Record<NoticeKind, boolean>>;
    /** Also show system notifications while the page is hidden. */
    system: boolean;
}

const PREFS_KEY = 'canonical-editor/notifications';

function loadPrefs(): NotifyPrefs {
    const raw = readLocal<any>(PREFS_KEY, {});
    return { disabled: raw && typeof raw.disabled === 'object' ? raw.disabled : {}, system: raw?.system === true };
}

class NotificationCenter extends Emitter<{ prefs: NotifyPrefs }> {
    prefs: NotifyPrefs = loadPrefs();
    private host: HTMLElement | null = null;
    /** Close functions of the open cards with a key. */
    private open = new Map<string, () => void>();

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
        writeLocal(PREFS_KEY, prefs);
        this.emit('prefs', prefs);
    }

    /** Closes the card with this key, if one is open. */
    dismiss(key: string) {
        this.open.get(key)?.();
    }

    /** Shows a notification, unless the user switched this kind off. */
    show(opts: NoticeOptions) {
        if (!this.enabled(opts.kind)) return;
        if (opts.key) this.dismiss(opts.key);
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
            if (opts.key && this.open.get(opts.key) === close) this.open.delete(opts.key);
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
                opts.mascot ? mascotAvatar(opts.mascot, 20, 'notice-heron') : icon(opts.icon ?? 'info', 16),
                title,
                h('button', { class: 'icon-btn notice-close', title: 'Close', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: close } }, icon('close', 14)),
            ),
            body,
            ...(actions.childElementCount ? [actions] : []),
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
        if (opts.key) this.open.set(opts.key, close);
        this.system(opts);
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

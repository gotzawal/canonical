// Messages for the user from code below the UI (the editor, the pipeline,
// the assistant's tools): short toasts, notices (cards with actions, see
// ui/notify.ts) and questions. They go up as events that main.ts hands to
// the UI; with nobody listening (tests), a question gets no answer (null).
// UI code calls ui/overlays.ts and ui/notify.ts directly.

import { Emitter } from './events';

export type ToastKind = 'info' | 'success' | 'error';

export type NoticeKind = 'ai-done' | 'stage' | 'review' | 'model';

/** How the assistant is doing, as its face shows it (ui/mascot.ts). */
export type AssistantMood = 'idle' | 'think' | 'ask' | 'done' | 'error' | 'sleep';

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
    /** A notice from the assistant shows its face in this mood instead of the icon. */
    mascot?: AssistantMood;
    actions?: NoticeAction[];
    /** Closes by itself after this many ms; 0 keeps it until answered. */
    timeout?: number;
    /** A card with the same key is replaced instead of stacked, and closed by dismiss(key). */
    key?: string;
}

export interface Choice {
    label: string;
    primary?: boolean;
    danger?: boolean;
    /** What the question answers when chosen (the label by default). */
    value?: string;
}

export const messages = new Emitter<{
    toast: { text: string; kind: ToastKind; timeout?: number };
    notice: NoticeOptions;
    dismiss: string;
    /** `answer` gets the value of the chosen button, null when the question is dismissed. */
    ask: { title: string; body: string; choices: Choice[]; answer: (value: string | null) => void };
}>();

export const toast = (text: string, kind: ToastKind = 'info', timeout?: number) => messages.emit('toast', { text, kind, timeout });
export const notify = (notice: NoticeOptions) => messages.emit('notice', notice);
/** Closes the notice with this key, if it is open. */
export const dismiss = (key: string) => messages.emit('dismiss', key);

export function ask(title: string, body: string, choices: Choice[]): Promise<string | null> {
    return new Promise((answer) => {
        if (messages.has('ask')) messages.emit('ask', { title, body, choices, answer });
        else answer(null);
    });
}

export function confirmDialog(title: string, body: string, ok = 'OK', danger = false): Promise<boolean> {
    return ask(title, body, [{ label: 'Cancel', value: 'cancel' }, { label: ok, value: 'ok', primary: !danger, danger }]).then((v) => v === 'ok');
}

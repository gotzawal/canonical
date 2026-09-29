// The heron: the assistant's face, and the editor's. Where there is room
// (the start screen, an empty chat, loading, empty panels, the cards that ask
// the user something, notices) the whole bird stands there in a pose that
// says what is going on; where the text is dense and space counts (the
// chat's header, the status over the view, the cards of stages) only its
// head shows, in a mood. It is drawn inline, so styles.css can move its parts
// (it blinks, tilts its head, pecks, walks, hops; see "the heron" there) and
// keep it still for those who ask for reduced motion.

import type { AssistantMood } from '../core/messages';
import avatarIdle from './mascot/avatar.svg?raw';
import avatarAsk from './mascot/avatar-ask.svg?raw';
import avatarDone from './mascot/avatar-done.svg?raw';
import avatarError from './mascot/avatar-error.svg?raw';
import avatarSleep from './mascot/avatar-sleep.svg?raw';
import avatarThink from './mascot/avatar-think.svg?raw';
import ask from './mascot/ask.svg?raw';
import celebrate from './mascot/celebrate.svg?raw';
import peck from './mascot/peck.svg?raw';
import rest from './mascot/rest.svg?raw';
import stand from './mascot/stand.svg?raw';
import walk from './mascot/walk.svg?raw';

/** idle: waiting; think: working; ask: waiting for the user; done: just finished; error: the request failed; sleep: not connected. */
export type MascotMood = AssistantMood;

const AVATARS: Record<MascotMood, string> = {
    idle: avatarIdle,
    think: avatarThink,
    ask: avatarAsk,
    done: avatarDone,
    error: avatarError,
    sleep: avatarSleep,
};

/**
 * The whole bird, all on the same 392 x 450 canvas and ground line:
 * stand (the default), ask (a question to the user), rest (asleep on one
 * leg: waiting, not connected, nothing to do), walk (on the way: loading),
 * peck (at work), celebrate (done).
 */
const POSES = { stand, ask, rest, walk, peck, celebrate };

export type MascotPose = keyof typeof POSES;

/** The whole bird for a mood of its head (a notice shows the one for its mood). */
export const MOOD_POSE: Record<MascotMood, MascotPose> = { idle: 'stand', think: 'peck', ask: 'ask', done: 'celebrate', error: 'ask', sleep: 'rest' };

/**
 * How much of the canvas is empty above each pose's drawing (a fraction of
 * its height, the question mark and the crest included): the element leaves
 * it out, so a resting or pecking heron takes less height than a standing
 * one of the same size. What moves above it (the question mark bobbing, a
 * hop) may draw outside the element.
 */
const EMPTY_ABOVE: Record<MascotPose, number> = { stand: 0.16, ask: 0.015, rest: 0.39, walk: 0.2, peck: 0.445, celebrate: 0.09 };

const parsed = new Map<string, SVGSVGElement>();

/** A copy of a drawing (parsed once). */
function drawing(svg: string): SVGSVGElement {
    let root = parsed.get(svg);
    if (!root) {
        root = document.importNode(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement, true) as unknown as SVGSVGElement;
        parsed.set(svg, root);
    }
    return root.cloneNode(true) as SVGSVGElement;
}

/**
 * Decorative (the text next to it says what it means), and out of step with
 * the other herons on the screen: they do not blink or breathe together.
 */
function decorate(el: SVGSVGElement, cls: string) {
    el.setAttribute('class', cls);
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('focusable', 'false');
    el.style.setProperty('--heron-delay', `${(-Math.random() * 6).toFixed(2)}s`);
}

/** The heron's head in a mood, `size` px square. */
export function mascotAvatar(mood: MascotMood = 'idle', size = 20, cls = ''): SVGSVGElement {
    const el = drawing(AVATARS[mood]);
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
    decorate(el, `heron mascot-avatar ${cls}`.trim());
    el.dataset.mood = mood;
    return el;
}

/** Changes an avatar's mood (its drawing, and data-mood for its animation). */
export function setMascotMood(el: SVGSVGElement, mood: MascotMood) {
    if (el.dataset.mood === mood) return;
    el.dataset.mood = mood;
    el.replaceChildren(...Array.from(drawing(AVATARS[mood]).childNodes));
}

/**
 * The whole heron in a pose. `scale`: the height of the pose's canvas in
 * px, the same bird size for every pose (standing, it is about 0.8 of that
 * tall); the element is that minus the empty part above the drawing. A
 * style may set its height instead (with width: auto): it keeps the pose's
 * shape.
 */
export function mascotPose(pose: MascotPose, scale: number, cls = ''): SVGSVGElement {
    const el = drawing(POSES[pose]);
    const shown = 1 - EMPTY_ABOVE[pose];
    // The files' canvas is 28 -10 392 450.
    el.setAttribute('viewBox', `28 ${(-10 + 450 * EMPTY_ABOVE[pose]).toFixed(1)} 392 ${(450 * shown).toFixed(1)}`);
    el.setAttribute('width', String(Math.round((scale * 392) / 450)));
    el.setAttribute('height', String(Math.round(scale * shown)));
    decorate(el, `heron mascot-pose ${cls}`.trim());
    el.dataset.pose = pose;
    return el;
}

const pngs = new Map<MascotMood, Promise<string>>();

/** The heron's head in a mood as a PNG data URL, `size` px (for system notifications, which may not show SVG). */
export function mascotPng(mood: MascotMood, size = 128): Promise<string> {
    let png = pngs.get(mood);
    if (!png) {
        png = new Promise<string>((resolve, reject) => {
            const img = new Image(size, size);
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = size;
                    canvas.getContext('2d')!.drawImage(img, 0, 0, size, size);
                    resolve(canvas.toDataURL('image/png'));
                } catch (e) {
                    reject(e);
                }
            };
            img.onerror = () => reject(new Error(`The heron (${mood}) could not be drawn.`));
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(AVATARS[mood])}`;
        });
        // A failure is not kept: the next notice tries again.
        png.catch(() => pngs.delete(mood));
        pngs.set(mood, png);
    }
    return png;
}

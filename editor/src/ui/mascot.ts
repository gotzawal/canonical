// The heron: the assistant's face, and the editor's. Where there is room
// (the start screen, an empty chat, loading, empty panels, the cards that ask
// the user something) the whole bird stands there in a pose that says what
// is going on; where the text is dense and space counts (the chat's header,
// the status over the view, notices, the cards of stages) only its head
// shows, in a mood.

import type { AssistantMood } from '../core/messages';
import avatarIdle from './mascot/avatar.svg';
import avatarAsk from './mascot/avatar-ask.svg';
import avatarDone from './mascot/avatar-done.svg';
import avatarError from './mascot/avatar-error.svg';
import avatarSleep from './mascot/avatar-sleep.svg';
import avatarThink from './mascot/avatar-think.svg';
import ask from './mascot/ask.svg';
import celebrate from './mascot/celebrate.svg';
import peck from './mascot/peck.svg';
import rest from './mascot/rest.svg';
import stand from './mascot/stand.svg';
import walk from './mascot/walk.svg';
import { h } from './dom';

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

/**
 * How much of the canvas is empty above each pose's drawing (a fraction of
 * its height, the top of the question mark or the crest included): the
 * element leaves it out, so a resting or pecking heron takes less height
 * than a standing one of the same size.
 */
const EMPTY_ABOVE: Record<MascotPose, number> = { stand: 0.16, ask: 0.08, rest: 0.39, walk: 0.2, peck: 0.445, celebrate: 0.09 };

/** The heron's head in a mood, `size` px square. Decorative: the text next to it says what it means. */
export function mascotAvatar(mood: MascotMood = 'idle', size = 20, cls = ''): HTMLImageElement {
    const img = h('img', { class: `mascot-avatar ${cls}`.trim(), attrs: { src: AVATARS[mood], width: size, height: size, alt: '', draggable: 'false' } });
    img.dataset.mood = mood;
    return img;
}

/** Changes an avatar's mood (the picture, and data-mood for its animation). */
export function setMascotMood(img: HTMLImageElement, mood: MascotMood) {
    if (img.dataset.mood === mood) return;
    img.dataset.mood = mood;
    img.src = AVATARS[mood];
}

/**
 * The whole heron in a pose, decorative as the avatar. `scale`: the height
 * of the pose's canvas in px, the same bird size for every pose (standing,
 * it is about 0.8 of that tall); the element is that minus the empty part
 * above the drawing. A style may set its height instead (with width: auto):
 * it keeps the pose's shape.
 */
export function mascotPose(pose: MascotPose, scale: number, cls = ''): HTMLImageElement {
    const shown = 1 - EMPTY_ABOVE[pose];
    const img = h('img', {
        class: `mascot-pose ${cls}`.trim(),
        style: { aspectRatio: `392 / ${Math.round(450 * shown)}` },
        attrs: { src: POSES[pose], width: Math.round((scale * 392) / 450), height: Math.round(scale * shown), alt: '', draggable: 'false' },
    });
    img.dataset.pose = pose;
    return img;
}

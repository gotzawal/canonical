// The heron: the assistant's face. A small avatar that shows what the
// assistant is doing (in the chat's header and the status over the view),
// and a whole bird on the start screen and when every step is done. Kept to
// those places, so it stays a quiet presence rather than a decoration.

import avatarIdle from './mascot/avatar.svg';
import avatarAsk from './mascot/avatar-ask.svg';
import avatarDone from './mascot/avatar-done.svg';
import avatarError from './mascot/avatar-error.svg';
import avatarSleep from './mascot/avatar-sleep.svg';
import avatarThink from './mascot/avatar-think.svg';
import celebrate from './mascot/celebrate.svg';
import stand from './mascot/stand.svg';
import { h } from './dom';

/** idle: waiting; think: working; ask: waiting for the user; done: just finished; error: the request failed; sleep: not connected. */
export type MascotMood = 'idle' | 'think' | 'ask' | 'done' | 'error' | 'sleep';

const AVATARS: Record<MascotMood, string> = {
    idle: avatarIdle,
    think: avatarThink,
    ask: avatarAsk,
    done: avatarDone,
    error: avatarError,
    sleep: avatarSleep,
};

const POSES = { stand, celebrate };

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

/** The whole heron, `height` px tall (the poses are 392 x 450). */
export function mascotPose(pose: keyof typeof POSES, height: number, cls = ''): HTMLImageElement {
    return h('img', { class: `mascot-pose ${cls}`.trim(), attrs: { src: POSES[pose], width: Math.round((height * 392) / 450), height, alt: '', draggable: 'false' } });
}

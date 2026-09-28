// Skeletal animation in Play: every imported model with clips plays its clip
// (NodeDoc.animation); the model of a character changes clip with the
// character's mode (idle, walk, run, jump, fall), crossfading; scripts play
// clips with this.animator.

import type { AnimatorComponent, Object3D } from '@orillusion/core';
import { Animation } from '../core/model';
import { defaults } from '../core/schema';
import type { Store } from '../core/store';
import type { AnimationDoc } from '../core/types';
import type { SceneSync } from '../engine/sync';
import type { Character, CharacterMode } from './character';

/** What a script sees of a model's animation (this.animator). */
export interface AnimatorApi {
    readonly clips: string[];
    /** The clip playing now. */
    readonly clip: string;
    /** Playback speed, 1 as made. */
    speed: number;
    /** Plays a clip, blending from the current one over `fade` seconds (the model's crossfade by default); false for an unknown clip. */
    play(clip: string, fade?: number): boolean;
}

/** Clip names that suit each mode, for models whose modes are not set. */
const NAMED: Record<CharacterMode, RegExp> = { idle: /idle|stand|breath|survey/i, walk: /walk/i, run: /run|sprint|jog/i, jump: /jump/i, fall: /fall|air/i };

/** The clip of a character's mode: the one set, else one named for the mode; null keeps the clip playing. */
export function clipFor(clips: string[], doc: AnimationDoc, mode: CharacterMode): string | null {
    return clips.includes(doc[mode]) ? doc[mode] : (clips.find((c) => NAMED[mode].test(c)) ?? null);
}

class Animated implements AnimatorApi {
    readonly clips: string[];
    clip = '';
    private rate: number;

    constructor(private animator: AnimatorComponent, readonly doc: AnimationDoc) {
        this.clips = animator.clips.map((c) => c.clipName);
        this.rate = animator.timeScale = doc.speed;
        this.play(this.clips.includes(doc.clip) ? doc.clip : this.clips[0], 0);
    }

    get speed() {
        return this.rate;
    }

    set speed(v: number) {
        this.rate = this.animator.timeScale = Math.max(0, +v || 0);
    }

    play(clip: string, fade = this.doc.fade): boolean {
        if (!this.clips.includes(clip)) return false;
        if (clip !== this.clip) {
            if (fade > 0 && this.clip) this.animator.crossFade(clip, fade);
            else this.animator.playAnim(clip);
        }
        this.clip = clip;
        return true;
    }

    pause(paused: boolean) {
        this.animator.timeScale = paused ? 0 : this.rate;
    }
}

/** The animated models of a Play session. */
export class Animations {
    private list = new Map<Object3D, Animated>();

    constructor(store: Store, sync: SceneSync, characters: readonly Character[]) {
        for (const n of store.doc.nodes) {
            const animator = n.model && sync.modelInfo(n.id)?.animator;
            if (animator) this.list.set(sync.entries.get(n.id)!.obj, new Animated(animator, n.animation ?? defaults(Animation)));
        }
        for (const c of characters) {
            const a = this.of(c.obj);
            if (!a) continue;
            const follow = (mode: CharacterMode) => {
                const clip = clipFor(a.clips, a.doc, mode);
                if (clip) a.play(clip);
            };
            follow(c.mode);
            c.on('mode', follow);
        }
    }

    /** The animation of an object's model, or of the first model under it. */
    of(obj: Object3D): Animated | null {
        const own = this.list.get(obj);
        if (own) return own;
        for (const [o, a] of this.list) {
            for (let p: Object3D | null = o; p; p = (p.transform.parent?.object3D as Object3D) ?? null) if (p === obj) return a;
        }
        return null;
    }

    /** Pausing Play holds every model on its frame. */
    pause(paused: boolean) {
        for (const a of this.list.values()) a.pause(paused);
    }
}

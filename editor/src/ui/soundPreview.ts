// Listening to a sound asset in the editor (the Audio section's Listen
// button, the assets panel): one at a time, as recorded, not in 3D.

import { getAssetUrl } from '../core/assets';
import type { AssetMeta } from '../core/types';

let current: { id: string; audio: HTMLAudioElement } | null = null;

/** Plays a sound asset, or stops it when it is the one playing; resolves true when it started. */
export async function toggleSound(meta: AssetMeta, opts: { volume?: number; pitch?: number } = {}): Promise<boolean> {
    const was = current?.id;
    stopSound();
    if (was === meta.id) return false;
    const url = await getAssetUrl(meta);
    if (!url) throw new Error(`${meta.name} is not stored in this browser.`);
    // The fragment names the file for the engine; a media element would read it as a time range.
    const audio = new Audio(url.split('#')[0]);
    audio.volume = Math.min(1, Math.max(0, opts.volume ?? 1));
    audio.playbackRate = Math.min(4, Math.max(0.25, opts.pitch ?? 1));
    audio.preservesPitch = false;
    const mine = { id: meta.id, audio };
    current = mine;
    audio.addEventListener('ended', () => {
        if (current === mine) current = null;
    });
    await audio.play();
    return true;
}

export function stopSound() {
    current?.audio.pause();
    current = null;
}

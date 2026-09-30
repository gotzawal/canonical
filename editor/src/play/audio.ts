// Sound in Play: the engine's audio components (packages/media-extention)
// on the objects with an Audio component (PositionAudio when 3D, else
// StaticAudio), heard by a listener that follows the active camera, and
// one-off sounds for scripts (this.playSound) and behavior trees (Play
// Sound). Each clip is decoded once and shared by every source playing it.
// Pausing Play suspends every sound; Stop closes them all.
//
// Browsers let a page make sound only after the user did something on it:
// the editor's Play is a click, and a built game stays silent until the
// first click, touch or key (then what should be playing is heard).

import { Object3D, type Camera3D } from '@orillusion/core';
import { AudioListener, PositionAudio, StaticAudio } from '@orillusion/media-extention/audio';
import { getAssetUrl } from '../core/assets';
import type { AssetMeta, AudioSourceDoc, Vec3 } from '../core/types';

/** An Audio component in Play, as scripts see it (this.audio). */
export interface AudioApi {
    /** The clip's asset name (null without one). */
    readonly clip: string | null;
    readonly playing: boolean;
    /** Seconds into the clip. */
    readonly time: number;
    /** Length of the clip in seconds (0 until it is loaded). */
    readonly duration: number;
    /** 0..2 (1 as recorded). */
    volume: number;
    /** Playback rate 0.25..4 (2: twice as fast, an octave higher). */
    pitch: number;
    loop: boolean;
    /** Plays from where it was paused (the start after stop() or the end). */
    play(): void;
    pause(): void;
    stop(): void;
}

export interface SoundOptions {
    /** 0..2, 1 by default. */
    volume?: number;
    /** Playback rate 0.25..4, 1 by default. */
    pitch?: number;
    loop?: boolean;
    /** Heard from there (an object it follows, or a point); without it, the same everywhere. */
    at?: Object3D | Vec3 | null;
    /** 3D: full volume within this many meters, fading out up to `far`. */
    near?: number;
    far?: number;
}

/** A one-off sound playing. */
export interface SoundHandle {
    stop(): void;
    /** Resolves when it ended or was stopped. */
    readonly done: Promise<void>;
}

/** Where a sound was heard, for the agents' hearing (play/ai/sensors.ts). */
export interface HeardSound {
    at: Vec3;
    /** How far it carries, meters. */
    range: number;
    /** The object that made it, if any. */
    source: Object3D | null;
}

interface Source {
    doc: AudioSourceDoc;
    audio: StaticAudio;
    meta: AssetMeta | null;
    /** A script (or Play on Start) wants it playing once the clip is loaded. */
    wanted: boolean;
}

interface Shot {
    node: AudioBufferSourceNode | null;
    panner: PannerNode | null;
    follow: Object3D | null;
    finish(): void;
}

/** One-off sounds at once at most: a script that plays one every frame drops the oldest. */
const MAX_SHOTS = 32;

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function position(at: Object3D | Vec3): Vec3 {
    if (Array.isArray(at)) return [at[0], at[1], at[2]];
    const w = (at as Object3D).transform.worldPosition;
    return [w.x, w.y, w.z];
}

function setParam(p: AudioParam | undefined, v: number) {
    if (p) p.value = v;
}

export class AudioSystem {
    /** Holds the listener: its AudioContext and the master gain every sound goes through. */
    private host = new Object3D();
    readonly listener: AudioListener;
    private buffers = new Map<string, Promise<AudioBuffer | null>>();
    private sources = new Map<Object3D, Source>();
    private shots: Shot[] = [];
    private gesture: (() => void) | null = null;
    private closed = false;
    private warned = new Set<string>();
    /** Called for every sound that starts where agents could hear it. */
    onSound: ((s: HeardSound) => void) | null = null;

    constructor(private assets: () => readonly AssetMeta[], private warn: (text: string) => void, opts: { muted?: boolean } = {}) {
        this.listener = this.host.addComponent(AudioListener);
        if (opts.muted) this.listener.gain.gain.value = 0;
        if (this.listener.context.state !== 'running') this.waitForGesture();
    }

    get context(): AudioContext {
        return this.listener.context;
    }

    /** A sound asset by id or name (with or without its extension, any case). */
    find(clip: string): AssetMeta | null {
        const all = this.assets().filter((a) => a.kind === 'audio');
        const want = String(clip ?? '').toLowerCase();
        return (
            all.find((a) => a.id === clip) ??
            all.find((a) => a.name.toLowerCase() === want) ??
            all.find((a) => a.name.replace(/\.[a-z0-9]+$/i, '').toLowerCase() === want) ??
            null
        );
    }

    /** The decoded clip (once per asset). */
    private buffer(meta: AssetMeta): Promise<AudioBuffer | null> {
        let p = this.buffers.get(meta.id);
        if (!p) {
            p = (async () => {
                const url = await getAssetUrl(meta);
                if (!url) throw new Error('its file is not stored in this browser');
                const bytes = await (await fetch(url)).arrayBuffer();
                return await this.context.decodeAudioData(bytes);
            })().catch((e) => {
                if (!this.closed) this.warnOnce(meta.id, `The sound "${meta.name}" could not be played: ${e?.message || e}.`);
                return null;
            });
            this.buffers.set(meta.id, p);
        }
        return p;
    }

    private warnOnce(key: string, text: string) {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        this.warn(text);
    }

    // ------------------------------------------------------------- sources

    /** An object's Audio component starts: its clip loads, and plays when it plays on start. */
    add(obj: Object3D, doc: AudioSourceDoc) {
        if (this.sources.has(obj)) return;
        const meta = doc.clip ? (this.assets().find((a) => a.id === doc.clip && a.kind === 'audio') ?? null) : null;
        const audio = obj.addComponent(doc.spatial ? PositionAudio : StaticAudio);
        audio.setLisenter(this.listener);
        if (audio instanceof PositionAudio) {
            audio.distanceModel = 'linear';
            audio.refDistance = doc.near;
            audio.maxDistance = Math.max(doc.far, doc.near + 0.1);
            audio.rolloffFactor = 1;
        }
        const src: Source = { doc, audio, meta, wanted: doc.autoplay };
        this.sources.set(obj, src);
        if (!meta) return;
        void this.buffer(meta).then((buf) => {
            if (!buf || this.closed || this.sources.get(obj) !== src) return;
            audio.setBuffer(buf, { loop: doc.loop, volume: doc.volume, playbackRate: doc.pitch });
            if (src.wanted) this.start(obj, src);
        });
    }

    private start(obj: Object3D, src: Source) {
        if (src.audio.playing || !src.audio.buffer) return;
        src.audio.play();
        if (src.doc.spatial) this.heard(obj, Math.max(src.doc.far, src.doc.near) * Math.min(1, src.audio.volume));
    }

    /** What scripts control an object's Audio component with (null without one). */
    api(obj: Object3D | null): AudioApi | null {
        const src = obj ? this.sources.get(obj) : undefined;
        if (!src || !obj) return null;
        const a = src.audio;
        const self = this;
        return {
            get clip() {
                return src.meta?.name ?? null;
            },
            get playing() {
                return a.playing;
            },
            get time() {
                return a.position;
            },
            get duration() {
                return a.buffer?.duration ?? 0;
            },
            get volume() {
                return a.volume;
            },
            set volume(v: number) {
                a.setVolume(clamp(v, 0, 2, a.volume));
            },
            get pitch() {
                return a.playbackRate;
            },
            set pitch(v: number) {
                a.playbackRate = clamp(v, 0.25, 4, a.playbackRate);
            },
            get loop() {
                return a.loop;
            },
            set loop(v: boolean) {
                a.loop = !!v;
            },
            play() {
                src.wanted = true;
                self.start(obj, src);
            },
            pause() {
                src.wanted = false;
                if (a.playing) a.pause();
            },
            stop() {
                src.wanted = false;
                a.stop();
            },
        };
    }

    /** Destroyed objects stop their sounds (document objects are only taken out of the scene). */
    removeObjects(gone: Set<Object3D>) {
        for (const [obj, src] of this.sources) {
            if (!gone.has(obj)) continue;
            src.audio.stop();
            this.sources.delete(obj);
        }
        for (const s of this.shots) if (s.follow && gone.has(s.follow)) s.follow = null;
    }

    // ------------------------------------------------------------ one-offs

    /** Plays a sound asset once (or looped until stopped); null when there is no such sound. */
    play(clip: string, opts: SoundOptions = {}, source: Object3D | null = null): SoundHandle | null {
        const meta = this.find(clip);
        if (!meta) {
            this.warnOnce(`missing:${clip}`, `There is no sound "${clip}" in the project: import it, or add one from the Library.`);
            return null;
        }
        let finish!: () => void;
        const done = new Promise<void>((r) => (finish = r));
        const shot: Shot = { node: null, panner: null, follow: null, finish: () => {} };
        let ended = false;
        shot.finish = () => {
            if (ended) return;
            ended = true;
            this.shots = this.shots.filter((s) => s !== shot);
            finish();
        };
        this.shots.push(shot);
        while (this.shots.length > MAX_SHOTS) this.stopShot(this.shots[0]);
        const volume = clamp(opts.volume, 0, 2, 1);
        const near = clamp(opts.near, 0.1, 1000, 2);
        const far = Math.max(clamp(opts.far, 0.5, 10000, 30), near + 0.1);
        void this.buffer(meta).then((buf) => {
            if (!buf || ended || this.closed) return shot.finish();
            const ctx = this.context;
            const node = ctx.createBufferSource();
            node.buffer = buf;
            node.loop = !!opts.loop;
            node.playbackRate.value = clamp(opts.pitch, 0.25, 4, 1);
            const gain = ctx.createGain();
            gain.gain.value = volume;
            if (opts.at) {
                const panner = ctx.createPanner();
                panner.panningModel = 'HRTF';
                panner.distanceModel = 'linear';
                panner.refDistance = near;
                panner.maxDistance = far;
                panner.rolloffFactor = 1;
                const p = position(opts.at);
                setParam(panner.positionX, p[0]);
                setParam(panner.positionY, p[1]);
                setParam(panner.positionZ, p[2]);
                node.connect(panner).connect(gain);
                shot.panner = panner;
                shot.follow = Array.isArray(opts.at) ? null : (opts.at as Object3D);
                this.onSound?.({ at: p, range: far * Math.min(1, volume), source: source ?? shot.follow });
            } else node.connect(gain);
            gain.connect(this.listener.gain);
            node.onended = () => {
                node.disconnect();
                gain.disconnect();
                shot.panner?.disconnect();
                shot.finish();
            };
            shot.node = node;
            node.start();
        });
        return { stop: () => this.stopShot(shot), done };
    }

    private stopShot(shot: Shot) {
        if (shot.node) shot.node.stop();
        else shot.finish();
    }

    /** Tells the agents about a sound of an object (Audio components that start, footsteps from scripts). */
    heard(obj: Object3D, range: number) {
        this.onSound?.({ at: position(obj), range, source: obj });
    }

    // --------------------------------------------------------------- frame

    /** The listener takes the camera's place (after the camera moved this frame); one-off sounds follow their objects. */
    frame(camera: Camera3D | null) {
        if (this.closed || !camera) return;
        const m = camera.object3D.transform.worldMatrix.rawData;
        const l = this.context.listener;
        const f = Math.hypot(m[8], m[9], m[10]) || 1;
        const u = Math.hypot(m[4], m[5], m[6]) || 1;
        if (l.positionX) {
            setParam(l.positionX, m[12]);
            setParam(l.positionY, m[13]);
            setParam(l.positionZ, m[14]);
            setParam(l.forwardX, m[8] / f);
            setParam(l.forwardY, m[9] / f);
            setParam(l.forwardZ, m[10] / f);
            setParam(l.upX, m[4] / u);
            setParam(l.upY, m[5] / u);
            setParam(l.upZ, m[6] / u);
        } else {
            l.setPosition(m[12], m[13], m[14]);
            l.setOrientation(m[8] / f, m[9] / f, m[10] / f, m[4] / u, m[5] / u, m[6] / u);
        }
        for (const s of this.shots) {
            if (!s.follow || !s.panner) continue;
            const p = position(s.follow);
            setParam(s.panner.positionX, p[0]);
            setParam(s.panner.positionY, p[1]);
            setParam(s.panner.positionZ, p[2]);
        }
    }

    /** Pausing Play pauses every sound where it is. */
    pause(paused: boolean) {
        if (this.closed) return;
        if (paused) void this.context.suspend();
        else void this.context.resume();
    }

    /** Stop: every sound ends and the context closes. */
    dispose() {
        if (this.closed) return;
        for (const s of this.shots.slice()) this.stopShot(s);
        for (const [obj, src] of this.sources) {
            src.audio.stop();
            obj.removeComponent(src.audio.constructor as typeof StaticAudio);
        }
        this.sources.clear();
        this.closed = true;
        this.gesture?.();
        // Destroys the listener, which closes its context.
        this.host.destroy();
    }

    /** Resumes the context at the page's first click, touch or key. */
    private waitForGesture() {
        const types = ['pointerdown', 'keydown', 'touchend'];
        const resume = () => {
            if (this.closed) return;
            void this.context.resume().then(() => {
                if (this.context.state === 'running') this.gesture?.();
            });
        };
        for (const t of types) window.addEventListener(t, resume, { capture: true });
        this.gesture = () => {
            for (const t of types) window.removeEventListener(t, resume, { capture: true });
            this.gesture = null;
        };
    }
}

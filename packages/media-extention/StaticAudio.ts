import { ComponentBase } from '@orillusion/core';
import { AudioListener } from './AudioListener';
/**
 * Static audio component, volume level does not vary depending on the position of the monitor
 * @group Audio
 */
export class StaticAudio extends ComponentBase {
    private listener: AudioListener | null = null;
    public context: AudioContext | null = null;
    public gainNode: GainNode | null = null;
    public source: AudioBufferSourceNode | null = null
    private _options = {
        loop: true,
        volume: 1,
        /** Playback rate: 2 plays twice as fast and an octave higher. */
        playbackRate: 1,
    };
    public playing = false;
    /** Where playback starts next, seconds into the buffer. */
    private _currentTime: number = 0;
    /** Context time at which the buffer's start would have played (for the position when paused). */
    private _startedAt: number = 0;
    private _buffer: AudioBuffer | null = null
    constructor() {
        super();
    }
    private _onState: (() => void) | null = null;
    public setLisenter(listener: AudioListener): this {
        this.listener = listener;
        this.context = listener.context as AudioContext;
        this.gainNode = this.context.createGain();
        this.gainNode.connect(this.listener.gain);

        const context = this.context;
        this._onState = () => {
            if (context.state === 'closed') {
                console.warn('AudioListener removed');
                this.release();
            }
        };
        context.addEventListener('statechange', this._onState);
        return this;
    }
    /** Lets go of the listener's context (it closed, or this component is destroyed). */
    private release() {
        this.stop();
        this.gainNode?.disconnect();
        if (this._onState) this.context?.removeEventListener('statechange', this._onState);
        this._onState = null;
        this.listener = null;
        this.context = null;
        this.gainNode = null;
    }
    async load(url: string, options: {} = {}) {
        Object.assign(this._options, options);
        let req = await fetch(url);
        let buffer = await req.arrayBuffer();
        this._buffer = await this.context?.decodeAudioData(buffer) as AudioBuffer;
    }
    async loadBuffer(buffer: ArrayBuffer, options: {} = {}) {
        Object.assign(this._options, options);
        this._buffer = await this.context?.decodeAudioData(buffer) as AudioBuffer;
    }
    /**
     * Uses audio decoded already (one buffer can serve many sources of the
     * same listener's context).
     */
    public setBuffer(buffer: AudioBuffer, options: { loop?: boolean; volume?: number; playbackRate?: number } = {}): this {
        Object.assign(this._options, options);
        this._buffer = buffer;
        this._currentTime = 0;
        return this;
    }
    public get buffer(): AudioBuffer | null {
        return this._buffer;
    }
    public get loop(): boolean {
        return this._options.loop;
    }
    public set loop(value: boolean) {
        this._options.loop = value;
        if (this.source) this.source.loop = value;
    }
    public get volume(): number {
        return this._options.volume;
    }
    public get playbackRate(): number {
        return this._options.playbackRate;
    }
    public set playbackRate(value: number) {
        if (this.playing && this.context) {
            // Keep the position right: it advances at the new rate from now on.
            this._currentTime = this.position;
            this._startedAt = this.context.currentTime;
        }
        this._options.playbackRate = value;
        this.source?.playbackRate.setValueAtTime(value, this.context?.currentTime ?? 0);
    }
    /** Seconds into the buffer that play now. */
    public get position(): number {
        if (!this.playing || !this.context || !this._buffer) return this._currentTime;
        const t = this._currentTime + (this.context.currentTime - this._startedAt) * this._options.playbackRate;
        const d = this._buffer.duration;
        return this._options.loop && d > 0 ? t % d : Math.min(t, d);
    }
    // loadAudio(mediaElement: HTMLAudioElement) {
    //     this.element = mediaElement;
    //     this.source = this.context.createMediaElementSource(mediaElement);
    //     this.connect();
    // }
    public play(): this {
        if (!this.context) {
            console.warn('no audio source yet');
            return this;
        }
        if (this.playing) {
            console.warn('Audio is alredy playing');
            return this;
        }
        if (!this._buffer) {
            console.warn('Audio is not ready');
            return this;
        }
        const source = this.context.createBufferSource();
        source.buffer = this._buffer;
        source.loop = this._options.loop;
        source.playbackRate.value = this._options.playbackRate;
        // A sound that is not looped ends by itself: it is not playing any more, and plays from the start next time.
        source.onended = () => {
            if (this.source !== source) return;
            this.source = null;
            source.disconnect();
            this.playing = false;
            this._currentTime = 0;
        };
        this.source = source;
        this.connect();
        if (this._currentTime >= this._buffer.duration) this._currentTime = 0;
        this.source.start(0, this._currentTime);
        this._startedAt = this.context.currentTime;
        this.setVolume(this._options.volume);
        this.playing = true;
        return this;
    }
    public pause(): this {
        if (!this.playing) {
            console.warn('Audio is not playing');
            return this;
        }
        this._currentTime = this.position;
        const source = this.source;
        this.source = null;
        source?.stop();
        source?.disconnect();
        this.playing = false;
        return this;
    }
    public stop(): this {
        if (this.playing) this.pause();
        this._currentTime = 0;
        return this;
    }
    public setVolume(value: number): this {
        this._options.volume = value;
        if (!this.context) {
            console.warn('no audio source yet');
            return this;
        }
        this.gainNode?.gain.setTargetAtTime(value, this.context ? this.context.currentTime : 0, 0.01);
        return this;
    }
    protected connect() {
        this.source?.connect(this.gainNode as GainNode);
    }
    public destroy(force?: boolean) {
        this.release();
        super.destroy(force);
    }
}

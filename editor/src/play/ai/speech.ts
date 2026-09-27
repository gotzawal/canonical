// Voice lines for scripts (this.say). A line is split into sentences and
// spoken one sentence at a time, in the order lines were asked for; a task's
// AbortSignal stops a line. While a line waits or plays, the decision model
// gets smaller batches (Scheduler.speechPending), so a voice line is not
// held up behind a long batch.
//
// Sentences are spoken by a SpeechEngine; the built-in one uses the
// browser's speech synthesis (Web Speech API).

export interface SayOptions {
    /** Voice name (or a part of it), e.g. "Google UK English Female". */
    voice?: string;
    /** BCP 47 language, e.g. "en-US" or "ko-KR". */
    lang?: string;
    /** 0.1 .. 10, default 1. */
    rate?: number;
    /** 0 .. 2, default 1. */
    pitch?: number;
    /** 0 .. 1, default 1. */
    volume?: number;
    signal?: AbortSignal;
}

export interface SpeechEngine {
    readonly name: string;
    readonly available: boolean;
    /** Speaks one sentence; resolves when it ended. */
    speak(sentence: string, opts: SayOptions): Promise<void>;
    /** Stops what is being spoken. */
    stop(): void;
}

/** Words whose period does not end a sentence. */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'prof', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'lt', 'sgt', 'capt', 'gen', 'col', 'no']);

/**
 * Splits text into sentences. A sentence ends at ., ! or ? followed by a
 * space or the end (so 5.30 stays whole), or at a CJK full stop; "Mr." and
 * other abbreviations and initials do not end one.
 */
export function splitSentences(text: string): string[] {
    const s = text.replace(/\s+/g, ' ').trim();
    const out: string[] = [];
    const re = /([.!?]+)["'”’)\]]*(?= |$)|[。！？]+["'”’)\]」』]*/g;
    let start = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
        if (m[1] === '.') {
            const word = /(\S+)$/.exec(s.slice(start, m.index))?.[1] ?? '';
            if (ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) continue;
        }
        const end = m.index + m[0].length;
        const piece = s.slice(start, end).trim();
        if (piece) out.push(piece);
        start = end;
    }
    const rest = s.slice(start).trim();
    if (rest) out.push(rest);
    return out;
}

/** Speech synthesis of the browser. */
export class WebSpeechEngine implements SpeechEngine {
    readonly name = 'web-speech';

    get available(): boolean {
        return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
    }

    speak(sentence: string, opts: SayOptions): Promise<void> {
        if (!this.available) return new Promise((r) => setTimeout(r, Math.min(4000, 60 * sentence.length)));
        return new Promise((resolve) => {
            const u = new SpeechSynthesisUtterance(sentence);
            if (opts.lang) u.lang = opts.lang;
            if (opts.voice) {
                const want = opts.voice.toLowerCase();
                const v = speechSynthesis.getVoices().find((x) => x.name.toLowerCase().includes(want));
                if (v) u.voice = v;
            }
            if (opts.rate !== undefined) u.rate = Math.min(10, Math.max(0.1, opts.rate));
            if (opts.pitch !== undefined) u.pitch = Math.min(2, Math.max(0, opts.pitch));
            if (opts.volume !== undefined) u.volume = Math.min(1, Math.max(0, opts.volume));
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve();
            };
            // Some systems never fire "end" (no voices): give up after about twice the reading time.
            const timer = window.setTimeout(finish, 2000 + (sentence.length * 150) / (opts.rate ?? 1));
            u.onend = finish;
            u.onerror = finish;
            speechSynthesis.speak(u);
        });
    }

    stop() {
        if (this.available) speechSynthesis.cancel();
    }
}

interface Line {
    sentences: string[];
    opts: SayOptions;
    resolve: () => void;
    reject: (e: unknown) => void;
    cancelled: boolean;
}

export class SpeechQueue {
    engine: SpeechEngine = new WebSpeechEngine();
    private lines: Line[] = [];
    private current: Line | null = null;
    /** Raised by cancelAll, so a loop that was waiting on the engine stops. */
    private generation = 0;
    private pumping = false;

    /** Sentences waiting or being spoken. */
    get pending(): number {
        return this.lines.reduce((n, l) => n + l.sentences.length, 0) + (this.current ? 1 : 0);
    }

    say(text: string, opts: SayOptions = {}): Promise<void> {
        const sentences = splitSentences(text);
        if (!sentences.length) return Promise.resolve();
        if (opts.signal?.aborted) return Promise.reject(abortError());
        return new Promise<void>((resolve, reject) => {
            const line: Line = { sentences, opts, resolve, reject, cancelled: false };
            opts.signal?.addEventListener('abort', () => this.cancel(line), { once: true });
            this.lines.push(line);
            void this.pump();
        });
    }

    private cancel(line: Line) {
        if (line.cancelled) return;
        line.cancelled = true;
        this.lines = this.lines.filter((l) => l !== line);
        if (this.current === line) this.engine.stop();
        line.reject(abortError());
    }

    private async pump() {
        if (this.pumping) return;
        this.pumping = true;
        const gen = this.generation;
        try {
            while (this.lines.length && gen === this.generation) {
                const line = this.lines[0];
                this.current = line;
                while (line.sentences.length && !line.cancelled && gen === this.generation) {
                    const s = line.sentences.shift()!;
                    try {
                        await this.engine.speak(s, line.opts);
                    } catch {
                        /* go on with the next sentence */
                    }
                }
                this.lines = this.lines.filter((l) => l !== line);
                this.current = null;
                if (!line.cancelled) line.resolve();
            }
        } finally {
            if (gen === this.generation) this.pumping = false;
        }
    }

    /** Stops everything (Play stopped). */
    cancelAll() {
        for (const l of [...this.lines]) this.cancel(l);
        if (this.current) this.cancel(this.current);
        this.lines = [];
        this.current = null;
        this.generation++;
        this.pumping = false;
        this.engine.stop();
    }
}

function abortError(): Error {
    const e = new Error('The line was stopped.');
    e.name = 'AbortError';
    return e;
}

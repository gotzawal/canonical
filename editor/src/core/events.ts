type Handler<T> = (payload: T) => void;

/** Times listeners (core/perf.ts installs one in development builds). */
export interface ListenerProbe {
    /** Where a listener is being added: the caller's function and file. */
    site(): string;
    /** A listener of `type` added at `site` ran from `start` for `ms` milliseconds. */
    record(type: string, site: string, start: number, ms: number): void;
}

let probe: ListenerProbe | null = null;

/** Starts timing every listener added from now on (null stops). */
export function probeListeners(p: ListenerProbe | null) {
    probe = p;
}

/** Where a listener is being added, while listeners are timed; '' otherwise. */
export function listenerSite(): string {
    return probe ? probe.site() : '';
}

/** Runs `fn`, timing it as a listener of `type` added at `site` while listeners are timed. */
export function timed<T>(type: string, site: string, fn: () => T): T {
    const p = probe;
    if (!p) return fn();
    const start = performance.now();
    try {
        return fn();
    } finally {
        p.record(type, site, start, performance.now() - start);
    }
}

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, any>> {
    private handlers = new Map<keyof Events, Set<Handler<any>>>();
    /** Where each handler was added, while listeners are timed. */
    private sites: WeakMap<Handler<any>, string> | null = null;

    on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
        let set = this.handlers.get(type);
        if (!set) {
            set = new Set();
            this.handlers.set(type, set);
        }
        set.add(handler);
        if (probe) (this.sites ??= new WeakMap()).set(handler, probe.site());
        return () => set!.delete(handler);
    }

    /** True when something listens to `type`. */
    has(type: keyof Events): boolean {
        return !!this.handlers.get(type)?.size;
    }

    emit<K extends keyof Events>(type: K, payload: Events[K]): void {
        const set = this.handlers.get(type);
        if (!set) return;
        const p = probe;
        for (const h of Array.from(set)) {
            const start = p ? performance.now() : 0;
            try {
                h(payload);
            } catch (e) {
                console.error(`[editor] handler for "${String(type)}" failed`, e);
            }
            if (p) p.record(String(type), this.sites?.get(h) ?? '(added before timing)', start, performance.now() - start);
        }
    }
}

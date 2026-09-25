type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, any>> {
    private handlers = new Map<keyof Events, Set<Handler<any>>>();

    on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
        let set = this.handlers.get(type);
        if (!set) {
            set = new Set();
            this.handlers.set(type, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
    }

    emit<K extends keyof Events>(type: K, payload: Events[K]): void {
        const set = this.handlers.get(type);
        if (!set) return;
        for (const h of Array.from(set)) {
            try {
                h(payload);
            } catch (e) {
                console.error(`[editor] handler for "${String(type)}" failed`, e);
            }
        }
    }
}

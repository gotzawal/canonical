// The few browser globals the tested modules touch: preferences in
// localStorage, and the script compiler's <script> injection (which falls
// back to Function when the script does not run, as here). An undo step
// that would not bring back what its change touched (a change hint that
// leaves something out) fails the test.

const items = new Map<string, string>();
const g = globalThis as any;

g.localStorage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k),
    clear: () => items.clear(),
    key: (i: number) => Array.from(items.keys())[i] ?? null,
    get length() {
        return items.size;
    },
};
g.window ??= g;
g.addEventListener ??= () => {};
g.removeEventListener ??= () => {};
g.document ??= {
    createElement: () => ({ textContent: '', remove() {} }),
    head: { appendChild() {} },
};

const { Store } = await import('../../src/core/store');
Store.historyProblem = (message) => {
    throw new Error(message);
};

export {};

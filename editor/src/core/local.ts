// Preferences of this browser in localStorage: reading never throws (storage
// blocked, damaged JSON), writing ignores a full or blocked storage.

export function readLocal<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

export function writeLocal(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* the preference lasts this session */ }
}

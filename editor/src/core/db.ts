// The editor's IndexedDB database. Object stores:
//   assets    imported files of the open project (see assets.ts)
//   kv        small editor state that outlives a reload (the assistant's conversation)
//   swatches  the swatch library, shared by every project in this browser

const DB_NAME = 'canonical-editor';
const DB_VERSION = 2;

export type StoreName = 'assets' | 'kv' | 'swatches';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
                if (!db.objectStoreNames.contains('swatches')) db.createObjectStore('swatches', { keyPath: 'id' });
            };
            req.onsuccess = () => {
                const db = req.result;
                // Let a newer editor in another tab upgrade the database.
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                resolve(db);
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => console.warn('[editor] storage upgrade is waiting for other editor tabs to close');
        });
        dbPromise.catch(() => (dbPromise = null));
    }
    return dbPromise;
}

/** Runs one request in its own transaction and resolves with its result once the transaction completes. */
export function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const t = db.transaction(store, mode);
                const req = run(t.objectStore(store));
                t.oncomplete = () => resolve(req.result);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            }),
    );
}

/** In-memory fallback for the kv store (private windows without IndexedDB). */
const kvMemory = new Map<string, unknown>();

export async function kvGet<T>(key: string): Promise<T | undefined> {
    try {
        const v = await tx('kv', 'readonly', (s) => s.get(key));
        if (v !== undefined) return v as T;
    } catch { /* fall back to memory */ }
    return kvMemory.get(key) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
    kvMemory.set(key, value);
    try {
        await tx('kv', 'readwrite', (s) => s.put(value, key));
    } catch (e) {
        console.warn('[editor] could not store', key, e);
    }
}

export async function kvDelete(key: string): Promise<void> {
    kvMemory.delete(key);
    try {
        await tx('kv', 'readwrite', (s) => s.delete(key));
    } catch { /* ignore */ }
}

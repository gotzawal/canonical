import { Emitter } from './events';
import { defaultCamera, defaultEnvironment, uid } from './defaults';
import type { CameraState, NodeDoc, SceneDoc } from './types';

/** What changed in a doc update. Omitted means "anything may have changed". */
export interface ChangeHint {
    /** Only these nodes changed (no nodes added, removed or re-parented). */
    nodes?: string[];
    /** Only the environment changed. */
    env?: boolean;
}

export type Tool = 'select' | 'translate' | 'rotate' | 'scale';
export type Space = 'world' | 'local';

export interface Prefs {
    tool: Tool;
    space: Space;
    snap: boolean;
    snapMove: number;
    snapRotate: number;
    snapScale: number;
    grid: boolean;
    helpers: boolean;
}

interface Snapshot {
    doc: string;
    selection: string[];
}

interface StoreEvents {
    /** The document changed (live, also fired during drags). */
    change: ChangeHint | undefined;
    /** A whole new document was loaded. */
    load: SceneDoc;
    /** An undoable step finished; persistence listens to this. */
    commit: string;
    selection: string[];
    history: { canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string };
    prefs: Prefs;
    camera: CameraState;
}

const HISTORY_LIMIT = 200;
const PREFS_KEY = 'canonical-editor/prefs';

function defaultPrefs(): Prefs {
    return {
        tool: 'translate',
        space: 'world',
        snap: false,
        snapMove: 0.5,
        snapRotate: 15,
        snapScale: 0.1,
        grid: true,
        helpers: true,
    };
}

function loadPrefs(): Prefs {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) return { ...defaultPrefs(), ...JSON.parse(raw) };
    } catch { /* storage unavailable */ }
    return defaultPrefs();
}

/**
 * Editor state: the scene document, selection, undo history and preferences.
 * All document edits go through `commit` (one undo step) or a
 * `begin`/`update`/`end` transaction (e.g. a gizmo drag that updates the
 * scene live and records a single undo step when released).
 */
export class Store extends Emitter<StoreEvents> {
    doc: SceneDoc;
    selection: string[] = [];
    camera: CameraState = defaultCamera();
    prefs: Prefs = loadPrefs();

    private index = new Map<string, NodeDoc>();
    private undoStack: (Snapshot & { label: string })[] = [];
    private redoStack: (Snapshot & { label: string })[] = [];
    private txn: { base: Snapshot; label: string; depth: number } | null = null;

    constructor(doc: SceneDoc) {
        super();
        this.doc = sanitize(doc);
        this.reindex();
    }

    // ------------------------------------------------------------- queries

    node(id: string | null | undefined): NodeDoc | undefined {
        return id ? this.index.get(id) : undefined;
    }

    children(parent: string | null): NodeDoc[] {
        return this.doc.nodes.filter((n) => n.parent === parent);
    }

    /** All descendants of `id` in document order (not including `id`). */
    descendants(id: string): NodeDoc[] {
        const out: NodeDoc[] = [];
        const walk = (pid: string) => {
            for (const n of this.doc.nodes) {
                if (n.parent === pid) {
                    out.push(n);
                    walk(n.id);
                }
            }
        };
        walk(id);
        return out;
    }

    isAncestor(ancestor: string, id: string): boolean {
        let n = this.node(id);
        while (n && n.parent) {
            if (n.parent === ancestor) return true;
            n = this.node(n.parent);
        }
        return false;
    }

    get primary(): NodeDoc | undefined {
        return this.node(this.selection[this.selection.length - 1]);
    }

    /** Selected ids with descendants of other selected ids removed. */
    selectionRoots(): string[] {
        return this.selection.filter((id) => !this.selection.some((o) => o !== id && this.isAncestor(o, id)));
    }

    // ----------------------------------------------------------- mutations

    begin(label: string) {
        if (this.txn) {
            this.txn.depth++;
            return;
        }
        this.txn = { base: this.snapshot(), label, depth: 1 };
    }

    /** Apply `fn` to the document. Outside a transaction this is one undo step. */
    update(fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        const auto = !this.txn;
        if (auto) this.begin('Edit');
        fn(this.doc);
        this.reindex();
        this.emit('change', hint);
        if (auto) this.end();
    }

    commit(label: string, fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        this.begin(label);
        try {
            this.update(fn, hint);
        } finally {
            this.end();
        }
    }

    end() {
        const txn = this.txn;
        if (!txn) return;
        if (--txn.depth > 0) return;
        this.txn = null;
        if (JSON.stringify(this.doc) !== txn.base.doc) {
            this.undoStack.push({ ...txn.base, label: txn.label });
            if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
            this.redoStack.length = 0;
            this.emitHistory();
            this.emit('commit', txn.label);
        }
    }

    /**
     * Applies a follow-up change without its own undo step, e.g. settling an
     * object once its asynchronously loaded content is known. Undoing the
     * preceding step still restores the state from before it.
     */
    patch(fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        if (this.txn) {
            this.update(fn, hint);
            return;
        }
        fn(this.doc);
        this.reindex();
        this.emit('change', hint);
        this.emit('commit', 'Patch');
    }

    /** Abort the open transaction and restore the document it started from. */
    cancel() {
        const txn = this.txn;
        if (!txn) return;
        this.txn = null;
        this.restore(txn.base);
    }

    get inTransaction(): boolean {
        return !!this.txn;
    }

    undo() {
        if (this.txn || !this.undoStack.length) return;
        const snap = this.undoStack.pop()!;
        this.redoStack.push({ ...this.snapshot(), label: snap.label });
        this.restore(snap);
        this.emitHistory();
        this.emit('commit', 'Undo ' + snap.label);
    }

    redo() {
        if (this.txn || !this.redoStack.length) return;
        const snap = this.redoStack.pop()!;
        this.undoStack.push({ ...this.snapshot(), label: snap.label });
        this.restore(snap);
        this.emitHistory();
        this.emit('commit', 'Redo ' + snap.label);
    }

    /** Replace the whole document and clear history. */
    load(doc: SceneDoc, camera?: CameraState) {
        this.txn = null;
        this.doc = sanitize(doc);
        this.reindex();
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.selection = [];
        if (camera) this.setCamera(camera);
        this.emit('load', this.doc);
        this.emit('change', undefined);
        this.emit('selection', this.selection);
        this.emitHistory();
    }

    // ----------------------------------------------------------- selection

    select(ids: string[], mode: 'replace' | 'toggle' | 'add' = 'replace') {
        let next: string[];
        const valid = ids.filter((id) => this.index.has(id));
        if (mode === 'replace') {
            next = valid;
        } else if (mode === 'add') {
            next = this.selection.filter((id) => !valid.includes(id)).concat(valid);
        } else {
            next = this.selection.slice();
            for (const id of valid) {
                const i = next.indexOf(id);
                if (i >= 0) next.splice(i, 1);
                else next.push(id);
            }
        }
        if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
        this.selection = next;
        this.emit('selection', this.selection);
    }

    // --------------------------------------------------------- prefs/camera

    setPrefs(patch: Partial<Prefs>) {
        this.prefs = { ...this.prefs, ...patch };
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
        } catch { /* storage unavailable */ }
        this.emit('prefs', this.prefs);
    }

    setCamera(camera: CameraState) {
        this.camera = { ...camera, target: [...camera.target] as CameraState['target'] };
        this.emit('camera', this.camera);
    }

    // ------------------------------------------------------------ internal

    private snapshot(): Snapshot {
        return { doc: JSON.stringify(this.doc), selection: this.selection.slice() };
    }

    private restore(snap: Snapshot) {
        this.doc = JSON.parse(snap.doc);
        this.reindex();
        this.selection = snap.selection.filter((id) => this.index.has(id));
        this.emit('change', undefined);
        this.emit('selection', this.selection);
    }

    private reindex() {
        this.index.clear();
        for (const n of this.doc.nodes) this.index.set(n.id, n);
    }

    private emitHistory() {
        this.emit('history', {
            canUndo: this.undoStack.length > 0,
            canRedo: this.redoStack.length > 0,
            undoLabel: this.undoStack[this.undoStack.length - 1]?.label ?? '',
            redoLabel: this.redoStack[this.redoStack.length - 1]?.label ?? '',
        });
    }
}

const finite = (v: any, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: any, d: [number, number, number]): [number, number, number] =>
    Array.isArray(v) && v.length === 3 ? [finite(v[0], d[0]), finite(v[1], d[1]), finite(v[2], d[2])] : [...d];

/** Repairs documents from files or older builds: ids, parents, cycles, defaults. */
export function sanitize(input: any): SceneDoc {
    const env = { ...defaultEnvironment(), ...(input?.environment || {}) };
    for (const k of ['bloom', 'ao', 'fog'] as const) {
        env[k] = { ...defaultEnvironment()[k], ...(input?.environment?.[k] || {}) } as any;
    }
    const seen = new Set<string>();
    const nodes: NodeDoc[] = [];
    for (const raw of Array.isArray(input?.nodes) ? input.nodes : []) {
        if (!raw || typeof raw !== 'object') continue;
        let id = typeof raw.id === 'string' && raw.id ? raw.id : uid();
        if (seen.has(id)) id = uid();
        seen.add(id);
        const node: NodeDoc = {
            ...raw,
            id,
            name: typeof raw.name === 'string' ? raw.name : 'Object',
            parent: typeof raw.parent === 'string' ? raw.parent : null,
            visible: raw.visible !== false,
            position: vec(raw.position, [0, 0, 0]),
            rotation: vec(raw.rotation, [0, 0, 0]),
            scale: vec(raw.scale, [1, 1, 1]),
        };
        nodes.push(node);
    }
    const ids = new Set(nodes.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
        if (n.parent && !ids.has(n.parent)) n.parent = null;
        // Break cycles by detaching the node that closes the loop.
        const visited = new Set<string>([n.id]);
        let p = n.parent;
        while (p) {
            if (visited.has(p)) {
                n.parent = null;
                break;
            }
            visited.add(p);
            p = byId.get(p)?.parent ?? null;
        }
    }
    return {
        format: 'canonical-scene',
        version: 1,
        name: typeof input?.name === 'string' && input.name ? input.name : 'Untitled Scene',
        environment: env,
        assets: Array.isArray(input?.assets) ? input.assets.filter((a: any) => a && typeof a.id === 'string') : [],
        nodes,
    };
}

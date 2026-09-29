// The store's undo history as it was before undo steps kept only what they
// changed: every step a snapshot of the whole document. The history tests
// run the same edits on this and on the store, which must end up the same.
// (Prefs, camera and play mode are left out.)

import { Emitter } from '../../src/core/events';
import { sanitize, type ChangeHint } from '../../src/core/store';
import type { NodeDoc, SceneDoc } from '../../src/core/types';

interface Snapshot {
    doc: string;
    selection: string[];
}

type Step = Snapshot & { label: string; batch?: string };

export interface LegacyCheckpoint {
    doc: string;
    selection: string[];
    undo: Step[];
    redo: Step[];
}

interface StoreEvents {
    change: ChangeHint | undefined;
    load: SceneDoc;
    commit: string;
    selection: string[];
    history: { canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string };
}

const HISTORY_LIMIT = 200;

export class LegacyStore extends Emitter<StoreEvents> {
    doc: SceneDoc;
    selection: string[] = [];

    private index = new Map<string, NodeDoc>();
    private undoStack: Step[] = [];
    private redoStack: Step[] = [];
    private txn: { base: Snapshot; label: string; depth: number; batch?: string } | null = null;
    batch: string | null = null;

    constructor(doc: SceneDoc) {
        super();
        this.doc = sanitize(doc);
        this.reindex();
    }

    node(id: string | null | undefined): NodeDoc | undefined {
        return id ? this.index.get(id) : undefined;
    }

    children(parent: string | null): NodeDoc[] {
        return this.doc.nodes.filter((n) => n.parent === parent);
    }

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

    begin(label: string) {
        if (this.txn) {
            this.txn.depth++;
            return;
        }
        this.txn = { base: this.snapshot(), label, depth: 1, batch: this.batch ?? undefined };
    }

    update(fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        const auto = !this.txn;
        if (auto) this.begin('Edit');
        try {
            fn(this.doc);
        } finally {
            this.reindex();
            this.emit('change', hint);
            if (auto) this.end();
        }
    }

    commit(label: string, fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        this.transact(label, () => this.update(fn, hint));
    }

    transact(label: string, fn: () => void) {
        this.begin(label);
        try {
            fn();
        } finally {
            this.end();
        }
    }

    async inBatch<T>(batch: string, fn: () => Promise<T>): Promise<T> {
        this.batch = batch;
        try {
            return await fn();
        } finally {
            this.batch = null;
        }
    }

    squash(batch: string, label: string): boolean {
        const steps = this.undoStack;
        if (!steps.some((s) => s.batch === batch)) return false;
        this.undoStack = steps
            .filter((s, i) => s.batch !== batch || steps[i - 1]?.batch !== batch)
            .map((s) => (s.batch === batch ? { ...s, label, batch: undefined } : s));
        this.emitHistory();
        return true;
    }

    end() {
        const txn = this.txn;
        if (!txn) return;
        if (--txn.depth > 0) return;
        this.txn = null;
        if (JSON.stringify(this.doc) !== txn.base.doc) {
            this.undoStack.push({ ...txn.base, label: txn.label, batch: txn.batch });
            if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
            this.redoStack.length = 0;
            this.emitHistory();
            this.emit('commit', txn.label);
        }
    }

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

    get undoLabel(): string {
        return this.undoStack[this.undoStack.length - 1]?.label ?? '';
    }

    get redoLabel(): string {
        return this.redoStack[this.redoStack.length - 1]?.label ?? '';
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
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

    load(doc: SceneDoc) {
        this.txn = null;
        this.batch = null;
        this.doc = sanitize(doc);
        this.reindex();
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.selection = [];
        this.emit('load', this.doc);
        this.emit('change', undefined);
        this.emit('selection', this.selection);
        this.emitHistory();
    }

    checkpoint(): LegacyCheckpoint {
        return {
            doc: JSON.stringify(this.doc),
            selection: this.selection.slice(),
            undo: this.undoStack.slice(),
            redo: this.redoStack.slice(),
        };
    }

    restoreCheckpoint(cp: LegacyCheckpoint) {
        this.doc = JSON.parse(cp.doc);
        this.reindex();
        this.undoStack = cp.undo.slice();
        this.redoStack = cp.redo.slice();
        this.selection = cp.selection.filter((id) => this.index.has(id));
        this.emit('change', undefined);
        this.emit('selection', this.selection);
        this.emitHistory();
    }

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

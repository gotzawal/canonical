import { Emitter } from './events';
import { readLocal, writeLocal } from './local';
import { defaultCamera, defaultRenderGraph, uid } from './defaults';
import { sanitizeAgent, sanitizeBehaviors, sanitizeBlackboards, sanitizeMemory, sanitizeAiModels } from './behavior/format';
import { sanitizeDesign } from './design';
import { migrateScene } from './migrate';
import { isMobileDevice } from './quality';
import { Animation, AudioSource, Body, Camera, Character, Environment, Grass, Instancing, Light, Mesh, Mirror, Model, Params, Particles, Player, Rain, Scatter, Terrain } from './model';
import { defaults, isObj, repair, str, vecOr } from './schema';
import {
    SCENE_VERSION, UNTITLED_SCENE, type BuildDoc, type CameraState, type NodeDoc, type ParamValue, type PostDoc, type PrefabDoc, type RenderGraphDoc,
    type SceneDoc, type ScriptDoc, type ScriptRef, type ShaderDoc,
} from './types';

/**
 * What changed in a doc update. Omitted means "anything may have changed".
 * Undo keeps only what a hint names (see Saved): a hint that leaves out
 * something the change touched makes that part of it impossible to undo.
 */
export interface ChangeHint {
    /** Only these nodes changed (no nodes added, removed, re-parented or reordered). */
    nodes?: string[];
    /** With `nodes`: only their position, rotation and scale changed (a gizmo drag, say). */
    transform?: boolean;
    /** Only the environment, the render graph or the scene's name changed. */
    env?: boolean;
    /** Only settings that do not change the scene changed (such as build settings). */
    meta?: boolean;
    /** Only the design section (the planning pipeline) changed, with its images among the assets. */
    design?: boolean;
    /** Only AI behavior data changed (blackboards, behavior trees, memory, agents). */
    behavior?: boolean;
    /** With `behavior`: the objects (or prefab parts) whose agent changed. Without it, any object's may have. */
    agents?: string[];
    /** Behavior tree nodes, services and keys that got another id: old id -> new id by "t:" tree id and "s:" schema id. */
    renamed?: Map<string, Map<string, string>>;
}

export type Tool = 'select' | 'translate' | 'rotate' | 'scale';
export type Space = 'world' | 'local';
/** How often the viewport draws: at most this many frames per second, or as often as the display refreshes (0). */
export type ViewportFps = 30 | 60 | 0;
/** How sharp the viewport draws (see engine/runtime.ts VIEWPORT_QUALITY). */
export type ViewportQuality = 'low' | 'medium' | 'high';

export interface Prefs {
    tool: Tool;
    space: Space;
    snap: boolean;
    snapMove: number;
    snapRotate: number;
    snapScale: number;
    grid: boolean;
    helpers: boolean;
    /** Show a sphere per GI probe with the light it captured. */
    giProbes: boolean;
    /** Glass surfaces; null follows the system's transparency setting (ui/theme.ts). */
    glass: boolean | null;
    /** The viewport's frame rate limit: 60 on a computer, 30 on a phone or tablet by default (viewportDefaults). */
    viewportFps: ViewportFps;
    /** The viewport's resolution: medium on a computer, low on a phone or tablet by default. Captures (the assistant's, shots) are taken sharp either way. */
    viewportQuality: ViewportQuality;
    /** A graphics quality tier the viewport shows instead of the scene's ('scene': the scene's, high when auto). */
    previewQuality: 'scene' | ViewportQuality;
    /** Make the compressed copies of textures (KTX2) in the background while editing, not only when building. */
    backgroundCompression: boolean;
    /** Compress imported textures and models right away and keep only the compressed file (smaller projects). */
    compressImports: boolean;
    /**
     * The full editor (hierarchy, inspector, pipeline, code) instead of the
     * simple view, which shows only the scene and the chat with the assistant.
     */
    editMode: boolean;
    /** Asset catalogs added by URL, listed in the Library after the editor's own (core/library.ts). */
    libraryCatalogs: string[];
    /** Show the navigation mesh the characters walk on (View > Navigation Mesh). */
    navMesh: boolean;
}

/**
 * The state an undo (or redo) step brings back: the whole document, or only
 * what the step changed, the objects and top-level parts its change hints
 * named. Changes without a hint (objects added, removed or re-parented) keep
 * the whole document.
 */
interface Saved {
    /** The whole document (JSON). */
    doc?: string;
    /** Objects by id (JSON). */
    nodes?: Map<string, string>;
    /** Top-level parts of the document (JSON; undefined for one that is not set). */
    parts?: Map<keyof SceneDoc, string | undefined>;
}

/** An undo (or redo) step. `batch` marks the steps of an assistant request (see squash). */
interface Step {
    label: string;
    batch?: string;
    selection: string[];
    saved: Saved;
    /** What bringing it back changes, for the views (undefined: anything). */
    hint: ChangeHint | undefined;
    /** About how many bytes it holds, for the history budget. */
    size: number;
    /** While the history is checked (verifyHistory): the whole document it brings back (JSON). */
    check?: string;
}

interface Transaction {
    label: string;
    depth: number;
    batch?: string;
    selection: string[];
    saved: Saved;
    /** The hints of its updates merged (null: none yet). */
    hint: ChangeHint | undefined | null;
    /** While the history is checked: the whole document when it began (JSON). */
    check?: string;
}

/** What a change may touch: objects and top-level parts of the document. */
interface Scope {
    nodes: readonly string[];
    parts: readonly (keyof SceneDoc)[];
    /** Ids that are not objects of the scene may be parts of prefab templates (agents). */
    templates: boolean;
}

/** Full editor state saved when Play starts and restored when it stops. */
export interface Checkpoint {
    doc: string;
    selection: string[];
    undo: Step[];
    redo: Step[];
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
    /** Play mode started or stopped. */
    playing: boolean;
}

/** Undo history kept, in bytes (about: the length of what the steps hold); the oldest steps go first. */
const HISTORY_BUDGET = 64 * 1024 * 1024;
/** What a step takes besides the state it holds: the step, its label and maps. */
const STEP_BYTES = 200;
const PREFS_KEY = 'canonical-editor/prefs';
/** Version of the stored preferences: 2 keeps only what differs from the defaults. */
const PREFS_VERSION = 2;

/** The top-level parts of the document each kind of hint may change. */
const PARTS = {
    env: ['name', 'environment', 'renderGraph'],
    meta: ['build'],
    design: ['design', 'assets'],
    behavior: ['blackboards', 'behaviors', 'memory', 'aiModels'],
} as const satisfies Record<string, readonly (keyof SceneDoc)[]>;

const NONE: readonly NodeDoc[] = Object.freeze([]);

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
        giProbes: false,
        glass: null,
        ...viewportDefaults(),
        previewQuality: 'scene',
        backgroundCompression: true,
        compressImports: true,
        editMode: false,
        libraryCatalogs: [],
        navMesh: false,
    };
}

/**
 * How often and how sharp the viewport draws unless the user chose: a
 * computer draws at 60 frames per second in medium quality, a phone or
 * tablet at 30 in low quality, to spare its battery.
 */
export function viewportDefaults(mobile = isMobileDevice()): Pick<Prefs, 'viewportFps' | 'viewportQuality'> {
    return mobile ? { viewportFps: 30, viewportQuality: 'low' } : { viewportFps: 60, viewportQuality: 'medium' };
}

function loadPrefs(): Prefs {
    const raw = readLocal<unknown>(PREFS_KEY, {});
    const saved: Partial<Prefs> & { v?: number } = isObj(raw) ? { ...raw } : {};
    // Earlier builds stored every preference, their defaults too: a viewport
    // left at the old defaults (30 fps, low) follows the new ones.
    if (saved.v !== PREFS_VERSION) {
        if (saved.viewportFps === 30) delete saved.viewportFps;
        if (saved.viewportQuality === 'low') delete saved.viewportQuality;
    }
    delete saved.v;
    const base = defaultPrefs();
    const prefs = { ...base, ...saved };
    if (![30, 60, 0].includes(prefs.viewportFps)) prefs.viewportFps = base.viewportFps;
    if (!['low', 'medium', 'high'].includes(prefs.viewportQuality)) prefs.viewportQuality = base.viewportQuality;
    if (!['scene', 'low', 'medium', 'high'].includes(prefs.previewQuality)) prefs.previewQuality = 'scene';
    prefs.editMode = prefs.editMode === true;
    prefs.backgroundCompression = prefs.backgroundCompression !== false;
    prefs.compressImports = prefs.compressImports !== false;
    prefs.navMesh = prefs.navMesh === true;
    prefs.libraryCatalogs = Array.isArray(prefs.libraryCatalogs) ? prefs.libraryCatalogs.filter((u) => typeof u === 'string' && u.length > 0) : [];
    return prefs;
}

/** The preferences as stored: only what differs from the defaults, so a later change of a default reaches everyone who kept it. */
function storedPrefs(prefs: Prefs): Partial<Prefs> & { v: number } {
    const base = defaultPrefs();
    const out: Partial<Prefs> & { v: number } = { v: PREFS_VERSION };
    for (const k of Object.keys(prefs) as (keyof Prefs)[]) {
        if (JSON.stringify(prefs[k]) !== JSON.stringify(base[k])) (out as Record<string, unknown>)[k] = prefs[k];
    }
    return out;
}

/**
 * Editor state: the scene document, selection, undo history and preferences.
 * All document edits go through `commit` (one undo step) or a
 * `begin`/`update`/`end` transaction (e.g. a gizmo drag that updates the
 * scene live and records a single undo step when released).
 */
export class Store extends Emitter<StoreEvents> {
    /** Reports a problem the history check found (verifyHistory); tests make it throw. */
    static historyProblem = (message: string) => console.error(message);

    doc: SceneDoc;
    selection: string[] = [];
    camera: CameraState = defaultCamera();
    prefs: Prefs = loadPrefs();
    /** True while Play mode runs; edits made meanwhile are reverted on Stop (except script and shader code). */
    playing = false;
    /** Undo history kept, in bytes: the oldest steps go first (the last one always stays). */
    historyBudget = HISTORY_BUDGET;
    /**
     * Also snapshots the whole document for every step and checks that
     * undoing and redoing it bring back the same (development builds): a
     * change hint that leaves out what the change touched shows up at once.
     */
    verifyHistory = import.meta.env.DEV;

    private index = new Map<string, NodeDoc>();
    /** The children of each parent (null: the top level), in document order. */
    private kids = new Map<string | null, NodeDoc[]>();
    /** Where each object is in doc.nodes. */
    private at = new Map<string, number>();
    /** Where each object is among its parent's children. */
    private slot = new Map<string, number>();
    /** Ids and parents at the last reindex, to tell whether the structure changed. */
    private shapeIds: string[] = [];
    private shapeParents: (string | null)[] = [];

    // Versions (see version, structureVersion, partsVersion and nodeVersion).
    private stamp = 0;
    private structureStamp = 0;
    private partsStamp = 0;
    /** The last change that may have touched every object. */
    private wholeStamp = 0;
    private nodeStamps = new Map<string, number>();

    private undoStack: Step[] = [];
    private redoStack: Step[] = [];
    /** What the undo and redo steps hold (see sizeOf). */
    private bytes = 0;
    private txn: Transaction | null = null;
    /** Set while an assistant tool runs (see inBatch). */
    batch: string | null = null;

    constructor(doc: SceneDoc) {
        super();
        this.doc = sanitize(doc);
        this.reindex();
    }

    // ------------------------------------------------------------- queries

    node(id: string | null | undefined): NodeDoc | undefined {
        return id ? this.index.get(id) : undefined;
    }

    /** The children of `parent` (null: the top level), in document order. */
    children(parent: string | null): readonly NodeDoc[] {
        return this.kids.get(parent) ?? NONE;
    }

    /** All descendants of `id` in document order (not including `id`). */
    descendants(id: string): NodeDoc[] {
        const out: NodeDoc[] = [];
        const stack = [...this.children(id)].reverse();
        // A parent cycle (which sanitize breaks) cannot run forever.
        while (stack.length && out.length <= this.doc.nodes.length) {
            const n = stack.pop()!;
            out.push(n);
            const kids = this.kids.get(n.id);
            if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        }
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

    // ------------------------------------------------------------ versions
    //
    // Views compare these numbers instead of keys built from the document:
    // each increases when what it covers may have changed.

    /** Every change of the document (and undo, redo, load). */
    get version(): number {
        return this.stamp;
    }

    /** Objects added, removed, re-parented or reordered. */
    get structureVersion(): number {
        return this.structureStamp;
    }

    /** The parts of the document besides its objects: environment, assets, scripts, design, behavior... */
    get partsVersion(): number {
        return this.partsStamp;
    }

    /** One object. */
    nodeVersion(id: string): number {
        return Math.max(this.nodeStamps.get(id) ?? 0, this.wholeStamp);
    }

    // ----------------------------------------------------------- mutations

    begin(label: string) {
        if (this.txn) {
            this.txn.depth++;
            return;
        }
        this.txn = {
            label,
            depth: 1,
            batch: this.batch ?? undefined,
            selection: this.selection.slice(),
            saved: {},
            hint: null,
            check: this.verifyHistory ? JSON.stringify(this.doc) : undefined,
        };
    }

    /** Apply `fn` to the document. Outside a transaction this is one undo step. */
    update(fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        const auto = !this.txn;
        if (auto) this.begin('Edit');
        const txn = this.txn!;
        const scope = scopeOf(hint);
        this.keep(txn.saved, scope);
        const nodes = this.doc.nodes;
        const count = nodes.length;
        try {
            fn(this.doc);
        } finally {
            // Also when `fn` throws half way: the views follow what it changed
            // (an undoable step), and the transaction opened here is closed.
            const held = this.held(scope, nodes, count, hint);
            txn.hint = mergeHints(txn.hint, held ? hint : undefined);
            this.changed(held ? scope : null);
            this.emit('change', held ? hint : undefined);
            if (auto) this.end();
        }
    }

    commit(label: string, fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        this.transact(label, () => this.update(fn, hint));
    }

    /** Runs `fn` as one undo step; its `update` calls give the change hints. */
    transact(label: string, fn: () => void) {
        this.begin(label);
        try {
            fn();
        } finally {
            this.end();
        }
    }

    /** Runs `fn` with the undo steps it starts marked as part of `batch`. */
    async inBatch<T>(batch: string, fn: () => Promise<T>): Promise<T> {
        this.batch = batch;
        try {
            return await fn();
        } finally {
            this.batch = null;
        }
    }

    /**
     * Makes one step, called `label`, of each run of adjacent steps of
     * `batch`: an assistant request undoes as a whole, while edits made by
     * hand in between stay steps of their own. The step brings back each
     * object and part as it was before the run. False when none are left.
     */
    squash(batch: string, label: string): boolean {
        const steps = this.undoStack;
        if (!steps.some((s) => s.batch === batch)) return false;
        const out: Step[] = [];
        for (let i = 0; i < steps.length; ) {
            if (steps[i].batch !== batch) {
                out.push(steps[i++]);
                continue;
            }
            let j = i + 1;
            while (j < steps.length && steps[j].batch === batch) j++;
            out.push(joined(steps.slice(i, j), label));
            i = j;
        }
        this.undoStack = out;
        this.recount();
        this.trim();
        this.emitHistory();
        return true;
    }

    end() {
        const txn = this.txn;
        if (!txn) return;
        if (--txn.depth > 0) return;
        this.txn = null;
        const step = this.stepOf(txn);
        if (!step) return;
        this.undoStack.push(step);
        this.bytes += step.size;
        for (const s of this.redoStack) this.bytes -= s.size;
        this.redoStack.length = 0;
        this.trim();
        this.emitHistory();
        this.emit('commit', txn.label);
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
        const scope = scopeOf(hint);
        // The steps next to undo and redo bring back what the patch changes too.
        this.widen(this.undoStack, scope, hint);
        this.widen(this.redoStack, scope, hint);
        this.trim();
        const nodes = this.doc.nodes;
        const count = nodes.length;
        fn(this.doc);
        const held = this.held(scope, nodes, count, hint);
        this.changed(held ? scope : null);
        this.emit('change', held ? hint : undefined);
        this.emit('commit', 'Patch');
    }

    get inTransaction(): boolean {
        return !!this.txn;
    }

    /** Label of the step Undo would revert, or '' when there is none. */
    get undoLabel(): string {
        return this.undoStack[this.undoStack.length - 1]?.label ?? '';
    }

    /** About how many bytes the undo and redo steps hold. */
    get historyBytes(): number {
        return this.bytes;
    }

    undo() {
        if (this.txn || !this.undoStack.length) return;
        const step = this.undoStack.pop()!;
        const back = this.swap(step);
        this.redoStack.push(back);
        this.bytes += back.size - step.size;
        this.trim();
        this.emitHistory();
        this.emit('commit', 'Undo ' + step.label);
    }

    redo() {
        if (this.txn || !this.redoStack.length) return;
        const step = this.redoStack.pop()!;
        const back = this.swap(step);
        this.undoStack.push(back);
        this.bytes += back.size - step.size;
        this.trim();
        this.emitHistory();
        this.emit('commit', 'Redo ' + step.label);
    }

    /** Replace the whole document and clear history. */
    load(doc: SceneDoc, camera?: CameraState) {
        this.txn = null;
        this.batch = null;
        this.doc = sanitize(doc);
        this.changed(null);
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.bytes = 0;
        this.selection = [];
        if (camera) this.setCamera(camera);
        this.emit('load', this.doc);
        this.emit('change', undefined);
        this.emit('selection', this.selection);
        this.emitHistory();
    }

    // ---------------------------------------------------------- play mode

    /** Captures the document and its history so Play can be undone as a whole. */
    checkpoint(): Checkpoint {
        return {
            doc: JSON.stringify(this.doc),
            selection: this.selection.slice(),
            undo: this.undoStack.slice(),
            redo: this.redoStack.slice(),
        };
    }

    /** Returns to a checkpoint: the document, selection and undo history. */
    restoreCheckpoint(cp: Checkpoint) {
        this.doc = JSON.parse(cp.doc);
        this.changed(null);
        this.undoStack = cp.undo.slice();
        this.redoStack = cp.redo.slice();
        this.recount();
        this.selection = cp.selection.filter((id) => this.index.has(id));
        this.emit('change', undefined);
        this.emit('selection', this.selection);
        this.emitHistory();
    }

    setPlaying(playing: boolean) {
        if (this.playing === playing) return;
        this.playing = playing;
        this.emit('playing', playing);
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
        writeLocal(PREFS_KEY, storedPrefs(this.prefs));
        this.emit('prefs', this.prefs);
    }

    setCamera(camera: CameraState) {
        this.camera = { ...camera, target: [...camera.target] as CameraState['target'] };
        this.emit('camera', this.camera);
    }

    // ------------------------------------------------------------- history

    /**
     * Adds to `saved` the current state of what a change within `scope` (null:
     * anything) may touch, where it holds nothing yet: the first update of a
     * transaction to touch something keeps it as it was before.
     */
    private keep(saved: Saved, scope: Scope | null) {
        if (saved.doc !== undefined) return;
        if (!scope) {
            saved.doc = this.wholeBefore(saved);
            delete saved.nodes;
            delete saved.parts;
            return;
        }
        let templates = false;
        for (const id of scope.nodes) {
            if (saved.nodes?.has(id)) continue;
            const n = this.index.get(id);
            if (n) (saved.nodes ??= new Map()).set(id, JSON.stringify(n));
            else templates ||= scope.templates;
        }
        for (const key of templates ? [...scope.parts, 'prefabs' as const] : scope.parts) {
            if (!saved.parts?.has(key)) (saved.parts ??= new Map()).set(key, json(this.doc[key]));
        }
    }

    /** The whole document (JSON) with the state `saved` holds put back: as it was before the changes since. */
    private wholeBefore(saved: Saved): string {
        if (!saved.nodes && !saved.parts) return JSON.stringify(this.doc);
        const doc = { ...this.doc, nodes: this.doc.nodes.slice() };
        putBack(doc, saved, (id) => this.at.get(id));
        return JSON.stringify(doc);
    }

    /** False when a change hinted to keep the objects added, removed or replaced some (and says so). */
    private held(scope: Scope | null, nodes: NodeDoc[], count: number, hint: ChangeHint | undefined): scope is Scope {
        if (!scope) return false;
        if (this.doc.nodes === nodes && nodes.length === count) return true;
        console.error(`[editor] A change hinted as ${hintText(hint)} added, removed or replaced objects: its hint is wrong, and undo will not bring them back.`);
        return false;
    }

    /** The undo step of a finished transaction; null when it changed nothing. */
    private stepOf(txn: Transaction): Step | null {
        const saved = txn.saved;
        let now: string | undefined;
        if (saved.doc !== undefined) {
            now = JSON.stringify(this.doc);
            if (now === saved.doc) return null;
        } else {
            // What the hints named but did not change needs no keeping.
            for (const [id, before] of saved.nodes ?? []) {
                const n = this.index.get(id);
                if (n && JSON.stringify(n) === before) saved.nodes!.delete(id);
            }
            for (const [key, before] of saved.parts ?? []) {
                if (json(this.doc[key]) === before) saved.parts!.delete(key);
            }
            if (!saved.nodes?.size) delete saved.nodes;
            if (!saved.parts?.size) delete saved.parts;
            if (!saved.nodes && !saved.parts) {
                if (txn.check !== undefined) {
                    const problem = differs(this.doc, txn.check);
                    if (problem) Store.historyProblem(`[editor] "${txn.label}" changed ${problem}, which its change hints (${hintText(txn.hint)}) do not name: it cannot be undone.`);
                }
                return null;
            }
        }
        const step: Step = {
            label: txn.label,
            batch: txn.batch,
            selection: txn.selection,
            saved,
            hint: saved.doc === undefined ? stepHint(txn.hint) : undefined,
            size: sizeOf(saved, txn.selection),
        };
        if (txn.check !== undefined) {
            step.check = txn.check;
            if (saved.doc === undefined) {
                // Undo, tried on a copy, has to bring back the document from the start.
                const doc = JSON.parse(now ?? JSON.stringify(this.doc)) as SceneDoc;
                putBack(doc, saved, (id) => this.at.get(id));
                const problem = differs(doc, txn.check);
                if (problem) Store.historyProblem(`[editor] Undo of "${txn.label}" would not bring back ${problem}: the change touched it, but its hints (${hintText(txn.hint)}) do not name it.`);
            }
        }
        return step;
    }

    /** Brings back what `step` holds; returns the step that brings back the state it replaced. */
    private swap(step: Step): Step {
        const saved = step.saved;
        const back: Saved = {};
        if (saved.doc !== undefined) back.doc = JSON.stringify(this.doc);
        if (saved.nodes) {
            back.nodes = new Map();
            for (const id of saved.nodes.keys()) {
                const n = this.index.get(id);
                if (n) back.nodes.set(id, JSON.stringify(n));
            }
        }
        if (saved.parts) {
            back.parts = new Map();
            for (const key of saved.parts.keys()) back.parts.set(key, json(this.doc[key]));
        }
        const selection = this.selection.slice();
        const opposite: Step = { label: step.label, selection, saved: back, hint: step.hint, size: sizeOf(back, selection) };
        if (this.verifyHistory) opposite.check = back.doc ?? JSON.stringify(this.doc);

        this.bringBack(saved);
        this.selection = step.selection.filter((id) => this.index.has(id));
        if (this.verifyHistory && step.check !== undefined) {
            const problem = differs(this.doc, step.check);
            if (problem) Store.historyProblem(`[editor] Undo or redo of "${step.label}" did not bring back ${problem}.`);
        }
        this.emit('change', saved.doc === undefined ? step.hint : undefined);
        this.emit('selection', this.selection);
        return opposite;
    }

    /** Puts the state `saved` holds into the document. */
    private bringBack(saved: Saved) {
        if (saved.doc !== undefined) {
            this.doc = JSON.parse(saved.doc);
            this.changed(null);
            return;
        }
        let moved = false;
        for (const [key, v] of saved.parts ?? []) (this.doc as unknown as Record<string, unknown>)[key] = parse(v);
        for (const [id, v] of saved.nodes ?? []) {
            const node = JSON.parse(v) as NodeDoc;
            const i = this.at.get(id);
            const old = i === undefined ? undefined : this.doc.nodes[i];
            if (!old || old.id !== id || old.parent !== node.parent) {
                // Not where the index has it (which cannot happen): put it there and index again.
                const j = this.doc.nodes.findIndex((n) => n.id === id);
                if (j >= 0) this.doc.nodes[j] = node;
                moved = true;
                continue;
            }
            this.doc.nodes[i!] = node;
            this.index.set(id, node);
            const siblings = this.kids.get(node.parent);
            const k = this.slot.get(id);
            if (siblings && k !== undefined && siblings[k] === old) siblings[k] = node;
            else moved = true;
        }
        const nodes = saved.nodes ? [...saved.nodes.keys()] : [];
        this.changed({ nodes, parts: saved.parts ? [...saved.parts.keys()] : [], templates: false });
        if (moved) this.reindex();
    }

    /**
     * Makes the step on top of `stack` also bring back what a change within
     * `scope` is about to touch (a patch), as it is now.
     */
    private widen(stack: Step[], scope: Scope | null, hint: ChangeHint | undefined) {
        const top = stack[stack.length - 1];
        if (!top || top.saved.doc !== undefined) return;
        const saved: Saved = {};
        if (top.saved.nodes) saved.nodes = new Map(top.saved.nodes);
        if (top.saved.parts) saved.parts = new Map(top.saved.parts);
        this.keep(saved, scope);
        // A new step: checkpoints (Play) share the old one.
        const step: Step = {
            ...top,
            saved,
            hint: saved.doc === undefined ? stepHint(mergeHints(top.hint, hint)) : undefined,
            size: sizeOf(saved, top.selection),
        };
        stack[stack.length - 1] = step;
        this.bytes += step.size - top.size;
    }

    /** Drops the oldest undo steps while the history holds more than its budget. */
    private trim() {
        let drop = 0;
        let bytes = this.bytes;
        while (bytes > this.historyBudget && drop < this.undoStack.length - 1) bytes -= this.undoStack[drop++].size;
        if (!drop) return;
        this.undoStack.splice(0, drop);
        this.bytes = bytes;
    }

    private recount() {
        let bytes = 0;
        for (const s of this.undoStack) bytes += s.size;
        for (const s of this.redoStack) bytes += s.size;
        this.bytes = bytes;
    }

    // ------------------------------------------------------------ internal

    /** Notes a change within `scope` (null: of anything) for the versions, and indexes the objects again after one of anything. */
    private changed(scope: Scope | null) {
        const v = ++this.stamp;
        if (!scope) {
            this.wholeStamp = v;
            this.partsStamp = v;
            this.nodeStamps.clear();
            this.reindex();
            return;
        }
        for (const id of scope.nodes) this.nodeStamps.set(id, v);
        if (scope.parts.length) this.partsStamp = v;
    }

    private reindex() {
        const nodes = this.doc.nodes;
        const index = new Map<string, NodeDoc>();
        const kids = new Map<string | null, NodeDoc[]>();
        const at = new Map<string, number>();
        const slot = new Map<string, number>();
        const ids = this.shapeIds;
        const parents = this.shapeParents;
        let same = nodes.length === ids.length;
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            index.set(n.id, n);
            at.set(n.id, i);
            const list = kids.get(n.parent);
            if (list) {
                slot.set(n.id, list.length);
                list.push(n);
            } else {
                slot.set(n.id, 0);
                kids.set(n.parent, [n]);
            }
            if (same && (ids[i] !== n.id || parents[i] !== n.parent)) same = false;
        }
        this.index = index;
        this.kids = kids;
        this.at = at;
        this.slot = slot;
        if (!same) {
            this.structureStamp = this.stamp;
            this.shapeIds = nodes.map((n) => n.id);
            this.shapeParents = nodes.map((n) => n.parent);
        }
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

// ------------------------------------------------------------------ hints

type HintKind = 'nodes' | 'env' | 'meta' | 'design' | 'behavior';

/** The one kind of change a hint names; null for none or several. */
function hintKind(h: ChangeHint): HintKind | null {
    let kind: HintKind | null = h.nodes ? 'nodes' : null;
    for (const k of ['env', 'meta', 'design', 'behavior'] as const) {
        if (!h[k]) continue;
        if (kind) return null;
        kind = k;
    }
    return kind;
}

/**
 * What two changes changed together, for views that catch up on several at
 * once. `a` null is "nothing yet"; undefined is "anything", which is also
 * what changes of different kinds (objects and the design, say) come to.
 */
export function mergeHints(a: ChangeHint | undefined | null, b: ChangeHint | undefined): ChangeHint | undefined {
    if (a === null) return b;
    if (!a || !b) return undefined;
    if (a === b) return a;
    const kind = hintKind(a);
    if (!kind || kind !== hintKind(b)) return undefined;
    if (kind === 'nodes') {
        const out: ChangeHint = { nodes: union(a.nodes!, b.nodes!) };
        if (a.transform && b.transform) out.transform = true;
        return out;
    }
    if (kind === 'behavior') {
        const out: ChangeHint = { behavior: true };
        if (a.agents && b.agents) out.agents = union(a.agents, b.agents);
        if (a.renamed || b.renamed) out.renamed = mergeRenames(a.renamed, b.renamed);
        return out;
    }
    return { [kind]: true };
}

function union(a: string[], b: string[]): string[] {
    if (a === b || !b.length) return a;
    if (!a.length) return b;
    return Array.from(new Set([...a, ...b]));
}

/** Renames of `a` followed by those of `b`. */
export function mergeRenames(a: ChangeHint['renamed'], b: ChangeHint['renamed']): ChangeHint['renamed'] {
    if (!a || !b) return a ?? b;
    const out = new Map<string, Map<string, string>>();
    for (const key of new Set([...a.keys(), ...b.keys()])) {
        const first = a.get(key);
        const then = b.get(key);
        const m = new Map<string, string>();
        for (const [from, to] of first ?? []) m.set(from, then?.get(to) ?? to);
        for (const [from, to] of then ?? []) if (!m.has(from)) m.set(from, to);
        out.set(key, m);
    }
    return out;
}

/** What a change with `hint` may touch; null when that may be anything. */
function scopeOf(hint: ChangeHint | undefined): Scope | null {
    // Without its objects a behavior change may have changed any object's agent.
    if (!hint || (hint.behavior && !hint.agents)) return null;
    let parts: readonly (keyof SceneDoc)[] = [];
    for (const k of ['env', 'meta', 'design', 'behavior'] as const) if (hint[k]) parts = [...parts, ...PARTS[k]];
    if (!hint.nodes && !parts.length) return null;
    const nodes = hint.behavior ? [...(hint.nodes ?? []), ...hint.agents!] : hint.nodes ?? [];
    return { nodes, parts, templates: !!hint.behavior };
}

/** What bringing a step back changes: its hints without the renames, which only hold going forward. */
function stepHint(hint: ChangeHint | undefined | null): ChangeHint | undefined {
    if (!hint?.renamed) return hint ?? undefined;
    const { renamed: _, ...rest } = hint;
    return rest;
}

function hintText(hint: ChangeHint | undefined | null): string {
    if (!hint) return 'none';
    const out: string[] = [];
    if (hint.nodes) out.push(`nodes [${hint.nodes.slice(0, 5).join(', ')}${hint.nodes.length > 5 ? ', ...' : ''}]`);
    for (const k of ['transform', 'env', 'meta', 'design', 'behavior'] as const) if (hint[k]) out.push(k);
    return out.join(', ') || 'none';
}

// ---------------------------------------------------------------- history

const json = (v: unknown): string | undefined => (v === undefined ? undefined : JSON.stringify(v));
const parse = (v: string | undefined): unknown => (v === undefined ? undefined : JSON.parse(v));

/** About how many bytes a step holding `saved` takes. */
function sizeOf(saved: Saved, selection: string[]): number {
    let n = STEP_BYTES + selection.length * 8 + (saved.doc?.length ?? 0);
    for (const [id, v] of saved.nodes ?? []) n += id.length + v.length + 32;
    for (const [, v] of saved.parts ?? []) n += (v?.length ?? 0) + 32;
    return n;
}

/** Puts the state `saved` holds into `doc`, whose objects `at` finds (their index in doc.nodes). */
function putBack(doc: SceneDoc, saved: Saved, at: (id: string) => number | undefined) {
    for (const [key, v] of saved.parts ?? []) (doc as unknown as Record<string, unknown>)[key] = parse(v);
    for (const [id, v] of saved.nodes ?? []) {
        let i = at(id);
        if (i === undefined || doc.nodes[i]?.id !== id) i = doc.nodes.findIndex((n) => n.id === id);
        if (i >= 0) doc.nodes[i] = JSON.parse(v);
    }
}

/**
 * One step of the adjacent steps `run` (oldest first) that brings back what
 * was there before the first: for each object and part the state the
 * earliest step that touched it holds.
 */
function joined(run: Step[], label: string): Step {
    const first = run[0];
    const saved: Saved = {};
    const whole = run.findIndex((s) => s.saved.doc !== undefined);
    if (whole >= 0) {
        // The document before that step, with what the steps before it changed put back.
        const doc = JSON.parse(run[whole].saved.doc!) as SceneDoc;
        const at = new Map(doc.nodes.map((n, i) => [n.id, i]));
        for (let k = whole - 1; k >= 0; k--) putBack(doc, run[k].saved, (id) => at.get(id));
        saved.doc = JSON.stringify(doc);
    } else {
        for (const s of run) {
            for (const [id, v] of s.saved.nodes ?? []) if (!saved.nodes?.has(id)) (saved.nodes ??= new Map()).set(id, v);
            for (const [key, v] of s.saved.parts ?? []) if (!saved.parts?.has(key)) (saved.parts ??= new Map()).set(key, v);
        }
    }
    const hint = saved.doc === undefined ? run.reduce<ChangeHint | undefined | null>((h, s) => mergeHints(h, s.hint), null) ?? undefined : undefined;
    const step: Step = { label, selection: first.selection, saved, hint, size: sizeOf(saved, first.selection) };
    if (first.check !== undefined) step.check = first.check;
    return step;
}

/** What of `doc` differs from the document `expected` (JSON), in words; '' when nothing (the order of keys aside). */
function differs(doc: SceneDoc, expected: string): string {
    if (JSON.stringify(doc) === expected) return '';
    const want = JSON.parse(expected) as SceneDoc;
    const out: string[] = [];
    const keys = new Set([...Object.keys(want), ...Object.keys(doc)] as (keyof SceneDoc)[]);
    for (const key of keys) if (key !== 'nodes' && canonical(doc[key]) !== canonical(want[key])) out.push(`the ${key}`);
    if (doc.nodes.length !== want.nodes.length) out.push(`the objects (${want.nodes.length} expected, ${doc.nodes.length} there)`);
    else {
        for (let i = 0; i < want.nodes.length && out.length < 6; i++) {
            const a = doc.nodes[i];
            const b = want.nodes[i];
            if (a.id !== b.id) out.push(`the order of the objects (at ${b.name})`);
            else if (canonical(a) !== canonical(b)) out.push(`object "${b.name}" (${b.id})`);
        }
    }
    return out.join(', ');
}

/** JSON with the keys of objects sorted. */
function canonical(v: unknown): string {
    return JSON.stringify(v, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
            : value,
    ) ?? 'undefined';
}


/** Values of script fields and shader properties by name; what is not one is dropped. */
const params = (raw: unknown): Record<string, ParamValue> => Params.parse(raw ?? {});

function sanitizeScripts(raw: any): ScriptDoc[] {
    const seen = new Set<string>();
    const out: ScriptDoc[] = [];
    for (const s of Array.isArray(raw) ? raw : []) {
        if (!isObj(s)) continue;
        let id = str(s.id, '') || uid('s');
        if (seen.has(id)) id = uid('s');
        seen.add(id);
        out.push({ id, name: str(s.name, 'Script.js') || 'Script.js', code: str(s.code, '') });
    }
    return out;
}

function sanitizeShaders(raw: any): ShaderDoc[] {
    const seen = new Set<string>();
    const out: ShaderDoc[] = [];
    for (const s of Array.isArray(raw) ? raw : []) {
        if (!isObj(s)) continue;
        let id = str(s.id, '') || uid('sh');
        if (seen.has(id)) id = uid('sh');
        seen.add(id);
        out.push({
            id,
            name: str(s.name, 'Shader.wgsl') || 'Shader.wgsl',
            kind: s.kind === 'post' ? 'post' : 'material',
            lighting: s.lighting === 'unlit' ? 'unlit' : 'lit',
            code: str(s.code, ''),
        });
    }
    return out;
}

function sanitizeRenderGraph(raw: any, shaders: ShaderDoc[]): RenderGraphDoc {
    const rg = defaultRenderGraph();
    if (!isObj(raw)) return rg;
    rg.disabled = Array.isArray(raw.disabled) ? raw.disabled.filter((n: any) => typeof n === 'string') : [];
    const ids = new Set(shaders.filter((s) => s.kind === 'post').map((s) => s.id));
    const seen = new Set<string>();
    for (const p of Array.isArray(raw.posts) ? raw.posts : []) {
        if (!isObj(p) || !ids.has(p.shader)) continue;
        let id = str(p.id, '') || uid('p');
        if (seen.has(id)) id = uid('p');
        seen.add(id);
        const post: PostDoc = { id, shader: p.shader, enabled: p.enabled !== false, params: params(p.params) };
        rg.posts.push(post);
    }
    return rg;
}

/** Repairs the components of a node loaded from a file or an older build (see core/model.ts). */
function sanitizeComponents(node: NodeDoc, scriptIds: Set<string>) {
    const set = <K extends keyof NodeDoc>(key: K, value: NodeDoc[K] | undefined) => {
        if (value === undefined) delete node[key];
        else node[key] = value;
    };
    set('mesh', isObj(node.mesh) && isObj(node.mesh.material) ? Mesh.parse(node.mesh) : undefined);
    set('model', repair(Model, node.model));
    set('light', repair(Light, node.light));
    set('camera', repair(Camera, node.camera));
    set('particles', repair(Particles, node.particles));
    set('body', repair(Body, node.body));
    set('animation', repair(Animation, node.animation));
    set('mirror', node.mesh ? repair(Mirror, node.mirror) : undefined);
    set('grass', repair(Grass, node.grass));
    set('rain', repair(Rain, node.rain));
    set('instancing', repair(Instancing, node.instancing));
    set('terrain', repair(Terrain, node.terrain));
    set('scatter', repair(Scatter, node.scatter));
    set('audio', repair(AudioSource, node.audio));
    // A player controls a character (an older player carried the body itself).
    const character = repair(Character, node.character ?? node.player);
    set('character', character);
    set('player', character && repair(Player, node.player));
    if (node.scripts !== undefined) {
        const refs: ScriptRef[] = [];
        for (const r of Array.isArray(node.scripts) ? node.scripts : []) {
            if (!isObj(r) || typeof r.script !== 'string' || !scriptIds.has(r.script)) continue;
            refs.push({ script: r.script, enabled: r.enabled !== false, props: params(r.props) });
        }
        set('scripts', refs.length ? refs : undefined);
    }
    if (node.agent !== undefined) set('agent', sanitizeAgent(node.agent));
    if (node.prefab !== undefined && (typeof node.prefab !== 'string' || !node.prefab)) delete node.prefab;
    if (node.prefabChild !== undefined && node.prefabChild !== true) delete node.prefabChild;
}

/** Repairs documents from files or older builds: migrations, ids, parents, cycles, defaults. */
export function sanitize(input: any): SceneDoc {
    if (input && typeof input === 'object') input = migrateScene(input);
    const scripts = sanitizeScripts(input?.scripts);
    const shaders = sanitizeShaders(input?.shaders);
    const scriptIds = new Set(scripts.map((s) => s.id));
    const nodes = sanitizeNodes(input?.nodes, scriptIds);
    const prefabs = sanitizePrefabs(input?.prefabs, scriptIds);
    const prefabIds = new Set(prefabs.map((p) => p.id));
    for (const n of nodes) if (n.prefab && !prefabIds.has(n.prefab)) delete n.prefab;
    return {
        format: 'canonical-scene',
        version: SCENE_VERSION,
        name: typeof input?.name === 'string' && input.name ? input.name : UNTITLED_SCENE,
        environment: repair(Environment, input?.environment) ?? defaults(Environment),
        assets: Array.isArray(input?.assets) ? input.assets.filter((a: any) => a && typeof a.id === 'string') : [],
        scripts,
        shaders,
        renderGraph: sanitizeRenderGraph(input?.renderGraph, shaders),
        nodes,
        prefabs,
        blackboards: sanitizeBlackboards(input?.blackboards),
        behaviors: sanitizeBehaviors(input?.behaviors),
        memory: sanitizeMemory(input?.memory),
        aiModels: sanitizeAiModels(input?.aiModels),
        build: sanitizeBuild(input?.build),
        design: sanitizeDesign(input?.design),
    };
}

/** Nodes with unique ids, valid parents (no cycles) and repaired components. */
function sanitizeNodes(raw: any, scriptIds: Set<string>): NodeDoc[] {
    const seen = new Set<string>();
    const nodes: NodeDoc[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
        if (!item || typeof item !== 'object') continue;
        let id = typeof item.id === 'string' && item.id ? item.id : uid();
        if (seen.has(id)) id = uid();
        seen.add(id);
        const node: NodeDoc = {
            ...item,
            id,
            name: typeof item.name === 'string' ? item.name : 'Object',
            parent: typeof item.parent === 'string' ? item.parent : null,
            visible: item.visible !== false,
            position: vecOr(item.position, [0, 0, 0]),
            rotation: vecOr(item.rotation, [0, 0, 0]),
            scale: vecOr(item.scale, [1, 1, 1]),
        };
        sanitizeComponents(node, scriptIds);
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
    return nodes;
}

function sanitizePrefabs(raw: any, scriptIds: Set<string>): PrefabDoc[] {
    const seen = new Set<string>();
    const out: PrefabDoc[] = [];
    for (const p of Array.isArray(raw) ? raw : []) {
        if (!isObj(p)) continue;
        let id = str(p.id, '') || uid('pf');
        if (seen.has(id)) id = uid('pf');
        seen.add(id);
        // Templates never hold instances of other prefabs (no nesting).
        const nodes = sanitizeNodes(p.nodes, scriptIds);
        for (const n of nodes) {
            delete n.prefab;
            delete n.prefabChild;
        }
        const prefab: PrefabDoc = { id, name: str(p.name, 'Prefab') || 'Prefab', nodes, asset: str(p.asset, '') || uid('a') };
        if (p.useModel === true) prefab.useModel = true;
        if (Array.isArray(p.modelOffset)) prefab.modelOffset = vecOr(p.modelOffset, [0, 0, 0]);
        out.push(prefab);
    }
    return out;
}

function sanitizeBuild(input: any): BuildDoc | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const out: BuildDoc = {};
    for (const k of ['title', 'repo', 'branch'] as const) {
        const v = input[k];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 200);
    }
    return Object.keys(out).length ? out : undefined;
}

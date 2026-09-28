import { Emitter } from './events';
import { readLocal, writeLocal } from './local';
import { defaultCamera, defaultRenderGraph, uid } from './defaults';
import { sanitizeAgent, sanitizeBehaviors, sanitizeBlackboards, sanitizeMemory, sanitizeAiModels } from './behavior/format';
import { sanitizeDesign } from './design';
import { migrateScene } from './migrate';
import { Animation, Body, Camera, Character, Environment, Mesh, Model, Params, Particles, Player } from './model';
import { defaults, isObj, repair, str, vecOr } from './schema';
import {
    SCENE_VERSION, type BuildDoc, type CameraState, type NodeDoc, type ParamValue, type PostDoc, type PrefabDoc, type RenderGraphDoc,
    type SceneDoc, type ScriptDoc, type ScriptRef, type ShaderDoc,
} from './types';

/** What changed in a doc update. Omitted means "anything may have changed". */
export interface ChangeHint {
    /** Only these nodes changed (no nodes added, removed or re-parented). */
    nodes?: string[];
    /** Only the environment changed. */
    env?: boolean;
    /** Only settings that do not change the scene changed (such as build settings). */
    meta?: boolean;
    /** Only the design section (the planning pipeline) changed. */
    design?: boolean;
    /** Only AI behavior data changed (blackboards, behavior trees, memory, agents). */
    behavior?: boolean;
    /** Behavior tree nodes, services and keys that got another id: old id -> new id by "t:" tree id and "s:" schema id. */
    renamed?: Map<string, Map<string, string>>;
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
    /** Show a sphere per GI probe with the light it captured. */
    giProbes: boolean;
    /** Glass surfaces; null follows the system's transparency setting (ui/theme.ts). */
    glass: boolean | null;
}

interface Snapshot {
    doc: string;
    selection: string[];
}

/** An undo step: the state before it. `batch` marks the steps of an assistant request (see squash). */
type Step = Snapshot & { label: string; batch?: string };

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
        giProbes: false,
        glass: null,
    };
}

function loadPrefs(): Prefs {
    return { ...defaultPrefs(), ...readLocal<Partial<Prefs>>(PREFS_KEY, {}) };
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
    /** True while Play mode runs; edits made meanwhile are reverted on Stop (except script and shader code). */
    playing = false;

    private index = new Map<string, NodeDoc>();
    private undoStack: Step[] = [];
    private redoStack: Step[] = [];
    private txn: { base: Snapshot; label: string; depth: number; batch?: string } | null = null;
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
        this.txn = { base: this.snapshot(), label, depth: 1, batch: this.batch ?? undefined };
    }

    /** Apply `fn` to the document. Outside a transaction this is one undo step. */
    update(fn: (doc: SceneDoc) => void, hint?: ChangeHint) {
        const auto = !this.txn;
        if (auto) this.begin('Edit');
        try {
            fn(this.doc);
        } finally {
            // Also when `fn` throws half way: the views follow what it changed
            // (an undoable step), and the transaction opened here is closed.
            this.reindex();
            this.emit('change', hint);
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
     * hand in between stay steps of their own. False when none are left.
     */
    squash(batch: string, label: string): boolean {
        const steps = this.undoStack;
        if (!steps.some((s) => s.batch === batch)) return false;
        // The first step of a run holds the state from before the run.
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

    get inTransaction(): boolean {
        return !!this.txn;
    }

    /** Label of the step Undo would revert, or '' when there is none. */
    get undoLabel(): string {
        return this.undoStack[this.undoStack.length - 1]?.label ?? '';
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
        this.batch = null;
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
        this.reindex();
        this.undoStack = cp.undo.slice();
        this.redoStack = cp.redo.slice();
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
        writeLocal(PREFS_KEY, this.prefs);
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
    set('camera', repair(Camera, node.camera));
    set('particles', repair(Particles, node.particles));
    set('body', repair(Body, node.body));
    set('animation', repair(Animation, node.animation));
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
        name: typeof input?.name === 'string' && input.name ? input.name : 'Untitled Scene',
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

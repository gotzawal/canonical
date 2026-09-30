import { applyBehaviorOps, writeBehaviorChanges, type OpsMode, type OpsResult } from './core/behavior/ops';
import { PARTICLE_PRESETS, presetParticles } from './core/particles';
import { makeCharacterNode } from './core/character';
import { formatBytes, kindOf, putAsset } from './core/assets';
import { externalUris, packGltf } from './core/gltfPack';
import { download as downloadFile, kindOfUrl, librarySource, urlFileName, type LibraryItem } from './core/library';
import { deleteDerivedOf } from './core/derived';
import { clampGIGrid, GI_MAX_PER_AXIS, giGridFits } from './core/giLimits';
import { MATERIAL_PRESETS } from './core/materialPresets';
import {
    defaultCamera, emptyScene, makeCameraNode, makeLightNode, makeMeshNode, makeNode, uid,
} from './core/defaults';
import { Emitter } from './core/events';
import { ask, confirmDialog, toast } from './core/messages';
import { AudioSource, Grass, Mirror } from './core/model';
import { defaults } from './core/schema';
import { DEG, add, decompose, eulerFromQuat, invert, len, mat4, mul, sub, tidy3, transformDir, transformPoint } from './core/math';
import {
    AutoSaver, collectGarbage, download, exportProject, exportSceneFile, fileNameFor, importProject, importSceneFile, pickFiles,
    keptAssets, projectFileNameFor, usedAssetIds,
} from './core/persistence';
import type { Store, Tool } from './core/store';
import { className, SCRIPT_TEMPLATES, SHADER_TEMPLATES } from './core/templates';
import type {
    AssetKind, AssetMeta, AssetSource, GeometryType, GrassDoc, LightType, MaterialOverride, NodeDoc, ParamValue, PartOverride, PrefabDoc,
    SceneDoc, ScriptDoc, ShaderDoc, ShaderKind, TextureCompression, Vec3,
} from './core/types';
import type { Picker } from './engine/picking';
import type { RenderGraphController } from './engine/renderGraph';
import type { Runtime } from './engine/runtime';
import type { ShaderManager } from './engine/shaders';
import type { SceneSync } from './engine/sync';
import type { ScriptCompiler } from './play/compiler';
import type { Player } from './play/player';
import type { CameraController } from './viewport/cameraController';
import { dropRefs, uses } from './core/refs';
import type { ModelServices } from './play/ai/services';
import type { RoomSample } from './design/materialSlots';
import { Pipeline } from './design/pipeline';
import { instanceRootOf, makeInstance, prefabFrom, regenerate, templateFromInstance } from './design/prefabs';
import type { Viewport } from './viewport/viewport';
import type { DerivedAssets } from './derive/derivedAssets';
import { exampleGuard, exampleShowcase } from './examples';
import { UsageLog } from './ai/usage';

/** What the editor works with; main.ts makes them. */
export interface EditorDeps {
    store: Store;
    runtime: Runtime;
    sync: SceneSync;
    picker: Picker;
    camera: CameraController;
    autosave: AutoSaver;
    shaders: ShaderManager;
    compiler: ScriptCompiler;
    player: Player;
    graph: RenderGraphController;
    /** The models of the agents. */
    models: ModelServices;
    viewport: Viewport;
    /** Compressed copies of the textures (KTX2) games ship. */
    derived: DerivedAssets;
}

export interface ImportUrlOptions {
    /** Where a model goes (default: where new objects go, framed). */
    at?: Vec3;
    /** false adds a model's file without placing it. */
    place?: boolean;
    /** The asset's name (default: the link's file name). */
    name?: string;
    kind?: AssetKind;
    source?: AssetSource;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total?: number) => void;
}

export interface ImportedUrl {
    asset: AssetMeta;
    /** The placed model's node. */
    node?: string;
    /** The project had the file already. */
    reused: boolean;
}

/** What the viewport shows: the scene, or the walk camera or the reference room (viewport/walk.ts, referenceRoom.ts). */
export type EditorView = 'scene' | 'walk' | 'room';

interface EditorEvents {
    /** Open a script, shader or behavior tree (as JSON) in the code dock. */
    'open-code': { kind: 'script' | 'shader' | 'behavior'; id: string };
    /** A model part was picked in the viewport. */
    'focus-part': { node: string; path: string | null };
    /** Show the AI panel, optionally with a prompt to send or prefill. */
    'ai-prompt': { text: string; send: boolean };
    /** Show the render graph tab of the dock. */
    'show-graph': void;
    /** Shows the Profiler tab of the dock. */
    'show-profiler': void;
    /** The scene (Ctrl+S) or the whole project was written to a file. */
    saved: 'scene' | 'project';
    /** Show the Design tab (pipeline, brief, shots): the full editor. */
    'show-design': void;
    /** Show the chat with the assistant. */
    'show-ai': void;
    /** Show the Scene tab (sky, exposure, post effects, GI). */
    /** Shows the Scene tab, at a section (by its key) when given. */
    'show-scene': string | void;
    /** A prefab instance is edited on its own (id of its root), or editing ended (null). */
    isolate: string | null;
    /** The viewport's view changed (setView). */
    view: EditorView;
    /** Show material samples in the reference room. */
    'show-room': RoomSample[];
    /** Take a picture of material samples in the reference room for the assistant (null: the view cannot show it now). */
    'capture-room': { samples: RoomSample[]; done: (image: string | null) => void };
    /** Apply the edits in progress (code panels): Play or a build starts. */
    'flush-edits': void;
    /** Show a behavior tree (or schema) in the Behavior tab of the dock. */
    'show-behavior': { tree?: string; schema?: string; node?: string };
}

// The dependencies are the editor's own fields (editor.store, editor.viewport...).
export interface Editor extends Readonly<EditorDeps> {}

/** Editor commands shared by menus, shortcuts, panels and the AI tools. */
export class Editor extends Emitter<EditorEvents> {
    /** Model part picked last, shown highlighted in the inspector. */
    focusedPart: { node: string; path: string } | null = null;
    /** Stage gates, checklists, shots and snapshots of the planning pipeline. */
    readonly pipeline: Pipeline;
    /** Tokens and credits the models spent on the project, per piece of work. */
    readonly usage: UsageLog;
    /** Root of the prefab instance being edited on its own (everything else hidden). */
    isolated: string | null = null;
    /** Objects under the edited instance that were not generated parts when the edit started. */
    private isolatedKept = new Set<string>();
    /** The document's structure version the isolation was made for. */
    private isolatedShape = -1;
    view: EditorView = 'scene';

    constructor(deps: EditorDeps) {
        super();
        Object.assign(this, deps);
        const { store, sync } = deps;
        this.pipeline = new Pipeline({ ...deps, blocked: () => this.viewBlock() });
        this.usage = new UsageLog(store);
        // Parts added while a prefab instance is edited on its own stay visible.
        store.on('change', () => {
            if (!this.isolated) return;
            if (!store.node(this.isolated)) {
                this.isolated = null;
                sync.setIsolation(null);
                this.emit('isolate', null);
                return;
            }
            // Only objects added, removed or re-parented change what is shown.
            if (store.structureVersion === this.isolatedShape) return;
            this.isolatedShape = store.structureVersion;
            sync.setIsolation(new Set([this.isolated, ...store.descendants(this.isolated).map((n) => n.id)]));
        });
        store.on('load', () => {
            if (!this.isolated) return;
            this.isolated = null;
            sync.setIsolation(null);
            this.emit('isolate', null);
        });
    }

    // ------------------------------------------------------------ creation

    private insert(nodes: NodeDoc[], label: string, select = true) {
        // While a prefab instance is edited on its own, new objects become its parts.
        const root = this.isolated ? this.picker.worldMatrix(this.isolated) : null;
        if (this.isolated && root) {
            const inv = invert(root) ?? mat4();
            for (const n of nodes) {
                if (n.parent) continue;
                n.parent = this.isolated;
                n.position = tidy3(transformPoint(inv, n.position), 4);
            }
        }
        this.store.commit(label, (doc) => {
            doc.nodes.push(...nodes);
        });
        if (select) this.store.select([nodes[0].id]);
    }

    createPrimitive(type: GeometryType) {
        const node = makeMeshNode(type);
        if (type !== 'plane') {
            const p = this.viewport.spawnPoint();
            node.position = [round(p[0]), node.position[1] + round(p[1]), round(p[2])];
        }
        node.name = this.uniqueName(node.name, null);
        this.insert([node], 'Create ' + node.name);
    }

    createLight(type: LightType) {
        const node = makeLightNode(type);
        if (type !== 'directional') {
            const p = this.viewport.spawnPoint();
            node.position = [round(p[0]), node.position[1] + round(p[1]), round(p[2])];
        }
        node.name = this.uniqueName(node.name, null);
        this.insert([node], 'Create ' + node.name);
    }

    /** A particle emitter from a preset (fire, smoke, sparks...), in front of the view. */
    createParticles(preset = 'fire'): string {
        const node = makeNode(this.uniqueName(PARTICLE_PRESETS.find((p) => p.id === preset)?.label ?? 'Particles', null), null);
        node.particles = presetParticles(preset);
        const p = this.viewport.spawnPoint();
        node.position = [round(p[0]), round(p[1]), round(p[2])];
        this.insert([node], 'Create ' + node.name);
        return node.id;
    }

    /** A field of grass in front of the view, on the object there (flat where there is none). */
    createGrass(): string {
        const node = makeNode(this.uniqueName('Grass', null), null);
        const [w, h] = this.runtime.cssSize;
        this.picker.update();
        const hit = this.picker.pick(w / 2, h / 2);
        const at = hit && hit.distance < this.store.camera.distance * 4 ? hit.point : this.viewport.spawnPoint();
        node.grass = { ...defaults(Grass), ground: hit ? hit.id : null };
        node.position = [round(at[0]), round(at[1]), round(at[2])];
        this.insert([node], 'Create ' + node.name);
        return node.id;
    }

    /**
     * A water surface in front of the view: a plane with a mirror and the
     * Water material shader (the scene's own, or made from the template).
     */
    createWater(): string {
        let id = '';
        this.store.transact('Create Water', () => {
            const shader = this.store.doc.shaders.find((s) => s.kind === 'material' && /^Water\d*\.wgsl$/.test(s.name)) ?? this.createShader({ template: 'water', open: false });
            const node = makeMeshNode('plane');
            node.name = this.uniqueName('Water', null);
            node.mesh.material = { ...node.mesh.material, type: 'shader', shader: shader.id };
            node.mesh.castShadow = false;
            node.mirror = defaults(Mirror);
            const p = this.viewport.spawnPoint();
            node.position = [round(p[0]), round(p[1]), round(p[2])];
            this.insert([node], 'Create ' + node.name);
            id = node.id;
        });
        return id;
    }

    /** Grass for an object (Add Component): on its own meshes and covering them when it has some, else a flat field around it. */
    grassFor(node: NodeDoc): GrassDoc {
        const grass = defaults(Grass);
        const box = node.mesh || node.model ? this.picker.bounds(node.id) : null;
        if (!box) return grass;
        const size: [number, number] = [round(box.max[0] - box.min[0]), round(box.max[2] - box.min[2])];
        return { ...grass, ground: node.id, size, count: Math.round(Math.min(20000, Math.max(1000, size[0] * size[1] * 20))) };
    }

    createEmpty(parent: string | null = null) {
        const node = makeNode(this.uniqueName('Empty', parent), parent);
        if (!parent) {
            const p = this.viewport.spawnPoint();
            node.position = [round(p[0]), round(p[1]), round(p[2])];
        }
        this.insert([node], 'Create Empty');
    }

    /** Groups the selection under a new empty at the selection's center. */
    groupSelection() {
        const roots = this.store.selectionRoots();
        if (!roots.length) return;
        const parent = this.store.node(roots[0])?.parent ?? null;
        const group = makeNode(this.uniqueName('Group', parent), parent);
        // Put the group's origin at the center of what it contains.
        let center: Vec3 = [0, 0, 0];
        for (const id of roots) {
            const m = this.picker.worldMatrix(id);
            if (m) center = [center[0] + m[12] / roots.length, center[1] + m[13] / roots.length, center[2] + m[14] / roots.length];
        }
        const parentWorld = parent ? this.picker.worldMatrix(parent) : null;
        const invParent = (parentWorld && invert(parentWorld)) || mat4();
        group.position = tidy3(transformPoint(invParent, center), 3);
        this.store.transact('Group', () => {
            this.store.update((doc) => {
                const idx = doc.nodes.findIndex((n) => n.id === roots[0]);
                doc.nodes.splice(Math.max(0, idx), 0, group);
            });
            this.moveNodes(roots, group.id, null, 'Group');
        });
        this.store.select([group.id]);
    }

    // ------------------------------------------------------------- editing

    deleteSelection() {
        const ids = new Set<string>();
        for (const id of this.store.selection) {
            ids.add(id);
            for (const d of this.store.descendants(id)) ids.add(d.id);
        }
        if (!ids.size) return;
        const count = ids.size;
        this.store.commit(count > 1 ? `Delete ${count} Objects` : 'Delete', (doc) => {
            doc.nodes = doc.nodes.filter((n) => !ids.has(n.id));
        });
        this.store.select([]);
    }

    duplicateSelection() {
        const roots = this.store.selectionRoots();
        if (!roots.length) return;
        const newRoots: string[] = [];
        this.store.commit('Duplicate', (doc) => {
            for (const rootId of roots) {
                const root = doc.nodes.find((n) => n.id === rootId);
                if (!root) continue;
                const subtree = [root, ...this.store.descendants(rootId)];
                const ids = new Map<string, string>();
                for (const n of subtree) ids.set(n.id, uid());
                const copies = subtree.map((n) => {
                    const c: NodeDoc = JSON.parse(JSON.stringify(n));
                    c.id = ids.get(n.id)!;
                    c.parent = n === root ? n.parent : ids.get(n.parent!) ?? n.parent;
                    return c;
                });
                copies[0].name = this.uniqueName(root.name, root.parent);
                const lastIndex = Math.max(...subtree.map((n) => doc.nodes.indexOf(n)));
                doc.nodes.splice(lastIndex + 1, 0, ...copies);
                newRoots.push(copies[0].id);
            }
        });
        this.store.select(newRoots);
    }

    rename(id: string, name: string) {
        const clean = name.trim();
        if (!clean) return;
        this.store.commit('Rename', (doc) => {
            const n = doc.nodes.find((x) => x.id === id);
            if (n) n.name = clean;
        }, { nodes: [id] });
    }

    toggleVisibility(ids: string[]) {
        if (!ids.length) return;
        const target = !this.store.node(ids[0])?.visible;
        this.store.commit(target ? 'Show' : 'Hide', (doc) => {
            for (const n of doc.nodes) if (ids.includes(n.id)) n.visible = target;
        }, { nodes: ids });
    }

    resetTransform(part: 'position' | 'rotation' | 'scale' | 'all' = 'all') {
        const ids = this.store.selection;
        if (!ids.length) return;
        this.store.commit('Reset Transform', (doc) => {
            for (const n of doc.nodes) {
                if (!ids.includes(n.id)) continue;
                if (part === 'position' || part === 'all') n.position = [0, 0, 0];
                if (part === 'rotation' || part === 'all') n.rotation = [0, 0, 0];
                if (part === 'scale' || part === 'all') n.scale = [1, 1, 1];
            }
        }, { nodes: ids, transform: true });
    }

    /** Drops objects onto the ground (y of their lowest point = 0). */
    dropToGround() {
        const ids = this.store.selectionRoots();
        const moves: { id: string; dy: number }[] = [];
        for (const id of ids) {
            const box = this.picker.bounds(id);
            if (box) moves.push({ id, dy: -box.min[1] });
        }
        if (!moves.length) return;
        this.store.commit('Drop to Ground', (doc) => {
            for (const m of moves) {
                const n = doc.nodes.find((x) => x.id === m.id);
                if (!n) continue;
                // Convert the world-space offset into the parent's space.
                const parentWorld = n.parent ? this.picker.worldMatrix(n.parent) : null;
                n.position = tidy3(add(n.position, transformDir((parentWorld && invert(parentWorld)) || mat4(), [0, m.dy, 0])));
            }
        }, { nodes: moves.map((m) => m.id), transform: true });
    }

    /**
     * Re-parents nodes, keeping their world transform, and places them
     * before `beforeId` among the new siblings (or last when null).
     */
    moveNodes(ids: string[], parent: string | null, beforeId: string | null, label = 'Reparent') {
        const store = this.store;
        let moving = ids.filter((id) => id !== parent && !(parent && store.isAncestor(id, parent)));
        moving = moving.filter((id) => !moving.some((o) => o !== id && store.isAncestor(o, id)));
        if (!moving.length) return;
        if (beforeId && moving.includes(beforeId)) return;

        const parentWorld = parent ? this.picker.worldMatrix(parent) : null;
        const invParent = (parentWorld && invert(parentWorld)) || mat4();
        const transforms = new Map<string, { position: Vec3; rotation: Vec3; scale: Vec3 }>();
        for (const id of moving) {
            const node = store.node(id);
            if (!node || node.parent === parent) continue;
            const world = this.picker.worldMatrix(id);
            if (!world) continue;
            const d = decompose(mul(invParent, world));
            transforms.set(id, { position: tidy3(d.position), rotation: tidy3(eulerFromQuat(d.rotation), 4), scale: tidy3(d.scale, 4) });
        }

        store.commit(label, (doc) => {
            // In the order they had, not the order they were selected in.
            const moved = doc.nodes.filter((n) => moving.includes(n.id));
            for (const n of moved) {
                const t = transforms.get(n.id);
                if (t) Object.assign(n, t);
                n.parent = parent;
            }
            doc.nodes = doc.nodes.filter((n) => !moving.includes(n.id));
            let index = beforeId ? doc.nodes.findIndex((n) => n.id === beforeId) : -1;
            if (index < 0) index = doc.nodes.length;
            doc.nodes.splice(index, 0, ...moved);
        });
    }

    uniqueName(base: string, parent: string | null): string {
        const stem = base.replace(/\s\(\d+\)$/, '');
        const names = new Set(this.store.doc.nodes.filter((n) => n.parent === parent).map((n) => n.name));
        if (!names.has(stem)) return stem;
        let i = 1;
        while (names.has(`${stem} (${i})`)) i++;
        return `${stem} (${i})`;
    }

    // -------------------------------------------------------------- assets

    async importFiles(files: File[], at?: Vec3) {
        for (const file of files) {
            const lower = file.name.toLowerCase();
            try {
                if (lower.endsWith('.json') || lower.endsWith('.zip')) {
                    await this.openSceneFromFile(file);
                    continue;
                }
                const kind = kindOf(file);
                if (kind === 'model') await this.importModel(file, at, files);
                else if (kind === 'texture') {
                    // The files a .gltf dropped with them names are part of it.
                    if (!files.some((f) => f !== file && /\.gltf$/i.test(f.name))) await this.importTexture(file);
                } else if (kind === 'audio') await this.importAudio(file);
                else if (!files.some((f) => /\.gltf$/i.test(f.name))) toast(`Unsupported file: ${file.name}`, 'error');
            } catch (e: any) {
                console.error(e);
                toast(`Import failed: ${e?.message || e}`, 'error');
            }
        }
    }

    /** `with`: files imported with it, where a .gltf finds the files it names (they are packed into one GLB). */
    async importModel(file: File, at?: Vec3, with_: File[] = []) {
        let blob: Blob = file;
        let name = file.name;
        if (name.toLowerCase().endsWith('.gltf')) {
            const json = JSON.parse(await file.text());
            const missing = externalUris(json).filter((uri) => !fileNamed(with_, uri));
            if (missing.length) {
                toast(`This .gltf names other files (${missing.slice(0, 3).join(', ')}): drop them together with it, or use a .glb.`, 'error');
                return;
            }
            blob = await packGltf(json, (uri) => fileNamed(with_, uri)!.arrayBuffer());
            name = name.replace(/\.gltf$/i, '.glb');
        }
        const meta = await putAsset(blob, name, 'model');
        // One undo step takes both back: the file and the object showing it.
        this.store.transact('Import Model', () => {
            this.store.update((doc) => doc.assets.push(meta));
            this.addModel(meta.id, at, true);
        });
        toast(`Imported ${file.name}`, 'success');
        this.compressImported(meta.id);
    }

    async importAudio(file: File) {
        const meta = await putAsset(file, file.name, 'audio');
        this.store.commit('Import Sound', (doc) => doc.assets.push(meta));
        toast(`Imported ${file.name}. Play it with an Audio component or from a script.`, 'success');
    }

    /** With Prefs.compressImports, an imported file is compressed and replaces its original once that is done (the view shows the file meanwhile). */
    private compressImported(assetId: string) {
        if (!this.store.prefs.compressImports) return;
        void this.derived.packFile(assetId).then((packed) => {
            if (packed?.packed) toast(`Compressed ${packed.packed.from}: ${formatBytes(packed.packed.size)} to ${formatBytes(packed.size)}.`, 'info');
        });
    }

    /** Compresses the files of these assets (every texture and model when none are given) and keeps only the compressed files. */
    async compressFiles(ids?: string[]): Promise<number> {
        const list = (ids ?? this.store.doc.assets.filter((a) => a.kind === 'texture' || a.kind === 'model').map((a) => a.id));
        const done = await Promise.all(list.map((id) => this.derived.packFile(id)));
        return done.filter(Boolean).length;
    }

    /** Places a model asset (where new objects go without `at`); returns the new node's id. */
    addModel(assetId: string, at?: Vec3, frame = false): string | undefined {
        const meta = this.store.doc.assets.find((a) => a.id === assetId);
        if (!meta) return;
        const spot = at ?? this.viewport.spawnPoint();
        const node = makeNode(this.uniqueName(meta.name.replace(/\.(glb|gltf)$/i, ''), null), null, spot);
        node.position = tidy3(node.position, 3);
        node.model = { asset: assetId };
        this.insert([node], 'Add Model');
        const off = this.sync.on('model', (id) => {
            if (id !== node.id) return;
            off();
            const state = this.sync.modelState(id);
            if (state?.status !== 'ready') {
                toast(`Could not load ${meta.name}: ${state?.error ?? 'unknown error'}`, 'error');
                return;
            }
            this.settleModel(id, spot);
            if (frame) this.viewport.frameNodes([id]);
        });
        return node.id;
    }

    /** Centers a freshly loaded model on `spot` and rests it on top of it. */
    private settleModel(id: string, spot: Vec3) {
        const box = this.picker.bounds(id);
        const node = this.store.node(id);
        if (!box || !node || node.parent) return;
        const dx = spot[0] - (box.min[0] + box.max[0]) / 2;
        const dy = spot[1] - box.min[1];
        const dz = spot[2] - (box.min[2] + box.max[2]) / 2;
        this.store.patch((doc) => {
            const n = doc.nodes.find((x) => x.id === id);
            if (n) n.position = tidy3([n.position[0] + dx, n.position[1] + dy, n.position[2] + dz], 3);
        }, { nodes: [id], transform: true });
    }

    async importTexture(file: File) {
        const meta = await putAsset(file, file.name, 'texture');
        const targets = this.store.selection.filter((id) => this.store.node(id)?.mesh);
        this.store.commit('Import Texture', (doc) => {
            doc.assets.push(meta);
            for (const n of doc.nodes) if (targets.includes(n.id) && n.mesh) n.mesh.material.map = meta.id;
        });
        toast(targets.length ? `Applied ${file.name} to ${targets.length} object(s)` : `Imported ${file.name}. Assign it from the Material section.`, 'success');
        this.compressImported(meta.id);
    }

    /**
     * A sound asset plays from these objects (their Audio component gets it,
     * added when missing), or from a new sound object at `at` (where new
     * objects go by default) when none are given. Returns the objects' ids.
     */
    addSound(assetId: string, targets: string[] = [], at?: Vec3): string[] {
        const meta = this.store.doc.assets.find((a) => a.id === assetId && a.kind === 'audio');
        if (!meta) return [];
        const ids = targets.filter((id) => this.store.node(id) && !this.store.node(id)!.prefabChild);
        if (ids.length) {
            this.store.commit('Set Audio Clip', (doc) => {
                for (const n of doc.nodes) if (ids.includes(n.id)) n.audio = { ...(n.audio ?? defaults(AudioSource)), clip: assetId };
            }, { nodes: ids });
            return ids;
        }
        const spot = at ?? this.viewport.spawnPoint();
        const node = makeNode(this.uniqueName(meta.name.replace(/\.[a-z0-9]+$/i, ''), null), null, tidy3([spot[0], spot[1] + 1, spot[2]], 3));
        node.audio = { ...defaults(AudioSource), clip: assetId };
        this.insert([node], 'Add Sound');
        return [node.id];
    }

    // ------------------------------------------------------------ downloads

    /**
     * Copies a Library item into the project and, for a model, places it
     * (see importUrl). A file copied from the same item before is used again.
     */
    addFromLibrary(item: LibraryItem, opts: ImportUrlOptions = {}): Promise<ImportedUrl> {
        const ext = item.file.match(/\.[a-z0-9]+$/i)?.[0] ?? '';
        return this.importUrl(item.url, { ...opts, name: item.name + ext, kind: item.kind, source: librarySource(item) });
    }

    /**
     * Downloads a model, image or sound into the project, so the scene keeps
     * it when the link goes away (a file downloaded from the same link, or
     * the same Library item, is used again), and places a model: at `at`, or
     * where new objects go; `place: false` only adds the file. A .gltf is
     * packed with the files it names into one GLB.
     */
    async importUrl(url: string, opts: ImportUrlOptions = {}): Promise<ImportedUrl> {
        const abs = new URL(url, document.baseURI).href;
        if (!/^https?:$/.test(new URL(abs).protocol)) throw new Error('Only http and https links can be imported.');
        if (/\.(zip|json)$/i.test(urlFileName(abs))) throw new Error('That is a scene or project file: open it with File > Open Link.');
        const source: AssetSource = opts.source ?? { url: abs };
        let asset = this.store.doc.assets.find((a) => (source.item ? a.source?.item === source.item : a.source?.url === abs));
        const reused = !!asset;
        if (!asset) {
            let name = opts.name ?? urlFileName(abs);
            let blob = await downloadFile(abs, { signal: opts.signal, onProgress: opts.onProgress });
            const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
            if (/\.gltf$/i.test(name) || (head[0] === 0x7b && kindOfUrl(name, blob.type) === 'model')) {
                // A .gltf: packed with the files it names, fetched next to it.
                const json = JSON.parse(await blob.text());
                blob = await packGltf(json, (uri) => downloadFile(new URL(uri, abs).href, { signal: opts.signal }).then((b) => b.arrayBuffer()));
                name = name.replace(/\.gltf$/i, '') + '.glb';
            } else if (head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46 && !/\.glb$/i.test(name)) {
                // A GLB under another name: the engine picks its parser by the extension.
                name += '.glb';
            }
            const kind: AssetKind | null = opts.kind ?? kindOfUrl(name, blob.type);
            if (kind !== 'model' && kind !== 'texture' && kind !== 'audio') throw new Error(`${name} is not a model (.glb, .gltf), image or sound file.`);
            asset = await putAsset(blob, name, kind, undefined, { source });
        }
        const meta = asset;
        let node: string | undefined;
        const place = meta.kind === 'model' && opts.place !== false;
        const label = meta.kind === 'model' ? 'Import Model' : meta.kind === 'audio' ? 'Import Sound' : 'Import Texture';
        if (!reused) {
            this.store.transact(label, () => {
                this.store.update((doc) => doc.assets.push(meta));
                if (place) node = this.addModel(meta.id, opts.at, !opts.at);
            });
            if (meta.kind !== 'audio') this.compressImported(meta.id);
        } else if (place) node = this.addModel(meta.id, opts.at, !opts.at);
        return { asset: meta, node, reused };
    }

    applyTexture(assetId: string | null, ids = this.store.selection) {
        const targets = ids.filter((id) => this.store.node(id)?.mesh);
        if (!targets.length) {
            toast('Select a mesh object first.', 'info');
            return;
        }
        this.store.commit('Assign Texture', (doc) => {
            for (const n of doc.nodes) if (targets.includes(n.id) && n.mesh) n.mesh.material.map = assetId;
        }, { nodes: targets });
    }

    removeAsset(assetId: string) {
        const used = usedAssetIds(this.store.doc).has(assetId);
        if (used) {
            toast('This asset is used in the scene. Remove those objects first.', 'error');
            return;
        }
        this.store.commit('Remove Asset', (doc) => {
            doc.assets = doc.assets.filter((a) => a.id !== assetId);
        });
    }

    // ------------------------------------------------------------- prefabs

    /** What a click on `id` selects: generated parts of a prefab instance select the instance. */
    selectable(id: string): string {
        const node = this.store.node(id);
        if (!node?.prefabChild) return id;
        if (this.isolated && (id === this.isolated || this.store.isAncestor(this.isolated, id))) return id;
        return instanceRootOf(this.store.doc, id)?.id ?? id;
    }

    prefab(ref: string | null | undefined): PrefabDoc | undefined {
        if (!ref) return undefined;
        const list = this.store.doc.prefabs;
        return list.find((p) => p.id === ref) ?? list.find((p) => p.name.toLowerCase() === ref.toLowerCase());
    }

    instancesOf(prefabId: string): NodeDoc[] {
        return this.store.doc.nodes.filter((n) => n.prefab === prefabId);
    }

    /**
     * Turns the selected objects into a prefab (pivot at their bottom
     * center) and puts one instance where they were.
     */
    createPrefab(name?: string, ids = this.store.selectionRoots()): { prefab: PrefabDoc; instance: string } | null {
        const roots = ids.filter((id) => {
            const n = this.store.node(id);
            return n && !n.prefab && !n.prefabChild;
        });
        if (!roots.length) {
            toast('Select the objects to make a prefab from (prefab instances cannot be nested).', 'info');
            return null;
        }
        let box: { min: Vec3; max: Vec3 } | null = null;
        for (const id of roots) {
            const b = this.picker.bounds(id);
            if (!b) continue;
            box = box
                ? { min: [0, 1, 2].map((i) => Math.min(box!.min[i], b.min[i])) as Vec3, max: [0, 1, 2].map((i) => Math.max(box!.max[i], b.max[i])) as Vec3 }
                : { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
        }
        if (!box) {
            toast('The selection has no meshes to make a prefab from.', 'info');
            return null;
        }
        const first = this.store.node(roots[0])!;
        const stem = (name?.trim() || first.name).replace(/\s\(\d+\)$/, '');
        const { prefab, pivot } = prefabFrom(this.store.doc, roots, stem, box, (id) => this.picker.worldMatrix(id));
        // Keep the instance under the objects' common parent.
        const parent = roots.every((id) => this.store.node(id)?.parent === first.parent) ? first.parent : null;
        const parentWorld = parent ? this.picker.worldMatrix(parent) : null;
        const local = parentWorld ? transformPoint(invert(parentWorld) ?? mat4(), pivot) : pivot;
        const nodes = makeInstance(prefab, tidy3(local, 4), this.uniqueName(stem, parent));
        nodes[0].parent = parent;
        const doomed = new Set<string>();
        for (const id of roots) {
            doomed.add(id);
            for (const d of this.store.descendants(id)) doomed.add(d.id);
        }
        this.store.commit('Create Prefab', (doc) => {
            const at = doc.nodes.findIndex((n) => n.id === roots[0]);
            doc.nodes = doc.nodes.filter((n) => !doomed.has(n.id));
            doc.nodes.splice(Math.max(0, Math.min(at, doc.nodes.length)), 0, ...nodes);
            doc.prefabs.push(prefab);
        });
        this.store.select([nodes[0].id]);
        return { prefab, instance: nodes[0].id };
    }

    /** Places an instance of a prefab (at the view's ground point by default). */
    placePrefab(prefabId: string, at?: Vec3, rotationY = 0, select = true): string | null {
        const prefab = this.prefab(prefabId);
        if (!prefab) return null;
        const spot = at ?? this.viewport.spawnPoint();
        const nodes = makeInstance(prefab, tidy3(spot, 3), this.uniqueName(prefab.name, null), rotationY);
        this.insert(nodes, 'Place Prefab', select);
        return nodes[0].id;
    }

    renamePrefab(prefabId: string, name: string) {
        const clean = name.trim();
        if (!clean) return;
        this.store.commit('Rename Prefab', (doc) => {
            const p = doc.prefabs.find((x) => x.id === prefabId);
            if (p) p.name = clean;
        });
    }

    /** Hides everything but one instance so its parts can be edited; Apply updates every instance. */
    editPrefab(rootId: string) {
        const root = this.store.node(rootId);
        const prefab = this.prefab(root?.prefab);
        if (!root || !prefab) return;
        if (prefab.useModel) {
            toast('This prefab shows its model. Switch it back to the greybox template to edit the template.', 'info', 5000);
            return;
        }
        this.isolated = rootId;
        this.isolatedShape = this.store.structureVersion;
        this.isolatedKept = new Set(this.store.descendants(rootId).filter((n) => !n.prefabChild).map((n) => n.id));
        const ids = new Set([rootId, ...this.store.descendants(rootId).map((n) => n.id)]);
        this.sync.setIsolation(ids);
        this.store.select([rootId]);
        this.viewport.frameNodes([rootId]);
        this.emit('isolate', rootId);
    }

    /** Ends prefab editing: apply the edited parts to every instance, or discard them. */
    finishPrefabEdit(apply: boolean) {
        const rootId = this.isolated;
        if (!rootId) return;
        const root = this.store.node(rootId);
        const prefabId = root?.prefab;
        this.isolated = null;
        this.sync.setIsolation(null);
        this.emit('isolate', null);
        if (!root || !prefabId) return;
        const others = this.instancesOf(prefabId).filter((n) => n.id !== rootId).map((n) => n.id);
        if (apply) {
            this.store.commit('Apply Prefab', (doc) => {
                const p = doc.prefabs.find((x) => x.id === prefabId);
                if (!p) return;
                p.nodes = templateFromInstance(doc, rootId);
                // The edited parts become generated parts again.
                const mark = (pid: string) => {
                    for (const n of doc.nodes) {
                        if (n.parent !== pid) continue;
                        n.prefabChild = true;
                        mark(n.id);
                    }
                };
                mark(rootId);
                regenerate(doc, prefabId, others);
            });
            toast(others.length ? `Updated ${others.length + 1} instances.` : 'Prefab updated.', 'success');
        } else {
            const kept = this.isolatedKept;
            const added = this.store.descendants(rootId).filter((n) => !n.prefabChild && !kept.has(n.id));
            this.store.commit('Discard Prefab Edit', (doc) => {
                // Parts added during the edit go with everything below them;
                // regenerating keeps the objects that were under the instance before.
                const doomed = new Set(added.map((n) => n.id));
                for (let grew = true; grew; ) {
                    grew = false;
                    for (const n of doc.nodes) {
                        if (n.parent && doomed.has(n.parent) && !doomed.has(n.id)) {
                            doomed.add(n.id);
                            grew = true;
                        }
                    }
                }
                doc.nodes = doc.nodes.filter((n) => !doomed.has(n.id));
                regenerate(doc, prefabId, [rootId]);
            });
        }
        this.store.select([rootId]);
    }

    /** Makes an instance ordinary objects that no longer follow the prefab. */
    unpackInstance(rootId: string) {
        this.store.commit('Unpack Prefab', (doc) => {
            const walk = (pid: string) => {
                for (const n of doc.nodes) {
                    if (n.parent !== pid) continue;
                    delete n.prefabChild;
                    walk(n.id);
                }
            };
            const root = doc.nodes.find((n) => n.id === rootId);
            if (root) delete root.prefab;
            walk(rootId);
        });
    }

    /** Deletes a prefab; its instances stay as ordinary objects. */
    async deletePrefab(prefabId: string, ask = true) {
        const prefab = this.prefab(prefabId);
        if (!prefab) return;
        const count = this.instancesOf(prefab.id).length;
        if (ask && count && !(await confirmDialog('Delete prefab', `${prefab.name} has ${count} instance(s). They stay in the scene as ordinary objects. Delete the prefab?`, 'Delete', true))) return;
        const roots = this.instancesOf(prefab.id).map((n) => n.id);
        this.store.commit('Delete Prefab', (doc) => {
            for (const rootId of roots) {
                const root = doc.nodes.find((n) => n.id === rootId);
                if (root) delete root.prefab;
                const walk = (pid: string) => {
                    for (const n of doc.nodes) {
                        if (n.parent !== pid) continue;
                        delete n.prefabChild;
                        walk(n.id);
                    }
                };
                walk(rootId);
            }
            doc.prefabs = doc.prefabs.filter((p) => p.id !== prefab.id);
        });
    }

    /**
     * Stores a model (.glb / .gltf) under the prefab's asset id: every
     * instance shows it instead of the greybox template. Importing again
     * replaces it (a new version from Blender).
     */
    async replacePrefabModel(prefabId: string, file?: File) {
        const prefab = this.prefab(prefabId);
        if (!prefab) return;
        const picked = file ?? (await pickFiles('.glb,.gltf', false))[0];
        if (!picked) return;
        if (picked.name.toLowerCase().endsWith('.gltf') && /"uri"\s*:\s*"(?!data:)/.test(await picked.text())) {
            toast('This .gltf references external files. Use a .glb or an embedded .gltf.', 'error');
            return;
        }
        const existed = this.store.doc.assets.some((a) => a.id === prefab.asset);
        const meta = await putAsset(picked, picked.name, 'model', prefab.asset);
        this.store.commit('Prefab Model', (doc) => {
            doc.assets = doc.assets.filter((a) => a.id !== meta.id);
            doc.assets.push(meta);
            const p = doc.prefabs.find((x) => x.id === prefab.id);
            if (!p) return;
            p.useModel = true;
            delete p.modelOffset;
            regenerate(doc, p.id);
        });
        if (existed) {
            this.sync.reloadAsset(meta.id);
            // Copies of the file it replaced are of no use any more.
            void deleteDerivedOf([meta.id]);
            this.derived.forget(meta.id);
        }
        this.settlePrefabModel(prefab.id);
        toast(`${prefab.name} now shows ${picked.name}.`, 'success');
        this.compressImported(meta.id);
    }

    /** Once the model of a prefab has loaded, moves it so its bottom center sits on the pivot. */
    private settlePrefabModel(prefabId: string) {
        const root = this.instancesOf(prefabId)[0];
        const child = root && this.store.children(root.id)[0];
        if (!root || !child) return;
        const off = this.sync.on('model', (id) => {
            if (id !== child.id) return;
            off();
            const box = this.picker.bounds(child.id);
            const rootWorld = this.picker.worldMatrix(root.id);
            if (!box || !rootWorld) return;
            const bottom = transformPoint(invert(rootWorld) ?? mat4(), [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2]);
            const offset = tidy3([-bottom[0], -bottom[1], -bottom[2]], 4);
            this.store.patch((doc) => {
                const p = doc.prefabs.find((x) => x.id === prefabId);
                if (!p) return;
                p.modelOffset = offset;
                regenerate(doc, prefabId);
            });
        });
    }

    /** Switches a prefab between its model and its greybox template. */
    usePrefabModel(prefabId: string, on: boolean) {
        const prefab = this.prefab(prefabId);
        if (!prefab) return;
        if (on && !this.store.doc.assets.some((a) => a.id === prefab.asset)) {
            void this.replacePrefabModel(prefabId);
            return;
        }
        this.store.commit(on ? 'Show Prefab Model' : 'Show Prefab Template', (doc) => {
            const p = doc.prefabs.find((x) => x.id === prefabId);
            if (!p) return;
            p.useModel = on || undefined;
            regenerate(doc, prefabId);
        });
        if (on && !prefab.modelOffset) this.settlePrefabModel(prefabId);
    }

    /**
     * The player: a character the size of the brief's player with the
     * built-in player controller (it walks, jumps and carries the camera in
     * Play), standing on the ground under the view. A scene has one player;
     * when it has one already, that one is selected.
     */
    createPlayer() {
        const existing = this.store.doc.nodes.find((n) => n.player);
        if (existing) {
            this.store.select([existing.id]);
            this.viewport.frameNodes([existing.id]);
            toast(`The scene has a player already: ${existing.name}. Move it to where the game starts.`, 'info', 4500);
            return;
        }
        this.createCharacter(true);
    }

    /** A character at the spawn point: an NPC (walked by a behavior tree or a script), or the player's. */
    createCharacter(player = false) {
        const node = makeCharacterNode(this.store.doc.design.specs, player);
        const p = this.viewport.spawnPoint();
        node.position = [round(p[0]), round(p[1] + node.character!.height / 2), round(p[2])];
        node.name = this.uniqueName(node.name, null);
        this.insert([node], player ? 'Create Player' : 'Create Character');
    }

    // ------------------------------------------------------------- cameras

    createCamera() {
        const node = makeCameraNode();
        node.name = this.uniqueName(node.name, null);
        const hasMain = this.store.doc.nodes.some((n) => n.camera?.main);
        node.camera!.main = !hasMain;
        const pose = this.editorCameraPose(null);
        node.position = pose.position;
        node.rotation = pose.rotation;
        this.insert([node], 'Create Camera');
    }

    /** Local transform that puts a node where the editor camera is, looking the same way. */
    private editorCameraPose(parent: string | null): { position: Vec3; rotation: Vec3 } {
        const world = this.runtime.camera.transform.worldMatrix.rawData;
        const parentWorld = parent ? this.picker.worldMatrix(parent) : null;
        const invParent = (parentWorld && invert(parentWorld)) || mat4();
        const d = decompose(mul(invParent, world));
        return { position: tidy3(d.position, 3), rotation: tidy3(eulerFromQuat(d.rotation), 3) };
    }

    /** Moves camera nodes to the current view. */
    alignCameraToView(ids = this.store.selection) {
        const targets = ids.filter((id) => this.store.node(id)?.camera);
        if (!targets.length) return;
        this.store.commit('Align Camera to View', (doc) => {
            for (const n of doc.nodes) {
                if (!targets.includes(n.id)) continue;
                const pose = this.editorCameraPose(n.parent);
                n.position = pose.position;
                n.rotation = pose.rotation;
            }
        }, { nodes: targets, transform: true });
    }

    /** Moves the editor camera to look through a camera node. */
    viewThroughCamera(id: string) {
        const node = this.store.node(id);
        const m = this.picker.worldMatrix(id);
        if (!node?.camera || !m) return;
        const pos: Vec3 = [m[12], m[13], m[14]];
        const f = [m[8], m[9], m[10]];
        const fl = Math.hypot(f[0], f[1], f[2]) || 1;
        const dir: Vec3 = [f[0] / fl, f[1] / fl, f[2] / fl];
        const distance = Math.max(0.5, this.store.camera.distance);
        const target: Vec3 = [pos[0] + dir[0] * distance, pos[1] + dir[1] * distance, pos[2] + dir[2] * distance];
        // The editor camera sits at target + (sin yaw cos pitch, sin pitch, cos yaw cos pitch) * distance.
        const back = sub(pos, target);
        const bl = len(back) || 1;
        const pitch = Math.asin(Math.max(-1, Math.min(1, back[1] / bl))) / DEG;
        const yaw = Math.atan2(back[0], back[2]) / DEG;
        this.camera.animateTo({ ...this.store.camera, target, distance, yaw: (yaw + 360) % 360, pitch, fov: node.camera.fov });
    }

    // ------------------------------------------------------------- scripts

    private uniqueFileName(base: string, ext: string, taken: string[]): string {
        const stem = base.replace(/\.[a-z0-9]+$/i, '').trim() || 'NewFile';
        const names = new Set(taken.map((n) => n.toLowerCase()));
        let name = `${stem}${ext}`;
        for (let i = 1; names.has(name.toLowerCase()); i++) name = `${stem}${i}${ext}`;
        return name;
    }

    /** Adds a script asset; attaches it to `attachTo` nodes and opens it. */
    createScript(opts: { name?: string; template?: string; code?: string; attachTo?: string[]; open?: boolean } = {}): ScriptDoc {
        const name = this.uniqueFileName(opts.name || 'NewScript', '.js', this.store.doc.scripts.map((s) => s.name));
        const template = SCRIPT_TEMPLATES.find((t) => t.id === (opts.template || 'empty')) ?? SCRIPT_TEMPLATES[0];
        const doc: ScriptDoc = { id: uid('s'), name, code: opts.code ?? template.code(className(name)) };
        const attach = (opts.attachTo ?? []).filter((id) => this.store.node(id));
        this.store.commit('Create Script', (d) => {
            d.scripts.push(doc);
            for (const n of d.nodes) {
                if (!attach.includes(n.id)) continue;
                n.scripts = [...(n.scripts ?? []), { script: doc.id, enabled: true, props: {} }];
            }
        });
        if (opts.open !== false) this.emit('open-code', { kind: 'script', id: doc.id });
        return doc;
    }

    updateScript(id: string, code: string) {
        const doc = this.store.doc.scripts.find((s) => s.id === id);
        if (!doc || doc.code === code) return;
        this.store.commit('Edit Script', (d) => {
            const s = d.scripts.find((x) => x.id === id);
            if (s) s.code = code;
        });
    }

    renameScript(id: string, name: string) {
        const clean = name.trim();
        if (!clean) return;
        const others = this.store.doc.scripts.filter((s) => s.id !== id).map((s) => s.name);
        const next = this.uniqueFileName(clean, '.js', others);
        this.store.commit('Rename Script', (d) => {
            const s = d.scripts.find((x) => x.id === id);
            if (s) s.name = next;
        });
    }

    async deleteScript(id: string, confirm = true) {
        const doc = this.store.doc.scripts.find((s) => s.id === id);
        if (!doc) return;
        const users = uses(this.store.doc, 'script', id);
        if (confirm && users && !(await confirmDialog('Delete script', `${doc.name} is attached to ${users} object(s). Delete it anyway?`, 'Delete', true))) return;
        this.store.commit('Delete Script', (d) => {
            d.scripts = d.scripts.filter((s) => s.id !== id);
            dropRefs(d, 'script', id);
        });
    }

    attachScript(ids: string[], scriptId: string, props: Record<string, ParamValue> = {}) {
        if (!this.store.doc.scripts.some((s) => s.id === scriptId)) return;
        // One copy per object: the Inspector finds a script's field values by the script.
        const targets = ids.filter((id) => {
            const n = this.store.node(id);
            return n && !n.scripts?.some((r) => r.script === scriptId);
        });
        if (!targets.length) {
            if (ids.length) toast('The script is already attached.', 'info');
            return;
        }
        this.store.commit('Add Script', (d) => {
            for (const n of d.nodes) {
                if (!targets.includes(n.id)) continue;
                n.scripts = [...(n.scripts ?? []), { script: scriptId, enabled: true, props: { ...props } }];
            }
        }, { nodes: targets });
    }

    detachScript(nodeId: string, index: number) {
        this.store.commit('Remove Script', (d) => {
            const n = d.nodes.find((x) => x.id === nodeId);
            if (!n?.scripts) return;
            n.scripts.splice(index, 1);
            if (!n.scripts.length) delete n.scripts;
        }, { nodes: [nodeId] });
    }

    // ------------------------------------------------------------- shaders

    createShader(opts: { name?: string; template?: string; kind?: ShaderKind; lighting?: 'lit' | 'unlit'; code?: string; open?: boolean } = {}): ShaderDoc {
        const template =
            SHADER_TEMPLATES.find((t) => t.id === opts.template) ??
            SHADER_TEMPLATES.find((t) => t.kind === (opts.kind ?? 'material')) ??
            SHADER_TEMPLATES[0];
        const name = this.uniqueFileName(opts.name || template.label.replace(/\s+/g, ''), '.wgsl', this.store.doc.shaders.map((s) => s.name));
        const doc: ShaderDoc = {
            id: uid('sh'),
            name,
            kind: opts.kind ?? template.kind,
            lighting: opts.lighting ?? template.lighting,
            code: opts.code ?? template.code,
        };
        this.store.commit('Create Shader', (d) => {
            d.shaders.push(doc);
        });
        if (opts.open !== false) this.emit('open-code', { kind: 'shader', id: doc.id });
        return doc;
    }

    updateShader(id: string, patch: Partial<Pick<ShaderDoc, 'code' | 'lighting' | 'kind' | 'name'>>) {
        const doc = this.store.doc.shaders.find((s) => s.id === id);
        if (!doc) return;
        if (Object.entries(patch).every(([k, v]) => (doc as any)[k] === v)) return;
        this.store.commit(patch.code !== undefined ? 'Edit Shader' : 'Shader Settings', (d) => {
            const s = d.shaders.find((x) => x.id === id);
            if (!s) return;
            if (patch.name !== undefined) {
                const others = d.shaders.filter((x) => x.id !== id).map((x) => x.name);
                s.name = this.uniqueFileName(patch.name, '.wgsl', others);
            }
            if (patch.code !== undefined) s.code = patch.code;
            if (patch.lighting) s.lighting = patch.lighting;
            if (patch.kind && patch.kind !== s.kind) {
                s.kind = patch.kind;
                // A shader cannot be both; drop the uses of the other kind.
                dropRefs(d, 'shader', id, s.kind === 'post' ? 'object' : 'post');
            }
        });
    }

    async deleteShader(id: string, confirm = true) {
        const doc = this.store.doc.shaders.find((s) => s.id === id);
        if (!doc) return;
        if (confirm && uses(this.store.doc, 'shader', id) && !(await confirmDialog('Delete shader', `${doc.name} is in use. Materials using it go back to Lit. Delete it anyway?`, 'Delete', true))) return;
        this.store.commit('Delete Shader', (d) => {
            d.shaders = d.shaders.filter((s) => s.id !== id);
            dropRefs(d, 'shader', id);
        });
    }

    /** Applies a material preset (see core/materialPresets.ts) to the mesh nodes in `ids`. */
    applyMaterialPreset(ids: string[], presetId: string) {
        const preset = MATERIAL_PRESETS.find((p) => p.id === presetId);
        const targets = ids.filter((id) => this.store.node(id)?.mesh);
        if (!preset || !targets.length) {
            if (!targets.length) toast('Select a mesh object first.', 'info');
            return;
        }
        this.store.commit(`Material Preset: ${preset.label}`, (d) => {
            for (const n of d.nodes) if (targets.includes(n.id) && n.mesh) preset.apply(n.mesh.material);
        }, { nodes: targets });
    }

    /** Renders the mesh nodes in `ids` with a material shader (null goes back to Lit). */
    assignShader(ids: string[], shaderId: string | null) {
        const targets = ids.filter((id) => this.store.node(id)?.mesh);
        if (!targets.length) {
            toast('Select a mesh object first.', 'info');
            return;
        }
        this.store.commit(shaderId ? 'Assign Shader' : 'Remove Shader', (d) => {
            for (const n of d.nodes) {
                if (!targets.includes(n.id) || !n.mesh) continue;
                if (shaderId) {
                    n.mesh.material.type = 'shader';
                    n.mesh.material.shader = shaderId;
                    n.mesh.material.params ??= {};
                } else {
                    n.mesh.material.type = 'lit';
                    n.mesh.material.shader = null;
                }
            }
        }, { nodes: targets });
    }

    // --------------------------------------------------------- render graph

    /** Switches a built-in render pass; refused (with a message) when the graph would break. */
    setPassEnabled(name: string, enabled: boolean): string {
        const err = this.graph.canSet(name, enabled);
        if (err) {
            toast(err, 'error');
            return err;
        }
        this.store.commit(enabled ? `Enable ${name}` : `Disable ${name}`, (d) => {
            const set = new Set(d.renderGraph.disabled);
            if (enabled) set.delete(name);
            else set.add(name);
            d.renderGraph.disabled = Array.from(set);
        }, { env: true });
        this.graph.apply(true);
        return '';
    }

    addPostEffect(shaderId: string): string | null {
        const shader = this.store.doc.shaders.find((s) => s.id === shaderId);
        if (!shader || shader.kind !== 'post') {
            toast('Pick a post shader.', 'error');
            return null;
        }
        const id = uid('p');
        this.store.commit('Add Post Effect', (d) => {
            d.renderGraph.posts.push({ id, shader: shaderId, enabled: true, params: {} });
        }, { env: true });
        this.graph.apply(true);
        return id;
    }

    removePostEffect(postId: string) {
        this.store.commit('Remove Post Effect', (d) => {
            d.renderGraph.posts = d.renderGraph.posts.filter((p) => p.id !== postId);
        }, { env: true });
        this.graph.apply(true);
    }

    movePostEffect(postId: string, delta: number) {
        const posts = this.store.doc.renderGraph.posts;
        const i = posts.findIndex((p) => p.id === postId);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= posts.length) return;
        this.store.commit('Reorder Post Effects', (d) => {
            const list = d.renderGraph.posts;
            const [p] = list.splice(i, 1);
            list.splice(j, 0, p);
        }, { env: true });
        this.graph.apply(true);
    }

    updatePostEffect(postId: string, patch: { enabled?: boolean; params?: Record<string, ParamValue> }, label = 'Post Effect') {
        this.store.commit(label, (d) => {
            const p = d.renderGraph.posts.find((x) => x.id === postId);
            if (!p) return;
            if (patch.enabled !== undefined) p.enabled = patch.enabled;
            if (patch.params) p.params = { ...p.params, ...patch.params };
        }, { env: true });
        this.graph.apply();
    }

    // ---------------------------------------------------------- lighting

    /**
     * Sizes the GI probe grid to the scene's meshes and models: probes at
     * least two per axis, about 200 in all, within the engine's limits.
     */
    fitGIToScene() {
        let min: Vec3 | null = null;
        let max: Vec3 | null = null;
        for (const n of this.store.doc.nodes) {
            if (!n.mesh && !n.model) continue;
            const box = this.picker.bounds(n.id, false);
            if (!box) continue;
            min = min ? [Math.min(min[0], box.min[0]), Math.min(min[1], box.min[1]), Math.min(min[2], box.min[2])] : [...box.min];
            max = max ? [Math.max(max[0], box.max[0]), Math.max(max[1], box.max[1]), Math.max(max[2], box.max[2])] : [...box.max];
        }
        if (!min || !max) {
            toast('There are no meshes or models to fit the probes to.', 'info');
            return;
        }
        const size = [0, 1, 2].map((i) => Math.max(0.5, max![i] - min![i]));
        const center = tidy3([0, 1, 2].map((i) => (min![i] + max![i]) / 2) as Vec3, 2);
        let spacing = Math.max(0.1, Math.cbrt((size[0] * size[1] * size[2]) / 200));
        let counts: Vec3 = [2, 2, 2];
        for (let i = 0; i < 60; i++) {
            counts = size.map((s) => Math.max(2, Math.ceil(s / spacing) + 1)) as Vec3;
            if (giGridFits(counts[0], counts[1], counts[2]) && counts.every((c) => c <= GI_MAX_PER_AXIS)) break;
            spacing *= 1.1;
        }
        spacing = Math.round(spacing * 100) / 100;
        this.store.commit('Fit GI to Scene', (d) => {
            d.environment.gi = { ...d.environment.gi, enable: true, center, counts: clampGIGrid(counts), spacing };
        }, { env: true });
        toast(`GI probes: ${counts.join(' x ')}, ${spacing} apart.`, 'success');
    }

    // -------------------------------------------------------- model editing

    /**
     * Changes a material slot of imported models. `patch` fields set to
     * undefined are reset to the file's value; null clears the whole slot.
     */
    setModelMaterial(ids: string[], slot: string, patch: Partial<MaterialOverride> | null, label = 'Edit Model Material') {
        const targets = ids.filter((id) => this.store.node(id)?.model);
        if (!targets.length) return;
        this.store.commit(label, (d) => {
            for (const n of d.nodes) {
                if (!targets.includes(n.id) || !n.model) continue;
                mergeOverride(n.model, 'materials', slot, patch);
            }
        }, { nodes: targets });
    }

    /** Changes a mesh part of imported models; null clears the part's overrides. */
    setModelPart(ids: string[], path: string, patch: Partial<PartOverride> | null, label = 'Edit Model Part') {
        const targets = ids.filter((id) => this.store.node(id)?.model);
        if (!targets.length) return;
        this.store.commit(label, (d) => {
            for (const n of d.nodes) {
                if (!targets.includes(n.id) || !n.model) continue;
                mergeOverride(n.model, 'parts', path, patch);
            }
        }, { nodes: targets });
    }

    resetModelOverrides(ids: string[]) {
        const targets = ids.filter((id) => this.store.node(id)?.model);
        this.store.commit('Reset Model Overrides', (d) => {
            for (const n of d.nodes) {
                if (!targets.includes(n.id) || !n.model) continue;
                delete n.model.materials;
                delete n.model.parts;
            }
        }, { nodes: targets });
    }

    /** Copies a model node's overrides to every other instance of the same model. */
    copyOverridesToInstances(id: string) {
        const src = this.store.node(id)?.model;
        if (!src) return;
        const others = this.store.doc.nodes.filter((n) => n.id !== id && n.model?.asset === src.asset).map((n) => n.id);
        if (!others.length) {
            toast('There are no other instances of this model.', 'info');
            return;
        }
        this.store.commit('Apply Overrides to Instances', (d) => {
            for (const n of d.nodes) {
                if (!others.includes(n.id) || !n.model) continue;
                n.model.materials = src.materials ? JSON.parse(JSON.stringify(src.materials)) : undefined;
                n.model.parts = src.parts ? JSON.parse(JSON.stringify(src.parts)) : undefined;
                if (!n.model.materials) delete n.model.materials;
                if (!n.model.parts) delete n.model.parts;
            }
        }, { nodes: others });
        toast(`Applied to ${others.length} other instance(s).`, 'success');
    }

    focusPart(node: string, path: string | null) {
        this.focusedPart = path ? { node, path } : null;
        this.emit('focus-part', { node, path });
    }

    // ------------------------------------------------------------- behavior

    /**
     * Applies a batch of behavior edit operations (core/behavior/ops.ts) as
     * one undo step. The editor UI and the assistant both edit trees,
     * schemas, agents and memory only through this. Edits are locked while
     * playing: Stop puts the document back, so they would be lost.
     */
    applyBehaviorOps(ops: unknown, opts: { mode?: OpsMode; label?: string } = {}): OpsResult {
        if (this.player.state !== 'stopped') {
            return {
                ok: false,
                errors: [{ op: -1, name: 'play', message: 'Behavior trees cannot be edited while playing (Stop puts the scene back, which would undo the edits). Stop Play first.' }],
                issues: [],
                added: [],
                created: [],
                touched: { trees: [], schemas: [], objects: [], memory: false, models: false },
                changes: null,
                label: '',
            };
        }
        const result = applyBehaviorOps(this.store.doc, ops, opts.mode ?? 'lenient');
        const changes = result.changes;
        if (result.ok && changes) {
            const agents = [...changes.agents.keys()];
            this.store.commit(`Behavior: ${opts.label ?? result.label}`, (doc) => writeBehaviorChanges(doc, changes), { behavior: true, agents, renamed: changes.renamed });
        }
        return result;
    }

    /** Opens a tree or schema in the Behavior tab. */
    showBehavior(target: { tree?: string; schema?: string; node?: string } = {}) {
        this.emit('show-behavior', target);
    }

    /**
     * Creates a behavior tree whose default branch waits (a blackboard schema
     * too when the scene has none) and makes `assign` objects run it.
     * Returns the id of the tree, or null when it was refused.
     */
    newBehaviorTree(opts: { schema?: string; assign?: string[] } = {}): string | null {
        const doc = this.store.doc;
        const free = (list: { name: string }[], base: string) => {
            const taken = new Set(list.map((x) => x.name.toLowerCase()));
            let n = list.length + 1;
            while (taken.has(`${base} ${n}`.toLowerCase())) n++;
            return `${base} ${n}`;
        };
        const name = free(doc.behaviors, 'Behavior');
        const ops: unknown[] = [];
        let schema = opts.schema ?? doc.blackboards[0]?.id;
        if (!schema) {
            schema = free(doc.blackboards, 'Blackboard');
            ops.push({ op: 'create_schema', name: schema });
        }
        ops.push({ op: 'create_tree', name, schema, root: { id: 'root', type: 'selector', children: [{ id: 'idle', type: 'wait', seconds: 1, note: 'Default behavior: replace me.' }] } });
        for (const id of opts.assign ?? []) ops.push({ op: 'set_agent', object: id, tree: name, enabled: true });
        const r = this.applyBehaviorOps(ops, { label: 'New Behavior Tree' });
        if (!r.ok) {
            const e = r.errors[0];
            toast(e ? `${e.node ? `${e.node}: ` : ''}${e.message}` : 'Could not create the tree.', 'error', 6000);
            return null;
        }
        return r.created.find((c) => c.kind === 'tree')?.id ?? null;
    }

    // ----------------------------------------------------------------- play

    togglePlay() {
        if (this.player.state === 'stopped') this.play();
        else this.stopPlay();
    }

    /** Starts Play; `asked` skips the question about paused scripts (already answered). */
    play(asked = false) {
        if (this.player.state === 'stopped') {
            // The game needs the whole scene and the keys: leave these view modes first.
            if (this.isolated) {
                toast('Finish editing the prefab first (Apply or Discard).', 'info');
                return;
            }
            this.setView('scene');
        }
        if (!asked && this.player.state === 'stopped' && !this.compiler.trusted && this.usesScripts()) {
            void this.confirmScripts().then((run) => {
                if (run) this.play(true);
            });
            return;
        }
        if (this.player.state === 'stopped') this.emit('flush-edits', undefined);
        if (this.store.inTransaction && this.player.state === 'stopped') {
            // Finish open edits (a drag in progress) before taking the checkpoint.
            this.viewport?.cancelInteraction();
        }
        this.player.play();
        this.viewport?.overlay.focus({ preventScroll: true });
    }

    pausePlay() {
        if (this.player.state === 'paused') this.player.play();
        else this.player.pause();
    }

    stopPlay() {
        this.player.stop();
    }

    /** True when an enabled script is attached to an object. */
    private usesScripts(): boolean {
        return this.store.doc.nodes.some((n) => n.scripts?.some((r) => r.enabled));
    }

    /** Asks before running the paused scripts of an opened file; false cancels Play. */
    private async confirmScripts(): Promise<boolean> {
        const count = this.store.doc.scripts.length;
        const choice = await ask(
            'Run the paused scripts?',
            `This scene has ${count} script${count === 1 ? '' : 's'} from an opened file or an earlier version. Scripts run JavaScript in this page and can read anything the editor keeps here, including your OpenRouter key. Only enable scripts you trust; you can read them in the code editor first.`,
            [
                { label: 'Cancel', value: 'cancel' },
                { label: 'Play Without Scripts', value: 'without' },
                { label: 'Enable Scripts and Play', value: 'enable', primary: true },
            ],
        );
        if (choice === 'enable') this.enableScripts();
        return choice === 'enable' || choice === 'without';
    }

    /** Lets the paused scripts of an opened file run. */
    enableScripts() {
        if (this.compiler.trusted) return;
        this.compiler.setTrusted(true);
        const failed = this.store.doc.scripts.filter((s) => this.compiler.get(s.id)?.error).length;
        toast(failed ? `Scripts enabled. ${failed} of them have errors.` : 'Scripts enabled.', failed ? 'error' : 'success');
    }

    /** Switches what the viewport shows (not while playing); the walk camera and the reference room follow. */
    setView(view: EditorView) {
        if (view === this.view) return;
        if (view !== 'scene' && this.player.state !== 'stopped') {
            toast('Stop Play mode first.', 'info');
            return;
        }
        this.view = view;
        this.emit('view', view);
    }

    /** Why the view does not show the scene now, or '' when it does (shots are captured from it). */
    viewBlock(): string {
        if (this.isolated) return 'The view shows only the prefab being edited. Finish the edit first (Apply or Discard).';
        if (this.view === 'room') return 'The view shows the reference room. Leave it first.';
        if (this.view === 'walk') return 'The view follows the walk camera. Stop walking first.';
        return '';
    }

    /** Opens the AI panel with a prompt. */
    askAI(text: string, send = false) {
        this.emit('ai-prompt', { text, send });
    }

    // ---------------------------------------------------------------- files

    /** Asks before the current scene is replaced; true when nothing would be lost or the user agrees. */
    private async confirmReplace(title: string, ok: string, what = 'Discard the current scene?'): Promise<boolean> {
        const d = this.store.doc;
        const empty = !d.nodes.length && !d.scripts.length && !d.shaders.length && !d.design.brief.text.trim() && !d.design.concepts.length && !d.design.areas.length;
        return empty || confirmDialog(title, `${what} It is only kept in this browser unless you saved a file.`, ok, true);
    }

    async newScene(kind: 'empty' | 'showcase' | 'guard' = 'empty') {
        if (!(await this.confirmReplace('New scene', 'Discard'))) return;
        const doc = kind === 'showcase' ? exampleShowcase() : kind === 'guard' ? exampleGuard() : emptyScene();
        const camera = kind === 'showcase' ? { ...defaultCamera(), distance: 16, pitch: 22, target: [0, 1, 0] as Vec3 } : kind === 'guard' ? { ...defaultCamera(), distance: 18, pitch: 38, target: [0, 0.5, 0] as Vec3 } : defaultCamera();
        this.loadDoc(doc, camera);
        if (kind === 'guard') this.showBehavior({ tree: doc.behaviors[0]?.id });
    }

    /**
     * Replaces the scene. Scripts of an untrusted document (an opened file)
     * stay paused until the user enables them; see ScriptCompiler.
     */
    loadDoc(doc: SceneDoc, camera = defaultCamera(), trusted = true) {
        // Stop first: Stop restores the scene Play started from.
        if (this.player.state !== 'stopped') this.player.stop();
        // Pause before loading so no untrusted code is evaluated, and trust
        // only once the previous document's scripts are gone.
        this.compiler.setTrusted(false);
        this.store.load({ ...doc, assets: keptAssets(doc) }, camera);
        this.compiler.setTrusted(trusted || !this.store.doc.scripts.length);
        collectGarbage(this.store.doc);
    }

    async saveSceneFile() {
        try {
            const blob = await exportSceneFile(this.store);
            download(blob, fileNameFor(this.store.doc));
            this.autosave.flush();
            toast(`Saved ${fileNameFor(this.store.doc)}`, 'success');
            this.emit('saved', 'scene');
        } catch (e: any) {
            console.error(e);
            toast(`Save failed: ${e?.message || e}`, 'error');
        }
    }

    /**
     * Downloads the whole project as one .zip: the scene with its design
     * section and every file, planning images and snapshots included.
     */
    async saveProjectFile(): Promise<boolean> {
        const name = projectFileNameFor(this.store.doc);
        try {
            const { blob, missing } = await exportProject(this.store);
            download(blob, name);
            this.autosave.flush();
            if (missing.length) {
                toast(`Saved ${name}. ${missing.length} file(s) are not stored in this browser and were left out: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''}`, 'info', 8000);
            } else toast(`Saved ${name}`, 'success');
            this.emit('saved', 'project');
            return true;
        } catch (e: any) {
            console.error(e);
            toast(`Saving the project failed: ${e?.message || e}`, 'error');
            return false;
        }
    }

    async openSceneFile() {
        const [file] = await pickFiles('.json,.zip,application/json,application/zip');
        if (file) await this.openSceneFromFile(file);
    }

    private async openSceneFromFile(file: File) {
        if (!(await this.confirmReplace('Open scene', 'Open', `Replace the current scene with ${file.name}?`))) return;
        try {
            await this.openBlob(file, file.name);
        } catch (e: any) {
            toast(e?.message || String(e), 'error');
        }
    }

    /**
     * Opens a scene (.json) or project (.zip) from a link, as File > Open
     * opens a file: its scripts stay paused until enabled. The site must let
     * other sites read the file (GitHub raw links, GitHub Pages and most file
     * hosts do). True when it opened.
     */
    async openUrl(url: string): Promise<boolean> {
        const abs = new URL(url, document.baseURI).href;
        const name = urlFileName(abs);
        if (!(await this.confirmReplace('Open link', 'Open', `Replace the current scene with ${name}?`))) return false;
        try {
            const blob = await downloadFile(abs);
            const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
            // A zip starts with PK, whatever the link is called.
            await this.openBlob(blob, head[0] === 0x50 && head[1] === 0x4b && !/\.zip$/i.test(name) ? name + '.zip' : name);
            return true;
        } catch (e: any) {
            toast(e?.message || String(e), 'error');
            return false;
        }
    }

    private async openBlob(blob: Blob, name: string) {
        const { doc, camera } = name.toLowerCase().endsWith('.zip') ? await importProject(blob) : await importSceneFile(await blob.text());
        this.loadDoc(doc, camera ?? defaultCamera(), false);
        const scripts = this.store.doc.scripts.length;
        if (scripts) toast(`Opened ${name}. Its ${scripts} script${scripts === 1 ? ' is' : 's are'} paused until you enable ${scripts === 1 ? 'it' : 'them'}.`, 'info', 6000);
        else toast(`Opened ${name}`, 'success');
    }

    async importModelDialog() {
        const files = await pickFiles('.glb,.gltf', true);
        if (files.length) await this.importFiles(files);
    }

    async importTextureDialog() {
        const files = await pickFiles('image/*,.ktx2', true);
        if (files.length) await this.importFiles(files);
    }

    async importSoundDialog() {
        const files = await pickFiles('audio/*,.mp3,.ogg,.opus,.wav,.m4a,.aac,.flac', true);
        if (files.length) await this.importFiles(files);
    }

    /**
     * Sets how a texture or model asset is compressed for games (mode,
     * largest texture size); its copies are made again for the new options.
     */
    setTextureCompression(assetId: string, patch: Partial<TextureCompression>) {
        const meta = this.store.doc.assets.find((a) => a.id === assetId);
        if (!meta || (meta.kind !== 'texture' && meta.kind !== 'model')) return;
        const next: TextureCompression = { ...meta.compress, ...patch };
        if (next.mode === 'auto' || !next.mode) delete next.mode;
        if (!next.maxSize) delete next.maxSize;
        // On unless turned off.
        if (next.quantize !== false) delete next.quantize;
        if (next.flat !== false) delete next.flat;
        if (JSON.stringify(next) === JSON.stringify(meta.compress ?? {})) return;
        // The copies are not part of the document, so only the assets change.
        this.store.commit('Texture Compression', (doc) => {
            const a = doc.assets.find((x) => x.id === assetId);
            if (!a) return;
            if (Object.keys(next).length) a.compress = next;
            else delete a.compress;
        }, { design: true });
    }

    // ----------------------------------------------------------------- view

    frameSelection() {
        const ids = this.store.selection;
        if (ids.length) this.viewport.frameNodes(ids);
        else this.viewport.frameAll();
    }

    setTool(tool: Tool) {
        this.store.setPrefs({ tool });
    }

    toggleSpace() {
        this.store.setPrefs({ space: this.store.prefs.space === 'world' ? 'local' : 'world' });
    }

    /** Selects what a click could: shown objects, prefab parts as their instance, and only the prefab being edited while one is. */
    selectAll() {
        const ids = new Set<string>();
        for (const n of this.store.doc.nodes) {
            if (!this.sync.entries.get(n.id)?.visible) continue;
            if (this.isolated && n.id !== this.isolated && !this.store.isAncestor(this.isolated, n.id)) continue;
            ids.add(this.selectable(n.id));
        }
        this.store.select([...ids]);
    }
}

function round(v: number): number {
    return Math.round(v * 100) / 100;
}

/** The file of a list that a URI in a .gltf names (by its file name). */
function fileNamed(files: File[], uri: string): File | undefined {
    let name = uri;
    try {
        name = decodeURIComponent(uri);
    } catch { /* as written */ }
    name = name.split(/[\\/]/).pop()!.toLowerCase();
    return files.find((f) => f.name.toLowerCase() === name);
}

/** Merges an override patch into ModelDoc.materials / .parts, dropping empty entries. */
function mergeOverride(model: NonNullable<NodeDoc['model']>, field: 'materials' | 'parts', key: string, patch: object | null) {
    const map: Record<string, any> = { ...(model[field] ?? {}) };
    if (patch === null) delete map[key];
    else {
        const next = { ...(map[key] ?? {}) };
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete next[k];
            else next[k] = Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? { ...v } : v;
        }
        if (Object.keys(next).length) map[key] = next;
        else delete map[key];
    }
    if (Object.keys(map).length) (model as any)[field] = map;
    else delete model[field];
}

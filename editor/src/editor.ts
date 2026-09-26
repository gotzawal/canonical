import { kindOf, putAsset } from './core/assets';
import { clampGIGrid, GI_MAX_PER_AXIS, giGridFits } from './core/giLimits';
import { MATERIAL_PRESETS } from './core/materialPresets';
import {
    defaultCamera, defaultMaterial, emptyScene, makeCameraNode, makeLightNode, makeMeshNode, makeNode, newScene, uid,
} from './core/defaults';
import { Emitter } from './core/events';
import { DEG, decompose, eulerFromQuat, invert, len, mat4, mul, sub, tidy, tidy3, transformPoint } from './core/math';
import {
    AutoSaver, collectGarbage, download, exportSceneFile, fileNameFor, importSceneFile, pickFiles, usedAssetIds,
} from './core/persistence';
import type { Store, Tool } from './core/store';
import { className, SCRIPT_TEMPLATES, SHADER_TEMPLATES } from './core/templates';
import type {
    GeometryType, LightType, MaterialOverride, NodeDoc, ParamValue, PartOverride, SceneDoc, ScriptDoc, ShaderDoc,
    ShaderKind, Vec3,
} from './core/types';
import type { Picker } from './engine/picking';
import type { RenderGraphController } from './engine/renderGraph';
import type { Runtime } from './engine/runtime';
import type { ShaderManager } from './engine/shaders';
import type { SceneSync } from './engine/sync';
import type { ScriptCompiler } from './play/compiler';
import type { Player } from './play/player';
import { confirmDialog, dialog, toast } from './ui/overlays';
import type { CameraController } from './viewport/cameraController';
import type { Viewport } from './viewport/viewport';
import { exampleShowcase } from './examples';

export interface EditorServices {
    shaders: ShaderManager;
    compiler: ScriptCompiler;
    player: Player;
    graph: RenderGraphController;
}

interface EditorEvents {
    /** Open a script or shader in the code dock. */
    'open-code': { kind: 'script' | 'shader'; id: string };
    /** A model part was picked in the viewport. */
    'focus-part': { node: string; path: string | null };
    /** Show the AI panel, optionally with a prompt to send or prefill. */
    'ai-prompt': { text: string; send: boolean };
    /** Show the render graph tab of the dock. */
    'show-graph': void;
}

/** Editor commands shared by menus, shortcuts, panels and the AI tools. */
export class Editor extends Emitter<EditorEvents> {
    viewport!: Viewport;
    readonly shaders: ShaderManager;
    readonly compiler: ScriptCompiler;
    readonly player: Player;
    readonly graph: RenderGraphController;
    /** Model part picked last, shown highlighted in the inspector. */
    focusedPart: { node: string; path: string } | null = null;

    constructor(
        readonly store: Store,
        readonly runtime: Runtime,
        readonly sync: SceneSync,
        readonly picker: Picker,
        readonly camera: CameraController,
        readonly autosave: AutoSaver,
        services: EditorServices,
    ) {
        super();
        this.shaders = services.shaders;
        this.compiler = services.compiler;
        this.player = services.player;
        this.graph = services.graph;
    }

    // ------------------------------------------------------------ creation

    private insert(nodes: NodeDoc[], label: string, select = true) {
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
        this.store.begin('Group');
        try {
            this.store.update((doc) => {
                const idx = doc.nodes.findIndex((n) => n.id === roots[0]);
                doc.nodes.splice(Math.max(0, idx), 0, group);
            });
            this.moveNodes(roots, group.id, null, 'Group');
        } finally {
            this.store.end();
        }
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
        }, { nodes: ids });
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
                const scaleY = parentWorld ? Math.hypot(parentWorld[4], parentWorld[5], parentWorld[6]) || 1 : 1;
                n.position = tidy3([n.position[0], n.position[1] + m.dy / scaleY, n.position[2]]);
            }
        }, { nodes: moves.map((m) => m.id) });
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
            const moved: NodeDoc[] = [];
            for (const id of moving) {
                const n = doc.nodes.find((x) => x.id === id);
                if (!n) continue;
                const t = transforms.get(id);
                if (t) Object.assign(n, t);
                n.parent = parent;
                moved.push(n);
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
                if (lower.endsWith('.json')) {
                    await this.openSceneFromFile(file);
                    continue;
                }
                const kind = kindOf(file);
                if (kind === 'model') await this.importModel(file, at);
                else if (kind === 'texture') await this.importTexture(file);
                else toast(`Unsupported file: ${file.name}`, 'error');
            } catch (e: any) {
                console.error(e);
                toast(`Import failed: ${e?.message || e}`, 'error');
            }
        }
    }

    async importModel(file: File, at?: Vec3) {
        if (file.name.toLowerCase().endsWith('.gltf')) {
            const text = await file.text();
            if (/"uri"\s*:\s*"(?!data:)/.test(text)) {
                toast('This .gltf references external files. Use a .glb or an embedded .gltf.', 'error');
                return;
            }
        }
        const meta = await putAsset(file, file.name, 'model');
        this.store.commit('Import Model', (doc) => {
            doc.assets.push(meta);
        });
        this.addModel(meta.id, at, true);
        toast(`Imported ${file.name}`, 'success');
    }

    addModel(assetId: string, at?: Vec3, frame = false) {
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
        }, { nodes: [id] });
    }

    async importTexture(file: File) {
        const meta = await putAsset(file, file.name, 'texture');
        const targets = this.store.selection.filter((id) => this.store.node(id)?.mesh);
        this.store.commit('Import Texture', (doc) => {
            doc.assets.push(meta);
            for (const n of doc.nodes) if (targets.includes(n.id) && n.mesh) n.mesh.material.map = meta.id;
        });
        toast(targets.length ? `Applied ${file.name} to ${targets.length} object(s)` : `Imported ${file.name}. Assign it from the Material section.`, 'success');
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
        }, { nodes: targets });
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
        const users = this.store.doc.nodes.filter((n) => n.scripts?.some((r) => r.script === id));
        if (confirm && users.length && !(await confirmDialog('Delete script', `${doc.name} is attached to ${users.length} object(s). Delete it anyway?`, 'Delete', true))) return;
        this.store.commit('Delete Script', (d) => {
            d.scripts = d.scripts.filter((s) => s.id !== id);
            for (const n of d.nodes) {
                if (!n.scripts) continue;
                n.scripts = n.scripts.filter((r) => r.script !== id);
                if (!n.scripts.length) delete n.scripts;
            }
        });
    }

    attachScript(ids: string[], scriptId: string, props: Record<string, ParamValue> = {}) {
        const targets = ids.filter((id) => this.store.node(id));
        if (!targets.length || !this.store.doc.scripts.some((s) => s.id === scriptId)) return;
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
                if (s.kind === 'post') this.unuseMaterialShader(d, id);
                else d.renderGraph.posts = d.renderGraph.posts.filter((p) => p.shader !== id);
            }
        });
    }

    private unuseMaterialShader(d: SceneDoc, id: string) {
        for (const n of d.nodes) {
            if (n.mesh?.material.shader === id) {
                n.mesh.material.type = 'lit';
                n.mesh.material.shader = null;
                delete n.mesh.material.params;
            }
            for (const o of Object.values(n.model?.materials ?? {})) {
                if (o.shader === id) {
                    delete o.shader;
                    delete o.params;
                }
            }
        }
    }

    async deleteShader(id: string, confirm = true) {
        const doc = this.store.doc.shaders.find((s) => s.id === id);
        if (!doc) return;
        const used =
            this.store.doc.renderGraph.posts.some((p) => p.shader === id) ||
            this.store.doc.nodes.some((n) => n.mesh?.material.shader === id || Object.values(n.model?.materials ?? {}).some((o) => o.shader === id));
        if (confirm && used && !(await confirmDialog('Delete shader', `${doc.name} is in use. Materials using it go back to Lit. Delete it anyway?`, 'Delete', true))) return;
        this.store.commit('Delete Shader', (d) => {
            d.shaders = d.shaders.filter((s) => s.id !== id);
            d.renderGraph.posts = d.renderGraph.posts.filter((p) => p.shader !== id);
            this.unuseMaterialShader(d, id);
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

    // ----------------------------------------------------------------- play

    togglePlay() {
        if (this.player.state === 'stopped') this.play();
        else this.stopPlay();
    }

    /** Called before Play starts, e.g. to apply unsaved code. */
    beforePlay: () => void = () => {};

    /** Starts Play; `asked` skips the question about paused scripts (already answered). */
    play(asked = false) {
        if (!asked && this.player.state === 'stopped' && !this.compiler.trusted && this.usesScripts()) {
            void this.confirmScripts().then((run) => {
                if (run) this.play(true);
            });
            return;
        }
        if (this.player.state === 'stopped') this.beforePlay();
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
        const choice = await dialog(
            'Run scripts from this file?',
            `This scene was opened from a file and has ${count} script${count === 1 ? '' : 's'}. Scripts run JavaScript in this page and can read anything the editor keeps here, including your OpenRouter key. Only enable scripts you trust; you can read them in the code editor first.`,
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

    /** Opens the AI panel with a prompt. */
    askAI(text: string, send = false) {
        this.emit('ai-prompt', { text, send });
    }

    // ---------------------------------------------------------------- files

    async newScene(kind: 'default' | 'empty' | 'showcase' = 'default') {
        if (this.store.doc.nodes.length && !(await confirmDialog('New scene', 'Discard the current scene? It is only kept in this browser unless you saved a file.', 'Discard', true))) {
            return;
        }
        const doc = kind === 'empty' ? emptyScene() : kind === 'showcase' ? exampleShowcase() : newScene();
        this.loadDoc(doc, kind === 'showcase' ? { ...defaultCamera(), distance: 16, pitch: 22, target: [0, 1, 0] } : defaultCamera());
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
        this.store.load(doc, camera);
        this.compiler.setTrusted(trusted || !this.store.doc.scripts.length);
        collectGarbage(this.store.doc);
    }

    async saveSceneFile() {
        try {
            const blob = await exportSceneFile(this.store);
            download(blob, fileNameFor(this.store.doc));
            this.autosave.flush();
            toast(`Saved ${fileNameFor(this.store.doc)}`, 'success');
        } catch (e: any) {
            console.error(e);
            toast(`Save failed: ${e?.message || e}`, 'error');
        }
    }

    async openSceneFile() {
        const [file] = await pickFiles('.json,application/json');
        if (file) await this.openSceneFromFile(file);
    }

    private async openSceneFromFile(file: File) {
        try {
            const { doc, camera } = await importSceneFile(await file.text());
            this.loadDoc(doc, camera ?? defaultCamera(), false);
            const scripts = this.store.doc.scripts.length;
            if (scripts) toast(`Opened ${file.name}. Its ${scripts} script${scripts === 1 ? ' is' : 's are'} paused until you enable ${scripts === 1 ? 'it' : 'them'}.`, 'info', 6000);
            else toast(`Opened ${file.name}`, 'success');
        } catch (e: any) {
            toast(e?.message || String(e), 'error');
        }
    }

    async importModelDialog() {
        const files = await pickFiles('.glb,.gltf', true);
        if (files.length) await this.importFiles(files);
    }

    async importTextureDialog() {
        const files = await pickFiles('image/*', true);
        if (files.length) await this.importFiles(files);
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

    selectAll() {
        this.store.select(this.store.doc.nodes.map((n) => n.id));
    }
}

function round(v: number): number {
    return Math.round(v * 100) / 100;
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

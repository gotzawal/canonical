import { kindOf, putAsset } from './core/assets';
import { defaultCamera, emptyScene, makeLightNode, makeMeshNode, makeNode, newScene, uid } from './core/defaults';
import { decompose, eulerFromQuat, invert, mat4, mul, tidy3, transformPoint } from './core/math';
import {
    AutoSaver, collectGarbage, download, exportSceneFile, fileNameFor, importSceneFile, pickFiles,
} from './core/persistence';
import type { Store, Tool } from './core/store';
import type { GeometryType, LightType, NodeDoc, SceneDoc, Vec3 } from './core/types';
import type { Picker } from './engine/picking';
import type { Runtime } from './engine/runtime';
import type { SceneSync } from './engine/sync';
import { confirmDialog, toast } from './ui/overlays';
import type { CameraController } from './viewport/cameraController';
import type { Viewport } from './viewport/viewport';
import { exampleShowcase } from './examples';

/** Editor commands shared by menus, shortcuts and panels. */
export class Editor {
    viewport!: Viewport;

    constructor(
        readonly store: Store,
        readonly runtime: Runtime,
        readonly sync: SceneSync,
        readonly picker: Picker,
        readonly camera: CameraController,
        readonly autosave: AutoSaver,
    ) {}

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
        const used = this.store.doc.nodes.some((n) => n.model?.asset === assetId || n.mesh?.material.map === assetId);
        if (used) {
            toast('This asset is used in the scene. Remove those objects first.', 'error');
            return;
        }
        this.store.commit('Remove Asset', (doc) => {
            doc.assets = doc.assets.filter((a) => a.id !== assetId);
        });
    }

    // ---------------------------------------------------------------- files

    async newScene(kind: 'default' | 'empty' | 'showcase' = 'default') {
        if (this.store.doc.nodes.length && !(await confirmDialog('New scene', 'Discard the current scene? It is only kept in this browser unless you saved a file.', 'Discard', true))) {
            return;
        }
        const doc = kind === 'empty' ? emptyScene() : kind === 'showcase' ? exampleShowcase() : newScene();
        this.loadDoc(doc, kind === 'showcase' ? { ...defaultCamera(), distance: 16, pitch: 22, target: [0, 1, 0] } : defaultCamera());
    }

    loadDoc(doc: SceneDoc, camera = defaultCamera()) {
        this.store.load(doc, camera);
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
            this.loadDoc(doc, camera ?? defaultCamera());
            toast(`Opened ${file.name}`, 'success');
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

import {
    BoxGeometry, CylinderGeometry, DirectLight, GeometryBase, LightBase, LitMaterial, Material, MeshRenderer,
    Object3D, PlaneGeometry, PointLight, RenderNode, SphereGeometry, SpotLight, Texture, TorusGeometry, UnLitMaterial,
} from '@orillusion/core';
import { Emitter } from '../core/events';
import { getAssetUrl } from '../core/assets';
import type { ChangeHint, Store } from '../core/store';
import type { GeometryDoc, LightDoc, LightType, MaterialDoc, MeshDoc, ModelDoc, NodeDoc } from '../core/types';
import { hexToColor } from './color';
import type { Runtime } from './runtime';

type AnyMaterial = LitMaterial | UnLitMaterial;

interface ModelState {
    asset: string;
    token: number;
    obj: Object3D | null;
    status: 'loading' | 'ready' | 'error';
    error?: string;
}

/** Engine-side state of one document node. */
export interface Entry {
    id: string;
    obj: Object3D;
    parent: string | null;
    visible: boolean;
    position?: string;
    rotation?: string;
    scale?: string;
    mesh: MeshRenderer | null;
    geometry: GeometryBase | null;
    geometryKey: string;
    material: AnyMaterial | null;
    materialType: MaterialDoc['type'] | null;
    materialKey: string;
    defaultBaseMap: Texture | null;
    mapAsset: string | null;
    alphaMode: string;
    light: LightBase | null;
    lightType: LightType | null;
    lightKey: string;
    model: ModelState | null;
}

interface SyncEvents {
    /** An async model load finished (successfully or not) for a node. */
    model: string;
}

const LIGHT_CLASSES: Record<LightType, new () => LightBase> = {
    directional: DirectLight,
    point: PointLight,
    spot: SpotLight,
};

let loadToken = 0;

/**
 * Keeps the engine scene in step with the document. Every change is a
 * reconcile: create what is new, re-parent what moved, destroy what was
 * removed and push changed properties to the existing engine objects.
 */
export class SceneSync extends Emitter<SyncEvents> {
    readonly entries = new Map<string, Entry>();
    private owner = new WeakMap<Object3D, string>();
    private prefabs = new Map<string, Promise<Object3D>>();
    private textures = new Map<string, Promise<Texture | null>>();

    constructor(private runtime: Runtime, private store: Store) {
        super();
    }

    // ---------------------------------------------------------------- sync

    sync(hint?: ChangeHint) {
        const doc = this.store.doc;
        this.runtime.applyEnvironment(doc.environment);
        if (hint?.env) return;

        if (hint?.nodes) {
            for (const id of hint.nodes) {
                const node = this.store.node(id);
                if (node && this.entries.has(id)) this.apply(node);
            }
        } else {
            const alive = new Set<string>();
            for (const node of doc.nodes) {
                alive.add(node.id);
                if (!this.entries.has(node.id)) this.create(node);
            }
            // Re-parent before destroying so surviving children of removed
            // nodes are moved out of the subtree that is about to die.
            for (const node of doc.nodes) this.parent(node);
            for (const [id, entry] of this.entries) {
                if (!alive.has(id)) this.destroy(entry);
            }
            for (const node of doc.nodes) this.apply(node);
        }
        this.updateVisibility();
    }

    /** Resolves an engine object (possibly deep inside a model) to its node id. */
    nodeIdOf(obj: Object3D | null): string | null {
        let o: Object3D | null = obj;
        while (o) {
            const id = this.owner.get(o);
            if (id) return id;
            o = (o.transform.parent?.object3D as Object3D) ?? null;
        }
        return null;
    }

    modelState(id: string): ModelState | null {
        return this.entries.get(id)?.model ?? null;
    }

    /** Renderers that belong to a node itself (its mesh and model), not to child nodes. */
    renderersOf(id: string): RenderNode[] {
        const entry = this.entries.get(id);
        if (!entry) return [];
        const out: RenderNode[] = [];
        if (entry.mesh) out.push(entry.mesh);
        if (entry.model?.obj) {
            entry.model.obj.traverse((o: Object3D) => {
                o.components.forEach((c) => {
                    if (c instanceof RenderNode && (c as RenderNode).geometry) out.push(c as RenderNode);
                });
            });
        }
        return out;
    }

    // ----------------------------------------------------------- lifecycle

    private create(node: NodeDoc) {
        const obj = new Object3D();
        obj.name = node.name;
        const entry: Entry = {
            id: node.id,
            obj,
            parent: undefined as any,
            visible: true,
            mesh: null,
            geometry: null,
            geometryKey: '',
            material: null,
            materialType: null,
            materialKey: '',
            defaultBaseMap: null,
            mapAsset: null,
            alphaMode: 'OPAQUE',
            light: null,
            lightType: null,
            lightKey: '',
            model: null,
        };
        this.entries.set(node.id, entry);
        this.owner.set(obj, node.id);
    }

    private parent(node: NodeDoc) {
        const entry = this.entries.get(node.id)!;
        if (entry.parent === node.parent && entry.obj.transform.parent) return;
        const parentObj = node.parent ? this.entries.get(node.parent)?.obj : null;
        (parentObj ?? this.runtime.scene).addChild(entry.obj);
        entry.parent = node.parent;
    }

    private destroy(entry: Entry) {
        this.entries.delete(entry.id);
        if (entry.model) entry.model.token = -1;
        entry.obj.removeFromParent();
        entry.obj.destroy();
    }

    // -------------------------------------------------------------- apply

    private apply(node: NodeDoc) {
        const entry = this.entries.get(node.id);
        if (!entry) return;
        if (entry.obj.name !== node.name) entry.obj.name = node.name;
        this.applyTransform(entry, node);
        this.applyMesh(entry, node.mesh);
        this.applyLight(entry, node.light);
        this.applyModel(entry, node.model);
    }

    private applyTransform(entry: Entry, node: NodeDoc) {
        const obj = entry.obj;
        let moved = false;
        const p = node.position.join(',');
        if (p !== entry.position) {
            obj.x = node.position[0];
            obj.y = node.position[1];
            obj.z = node.position[2];
            entry.position = p;
            moved = true;
        }
        const r = node.rotation.join(',');
        if (r !== entry.rotation) {
            obj.rotationX = node.rotation[0];
            obj.rotationY = node.rotation[1];
            obj.rotationZ = node.rotation[2];
            entry.rotation = r;
            moved = true;
        }
        const s = node.scale.join(',');
        if (s !== entry.scale) {
            // Zero scale produces a singular matrix; keep it just above zero.
            obj.scaleX = nonZero(node.scale[0]);
            obj.scaleY = nonZero(node.scale[1]);
            obj.scaleZ = nonZero(node.scale[2]);
            entry.scale = s;
            moved = true;
        }
        if (moved) this.refreshLightsBelow(node.id);
    }

    /** Lights cache their world position/direction; nudge the ones below a moved node. */
    private refreshLightsBelow(id: string) {
        for (const child of this.store.descendants(id)) {
            const light = this.entries.get(child.id)?.light;
            if (light) light.transform.notifyChange();
        }
    }

    private applyMesh(entry: Entry, mesh: MeshDoc | undefined) {
        if (!mesh) {
            if (entry.mesh) {
                entry.obj.removeComponent(MeshRenderer);
                entry.mesh = null;
                entry.geometry = null;
                entry.material = null;
                entry.materialType = null;
                entry.geometryKey = '';
                entry.materialKey = '';
                entry.mapAsset = null;
            }
            return;
        }
        if (!entry.mesh) {
            entry.mesh = entry.obj.addComponent(MeshRenderer);
            if (!entry.visible) entry.mesh.enable = false;
        }
        const mr = entry.mesh;

        const geometryKey = JSON.stringify(mesh.geometry);
        if (geometryKey !== entry.geometryKey) {
            const old = entry.geometry;
            entry.geometry = buildGeometry(mesh.geometry);
            mr.geometry = entry.geometry;
            entry.geometryKey = geometryKey;
            if (old) this.disposeLater(old);
        }

        if (!entry.material || entry.materialType !== mesh.material.type) {
            const old = entry.material;
            const ctx = this.runtime.engine.context3D;
            entry.material = mesh.material.type === 'unlit' ? new UnLitMaterial(ctx) : new LitMaterial(ctx);
            entry.defaultBaseMap = entry.material.baseMap ?? null;
            entry.materialType = mesh.material.type;
            entry.materialKey = '';
            entry.mapAsset = null;
            entry.alphaMode = 'OPAQUE';
            mr.material = entry.material;
            if (old) this.disposeLater(old);
        }

        const materialKey = JSON.stringify(mesh.material);
        if (materialKey !== entry.materialKey) {
            this.applyMaterial(entry, mesh.material);
            entry.materialKey = materialKey;
        }
        mr.castShadow = mesh.castShadow;
        mr.receiveShadow = mesh.receiveShadow;
    }

    private applyMaterial(entry: Entry, md: MaterialDoc) {
        const mat = entry.material!;
        const opacity = clamp01(md.opacity);
        mat.baseColor = hexToColor(md.color, opacity);
        if (mat instanceof LitMaterial) {
            mat.metallic = clamp01(md.metallic);
            mat.roughness = clamp01(md.roughness);
            mat.emissiveColor = hexToColor(md.emissive);
            mat.emissiveIntensity = Math.max(0, md.emissiveIntensity);
        }
        (mat as Material).doubleSide = !!md.doubleSide;

        const alphaMode = opacity < 0.999 ? 'BLEND' : 'OPAQUE';
        if (alphaMode !== entry.alphaMode) {
            mat.alphaMode = alphaMode;
            entry.alphaMode = alphaMode;
        }

        if (md.map !== entry.mapAsset) {
            entry.mapAsset = md.map;
            if (!md.map) {
                if (entry.defaultBaseMap) mat.baseMap = entry.defaultBaseMap;
            } else {
                const asset = md.map;
                this.loadTexture(asset).then((tex) => {
                    if (!tex || entry.material !== mat || entry.mapAsset !== asset) return;
                    // The texture is decoded from sRGB by the GPU, so skip the shader's own decode.
                    mat.setDefine('USE_SRGB_ALBEDO', (tex as any).format === 'rgba8unorm-srgb');
                    mat.baseMap = tex;
                });
            }
        }
    }

    private applyLight(entry: Entry, light: LightDoc | undefined) {
        if (!light) {
            if (entry.light) {
                entry.obj.removeComponent(LIGHT_CLASSES[entry.lightType!]);
                entry.light = null;
                entry.lightType = null;
                entry.lightKey = '';
            }
            return;
        }
        if (entry.lightType !== light.type) {
            if (entry.light) entry.obj.removeComponent(LIGHT_CLASSES[entry.lightType!]);
            entry.light = entry.obj.addComponent(LIGHT_CLASSES[light.type]);
            entry.lightType = light.type;
            entry.lightKey = '';
            if (!entry.visible) entry.light.enable = false;
        }
        const key = JSON.stringify(light);
        if (key === entry.lightKey) return;
        entry.lightKey = key;
        const l = entry.light!;
        l.lightColor = hexToColor(light.color);
        l.intensity = Math.max(0, light.intensity);
        l.castShadow = !!light.castShadow;
        if (l instanceof PointLight || l instanceof SpotLight) {
            l.range = Math.max(0.01, light.range);
            l.radius = Math.max(0, light.radius);
        }
        if (l instanceof SpotLight) {
            l.outerAngle = Math.min(179, Math.max(1, light.outerAngle));
            l.innerAngle = Math.min(100, Math.max(0, light.innerAngle));
        }
    }

    private applyModel(entry: Entry, model: ModelDoc | undefined) {
        if (!model) {
            if (entry.model) {
                this.dropModel(entry);
                entry.model = null;
            }
            return;
        }
        if (entry.model && entry.model.asset === model.asset) return;
        if (entry.model) this.dropModel(entry);
        const token = ++loadToken;
        const state: ModelState = { asset: model.asset, token, obj: null, status: 'loading' };
        entry.model = state;
        this.loadPrefab(model.asset)
            .then((prefab) => {
                if (state.token !== token || this.entries.get(entry.id) !== entry) return;
                const instance = prefab.clone();
                instance.name = prefab.name || 'model';
                entry.obj.addChild(instance);
                state.obj = instance;
                state.status = 'ready';
                this.setEnabled(entry, entry.visible, true);
                this.emit('model', entry.id);
            })
            .catch((err) => {
                if (state.token !== token) return;
                state.status = 'error';
                state.error = err?.message || String(err);
                console.error('[editor] model load failed', err);
                this.emit('model', entry.id);
            });
    }

    private dropModel(entry: Entry) {
        const m = entry.model;
        if (!m) return;
        m.token = -1;
        if (m.obj) {
            m.obj.removeFromParent();
            m.obj.destroy();
        }
    }

    // ------------------------------------------------------------ visibility

    private updateVisibility() {
        const effective = new Map<string, boolean>();
        const resolve = (node: NodeDoc | undefined): boolean => {
            if (!node) return true;
            const known = effective.get(node.id);
            if (known !== undefined) return known;
            const v = node.visible && resolve(this.store.node(node.parent));
            effective.set(node.id, v);
            return v;
        };
        for (const node of this.store.doc.nodes) {
            const entry = this.entries.get(node.id);
            if (entry) this.setEnabled(entry, resolve(node));
        }
    }

    private setEnabled(entry: Entry, visible: boolean, force = false) {
        if (entry.visible === visible && !force) return;
        entry.visible = visible;
        if (entry.mesh) entry.mesh.enable = visible;
        if (entry.light) entry.light.enable = visible;
        entry.model?.obj?.traverse((o: Object3D) => {
            o.components.forEach((c) => {
                if (c instanceof RenderNode) c.enable = visible;
            });
        });
    }

    // --------------------------------------------------------------- assets

    private loadPrefab(assetId: string): Promise<Object3D> {
        let p = this.prefabs.get(assetId);
        if (!p) {
            p = (async () => {
                const meta = this.store.doc.assets.find((a) => a.id === assetId);
                if (!meta) throw new Error('Model asset is missing from this project.');
                const url = await getAssetUrl(meta);
                if (!url) throw new Error(`"${meta.name}" is not stored in this browser.`);
                return this.runtime.engine.res.loadGltf(url);
            })();
            p.catch(() => this.prefabs.delete(assetId));
            this.prefabs.set(assetId, p);
        }
        return p;
    }

    private loadTexture(assetId: string): Promise<Texture | null> {
        let p = this.textures.get(assetId);
        if (!p) {
            p = (async () => {
                const meta = this.store.doc.assets.find((a) => a.id === assetId);
                if (!meta) return null;
                const url = await getAssetUrl(meta);
                if (!url) return null;
                return (await this.runtime.engine.res.loadTexture(url, undefined, false, 'srgb')) as Texture;
            })().catch((e) => {
                console.error('[editor] texture load failed', e);
                this.textures.delete(assetId);
                return null;
            });
            this.textures.set(assetId, p);
        }
        return p;
    }

    /** Frees GPU resources once the GPU has finished frames that may still use them. */
    private disposeLater(res: { destroy(force?: boolean): void }) {
        const device = this.runtime.engine.context3D.device;
        const run = () => {
            try {
                res.destroy();
            } catch (e) {
                console.warn('[editor] dispose failed', e);
            }
        };
        device.queue.onSubmittedWorkDone().then(() => requestAnimationFrame(() => requestAnimationFrame(run)), run);
    }
}

function nonZero(v: number): number {
    return Math.abs(v) < 1e-5 ? (v < 0 ? -1e-5 : 1e-5) : v;
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function buildGeometry(g: GeometryDoc): GeometryBase {
    const pos = (v: number, min = 0.001) => (Number.isFinite(v) ? Math.max(min, v) : 1);
    const seg = (v: number, min = 3) => Math.round(Math.min(256, Math.max(min, Number.isFinite(v) ? v : 16)));
    switch (g.type) {
        case 'box':
            return new BoxGeometry(pos(g.width), pos(g.height), pos(g.depth));
        case 'sphere':
            return new SphereGeometry(pos(g.radius), seg(g.segments), seg(g.segments / 2, 2));
        case 'plane':
            return new PlaneGeometry(pos(g.width), pos(g.height));
        case 'cylinder':
            return new CylinderGeometry(Math.max(0, g.radiusTop), Math.max(0, g.radiusBottom), pos(g.height), seg(g.segments), 1);
        case 'torus':
            return new TorusGeometry(pos(g.radius), pos(g.tube), seg(g.segments), seg(g.segments / 2));
    }
}

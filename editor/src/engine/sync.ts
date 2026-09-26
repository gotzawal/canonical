import {
    BoxGeometry, Color, CylinderGeometry, DirectLight, GeometryBase, LightBase, LitMaterial, Material, MeshRenderer,
    Object3D, PlaneGeometry, PointLight, RenderNode, RendererMask, SphereGeometry, SpotLight, Texture, TorusGeometry,
    UnLitMaterial,
} from '@orillusion/core';
import { Emitter } from '../core/events';
import { getAssetUrl } from '../core/assets';
import type { ChangeHint, Store } from '../core/store';
import type { GeometryDoc, LightDoc, LightType, MaterialDoc, MeshDoc, ModelDoc, NodeDoc } from '../core/types';
import { hexToColor } from './color';
import { castGI } from './gi';
import {
    applyAlpha, applyPBR, applyUVTransform, BASE_MAP, createBuiltinMaterial, engineAlpha, MaterialMaps, normalizeModelMaterials, PBR_MAPS,
} from './materials';
import { inspectModel, ModelInfo, ModelOverrides } from './modelParts';
import type { Runtime } from './runtime';
import { applyProps, type ShaderManager } from './shaders';

interface ModelState {
    asset: string;
    token: number;
    obj: Object3D | null;
    status: 'loading' | 'ready' | 'error';
    error?: string;
    /** Parts and material slots, once loaded. */
    info: ModelInfo | null;
    overrides: ModelOverrides | null;
    /** Overrides last applied, to skip unchanged updates. */
    key: string;
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
    material: Material | null;
    /** 'lit', 'unlit', 'lambert', 'shader:<id>:<version>' or 'shader-missing'. */
    materialKind: string;
    materialKey: string;
    /** Texture assets shown in the material's maps. */
    maps: MaterialMaps | null;
    paramAssets: Record<string, string>;
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
    /** Nodes whose objects a script destroyed in Play mode; they stay out of the scene until Stop. */
    readonly detached = new Set<string>();
    private owner = new WeakMap<Object3D, string>();
    private prefabs = new Map<string, Promise<Object3D>>();
    private textures = new Map<string, Promise<Texture | null>>();

    constructor(private runtime: Runtime, private store: Store, readonly shaders: ShaderManager) {
        super();
        // A shader that finished compiling changes the materials built from it.
        shaders.on('compiled', () => this.sync());
        shaders.on('status', () => this.sync());
    }

    // ---------------------------------------------------------------- sync

    sync(hint?: ChangeHint) {
        if (hint?.meta) return;
        const doc = this.store.doc;
        this.runtime.applyEnvironment(doc.environment);
        // Anything that changed (objects, materials, sky) changes what the GI probes see.
        this.runtime.gi.invalidate();
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
            for (const [id, entry] of Array.from(this.entries)) {
                if (!alive.has(id)) this.destroy(entry);
            }
            for (const node of doc.nodes) this.apply(node);
        }
        this.updateVisibility();
    }

    /**
     * Destroys every engine object and builds the scene again from the
     * document. Play mode uses this to throw away what scripts changed.
     */
    rebuild() {
        for (const entry of Array.from(this.entries.values())) this.destroy(entry);
        this.sync();
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

    /** Parts and material slots of a loaded model node. */
    modelInfo(id: string): ModelInfo | null {
        return this.entries.get(id)?.model?.info ?? null;
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
            materialKind: '',
            materialKey: '',
            maps: null,
            paramAssets: {},
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
        if (this.detached.has(node.id)) return;
        if (entry.parent === node.parent && entry.obj.transform.parent) return;
        const parentObj = node.parent ? this.entries.get(node.parent)?.obj : null;
        (parentObj ?? this.runtime.scene).addChild(entry.obj);
        entry.parent = node.parent;
    }

    private destroy(entry: Entry) {
        this.entries.delete(entry.id);
        if (entry.model) {
            entry.model.token = -1;
            entry.model.overrides?.dispose();
        }
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
                entry.materialKind = '';
                entry.geometryKey = '';
                entry.materialKey = '';
                entry.maps = null;
                entry.paramAssets = {};
            }
            return;
        }
        if (!entry.mesh) {
            entry.mesh = entry.obj.addComponent(MeshRenderer);
            // Seen by the GI probes (only matters while GI is on).
            entry.mesh.castGI = true;
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

        const kind = this.materialKind(entry, mesh.material);
        if (!entry.material || entry.materialKind !== kind) {
            const old = entry.material;
            const ctx = this.runtime.engine.context3D;
            let mat: Material | null = null;
            let shaderId: string | null = null;
            if (kind.startsWith('shader:')) {
                shaderId = mesh.material.shader!;
                mat = this.shaders.createMaterial(shaderId);
            }
            if (!mat) {
                if (kind === 'shader-missing') mat = errorMaterial(ctx);
                else mat = createBuiltinMaterial(kind === 'unlit' || kind === 'lambert' ? kind : 'lit', ctx);
            }
            entry.material = mat;
            entry.maps = new MaterialMaps(mat, ctx, (id, linear) => this.loadTexture(id, linear));
            entry.materialKind = kind;
            entry.materialKey = '';
            entry.paramAssets = {};
            // Vertex shaders that move vertices cannot use the depth prepass,
            // which draws the undisplaced mesh.
            if (shaderId && this.shaders.movesVertices(shaderId)) mr.addRendererMask(RendererMask.IgnoreDepthPass);
            else mr.removeRendererMask(RendererMask.IgnoreDepthPass);
            mr.material = mat;
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

    private materialKind(entry: Entry, md: MaterialDoc): string {
        if (md.type !== 'shader') return md.type;
        const id = md.shader;
        if (id && this.shaders.isValid(id)) return `shader:${id}:${this.shaders.version(id)}`;
        // While a first version compiles, keep the current look, or show a
        // plain lit material: magenta is for shaders that failed.
        if (id && this.shaders.status(id).state === 'compiling') return entry.material ? entry.materialKind : 'lit';
        return 'shader-missing';
    }

    private applyMaterial(entry: Entry, md: MaterialDoc) {
        const mat = entry.material!;
        const kind = entry.materialKind;
        if (kind === 'shader-missing') return;
        const opacity = clamp01(md.opacity);
        mat.baseColor = hexToColor(md.color, opacity);
        if (mat instanceof LitMaterial) {
            applyPBR(mat, md);
        } else if (kind.startsWith('shader:')) {
            const sh = mat.shader;
            sh.setUniformFloat('metallic', clamp01(md.metallic));
            sh.setUniformFloat('roughness', clamp01(md.roughness));
            sh.setUniformColor('emissiveColor', hexToColor(md.emissive));
            sh.setUniformFloat('emissiveIntensity', Math.max(0, md.emissiveIntensity));
            const assets = applyProps(sh, this.shaders.props(md.shader!), md.params ?? {}, this.runtime.engine.context3D);
            for (const { name, asset } of assets) {
                if (entry.paramAssets[name] === asset) continue;
                entry.paramAssets[name] = asset;
                this.loadTexture(asset).then((tex) => {
                    if (tex && entry.material === mat && entry.paramAssets[name] === asset) sh.setTexture(name, tex);
                });
            }
        }
        mat.doubleSide = !!md.doubleSide;
        applyAlpha(mat, engineAlpha(md.alphaMode, opacity), clamp01(md.alphaCutoff ?? 0.5));
        applyUVTransform(mat, md.tiling, md.offset);

        const maps = entry.maps!;
        for (const map of mat instanceof LitMaterial ? PBR_MAPS : [BASE_MAP]) maps.set(map, md[map.key] ?? null);
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
            if (this.runtime.gi.enabled) entry.light.castGI = true;
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
        if (entry.model && entry.model.asset === model.asset) {
            this.applyModelOverrides(entry, model);
            return;
        }
        if (entry.model) this.dropModel(entry);
        const token = ++loadToken;
        const state: ModelState = { asset: model.asset, token, obj: null, status: 'loading', info: null, overrides: null, key: '' };
        entry.model = state;
        this.loadPrefab(model.asset)
            .then((prefab) => {
                if (state.token !== token || this.entries.get(entry.id) !== entry) return;
                const instance = prefab.clone();
                instance.name = prefab.name || 'model';
                entry.obj.addChild(instance);
                castGI(instance);
                state.obj = instance;
                state.status = 'ready';
                const ctx = this.runtime.engine.context3D;
                try {
                    state.info = inspectModel(instance, ctx);
                    state.overrides = new ModelOverrides(state.info, {
                        shaders: this.shaders,
                        loadTexture: (id, linear) => this.loadTexture(id, linear),
                        dispose: (m) => this.disposeLater(m, true),
                        ctx,
                    });
                    const current = this.store.node(entry.id)?.model;
                    if (current) this.applyModelOverrides(entry, current);
                } catch (e) {
                    // The model still renders; it just cannot be edited part by part.
                    console.warn('[editor] could not read the parts of the model', e);
                    state.info = null;
                    state.overrides = null;
                }
                this.setEnabled(entry, entry.visible, true);
                this.runtime.gi.invalidate();
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

    private applyModelOverrides(entry: Entry, model: ModelDoc) {
        const st = entry.model;
        if (!st?.overrides) return;
        // Recompiled shaders need a re-apply even when the overrides did not change.
        const versions = Object.values(model.materials ?? {})
            .map((o) => (o.shader ? `${o.shader}:${this.shaders.version(o.shader)}` : ''))
            .join(',');
        const key = JSON.stringify([model.materials ?? {}, model.parts ?? {}, versions]);
        if (key === st.key) return;
        st.key = key;
        st.overrides.apply(model, entry.visible);
    }

    private dropModel(entry: Entry) {
        const m = entry.model;
        if (!m) return;
        m.token = -1;
        m.overrides?.dispose();
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
        const model = this.store.node(entry.id)?.model;
        if (entry.model?.overrides && model) {
            entry.model.overrides.setVisible(model, visible);
            return;
        }
        entry.model?.obj?.traverse((o: Object3D) => {
            o.components.forEach((c) => {
                if (c instanceof RenderNode) c.enable = visible;
            });
        });
    }

    // --------------------------------------------------------------- assets

    /** Resolves once every model and texture requested so far has loaded or failed. */
    async whenLoaded(): Promise<void> {
        for (;;) {
            const pending = [...this.prefabs.values(), ...this.textures.values()];
            await Promise.allSettled(pending);
            // Loaded models can ask for more textures (their overrides).
            const now = [...this.prefabs.values(), ...this.textures.values()];
            if (now.every((p) => pending.includes(p))) return;
        }
    }

    private loadPrefab(assetId: string): Promise<Object3D> {
        let p = this.prefabs.get(assetId);
        if (!p) {
            p = (async () => {
                const meta = this.store.doc.assets.find((a) => a.id === assetId);
                if (!meta) throw new Error('Model asset is missing from this project.');
                const url = await getAssetUrl(meta);
                if (!url) throw new Error(`"${meta.name}" is not stored in this browser.`);
                const prefab = await this.runtime.engine.res.loadGltf(url);
                normalizeModelMaterials(prefab, this.runtime.engine.context3D);
                return prefab;
            })();
            p.catch(() => this.prefabs.delete(assetId));
            this.prefabs.set(assetId, p);
        }
        return p;
    }

    /**
     * Loads a texture asset. Color textures are decoded from sRGB, data
     * textures (normal, metallic-roughness, occlusion maps) are `linear`.
     */
    loadTexture(assetId: string, linear = false): Promise<Texture | null> {
        const key = `${assetId}|${linear ? 'linear' : 'srgb'}`;
        let p = this.textures.get(key);
        if (!p) {
            p = (async () => {
                const meta = this.store.doc.assets.find((a) => a.id === assetId);
                if (!meta || meta.kind !== 'texture') return null;
                const url = await getAssetUrl(meta);
                if (!url) return null;
                return (await this.runtime.engine.res.loadTexture(url, undefined, false, linear ? 'linear' : 'srgb')) as Texture;
            })().catch((e) => {
                console.error('[editor] texture load failed', e);
                this.textures.delete(key);
                return null;
            });
            this.textures.set(key, p);
        }
        return p;
    }

    /**
     * Frees GPU resources once the GPU has finished frames that may still use
     * them. `keepTextures` protects textures shared with other materials
     * (model materials share the textures of the file).
     */
    disposeLater(res: { destroy(force?: boolean): void }, keepTextures = false) {
        const device = this.runtime.engine.context3D.device;
        const run = () => {
            try {
                if (keepTextures && res instanceof Material && res.shader) {
                    for (const list of res.shader.passShader.values()) {
                        for (const pass of list) pass.textures = {};
                    }
                }
                res.destroy();
            } catch (e) {
                console.warn('[editor] dispose failed', e);
            }
        };
        device.queue.onSubmittedWorkDone().then(() => requestAnimationFrame(() => requestAnimationFrame(run)), run);
    }
}

function errorMaterial(ctx: any): Material {
    // The classic "shader missing" magenta.
    const mat = new UnLitMaterial(ctx);
    mat.baseColor = new Color(1, 0, 1, 1);
    return mat;
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

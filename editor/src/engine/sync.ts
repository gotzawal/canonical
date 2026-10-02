import {
    Vector3,
    BoxGeometry, Color, CompressedTexture2D, CylinderGeometry, DirectLight, GeometryBase, InstanceDrawComponent, isKTX2, LightBase, LitMaterial, Material,
    MeshRenderer, MirrorComponent, MirrorMaterial, Object3D, PlaneGeometry, PointLight, Reference, RenderNode, RendererMask, SkinnedMeshRenderer,
    SkinnedMeshRenderer2, SphereGeometry, SpotLight, Texture, TorusGeometry, UnLitMaterial,
} from '@orillusion/core';
import { Emitter } from '../core/events';
import { getAssetUrl } from '../core/assets';
import type { ChangeHint, Store } from '../core/store';
import type {
    AnimationDoc, AssetMeta, EnvironmentDoc, GeometryDoc, GrassDoc, RainDoc, InstancingDoc, LightDoc, LightType, MaterialDoc, MeshDoc, ModelDoc, NodeDoc, ParticlesDoc, ScatterDoc, TerrainDoc,
    TextureRole,
} from '../core/types';
import { placeScatter, type AvoidBox, type GroundSample, type Placement, type ScatterSolid } from '../core/scatter';
import { contactMap, covers, groundHeight, groundNormal, layerWeights, paintAt, type Contact, type Cover, type TerrainFrame, type TerrainSurface } from '../core/terrain';
import { quatRotate } from '../core/math';
import type { ClutterGround } from '../core/clutter';
import { GroundClutter } from './clutter';
import { linearOf } from './rockGround';
import type { DerivedRole } from '../core/derived';
import { ParticleSystem } from '@orillusion/particle';
import { buildParticles, dotTextureUrl } from './particles';
import { hexToColor } from './color';
import { skySunOf, sunlightThroughAir } from '../core/sky';
import { weatherNow, type WeatherNow } from '../core/weather';
import { defaults } from '../core/schema';
import { Rain } from '../core/model';
import { ModelLods } from './lod';
import { castGI } from './gi';
import { setLightShadow } from './shadows';
import { QUALITY, type QualityLevel } from '../core/quality';
import { movesInPlay } from '../core/motion';
import { patchNoise } from '../core/grass';
import { fieldArea, fieldFrame, GrassField, gustTexture, GroundGrid, hashString, LayeredGround, plainBlades } from './grass';
import { flatMap, heightmapOf, paintOf, TerrainView } from './terrain';
import { ScatterModel, ScatterView } from './scatter';
import { rendererWorldBox } from './picking';
import { objectWorldBox, RAIN_SHADER, RainVolume } from './rain';
import type { MaterialLayer } from './terrainMaterial';
import { CapsuleGeometry, ConeGeometry, RampGeometry, StairsGeometry } from './shapes';
import {
    applyAlpha, applyPBR, applyUVTransform, BASE_MAP, createBuiltinMaterial, engineAlpha, MaterialMaps, normalizeModelMaterials, PBR_MAPS,
} from './materials';
import { cloneMaterial, inspectModel, ModelInfo, ModelOverrides } from './modelParts';
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
    /** The clip the editor last played. */
    clip?: string;
    /** The instancing group whose copy of the file's materials it shows ('' for the file's own). */
    group: string;
    /** Lets go of the group's copy it was made from. */
    release?: () => void;
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
    /** The material it shows, shared with the objects whose materials are the same. */
    material: SharedMaterial | null;
    /** 'lit', 'unlit', 'lambert', 'shader:<id>:<version>' or 'shader-missing'. */
    materialKind: string;
    /** Its material's key among the shared materials. */
    materialKey: string;
    light: LightBase | null;
    lightType: LightType | null;
    lightKey: string;
    model: ModelState | null;
    particles: ParticleSystem | null;
    particlesKey: string;
    /** Increases with every rebuild, so a late texture load does not build an outdated emitter. */
    particlesToken: number;
    /** The planar mirror of its mesh. */
    mirror: MirrorComponent | null;
    /** Its field of grass (a renderer at the scene root), and the blades and width it was made with. */
    grass: GrassField | null;
    grassBuild: string;
    /** What its blades were last placed for (see placeGrass). */
    grassPlaced: string;
    /** Its rain (a box at the scene root, placed every frame). */
    rain: RainVolume | null;
    /** Draws the meshes of its instancing group, when it has instancing. */
    instancer: InstanceDrawComponent | null;
    /** The instancing group its meshes are drawn in: the nearest object with instancing, itself included; '' for none. */
    group: string;
    /** Its terrain: chunks, material and what they were made from. */
    terrain: TerrainState | null;
    /** Its scatter: the copies and what they were placed from. */
    scatter: ScatterState | null;
}

/** A scatter's engine side (engine/scatter.ts), and what its copies were placed from. */
interface ScatterState {
    view: ScatterView;
    /** Its rules, place, ground, what it avoids and the models loaded when it was last placed. */
    placed: string;
    placements: Placement[];
    /** The solid copies, as trunks and boxes. */
    solids: ScatterSolid[];
    /** What its soil and moss were last set from. */
    groundKey?: string;
}

/** Scatters are placed again this long after the last change (a drag changes things many times a second). */
const SCATTER_DELAY = 120;

/** A terrain's engine side (engine/terrain.ts) and what it shows. */
interface TerrainState {
    view: TerrainView;
    /** The map file, size, height and detail its chunks were built from, and the size, height and detail alone. */
    built: string;
    shape: string;
    /** The paint file shown, and the layers (with the size of their arrays). */
    paint: string;
    layers: string;
    /** Increases with every map load, so a late load does not replace a newer one. */
    token: number;
    /** The layer textures it watches for refills (a compressed copy replacing a file). */
    watched: Texture[];
    /** Changes whenever its heights or place change (grass and scatter on it follow). */
    version: number;
    /** The water and rain that last made it wet (see updateWetness). */
    wet: string;
    /** The height of water over it (grass grows above it), or null. */
    water?: number | null;
    /** Its paint as last loaded (scatters that follow a layer read it), or null. */
    paintData: { width: number; height: number; data: Uint8Array } | null;
}

/** An engine material and the objects showing it (see SceneSync.materials). */
interface SharedMaterial {
    key: string;
    kind: string;
    material: Material;
    /** Texture assets shown in the material's maps. */
    maps: MaterialMaps;
    paramAssets: Record<string, string>;
    /** Objects showing it. */
    users: number;
    /** The instancing group it is compiled for ('' for none): its passes draw that group's instances. */
    group: string;
}

/** A renderer an instancing group draws, and whose it is (a model's part by its path). */
interface GroupMember {
    r: MeshRenderer;
    id: string;
    path?: string;
}

interface SyncEvents {
    /** An async model load finished (successfully or not) for a node. */
    model: string;
    /** A terrain's heights or place changed (its map loaded, it was sculpted or moved). */
    terrain: string;
    /** A scatter's copies were placed anew (or went). */
    scatter: string;
}

const LIGHT_CLASSES: Record<LightType, new () => LightBase> = {
    directional: DirectLight,
    point: PointLight,
    spot: SpotLight,
};

let loadToken = 0;

/**
 * Where compressed copies of assets come from (derive/ in the editor, the
 * game's files in a built game): the copy of a texture for a role, that a
 * texture or model is shown from its file (so its copy can be made), and
 * the URL of a model's copy (games only: the editor shows model files).
 */
export interface TextureSource {
    resolve(meta: AssetMeta, role: TextureRole): Promise<Blob | null>;
    used?(meta: AssetMeta, role: DerivedRole): void;
    /** A URL ending in .glb, or null to load the file. */
    model?(meta: AssetMeta): Promise<string | null>;
}

/**
 * Keeps the engine scene in step with the document. Every change is a
 * reconcile: create what is new, re-parent what moved, destroy what was
 * removed and push changed properties to the existing engine objects.
 */
export class SceneSync extends Emitter<SyncEvents> {
    readonly entries = new Map<string, Entry>();
    /** Nodes whose objects a script destroyed in Play mode; they stay out of the scene until Stop. */
    readonly detached = new Set<string>();
    /** While a prefab instance is edited on its own, only these nodes (and lights) are shown. */
    private isolation: Set<string> | null = null;
    /** Isolation hides lights too (the reference room brings its own). */
    private isolateLights = false;
    /** Environment shown instead of the document's (the reference room). */
    private envOverride: EnvironmentDoc | null = null;
    /** The weather and time of day shown (Environment.weather), when on; when it was worked out and from what. */
    private weather: WeatherNow | null = null;
    private weatherKey = '';
    private weatherAt = 0;
    private weatherTime = NaN;
    private weatherStart = 0;
    private weatherRain: RainVolume | null = null;
    private owner = new WeakMap<Object3D, string>();
    private prefabs = new Map<string, Promise<Object3D>>();
    /** Texture assets by `${asset}|${role}`: the texture, once it has data. */
    private textures = new Map<string, Promise<Texture | null>>();
    /**
     * The texture of each loaded `${asset}|${role}`. It stays the same
     * object while its data changes (a replaced file, a compressed copy
     * made), so everything showing it keeps it and rebinds.
     */
    private assetTextures = new Map<string, CompressedTexture2D>();
    /** Fills of each texture, one after the other. */
    private fills = new Map<string, Promise<void>>();
    /**
     * Shapes by their document (JSON): objects of the same shape share one
     * geometry (its GPU buffers, and consecutive draws skip binding it
     * again). The map holds a reference of its own, so the engine never
     * frees a shape here; sweepGeometries frees those no object shows.
     */
    private geometries = new Map<string, GeometryBase>();
    private geometriesChanged = false;
    /**
     * Materials by their document (their kind and fields): objects whose
     * materials are the same (material slots, repeated props) share one,
     * so they draw with the same bindings and a change is applied once. A
     * material only one object shows changes in place when that object's
     * material changes; a shared one never does, the object gets another.
     * Objects with scripts or a behavior tree keep one of their own (their
     * code may change it). Like the shapes, the map holds a reference.
     */
    private materials = new Map<string, SharedMaterial>();
    private materialsChanged = false;
    /**
     * An imported model in an instancing group shows a copy of its file's
     * materials made for the group (by `${group}|${asset}`): the group's
     * instances share it and draw together, and nothing else does, as the
     * materials an instancer draws are compiled for it.
     */
    private groupPrefabs = new Map<string, { prefab: Promise<Object3D>; users: number }>();
    /** Instancing groups whose members changed, grouped again at the end of the change (flushGroups). */
    private dirtyGroups = new Set<string>();
    /** The renderers each instancing group draws, and the objects (and model parts) they belong to. */
    private groupMembers = new Map<string, GroupMember[]>();
    /** Renderers an instancer draws: disabled, but shown. */
    private instanced = new Set<RenderNode>();
    /** The built-in gusts of grass fields, made once. */
    private gusts: Texture | null = null;
    /** The terrains, and their map and paint loads still running (whenLoaded waits for them). */
    private terrainStates = new Set<TerrainState>();
    private terrainLoads = new Set<Promise<unknown>>();
    /** The terrain material shaders read (terrainHeight), by id and version. */
    private sharedTerrain = '';
    /** Scatter source models by asset id (taken apart once), and those loaded. */
    private scatterModels = new Map<string, Promise<ScatterModel | null>>();
    private scatterModelsLoaded = new Map<string, ScatterModel | null>();
    /** Scatters in the scene; a placement waiting to run, and what resolves once it ran. */
    private scatterStates = new Set<ScatterState>();
    /** Counts scatter placements (things on the ground follow them), and what the ground details were made from. */
    private scatterVersion = 0;
    private groundKey = '';
    private contactsKey = '';
    private contactMaps = new Map<TerrainState, { width: number; height: number; data: Uint8Array }>();
    private clutter: GroundClutter | null = null;
    private scatterTimer = 0;
    private scatterPending: Promise<void> | null = null;
    private scatterRan: (() => void) | null = null;

    /** Textures load at most this large (the longer side): games on a low quality tier skip the top mips. */
    private readonly textureMaxSize: number;

    constructor(private runtime: Runtime, private store: Store, readonly shaders: ShaderManager, private textureSource: TextureSource | null = null, opts: { textureMaxSize?: number } = {}) {
        super();
        this.textureMaxSize = opts.textureMaxSize ?? Infinity;
        // The HDRI sky's image comes from the project's assets.
        runtime.assetUrl = async (id) => {
            const meta = this.store.doc.assets.find((a) => a.id === id);
            return meta ? getAssetUrl(meta) : null;
        };
        // A shader that finished compiling changes the materials built from it.
        shaders.on('compiled', () => this.sync());
        shaders.on('status', () => this.sync());
        // Terrains draw the detail the camera's distance calls for.
        runtime.onBeforeFrame(() => this.eachFrame());
    }

    /** Terrain levels of detail and scatter draw distances for the camera, once a frame. */
    private eachFrame() {
        if (this.tierApplied !== this.runtime.qualityLevel) this.applyTier();
        const eye = this.runtime.activeCamera?.transform.worldPosition;
        if (!eye) return;
        const at = [eye.x, eye.y, eye.z];
        // Each part's CPU time shows in the Profiler as a row of its own.
        const stats = this.runtime.stats;
        let t0 = performance.now();
        const lap = (name: string) => {
            const t = performance.now();
            stats?.addCpu(name, t - t0);
            t0 = t;
        };
        this.modelLods.update(at, QUALITY[this.runtime.qualityLevel].lodDistance);
        for (const g of this.grasses) g.grass?.update(at);
        lap('Editor: grass and model levels of detail');
        this.updateWeather(at);
        this.runtime.setCloudSun(this.cloudSunlight());
        lap('Editor: weather');
        if (!this.terrainStates.size && !this.scatterStates.size) return;
        let eased = false;
        for (const t of this.terrainStates) eased = t.view.update(at) || eased;
        // Eased terrain heights move the shadows they cast (a few times a second at most).
        const now = performance.now();
        if (eased && now - this.shadowsEasedAt > 250) {
            this.shadowsEasedAt = now;
            this.runtime.redrawShadows();
        }
        for (const s of this.scatterStates) s.view.update(at);
        lap('Editor: terrain and scatter levels of detail');
        if (this.terrainStates.size) this.updateWetness();
        this.updateGround(at);
        lap('Editor: ground (contacts, stones, soil, wetness)');
    }

    /** What each part of the environment draws now, for the Profiler: its name and load. */
    environmentReport(): [string, string][] {
        const name = (id: string) => this.store.node(id)?.name ?? id;
        const rows: [string, string][] = [];
        for (const t of this.terrainStates) rows.push([`Terrain "${name(t.view.id)}"`, t.view.report()]);
        for (const e of this.grasses) if (e.grass) rows.push([`Grass "${name(e.id)}"`, e.grass.report()]);
        for (const e of this.entries.values()) if (e.scatter) rows.push([`Scatter "${name(e.id)}"`, e.scatter.view.report()]);
        if (this.clutter) rows.push(['Loose stones', this.clutter.report()]);
        const w = this.weather, env = this.store.doc.environment.weather;
        if (w) rows.push(['Weather', `${env.preset}, sun ${w.sun.elevation.toFixed(0)}° ${w.night ? '(night, moon light)' : ''}, wind ${w.wind.speed.toFixed(1)} m/s${w.rain ? `, rain ${w.rain}` : ''}`]);
        rows.push(...this.runtime.environmentReport());
        return rows;
    }

    /** When terrain heights eased last asked for the shadows again. */
    private shadowsEasedAt = 0;
    /** The tier the mirrors, terrains and scatters were last fitted to. */
    private tierApplied: QualityLevel | null = null;

    /** Fits mirrors, terrains and scatters to the graphics tier drawn (a preview or the scene's setting changed it). */
    private applyTier() {
        const level = (this.tierApplied = this.runtime.qualityLevel);
        for (const e of this.entries.values()) {
            const node = this.store.node(e.id);
            if (!node) continue;
            if (e.mirror) this.applyMirror(e, node);
            if (e.terrain && node.terrain) {
                e.terrain.view.material.setLook(node.terrain.blending, node.terrain.variation, QUALITY[level].terrainFar);
                e.terrain.view.material.setRelief(node.terrain.relief, QUALITY[level].terrainRelief);
            }
            if (e.scatter) e.scatter.view.setLodScale(QUALITY[level].lodDistance);
            e.grass?.setLodScale(QUALITY[level].lodDistance);
        }
    }

    /**
     * Gives each terrain the water surface over it (the highest of the
     * planes whose shader shows what lies under them, water) and the rain
     * box over it with the most ground under it, which make it wet. The
     * uniforms change only when what makes it wet does.
     */
    private updateWetness() {
        const waters: { box: { min: number[]; max: number[] } }[] = [];
        for (const e of this.waters) {
            if (!e.visible || this.detached.has(e.id)) continue;
            const box = objectWorldBox(e.obj);
            if (box) waters.push({ box });
        }
        const rains: { rect: [number, number, number, number]; amount: number }[] = [];
        for (const e of this.rains) {
            const doc = this.store.node(e.id)?.rain;
            if (!doc || !e.visible) continue;
            const q = e.obj.transform.worldPosition;
            rains.push({ rect: [q.x - doc.size[0] / 2, q.z - doc.size[2] / 2, q.x + doc.size[0] / 2, q.z + doc.size[2] / 2], amount: doc.amount });
        }
        // The weather's rain falls everywhere.
        if (this.weather?.rain) rains.push({ rect: [-1e6, -1e6, 1e6, 1e6], amount: this.weather.rain });
        for (const t of this.terrainStates) {
            const doc = this.store.node(t.view.id)?.terrain;
            if (!doc) continue;
            const f = t.view.frame;
            const x0 = f.x - f.sizeX / 2;
            const z0 = f.z - f.sizeZ / 2;
            const x1 = f.x + f.sizeX / 2;
            const z1 = f.z + f.sizeZ / 2;
            const overlap = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(c, x1) - Math.max(a, x0)) * Math.max(0, Math.min(d, z1) - Math.max(b, z0));
            let water: number | null = null;
            for (const w of waters) {
                if (overlap(w.box.min[0], w.box.min[2], w.box.max[0], w.box.max[2]) <= 0) continue;
                water = Math.max(water ?? -Infinity, w.box.max[1]);
            }
            let rain: (typeof rains)[number] | null = null;
            let most = 0;
            for (const r of rains) {
                const a = overlap(...r.rect);
                if (a > most) {
                    most = a;
                    rain = r;
                }
            }
            const wet = { water: water === null ? null : Math.round(water * 1000) / 1000, shore: doc.wetShore, rain, puddles: doc.puddles };
            t.water = wet.water;
            const key = JSON.stringify(wet);
            if (key === t.wet) continue;
            t.wet = key;
            t.view.material.setWet(wet);
        }
    }

    // ---------------------------------------------------------------- sync

    sync(hint?: ChangeHint) {
        if (hint?.meta || hint?.design || hint?.behavior) return;
        const doc = this.store.doc;
        // Anything that changed (objects, materials, sky) changes what the GI probes see.
        this.runtime.gi.invalidate();
        if (!hint?.nodes || hint.env) {
            this.applySkyEnvironment();
            // The key light takes its color from the air the sky's sun shines through.
            this.refreshKeyLight();
        }
        if (hint?.env && !hint.nodes) return;

        if (hint?.nodes) {
            // Instancing turned on or off moves everything below into another group: all of it is applied again.
            if (!hint.transform && hint.nodes.some((id) => !!this.store.node(id)?.instancing !== !!this.entries.get(id)?.instancer)) {
                this.sync();
                return;
            }
            // Only these objects changed; moving them (a gizmo drag) shows or hides nothing.
            for (const id of hint.nodes) {
                const node = this.store.node(id);
                const entry = this.entries.get(id);
                if (!node || !entry) continue;
                if (hint.transform) {
                    this.applyTransform(entry, node);
                    if (entry.terrain) this.placeTerrain(entry, node);
                } else {
                    this.apply(node);
                    if (entry.group) this.dirtyGroups.add(entry.group);
                }
            }
            if (!hint.transform) {
                this.updateVisibility(hint.nodes);
                this.sweep();
            }
            this.placeGrass(hint.nodes);
            this.schedulePlaceScatters();
            this.flushGroups();
            if (!hint.transform) this.shadowsChanged();
            // A directional light turned, shown or hidden moves the sky's sun with it.
            if (hint.nodes.some((id) => this.store.node(id)?.light?.type === 'directional') && this.followsLight()) {
                this.applySkyEnvironment();
                this.refreshKeyLight();
            }
            return;
        }
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
        this.assignGroups();
        for (const node of doc.nodes) this.apply(node);
        this.updateVisibility();
        for (const e of this.entries.values()) if (e.instancer) this.dirtyGroups.add(e.id);
        this.placeGrass();
        this.schedulePlaceScatters();
        this.flushGroups();
        this.sweep();
        this.shadowsChanged();
    }

    /**
     * After an edit that is not only a move: marks which renderers stand
     * still in Play (a light whose shadow redraws for static objects only
     * draws those), and draws the shadow maps again, as a material may cut
     * out something else now (moves the shadow passes see themselves).
     */
    private shadowsChanged() {
        const canMove = movesInPlay(this.store.doc);
        for (const [id, entry] of this.entries) {
            const mode = canMove(id) ? 'auto' : 'static';
            for (const r of this.renderersOf(id)) r.shadowCacheMode = mode;
            entry.grass?.setShadowCacheMode(mode);
            // Its copies move without it: a copy that can move makes it change every frame it moves.
            if (entry.instancer) {
                const members = this.groupMembers.get(id) ?? [];
                entry.instancer.shadowCacheMode = canMove(id) || members.some((m) => canMove(m.id)) ? 'dynamic' : 'static';
            }
        }
        this.runtime.redrawShadows();
    }

    /** Frees the shapes and materials no object shows any more. */
    private sweep() {
        this.sweepGeometries();
        this.sweepMaterials();
    }

    /** The shared geometry of a shape. */
    private geometryFor(key: string, doc: GeometryDoc): GeometryBase {
        let g = this.geometries.get(key);
        if (!g) {
            g = buildGeometry(doc);
            this.geometries.set(key, g);
            Reference.getInstance().attached(g, this.geometries);
        }
        return g;
    }

    /** Frees the shapes no object shows any more, once the GPU is done with them. */
    private sweepGeometries() {
        if (!this.geometriesChanged) return;
        this.geometriesChanged = false;
        const ref = Reference.getInstance();
        for (const [key, g] of Array.from(this.geometries)) {
            // Only the map's own reference is left.
            if (ref.getReferenceCount(g) > 1) continue;
            this.geometries.delete(key);
            ref.detached(g, this.geometries);
            this.disposeLater(g);
        }
    }

    /**
     * Destroys every engine object and builds the scene again from the
     * document. Play mode uses this to throw away what scripts changed.
     */
    rebuild() {
        for (const entry of Array.from(this.entries.values())) this.destroy(entry);
        this.groupMembers.clear();
        this.instanced.clear();
        this.dirtyGroups.clear();
        // Scripts had engine access to the shared shapes too: build them again.
        for (const g of this.geometries.values()) {
            Reference.getInstance().detached(g, this.geometries);
            if (!Reference.getInstance().hasReference(g)) this.disposeLater(g);
        }
        this.geometries.clear();
        // And materials (the objects let go of them above).
        for (const rec of this.materials.values()) this.dropMaterial(rec);
        this.materials.clear();
        this.sync();
    }

    /**
     * Loads an asset again after its data was replaced under the same id (a
     * new version of a model from Blender, a reworked texture): models using
     * it are rebuilt and materials showing it are recreated.
     */
    reloadAsset(id: string) {
        this.prefabs.delete(id);
        this.scatterModels.delete(id);
        this.scatterModelsLoaded.delete(id);
        // Group copies are made again too; the models showing them let go as they reload.
        for (const key of Array.from(this.groupPrefabs.keys())) if (key.endsWith(`|${id}`)) this.groupPrefabs.delete(key);
        // Textures take the new data in place.
        this.refreshTexture(id);
        for (const entry of Array.from(this.entries.values())) {
            const node = this.store.node(entry.id);
            if (!node) continue;
            if (entry.model && (entry.model.asset === id || JSON.stringify(node.model?.materials ?? {}).includes(id))) {
                this.dropModel(entry);
                entry.model = null;
            }
            if (node.mesh && JSON.stringify(node.mesh.material).includes(id)) entry.materialKey = '';
        }
        // Materials showing it are made again; their objects move to the new ones.
        for (const [key, rec] of Array.from(this.materials)) {
            if (!key.includes(id)) continue;
            this.materials.delete(key);
            if (!rec.users) this.dropMaterial(rec);
        }
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
            light: null,
            lightType: null,
            lightKey: '',
            model: null,
            particles: null,
            particlesKey: '',
            particlesToken: 0,
            mirror: null,
            grass: null,
            grassBuild: '',
            grassPlaced: '',
            rain: null,
            instancer: null,
            group: '',
            terrain: null,
            scatter: null,
        };
        this.entries.set(node.id, entry);
        this.owner.set(obj, node.id);
    }

    private parent(node: NodeDoc) {
        const entry = this.entries.get(node.id)!;
        if (this.detached.has(node.id)) return;
        if (entry.parent === node.parent && entry.obj.transform.parent) return;
        // Leaving the scene turns the engine's renderers off for good
        // (RenderNode.onDisable), and a move takes an object out first.
        const moved = !!entry.obj.transform.scene3D;
        const parentObj = node.parent ? this.entries.get(node.parent)?.obj : null;
        (parentObj ?? this.runtime.scene).addChild(entry.obj);
        entry.parent = node.parent;
        if (moved) this.reshow(node.id);
    }

    /** Turns the renderers of an object and of the objects under it on again as they are shown. */
    private reshow(id: string) {
        for (const nid of [id, ...this.store.descendants(id).map((n) => n.id)]) {
            const e = this.entries.get(nid);
            if (!e) continue;
            this.setEnabled(e, e.visible, true);
            if (e.instancer) e.instancer.enable = true;
        }
    }

    private destroy(entry: Entry) {
        this.entries.delete(entry.id);
        if (entry.geometry) this.geometriesChanged = true;
        if (entry.material) this.releaseMaterial(entry.material);
        entry.material = null;
        if (entry.model) {
            entry.model.token = -1;
            entry.model.overrides?.dispose();
            entry.model.release?.();
        }
        if (entry.group) this.dirtyGroups.add(entry.group);
        if (entry.instancer) this.dirtyGroups.add(entry.id);
        entry.grass?.remove((res) => this.disposeLater(res));
        entry.grass = null;
        this.grasses.delete(entry);
        this.applyRain(entry, undefined);
        this.waters.delete(entry);
        if (entry.terrain) this.dropTerrain(entry);
        if (entry.scatter) this.dropScatter(entry);
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
        this.applyAnimation(entry, node.animation);
        this.applyParticles(entry, node.particles);
        this.applyMirror(entry, node);
        this.applyGrass(entry, node.grass);
        this.applyRain(entry, node.rain);
        this.applyInstancing(entry, node.instancing);
        this.applyTerrain(entry, node);
        this.applyScatter(entry, node.scatter);
    }

    /** Emitters are built again when their settings change (the simulator bakes its particles). */
    private applyParticles(entry: Entry, p: ParticlesDoc | undefined) {
        const key = p ? JSON.stringify(p) : '';
        if (key === entry.particlesKey) return;
        entry.particlesKey = key;
        const token = ++entry.particlesToken;
        if (entry.particles) {
            entry.obj.removeComponent(ParticleSystem);
            entry.particles = null;
        }
        if (!p) return;
        const texture = p.texture ? this.loadTexture(p.texture, 'color') : this.dotTexture();
        void texture.then((tex) => {
            if (entry.particlesToken !== token || this.entries.get(entry.id) !== entry) return;
            try {
                entry.particles = buildParticles(entry.obj, p, tex ?? this.runtime.engine.res.whiteTexture);
                if (!entry.visible) entry.particles.enable = false;
            } catch (e) {
                console.error('[editor] particle emitter failed', e);
            }
        });
    }

    private dotTexturePromise: Promise<Texture | null> | null = null;

    private dotTexture(): Promise<Texture | null> {
        this.dotTexturePromise ??= (this.runtime.engine.res.loadTexture(dotTextureUrl(), undefined, false, 'srgb') as Promise<Texture>).catch((e) => {
            console.warn('[editor] particle sprite failed', e);
            return null;
        });
        return this.dotTexturePromise;
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
                if (entry.geometry) this.geometriesChanged = true;
                entry.obj.removeComponent(MeshRenderer);
                if (entry.material) this.releaseMaterial(entry.material);
                entry.mesh = null;
                entry.geometry = null;
                entry.material = null;
                entry.materialKind = '';
                entry.geometryKey = '';
                entry.materialKey = '';
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
            // The renderer lets go of the old shape; the sweep frees it if nothing else shows it.
            if (entry.geometry) this.geometriesChanged = true;
            entry.geometry = this.geometryFor(geometryKey, mesh.geometry);
            mr.geometry = entry.geometry;
            entry.geometryKey = geometryKey;
        }

        const kind = this.materialKind(entry, mesh.material);
        const key = this.materialKeyOf(entry, kind, mesh.material);
        if (key !== entry.materialKey || !entry.material) {
            const cur = entry.material;
            if (cur && cur.users === 1 && cur.kind === kind && cur.group === entry.group && !this.materials.has(key) && this.materials.get(cur.key) === cur) {
                // Only this object shows it: change it in place (a drag in the inspector).
                this.materials.delete(cur.key);
                cur.key = key;
                this.materials.set(key, cur);
                this.applyMaterial(cur, mesh.material);
            } else {
                const next = this.acquireMaterial(key, kind, mesh.material, entry.group);
                // Vertex shaders that move vertices cannot use the depth prepass,
                // which draws the undisplaced mesh, and can draw outside the
                // shape's bounds, so the camera's frustum does not cull them.
                // Shaders that read the scene behind them (water) stay out of
                // it too: the scene depth they read is copied from it.
                const moves = kind.startsWith('shader:') && this.shaders.movesVertices(mesh.material.shader!);
                const reads = kind.startsWith('shader:') && this.shaders.readsScene(mesh.material.shader!);
                if (moves || reads) mr.addRendererMask(RendererMask.IgnoreDepthPass);
                else mr.removeRendererMask(RendererMask.IgnoreDepthPass);
                // A surface that shows what lies under it is water: terrains under it are wet along it.
                if (reads) this.waters.add(entry);
                else this.waters.delete(entry);
                mr.frustumCulled = !moves;
                mr.material = next.material;
                entry.material = next;
                if (cur) this.releaseMaterial(cur);
            }
            entry.materialKind = kind;
            entry.materialKey = key;
        }
        mr.castShadow = mesh.castShadow;
        mr.receiveShadow = mesh.receiveShadow;
    }

    private materialKind(entry: Entry, md: MaterialDoc): string {
        // A mirror with a built-in material shows the reflection, tinted by its color.
        if (md.type !== 'shader') return this.store.node(entry.id)?.mirror ? 'mirror' : md.type;
        const id = md.shader;
        if (id && this.shaders.isValid(id)) return `shader:${id}:${this.shaders.version(id)}`;
        // While a first version compiles, keep the current look, or show a
        // plain lit material: magenta is for shaders that failed.
        if (id && this.shaders.status(id).state === 'compiling') return entry.material ? entry.materialKind : 'lit';
        return 'shader-missing';
    }

    /**
     * The key of an object's material among the shared ones: its kind and
     * fields (not the slot it is linked to, which looks the same); for an
     * object with scripts, a behavior tree or a mirror (which binds its
     * reflection into it), the object itself; and its instancing group,
     * whose instancer compiles the materials it draws for itself.
     */
    private materialKeyOf(entry: Entry, kind: string, md: MaterialDoc): string {
        const node = this.store.node(entry.id);
        const own = !!node && (!!node.scripts?.length || !!node.agent || !!node.mirror);
        const { slot: _slot, ...look } = md;
        return `${kind}|${JSON.stringify(look)}${own ? `#${entry.id}` : ''}${entry.group ? `@${entry.group}` : ''}`;
    }

    /** The shared material of a key, made (and filled in from `md`) when no object shows it yet. */
    private acquireMaterial(key: string, kind: string, md: MaterialDoc, group: string): SharedMaterial {
        let rec = this.materials.get(key);
        if (!rec) {
            const ctx = this.runtime.engine.context3D;
            let mat: Material | null = kind.startsWith('shader:') ? this.shaders.createMaterial(md.shader!) : null;
            if (!mat) {
                if (kind === 'shader-missing') mat = errorMaterial(ctx);
                else if (kind === 'mirror') mat = new MirrorMaterial(ctx);
                else mat = createBuiltinMaterial(kind === 'unlit' || kind === 'lambert' ? kind : 'lit', ctx);
            }
            rec = { key, kind, material: mat, maps: new MaterialMaps(mat, ctx, (id, role) => this.loadTexture(id, role)), paramAssets: {}, users: 0, group };
            Reference.getInstance().attached(mat, this.materials);
            this.materials.set(key, rec);
            this.applyMaterial(rec, md);
        }
        rec.users++;
        return rec;
    }

    /** An object stops showing a material; the sweep frees it once none does. */
    private releaseMaterial(rec: SharedMaterial) {
        rec.users--;
        this.materialsChanged = true;
        // Made again for a reloaded asset: nobody can get it any more.
        if (rec.users <= 0 && this.materials.get(rec.key) !== rec) this.dropMaterial(rec);
    }

    private sweepMaterials() {
        if (!this.materialsChanged) return;
        this.materialsChanged = false;
        for (const [key, rec] of Array.from(this.materials)) {
            if (rec.users > 0) continue;
            this.materials.delete(key);
            this.dropMaterial(rec);
        }
    }

    /** Frees a material once the GPU is done with it, unless something else still shows it. */
    private dropMaterial(rec: SharedMaterial) {
        const ref = Reference.getInstance();
        if (!ref.hasReference(rec.material)) return;
        ref.detached(rec.material, this.materials);
        if (!ref.hasReference(rec.material)) this.disposeLater(rec.material);
    }

    private applyMaterial(rec: SharedMaterial, md: MaterialDoc) {
        const mat = rec.material;
        const kind = rec.kind;
        if (kind === 'shader-missing') return;
        if (kind === 'mirror') {
            mat.baseColor = hexToColor(md.color);
            mat.doubleSide = !!md.doubleSide;
            return;
        }
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
            for (const { name, asset, role } of assets) {
                if (rec.paramAssets[name] === asset) continue;
                rec.paramAssets[name] = asset;
                this.loadTexture(asset, role).then((tex) => {
                    if (tex && rec.paramAssets[name] === asset) sh.setTexture(name, tex);
                });
            }
        }
        mat.doubleSide = !!md.doubleSide;
        applyAlpha(mat, engineAlpha(md.alphaMode, opacity), clamp01(md.alphaCutoff ?? 0.5));
        applyUVTransform(mat, md.tiling, md.offset);

        for (const map of mat instanceof LitMaterial ? PBR_MAPS : [BASE_MAP]) rec.maps.set(map, md[map.key] ?? null);
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
        const tint = light.type === 'directional' ? this.sunlightTint(entry.id) : null;
        if (tint) this.tintedLight = entry.id;
        else if (this.tintedLight === entry.id) this.tintedLight = null;
        const key = JSON.stringify([light, tint]);
        if (key === entry.lightKey) return;
        entry.lightKey = key;
        const l = entry.light!;
        const c = hexToColor(light.color);
        if (tint) {
            c.r *= tint.color[0];
            c.g *= tint.color[1];
            c.b *= tint.color[2];
        }
        l.lightColor = c;
        l.intensity = Math.max(0, light.intensity) * (tint?.strength ?? 1);
        l.castShadow = !!light.castShadow;
        setLightShadow(l, light.shadow);
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
        // In an instancing group it shows the group's copy of the file's materials.
        const group = entry.group;
        if (entry.model && entry.model.asset === model.asset && entry.model.group === group) {
            this.applyModelOverrides(entry, model);
            return;
        }
        if (entry.model) this.dropModel(entry);
        const token = ++loadToken;
        const state: ModelState = { asset: model.asset, token, obj: null, status: 'loading', info: null, overrides: null, key: '', group };
        entry.model = state;
        (group ? this.loadGroupPrefab(model.asset, group, state) : this.loadPrefab(model.asset))
            .then((prefab) => {
                if (state.token !== token || this.entries.get(entry.id) !== entry) return;
                const instance = prefab.clone();
                instance.name = prefab.name || 'model';
                entry.obj.addChild(instance);
                castGI(instance);
                state.obj = instance;
                state.status = 'ready';
                // Outside an instancing group (which draws all its copies at one level), parts get simpler levels far away.
                if (!group) void this.modelLods.add(staticRenderers(instance), () => entry.model === state && this.entries.get(entry.id) === entry);
                const ctx = this.runtime.engine.context3D;
                try {
                    state.info = inspectModel(instance, ctx);
                    state.overrides = new ModelOverrides(state.info, {
                        shaders: this.shaders,
                        loadTexture: (id, role) => this.loadTexture(id, role),
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
                this.applyAnimation(entry, this.store.node(entry.id)?.animation);
                this.setEnabled(entry, entry.visible, true);
                this.runtime.gi.invalidate();
                // Its group draws it with the others, and a field of grass or a scatter may stand on it.
                this.flushGroups();
                this.placeGrass();
                this.schedulePlaceScatters();
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

    /** The clip a model shows in the editor, moving while previewed (Play drives it: play/animation.ts). */
    private applyAnimation(entry: Entry, doc: AnimationDoc | undefined) {
        const st = entry.model;
        const a = st?.info?.animator;
        if (!st?.info || !a || this.store.playing) return;
        const clip = doc?.clip && st.info.clips.includes(doc.clip) ? doc.clip : st.info.clips[0];
        const preview = doc?.preview ?? true;
        // Without the preview it holds the clip's first frame.
        if (clip !== st.clip || !preview) a.playAnim(clip);
        st.clip = clip;
        a.timeScale = preview ? (doc?.speed ?? 1) : 0;
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
        m.release?.();
        m.release = undefined;
        if (entry.group) this.dirtyGroups.add(entry.group);
        if (m.obj) {
            m.obj.removeFromParent();
            m.obj.destroy();
        }
    }

    // --------------------------------------------------------------- mirror

    /** A mesh with a mirror reflects the scene in the plane through its top. */
    private applyMirror(entry: Entry, node: NodeDoc) {
        const doc = node.mesh ? node.mirror : undefined;
        if (!doc) {
            if (entry.mirror) {
                entry.obj.removeComponent(MirrorComponent);
                entry.mirror = null;
            }
            return;
        }
        if (!entry.mirror) {
            entry.mirror = entry.obj.addComponent(MirrorComponent);
            if (!entry.visible) entry.mirror.enable = false;
        }
        // Weaker tiers capture fewer pixels.
        entry.mirror.resolutionScale = doc.resolution * QUALITY[this.runtime.qualityLevel].mirrorScale;
        // The top of its shape: a plane's face, a box's top.
        entry.mirror.surfaceOffset = shapeTop(node.mesh!.geometry);
    }

    // ----------------------------------------------------------------- rain

    /** The light whose color the air tinted last (the key light while the sky follows it). */
    private tintedLight: string | null = null;

    /** The objects with rain; their volumes follow them every frame (rainFrame). */
    private rains = new Set<Entry>();
    /** The objects with grass (their chunks follow the camera every frame). */
    private grasses = new Set<Entry>();
    /** Renderers of models placed one by one that draw simpler levels far away. */
    private modelLods = new ModelLods();
    /** The objects whose material shows what lies under them (water): terrains under them are wet. */
    private waters = new Set<Entry>();
    private rainFrame: (() => void) | null = null;

    private applyRain(entry: Entry, doc: RainDoc | undefined) {
        if (!doc) {
            if (entry.rain) {
                entry.rain.remove();
                entry.rain = null;
                this.rains.delete(entry);
            }
            if (!this.rains.size && this.rainFrame) {
                this.rainFrame();
                this.rainFrame = null;
            }
            return;
        }
        if (!entry.rain) {
            this.shaders.ensure(RAIN_SHADER);
            entry.rain = new RainVolume(this.runtime.scene, this.shaders);
            this.rains.add(entry);
            this.rainFrame ??= this.runtime.onFrame(() => this.updateRain());
        }
        this.updateRain(entry);
    }

    /** Places the rain volumes where their objects, shelters and lights are now. */
    private updateRain(only?: Entry) {
        for (const entry of only ? [only] : this.rains) {
            const node = this.store.node(entry.id);
            if (!node?.rain || !entry.rain) continue;
            const doc = node.rain;
            const p = entry.obj.transform.worldPosition;
            const shelter = doc.shelter ? this.entries.get(doc.shelter) : undefined;
            const lightNode = doc.light ? this.store.node(doc.light) : undefined;
            const light = lightNode?.light ? this.entries.get(lightNode.id) : undefined;
            let lightAt = null;
            if (light && lightNode?.light) {
                const q = light.obj.transform.worldPosition;
                lightAt = { at: [q.x, q.y, q.z] as [number, number, number], color: lightNode.light.color, range: lightNode.light.type === 'directional' ? 1000 : lightNode.light.range };
            }
            entry.rain.update(doc, { center: [p.x, p.y, p.z], shelter: shelter ? objectWorldBox(shelter.obj) : null, light: lightAt }, entry.visible);
        }
    }

    // ---------------------------------------------------------------- grass

    /** Makes (again, when its blades or their width changed) and updates a field of grass. */
    private applyGrass(entry: Entry, doc: GrassDoc | undefined) {
        const build = doc ? JSON.stringify([doc.count, doc.width]) : '';
        if (entry.grass && build !== entry.grassBuild) {
            entry.grass.remove((res) => this.disposeLater(res));
            entry.grass = null;
            this.grasses.delete(entry);
        }
        entry.grassBuild = build;
        if (!doc) {
            entry.grassPlaced = '';
            return;
        }
        if (!entry.grass) {
            entry.grass = new GrassField(this.runtime.scene, doc);
            entry.grass.setVisible(entry.visible);
            entry.grass.setLodScale(QUALITY[this.runtime.qualityLevel].lodDistance);
            this.grasses.add(entry);
            entry.grassPlaced = '';
        }
        const field = entry.grass;
        field.apply(this.windOn(doc));
        const ctx = this.runtime.engine.context3D;
        this.gusts ??= gustTexture(ctx);
        const blade = doc.texture ? this.loadTexture(doc.texture, 'color') : Promise.resolve(null);
        const gusts = doc.windMap ? this.loadTexture(doc.windMap, 'data') : Promise.resolve(null);
        // Plain until its textures are there.
        if (!field.hasTextures) field.setTextures(plainBlades(ctx), this.gusts);
        void Promise.all([blade, gusts]).then(([b, g]) => {
            if (entry.grass !== field) return;
            const now = this.store.node(entry.id)?.grass;
            if (!now || now.texture !== doc.texture || now.windMap !== doc.windMap) return;
            field.setTextures(b ?? plainBlades(ctx), g ?? this.gusts!);
        });
    }

    /**
     * Places the blades of the fields whose placement changed: their
     * object moved, their area or ground changed, or their ground moved,
     * changed or loaded. `ids`: only the objects that changed (a drag),
     * else every field is looked at.
     */
    private placeGrass(ids?: readonly string[]) {
        for (const entry of this.entries.values()) {
            const doc = entry.grass ? this.store.node(entry.id)?.grass : undefined;
            if (!doc) continue;
            if (ids && !ids.some((id) => id === entry.id || (!!doc.ground && this.isUnder(id, doc.ground)))) continue;
            const ground = doc.ground ? this.groundRenderers(doc.ground) : null;
            const lands = doc.ground ? this.groundTerrains(doc.ground) : [];
            const m = entry.obj.transform.worldMatrix.rawData;
            const key = JSON.stringify([
                doc.size, doc.count, doc.ground, doc.heights, doc.widths, doc.sizes, doc.shapes, doc.shapeSpread, doc.curvature, doc.patchSize, doc.height, Array.from(m, (v) => +v.toFixed(4)),
                ground?.map((r) => [r.geometry?.instanceID, Array.from(r.object3D.transform.worldMatrix.rawData, (v) => +v.toFixed(4))]),
                lands.map((l) => [l.id, l.version]),
                // Where it grows follows the layers, what stands on them and the water.
                lands.length ? this.groundKey : null,
            ]);
            if (key === entry.grassPlaced) continue;
            entry.grassPlaced = key;
            const frame = fieldFrame(m);
            const grid = ground?.length ? new GroundGrid(ground, fieldArea(frame, doc.size)) : null;
            const states = [...this.terrainStates].filter((t) => lands.some((l) => l.id === t.view.id));
            // The steepest ground blades stand on: a little past the field's own limit, which thins them out before it.
            const slope = Math.cos((Math.min(85, doc.maxSlope + 5) * Math.PI) / 180);
            const grow = this.grassGrowth(states, doc, hashString(entry.id));
            const surface = grid || lands.length ? new LayeredGround(grid, lands.map((l) => l.surface), slope) : doc.ground ? new LayeredGround(null, []) : null;
            entry.grass!.place(doc, frame, surface, hashString(entry.id), grow);
        }
    }

    /** Whether `id` is `ancestor` or under it. */
    private isUnder(id: string, ancestor: string): boolean {
        for (let n = this.store.node(id); n; n = n.parent ? this.store.node(n.parent) : undefined) if (n.id === ancestor) return true;
        return false;
    }

    /** The shown terrains of a ground object and of the objects under it. */
    groundTerrains(id: string): { id: string; surface: TerrainSurface; version: number }[] {
        const ids = new Set([id, ...this.store.descendants(id).map((n) => n.id)]);
        return this.terrains().filter((t) => ids.has(t.id));
    }

    /** The shown meshes of a ground object and of the objects under it (not skinned ones, which move). */
    private groundRenderers(id: string): RenderNode[] {
        const out: RenderNode[] = [];
        for (const nid of [id, ...this.store.descendants(id).map((n) => n.id)]) {
            if (!this.entries.get(nid)?.visible) continue;
            for (const r of this.renderersOf(nid)) if (!(r instanceof SkinnedMeshRenderer) && !(r instanceof SkinnedMeshRenderer2)) out.push(r);
        }
        return out;
    }

    // -------------------------------------------------------------- terrain

    /** Where a terrain lies: its object's world position (it does not turn or scale), its size and height. */
    private terrainFrame(entry: Entry, doc: TerrainDoc): TerrainFrame {
        const m = entry.obj.transform.worldMatrix.rawData;
        return { x: m[12], y: m[13], z: m[14], sizeX: Math.max(0.1, doc.size[0]), sizeZ: Math.max(0.1, doc.size[1]), height: doc.height };
    }

    /** Makes, rebuilds (a new map, size, height or detail) or updates a terrain. */
    private applyTerrain(entry: Entry, node: NodeDoc) {
        const doc = node.terrain;
        if (!doc) {
            if (entry.terrain) this.dropTerrain(entry);
            return;
        }
        let t = entry.terrain;
        if (!t) {
            const view = new TerrainView(this.runtime.scene, this.runtime.engine.context3D, entry.id);
            view.material.setAnisotropy(QUALITY[this.runtime.qualityLevel].anisotropy);
            t = entry.terrain = { view, built: '', shape: '', paint: '', layers: '', token: 0, watched: [], version: 0, wet: '', paintData: null };
            this.terrainStates.add(t);
            view.setVisible(entry.visible);
        }
        const state = t;
        state.view.setShadows(doc.castShadow);
        state.view.material.setLook(doc.blending, doc.variation, QUALITY[this.runtime.qualityLevel].terrainFar);
        state.view.material.setCompressed(doc.compress);
        state.view.material.setRelief(doc.relief, QUALITY[this.runtime.qualityLevel].terrainRelief);
        state.wet = '';
        const built = JSON.stringify([doc.heightmap, doc.size, doc.height, doc.detail]);
        if (built !== state.built) {
            state.built = built;
            const token = ++state.token;
            const meta = doc.heightmap ? this.store.doc.assets.find((a) => a.id === doc.heightmap) : undefined;
            const load = (meta ? heightmapOf(meta) : Promise.resolve(flatMap())).catch((e) => {
                console.warn(`[editor] the heightmap of "${node.name}" could not be read`, e);
                return flatMap();
            });
            const shape = JSON.stringify([doc.size, doc.height, doc.detail]);
            const done = load.then((map) => {
                if (state.token !== token || entry.terrain !== state) return;
                const now = this.store.node(entry.id)?.terrain ?? doc;
                // A stroke saved the heights the chunks show already: nothing to build.
                if (map === state.view.map && shape === state.shape) {
                    this.placeTerrain(entry, this.store.node(entry.id) ?? node);
                    return;
                }
                state.shape = shape;
                state.view.build(map, this.terrainFrame(entry, now), now.detail);
                state.view.setShadows(now.castShadow);
                state.view.setVisible(entry.visible);
                this.terrainMoved(entry);
            });
            this.terrainLoads.add(done);
            void done.finally(() => this.terrainLoads.delete(done));
        } else this.placeTerrain(entry, node);
        this.applyTerrainPaint(entry, state, doc);
        this.applyTerrainLayers(entry, state, doc);
    }

    /** Moves a terrain with its object (its chunks stay as they are). */
    private placeTerrain(entry: Entry, node: NodeDoc) {
        const t = entry.terrain;
        if (!t || !node.terrain) return;
        const frame = this.terrainFrame(entry, node.terrain);
        const f = t.view.frame;
        if (frame.x === f.x && frame.y === f.y && frame.z === f.z) return;
        t.view.place(frame);
        this.terrainMoved(entry);
    }

    /** After a terrain's heights or place changed: what stands on it follows. */
    private terrainMoved(entry: Entry) {
        if (entry.terrain) entry.terrain.version++;
        this.runtime.gi.invalidate();
        this.placeGrass();
        this.schedulePlaceScatters();
        this.shareTerrain();
        this.emit('terrain', entry.id);
    }

    /**
     * The heights of a terrain changed in place (a sculpt stroke): its
     * chunks in the region are written again; `live` (while the stroke
     * goes on) leaves what stands on it until the stroke ends.
     */
    terrainEdited(id: string, region: { x0: number; z0: number; x1: number; z1: number }, live = false) {
        const entry = this.entries.get(id);
        if (!entry?.terrain) return;
        entry.terrain.view.refresh(region);
        if (!live) this.terrainMoved(entry);
    }

    /** Shows a terrain's saved paint again (a paint stroke was cancelled). */
    reloadTerrainPaint(id: string) {
        const entry = this.entries.get(id);
        const doc = this.store.node(id)?.terrain;
        if (!entry?.terrain || !doc) return;
        entry.terrain.paint = '\u0000';
        this.applyTerrainPaint(entry, entry.terrain, doc);
    }

    private applyTerrainPaint(entry: Entry, t: TerrainState, doc: TerrainDoc) {
        const key = doc.splatmap ?? '';
        if (key === t.paint) return;
        t.paint = key;
        const meta = doc.splatmap ? this.store.doc.assets.find((a) => a.id === doc.splatmap) : undefined;
        if (!meta) {
            t.view.material.setPaint(null);
            t.paintData = null;
            this.schedulePlaceScatters();
            return;
        }
        const done = paintOf(meta).then(
            (paint) => {
                if (entry.terrain !== t || t.paint !== key) return;
                t.view.material.setPaint(paint);
                t.paintData = paint;
                // Scatters that follow a layer stand where it is painted now.
                this.schedulePlaceScatters();
            },
            (e) => console.warn('[editor] the terrain paint could not be read', e),
        );
        this.terrainLoads.add(done);
        void done.finally(() => this.terrainLoads.delete(done));
    }

    /** The side of a terrain's layer arrays: its largest swatch, 256 to 1024 (and what the quality tier loads). */
    private layerArraySize(doc: TerrainDoc): number {
        let side = 256;
        for (const l of doc.layers) {
            const meta = l.albedo ? this.store.doc.assets.find((a) => a.id === l.albedo) : undefined;
            side = Math.max(side, meta?.width ?? 0, meta?.height ?? 0);
        }
        const cap = Math.min(1024, Number.isFinite(this.textureMaxSize) ? this.textureMaxSize : 1024);
        return 2 ** Math.round(Math.log2(Math.min(cap, side)));
    }

    private applyTerrainLayers(entry: Entry, t: TerrainState, doc: TerrainDoc) {
        const size = this.layerArraySize(doc);
        // Loose stones are drawn apart (GroundClutter): they leave the arrays as they are.
        const key = JSON.stringify([doc.layers.map(({ debris: _, ...l }) => l), size]);
        if (key === t.layers) return;
        t.layers = key;
        const layers = doc.layers.length ? doc.layers : [];
        void Promise.all(
            layers.map((l) =>
                Promise.all([
                    l.albedo ? this.loadTexture(l.albedo, 'color') : null,
                    l.normal ? this.loadTexture(l.normal, 'normal') : null,
                    l.arm ? this.loadTexture(l.arm, 'data') : null,
                    l.heightMap ? this.loadTexture(l.heightMap, 'data') : null,
                ]),
            ),
        ).then((maps) => {
            if (entry.terrain !== t || t.layers !== key) return;
            for (const tex of t.watched) tex.unBindStateChange(t);
            t.watched = [];
            const list: MaterialLayer[] = layers.map((l, i) => ({
                albedo: maps[i][0],
                normal: maps[i][1],
                arm: maps[i][2],
                heightMap: maps[i][3],
                tile: l.tile,
                color: l.color,
                roughness: l.roughness,
                height: l.height,
                slope: l.slope,
                heightBlend: l.heightBlend,
                slopeBlend: l.slopeBlend,
                onlyPainted: l.onlyPainted,
            }));
            t.view.setLayers(list, size);
            // A refilled texture (its compressed copy arrived) is drawn into the arrays again.
            let queued = false;
            const refill = () => {
                if (queued) return;
                queued = true;
                queueMicrotask(() => {
                    queued = false;
                    if (entry.terrain === t && t.layers === key) t.view.material.rebuildArrays(list, size);
                });
            };
            for (const four of maps) {
                for (const tex of four) {
                    if (!tex) continue;
                    tex.bindStateChange(refill, t);
                    t.watched.push(tex);
                }
            }
        });
    }

    private dropTerrain(entry: Entry) {
        const t = entry.terrain!;
        t.token++;
        for (const tex of t.watched) tex.unBindStateChange(t);
        t.view.dispose();
        this.terrainStates.delete(t);
        entry.terrain = null;
        this.placeGrass();
        this.schedulePlaceScatters();
        this.shareTerrain();
        this.emit('terrain', entry.id);
    }

    /** Hands the largest shown terrain to the material shaders that read its heights (water over it). */
    private shareTerrain() {
        let best: TerrainState | null = null;
        let area = 0;
        for (const t of this.terrainStates) {
            if (!this.entries.get(t.view.id)?.visible) continue;
            const a = t.view.frame.sizeX * t.view.frame.sizeZ;
            if (a > area) {
                area = a;
                best = t;
            }
        }
        const key = best ? `${best.view.id}|${best.version}` : '';
        if (key === this.sharedTerrain) return;
        this.sharedTerrain = key;
        if (!best) {
            this.shaders.setTerrain(null);
            return;
        }
        const { map, frame: f } = best.view;
        this.shaders.setTerrain({ width: map.width, depth: map.height, data: map.data, x: f.x, z: f.z, sizeX: f.sizeX, sizeZ: f.sizeZ, y: f.y, height: f.height });
    }

    /** The terrains shown, with their heights (flat while their map loads): for rays, ground, physics and navigation. */
    terrains(): { id: string; surface: TerrainSurface; collide: boolean; version: number }[] {
        const out: { id: string; surface: TerrainSurface; collide: boolean; version: number }[] = [];
        for (const t of this.terrainStates) {
            const e = this.entries.get(t.view.id);
            if (!e || !e.visible || this.detached.has(e.id)) continue;
            out.push({ id: e.id, surface: t.view.surface, collide: this.store.node(e.id)?.terrain?.collide !== false, version: t.version });
        }
        return out;
    }

    /** The highest terrain ground at world x, z (shown terrains only), or null where none lies. */
    terrainHeightAt(x: number, z: number): number | null {
        let best: number | null = null;
        for (const t of this.terrains()) {
            if (!covers(t.surface, x, z)) continue;
            const y = groundHeight(t.surface, x, z);
            if (best === null || y > best) best = y;
        }
        return best;
    }

    /** A terrain's engine side, for sculpting it live. */
    terrainView(id: string): TerrainView | null {
        return this.entries.get(id)?.terrain?.view ?? null;
    }

    // -------------------------------------------------------------- scatter

    /** A scatter's copies are placed (again) shortly, once its source models are there. */
    private applyScatter(entry: Entry, doc: ScatterDoc | undefined) {
        if (!doc) {
            if (entry.scatter) this.dropScatter(entry);
            return;
        }
        if (!entry.scatter) {
            const view = new ScatterView(this.runtime.scene, this.runtime.engine.context3D, entry.id, this.shaders.terrainTexture());
            view.setLodScale(QUALITY[this.runtime.qualityLevel].lodDistance);
            view.setVisible(entry.visible);
            entry.scatter = { view, placed: '', placements: [], solids: [] };
            this.scatterStates.add(entry.scatter);
        }
        entry.scatter.view.setDrawDistance(doc.distance);
        for (const s of doc.sources) if (s.model) void this.scatterModel(s.model);
        this.schedulePlaceScatters();
    }

    private dropScatter(entry: Entry) {
        entry.scatter!.view.dispose((res) => this.disposeLater(res));
        this.scatterStates.delete(entry.scatter!);
        entry.scatter = null;
        this.runtime.redrawShadows();
        this.emit('scatter', entry.id);
    }

    /** A source model taken apart (loaded once per asset); null when it could not be loaded. */
    private scatterModel(assetId: string): Promise<ScatterModel | null> {
        let p = this.scatterModels.get(assetId);
        if (!p) {
            const made = this.loadPrefab(assetId).then(
                async (prefab) => {
                    const m = new ScatterModel(prefab);
                    // Simpler versions for the cells far from the camera.
                    await m.addLods();
                    return m;
                },
                (e) => {
                    console.warn('[editor] a scatter model could not be loaded', e);
                    return null;
                },
            );
            p = made;
            this.scatterModels.set(assetId, made);
            void made.then((m) => {
                if (this.scatterModels.get(assetId) !== made) return;
                this.scatterModelsLoaded.set(assetId, m);
                this.schedulePlaceScatters();
            });
        }
        return p;
    }

    /** Places the scatters again a moment after the last change: a drag moves their ground many times a second. */
    private schedulePlaceScatters() {
        if (!this.scatterStates.size) return;
        clearTimeout(this.scatterTimer);
        this.scatterPending ??= new Promise<void>((resolve) => (this.scatterRan = resolve));
        this.scatterTimer = window.setTimeout(() => {
            const ran = this.scatterRan;
            this.scatterPending = null;
            this.scatterRan = null;
            try {
                this.placeScatters();
            } catch (e) {
                console.error('[editor] scatter placement failed', e);
            } finally {
                ran?.();
            }
        }, SCATTER_DELAY);
    }

    /**
     * Places the copies of the scatters whose placement changed: their
     * rules, their object's place, their ground (moved, reshaped, loaded),
     * what they avoid, or their source models (loaded).
     */
    private placeScatters() {
        for (const entry of this.entries.values()) {
            const st = entry.scatter;
            const doc = st ? this.store.node(entry.id)?.scatter : undefined;
            if (!st || !doc) continue;
            const models = doc.sources.map((s) => (s.model ? (this.scatterModelsLoaded.get(s.model) ?? null) : null));
            const m = entry.obj.transform.worldMatrix.rawData;
            const ground = doc.ground ? this.groundRenderers(doc.ground) : null;
            const lands = doc.ground ? this.groundTerrains(doc.ground) : [];
            const avoid = this.avoidBoxes(doc.avoid);
            const round = (v: number) => +v.toFixed(3);
            const key = JSON.stringify([
                { ...doc, distance: 0 }, Array.from(m, round),
                ground?.map((r) => [r.geometry?.instanceID, Array.from(r.object3D.transform.worldMatrix.rawData, round)]),
                lands.map((l) => [l.id, l.version]),
                // A scatter that follows a layer moves with the layers' rules and paint.
                doc.layer > 0 ? lands.map((l) => [this.store.node(l.id)?.terrain?.layers, this.entries.get(l.id)?.terrain?.paintData ? this.store.node(l.id)?.terrain?.splatmap : null]) : null,
                avoid.map((b) => [b.minX, b.maxX, b.minZ, b.maxZ].map(round)),
                models.map((x) => !!x),
            ]);
            if (key === st.placed) continue;
            st.placed = key;
            this.scatterVersion++;
            const frame = fieldFrame(m);
            const grid = ground?.length ? new GroundGrid(ground, fieldArea(frame, doc.size)) : null;
            const layered = grid || lands.length ? new LayeredGround(grid, lands.map((l) => l.surface)) : null;
            // With a ground object copies stand only where it is; without one, flat at the object's height.
            const query = doc.ground ? (x: number, z: number) => layered?.sample(x, z) ?? null : null;
            st.placements = placeScatter(doc, frame, query, avoid, hashString(entry.id), {
                layers: doc.layer > 0 && lands.length ? (x, z, g) => this.terrainLayersAt(lands, x, z, g) : undefined,
                base: (source, variant) => models[source]?.piece(variant)?.base ?? [],
            });
            st.view.build(st.placements, models, doc.castShadow, (res) => this.disposeLater(res));
            st.solids = scatterSolids(doc, st.placements, models);
            this.runtime.gi.invalidate();
            this.runtime.redrawShadows();
            this.emit('scatter', entry.id);
        }
    }

    /**
     * What lies on and around the ground, once a frame (made again only when
     * what it comes from changes): the contacts of scattered copies on each
     * terrain, the soil and moss of each scatter, and the loose stones near
     * the camera.
     */
    private updateGround(eye: number[]) {
        const tier = QUALITY[this.runtime.qualityLevel];
        const terrains = [...this.terrainStates].filter((t) => this.entries.get(t.view.id)?.visible);
        const land = [this.scatterVersion, ...terrains.map((t) => `${t.view.id}:${t.version}:${t.water}:${this.store.node(t.view.id)?.terrain?.layers.map((l) => [l.debris, l.grass])}`)].join('|');
        // What stands on the terrains and the grass covering them (the ground under far grass takes its color).
        const fields = this.grassOnTerrains(terrains);
        const contactsKey = land + JSON.stringify(fields.map(({ id, doc, m }) => [id, doc.size, doc.count, doc.maxSlope, doc.waterGap, doc.gaps, doc.patchSize, doc.bottomColor, doc.topColor, doc.dryness, doc.distance, Array.from(m, (v) => +v.toFixed(2))]));
        if (contactsKey !== this.contactsKey) {
            this.contactsKey = contactsKey;
            const contacts = this.scatterContacts();
            this.contactMaps.clear();
            for (const t of terrains) {
                const mine = fields.filter((f) => f.lands.includes(t));
                const map = contactMap(t.view.frame, contacts, 512, mine.map((f) => f.cover), (m) => this.contactMaps.set(t, m));
                t.view.material.setContacts(map);
                if (!map) this.contactMaps.delete(t);
                t.view.material.setGrass(mine.length ? grassTint(mine.map((f) => f.doc)) : null);
            }
        }
        const key = land + terrains.map((t) => t.view.material.meansVersion).join();
        if (key !== this.groundKey) {
            this.groundKey = key;
            this.clutter ??= new GroundClutter(this.runtime.scene, this.runtime.engine.context3D);
            this.clutter.setGround(this.clutterGround(terrains), terrains[0]?.view.material.means ?? []);
            // Grass grows where the ground suits it now, its roots in the ground's colors.
            this.placeGrass();
            for (const entry of this.entries.values()) {
                if (!entry.grass) continue;
                const frame = fieldFrame(entry.obj.transform.worldMatrix.rawData);
                const doc = this.store.node(entry.id)?.grass;
                const pts: [number, number][] = [];
                if (doc) for (let i = 0; i < 16; i++) pts.push([frame.origin[0] + (((i % 4) + 0.5) / 4 - 0.5) * doc.size[0], frame.origin[2] + ((Math.floor(i / 4) + 0.5) / 4 - 0.5) * doc.size[1]]);
                const c = this.groundColor(terrains, pts);
                if (c) entry.grass.setGroundColor(c);
            }
        }
        this.clutter?.update(eye, tier.clutterDistance * tier.lodDistance);
        for (const entry of this.entries.values()) {
            const st = entry.scatter;
            const doc = st ? this.store.node(entry.id)?.scatter : undefined;
            if (st && doc) this.applyRockGround(st, doc, terrains);
        }
    }

    /** The grass fields on these terrains: their ground, and how densely they cover it (see Cover). */
    private grassOnTerrains(terrains: TerrainState[]): { id: string; doc: GrassDoc; m: ArrayLike<number>; lands: TerrainState[]; cover: Cover }[] {
        const out: { id: string; doc: GrassDoc; m: ArrayLike<number>; lands: TerrainState[]; cover: Cover }[] = [];
        for (const entry of this.entries.values()) {
            const doc = entry.grass && entry.visible ? this.store.node(entry.id)?.grass : undefined;
            if (!doc?.ground) continue;
            const ids = new Set(this.groundTerrains(doc.ground).map((l) => l.id));
            const lands = terrains.filter((t) => ids.has(t.view.id));
            if (!lands.length) continue;
            const m = entry.obj.transform.worldMatrix.rawData;
            const { origin: o, x: ax, z: az } = fieldFrame(m);
            const [w, d] = doc.size;
            const grow = this.grassGrowth(lands, doc, hashString(entry.id));
            // Full cover at about twenty blades a square meter, fading over the last meter of the field.
            const dense = Math.min(1, doc.count / Math.max(1, w * d) / 20);
            const reach = [Math.abs(ax[0]) * w + Math.abs(az[0]) * d, Math.abs(ax[2]) * w + Math.abs(az[2]) * d].map((r) => r / 2);
            const cover: Cover = {
                minX: o[0] - reach[0], maxX: o[0] + reach[0], minZ: o[2] - reach[1], maxZ: o[2] + reach[1],
                at: (x, z) => {
                    const u = (x - o[0]) * ax[0] + (z - o[2]) * ax[2], v = (x - o[0]) * az[0] + (z - o[2]) * az[2];
                    const edge = Math.min(w / 2 - Math.abs(u), d / 2 - Math.abs(v));
                    return edge <= 0 ? 0 : Math.min(1, edge) * dense * (grow ? grow(x, z) : 1);
                },
            };
            out.push({ id: entry.id, doc, m, lands, cover });
        }
        return out;
    }

    /** Where scattered copies meet the ground: their trunks, rocks (wider than tall) with a ring of loose stones. */
    private scatterContacts(): Contact[] {
        const out: Contact[] = [];
        for (const entry of this.entries.values()) {
            const st = entry.scatter;
            const doc = st && entry.visible ? this.store.node(entry.id)?.scatter : undefined;
            if (!st || !doc) continue;
            for (const p of st.placements) {
                const model = doc.sources[p.source]?.model;
                const piece = model ? this.scatterModelsLoaded.get(model)?.piece(p.variant) : null;
                if (!piece) continue;
                const c = quatRotate(p.rotation, [piece.trunk.x * p.scale, 0, piece.trunk.z * p.scale]);
                const tall = (piece.max[1] - piece.min[1]) / Math.max(1e-6, piece.max[0] - piece.min[0], piece.max[2] - piece.min[2]);
                out.push({ x: p.position[0] + c[0], z: p.position[2] + c[2], r: piece.trunk.radius * p.scale, ring: tall < 1.5 ? 1 : 0 });
            }
        }
        return out;
    }

    /** The ground loose stones lie on: the terrains shown, their layers' Loose Stones, and rings around rocks; null with none. */
    private clutterGround(terrains: TerrainState[]): ClutterGround | null {
        const lands = terrains.flatMap((t) => {
            const doc = this.store.node(t.view.id)?.terrain;
            const ring = this.contactMaps.get(t);
            return doc && (doc.layers.some((l) => l.debris > 0) || ring) ? [{ t, doc, surface: t.view.surface, ring }] : [];
        });
        if (!lands.length) return null;
        const landAt = (x: number, z: number) => lands.find((l) => covers(l.surface, x, z));
        return {
            at: (x, z) => {
                const l = landAt(x, z);
                return l ? { y: groundHeight(l.surface, x, z), ny: groundNormal(l.surface, x, z)[1] } : null;
            },
            amount: (x, z) => {
                const l = landAt(x, z);
                if (!l) return { amount: 0, layer: 0 };
                const y = groundHeight(l.surface, x, z);
                const slope = (Math.acos(Math.min(1, groundNormal(l.surface, x, z)[1])) * 180) / Math.PI;
                const paint = l.t.paintData;
                const w = layerWeights(l.doc.layers, y, slope, paint ? paintAt(l.surface.frame, paint, x, z) : null);
                let amount = 0, layer = 0;
                w.forEach((v, i) => {
                    amount += v * (l.doc.layers[i]?.debris ?? 0);
                    if (v > w[layer]) layer = i;
                });
                if (l.ring) {
                    const f = l.surface.frame;
                    const i = Math.floor(((x - f.x + f.sizeX / 2) / f.sizeX) * l.ring.width), j = Math.floor(((z - f.z + f.sizeZ / 2) / f.sizeZ) * l.ring.height);
                    if (i >= 0 && j >= 0 && i < l.ring.width && j < l.ring.height) amount += (l.ring.data[(j * l.ring.width + i) * 4 + 1] / 255) * 0.8;
                }
                return { amount, layer };
            },
        };
    }

    /** The mean height of a scatter's copies, meters (what they sway over). */
    private scatterHeight(doc: ScatterDoc, st: ScatterState): number {
        let sum = 0, n = 0;
        for (let k = 0; k < st.placements.length; k += Math.max(1, Math.floor(st.placements.length / 32))) {
            const p = st.placements[k];
            const model = doc.sources[p.source]?.model;
            const piece = model ? this.scatterModelsLoaded.get(model)?.piece(p.variant) : null;
            if (piece) {
                sum += (piece.max[1] - piece.min[1]) * p.scale;
                n++;
            }
        }
        return n ? Math.max(0.1, sum / n) : 1;
    }

    /** The mean color (linear rgb) of the terrains' ground at these points, as their layers show there; null off them or before their colors are read. */
    private groundColor(terrains: TerrainState[], points: [number, number][]): number[] | null {
        const sum = [0, 0, 0];
        let n = 0;
        for (const [x, z] of points) {
            const t = terrains.find((t) => covers(t.view.surface, x, z));
            const w = t && t.view.material.means.length ? this.layersOn(t, x, z) : null;
            if (!t || !w) continue;
            w.forEach((v, i) => {
                const m = t.view.material.means[i];
                if (m) for (let c = 0; c < 3; c++) sum[c] += m[c] * v;
            });
            n++;
        }
        return n ? sum.map((v) => v / n) : null;
    }

    /** How much each layer of a terrain shows at (x, z) on its ground, or null without its document. */
    private layersOn(t: TerrainState, x: number, z: number): number[] | null {
        const doc = this.store.node(t.view.id)?.terrain;
        if (!doc) return null;
        const slope = (Math.acos(Math.min(1, groundNormal(t.view.surface, x, z)[1])) * 180) / Math.PI;
        return layerWeights(doc.layers, groundHeight(t.view.surface, x, z), slope, t.paintData ? paintAt(t.view.surface.frame, t.paintData, x, z) : null);
    }

    /**
     * How well a field's grass grows at (x, z): in its bare patches not at
     * all (Grass.gaps), and on these terrains as their layers let it
     * (TerrainLayer.grass), thinning toward its steepest slope, not under
     * what stands there (the contact map), not under water and bare a gap
     * above it.
     */
    private grassGrowth(lands: TerrainState[], doc: GrassDoc, seed: number): ((x: number, z: number) => number) | undefined {
        const gaps = Math.min(1, Math.max(0, doc.gaps));
        if (!lands.length && !gaps) return undefined;
        const steep = Math.cos((doc.maxSlope * Math.PI) / 180), soft = Math.cos((doc.maxSlope * 0.66 * Math.PI) / 180);
        return (x, z) => {
            let bare = 1;
            if (gaps > 0) {
                const n = patchNoise(x, z, doc.patchSize * 3, seed ^ 0x3c6ef372);
                bare = Math.min(1, Math.max(0, (n - gaps * 0.9 + 0.08) / 0.16));
            }
            const t = lands.find((t) => covers(t.view.surface, x, z));
            if (!t || !bare) return bare;
            const ny = groundNormal(t.view.surface, x, z)[1];
            if (ny <= steep) return 0;
            bare *= Math.min(1, (ny - steep) / Math.max(1e-6, soft - steep));
            const land = this.store.node(t.view.id)?.terrain;
            const w = this.layersOn(t, x, z);
            let g = 0;
            w?.forEach((v, i) => (g += v * (land?.layers[i]?.grass ?? 1)));
            const c = this.contactMaps.get(t);
            if (c) {
                const f = t.view.frame;
                const i = Math.floor(((x - f.x + f.sizeX / 2) / f.sizeX) * c.width), j = Math.floor(((z - f.z + f.sizeZ / 2) / f.sizeZ) * c.height);
                if (i >= 0 && j >= 0 && i < c.width && j < c.height) g *= 1 - c.data[(j * c.width + i) * 4] / 255;
            }
            if (t.water !== null && t.water !== undefined) {
                const y = groundHeight(t.view.surface, x, z);
                g *= Math.min(1, Math.max(0, (y - t.water - doc.waterGap) / 0.4));
            }
            return g * bare;
        };
    }

    /** A scatter's soil (the terrain's colors under its copies), moss and variation. */
    private applyRockGround(st: ScatterState, doc: ScatterDoc, terrains: TerrainState[]) {
        const place = this.shaders.terrainPlace;
        const wind = this.weather?.wind ?? { speed: 5, direction: this.shownEnvironment.clouds.windDirection };
        const key = JSON.stringify([doc.soil, doc.moss, doc.mossColor, doc.vary, doc.sway, wind, st.placements.length, this.groundKey, place.frame.x, place.frame.z, place.frame.w, place.level.x, place.level.y, place.level.z]);
        if (key === st.groundKey) return;
        st.groundKey = key;
        // The soil: the terrains' mean colors where the copies stand (a few of them).
        const step = Math.max(1, Math.floor(st.placements.length / 24));
        const soil = this.groundColor(terrains, st.placements.filter((_, k) => k % step === 0).map((p) => [p.position[0], p.position[2]]));
        const n = soil ? 1 : 0;
        const color = soil ? soil.map((v) => v * 0.85) : linearOf('#6a5c4c');
        st.view.ground.set({
            frame: [place.frame.x, place.frame.y, place.frame.z, place.frame.w],
            level: [place.level.x, place.level.y, place.level.z, doc.vary],
            soil: [color[0], color[1], color[2], n ? doc.soil : 0],
            moss: [...linearOf(doc.mossColor), doc.moss],
            // The wind's way and strength (tops lean more in stronger wind), bent over the copies' mean height.
            sway: [Math.cos((wind.direction * Math.PI) / 180), Math.sin((wind.direction * Math.PI) / 180), doc.sway * Math.max(0.15, Math.min(2.5, wind.speed / 6)), this.scatterHeight(doc, st)],
        });
    }

    /** How much each layer shows on the terrain (of these) whose ground a copy stands on, or null on other ground. */
    private terrainLayersAt(lands: { id: string; surface: TerrainSurface }[], x: number, z: number, g: GroundSample): number[] | null {
        for (const l of lands) {
            if (!covers(l.surface, x, z) || Math.abs(groundHeight(l.surface, x, z) - g.y) > 0.05) continue;
            const doc = this.store.node(l.id)?.terrain;
            if (!doc) continue;
            const paint = this.entries.get(l.id)?.terrain?.paintData;
            const slope = (Math.acos(Math.min(1, Math.max(-1, g.normal[1]))) * 180) / Math.PI;
            return layerWeights(doc.layers, g.y, slope, paint ? paintAt(l.surface.frame, paint, x, z) : null);
        }
        return null;
    }

    /** The x-z boxes of the shown meshes of objects to avoid (and of the objects under them). */
    private avoidBoxes(ids: readonly string[]): AvoidBox[] {
        const out: AvoidBox[] = [];
        for (const id of ids) {
            for (const nid of [id, ...this.store.descendants(id).map((n) => n.id)]) {
                if (!this.entries.get(nid)?.visible) continue;
                for (const r of this.renderersOf(nid)) {
                    const b = rendererWorldBox(r);
                    if (b) out.push({ minX: b.min[0], maxX: b.max[0], minZ: b.min[2], maxZ: b.max[2] });
                }
                const f = this.terrainView(nid)?.frame;
                if (f) out.push({ minX: f.x - f.sizeX / 2, maxX: f.x + f.sizeX / 2, minZ: f.z - f.sizeZ / 2, maxZ: f.z + f.sizeZ / 2 });
            }
        }
        return out;
    }

    /** The shown scatters, for picking. */
    scatterViews(): { id: string; view: ScatterView }[] {
        const out: { id: string; view: ScatterView }[] = [];
        for (const e of this.entries.values()) if (e.scatter && e.visible && !this.detached.has(e.id)) out.push({ id: e.id, view: e.scatter.view });
        return out;
    }

    /** A scatter's engine side. */
    scatterView(id: string): ScatterView | null {
        return this.entries.get(id)?.scatter?.view ?? null;
    }

    /** Where a scatter's copies stand (to turn them into objects). */
    scatterPlacements(id: string): readonly Placement[] {
        return this.entries.get(id)?.scatter?.placements ?? [];
    }

    /** A scatter source model taken apart, once loaded. */
    scatterModelOf(assetId: string): ScatterModel | null {
        return this.scatterModelsLoaded.get(assetId) ?? null;
    }

    /** The solid copies of the shown scatters: what characters, bodies and the navigation mesh run into. */
    scatterSolids(): { id: string; solids: ScatterSolid[] }[] {
        const out: { id: string; solids: ScatterSolid[] }[] = [];
        for (const e of this.entries.values()) {
            if (!e.scatter?.solids.length || !e.visible || this.detached.has(e.id)) continue;
            out.push({ id: e.id, solids: e.scatter.solids });
        }
        return out;
    }

    // ------------------------------------------------------------ instancing

    /** An object with instancing draws the meshes of its group instanced: its own and its children's. */
    private applyInstancing(entry: Entry, doc: InstancingDoc | undefined) {
        if (!doc) {
            if (entry.instancer) {
                entry.obj.removeComponent(InstanceDrawComponent);
                entry.instancer = null;
                // Its members go back to drawing on their own (flushGroups).
                this.dirtyGroups.add(entry.id);
            }
            return;
        }
        if (entry.instancer) return;
        const inst = entry.obj.addComponent(InstanceDrawComponent);
        // The editor hands it its members (flushGroups).
        inst.autoGroup = false;
        // Seen by the GI probes, as its members would be.
        inst.castGI = true;
        entry.instancer = inst;
        this.dirtyGroups.add(entry.id);
    }

    /** Which instancing group each object's meshes are drawn in: its nearest ancestor with instancing, itself included. */
    private assignGroups() {
        const memo = new Map<string, string>();
        const groupOf = (id: string | null): string => {
            if (!id) return '';
            const known = memo.get(id);
            if (known !== undefined) return known;
            const n = this.store.node(id);
            const g = !n ? '' : n.instancing ? n.id : groupOf(n.parent);
            memo.set(id, g);
            return g;
        };
        for (const e of this.entries.values()) {
            const g = groupOf(e.id);
            if (g === e.group) continue;
            if (e.group) this.dirtyGroups.add(e.group);
            if (g) this.dirtyGroups.add(g);
            e.group = g;
        }
    }

    /**
     * Groups the instancing groups that changed again: the renderers each
     * one draws, and the ones it lets go of, which draw on their own again
     * as their objects show them.
     */
    private flushGroups() {
        if (!this.dirtyGroups.size) return;
        const groups = Array.from(this.dirtyGroups);
        this.dirtyGroups.clear();
        for (const id of groups) {
            const inst = this.entries.get(id)?.instancer ?? null;
            const members = inst ? this.membersOf(id) : [];
            const keep = new Set<RenderNode>(members.map((m) => m.r));
            for (const m of this.groupMembers.get(id) ?? []) {
                if (keep.has(m.r)) continue;
                this.instanced.delete(m.r);
                if (!m.r.isDestroyed) m.r.enable = this.shownAlone(m);
            }
            for (const m of members) this.instanced.add(m.r);
            if (members.length) this.groupMembers.set(id, members);
            else this.groupMembers.delete(id);
            inst?.rebuild(members.map((m) => m.r));
        }
    }

    /** The renderers a group draws: shown meshes of its objects that can be instanced (models once they show the group's materials). */
    private membersOf(group: string): GroupMember[] {
        const out: GroupMember[] = [];
        for (const e of this.entries.values()) {
            if (e.group !== group || !e.visible || this.detached.has(e.id)) continue;
            if (e.mesh && !e.mirror && instanceable(e.mesh)) out.push({ r: e.mesh, id: e.id });
            const info = e.model?.group === group ? e.model.info : null;
            const parts = this.store.node(e.id)?.model?.parts ?? {};
            for (const part of info?.parts ?? []) {
                const r = part.renderer;
                if (part.skinned || parts[part.path]?.visible === false || !(r instanceof MeshRenderer) || !instanceable(r)) continue;
                out.push({ r, id: e.id, path: part.path });
            }
        }
        return out;
    }

    /** Whether a renderer an instancer let go of shows on its own: its object is shown, and a model's part is not hidden. */
    private shownAlone(m: GroupMember): boolean {
        if (!this.entries.get(m.id)?.visible) return false;
        return !m.path || this.store.node(m.id)?.model?.parts?.[m.path]?.visible !== false;
    }

    /** Whether a renderer is shown: drawn on its own, or by an instancer. */
    shown(r: RenderNode): boolean {
        return r.enable || this.instanced.has(r);
    }

    /** Instancing groups and what they draw: how many meshes in how many draw calls. */
    instancingOf(id: string): { meshes: number; draws: number } | null {
        const inst = this.entries.get(id)?.instancer;
        return inst ? { meshes: this.groupMembers.get(id)?.length ?? 0, draws: inst.groupCount } : null;
    }

    /**
     * The model's prefab with copies of its materials for an instancing
     * group, shared by the group's instances; `state` lets go of it.
     */
    private loadGroupPrefab(assetId: string, group: string, state: ModelState): Promise<Object3D> {
        const key = `${group}|${assetId}`;
        let rec = this.groupPrefabs.get(key);
        if (!rec) {
            const prefab = this.loadPrefab(assetId).then((base) => {
                const copy = base.clone();
                const ctx = this.runtime.engine.context3D;
                // Parts drawn on their own (skinned, see-through) get copies of
                // their own: the instancer compiles the ones it draws for itself.
                const instanced = new Map<Material, Material>();
                const alone = new Map<Material, Material>();
                copy.traverse((o: Object3D) => {
                    o.components.forEach((c) => {
                        if (!(c instanceof RenderNode) || !c.materials?.length) return;
                        const copies = c instanceof MeshRenderer && instanceable(c) ? instanced : alone;
                        c.materials = c.materials.map((m) => {
                            let k = copies.get(m);
                            if (!k) copies.set(m, (k = cloneMaterial(m, ctx)));
                            return k;
                        });
                    });
                });
                return copy;
            });
            const made = { prefab, users: 0 };
            prefab.catch(() => {
                if (this.groupPrefabs.get(key) === made) this.groupPrefabs.delete(key);
            });
            this.groupPrefabs.set(key, made);
            rec = made;
        }
        const held = rec;
        held.users++;
        state.release = () => {
            if (--held.users > 0) return;
            if (this.groupPrefabs.get(key) === held) this.groupPrefabs.delete(key);
            // Its materials go with it; the file's textures and shapes stay with the file's prefab.
            void held.prefab.then((p) => this.disposeLater(p), () => {});
        };
        return held.prefab;
    }

    // ------------------------------------------------------------ visibility

    setIsolation(ids: Set<string> | null, hideLights = false) {
        this.isolation = ids;
        this.isolateLights = !!ids && hideLights;
        this.updateVisibility();
        this.flushGroups();
        this.runtime.gi.invalidate();
    }

    /** False for nodes isolation hides: the scene around an edited prefab, or all of it in the reference room. */
    inView(id: string): boolean {
        return !this.isolation || this.isolation.has(id);
    }

    /** Shows another environment than the document's until called with null. */
    setEnvironmentOverride(env: EnvironmentDoc | null) {
        this.envOverride = env;
        this.runtime.invalidateEnvironment();
        this.applySkyEnvironment();
        this.refreshKeyLight();
    }

    /** The environment shown: the override's or the document's, as its weather and time of day make it. */
    private get shownEnvironment(): EnvironmentDoc {
        return this.weather?.env ?? this.envOverride ?? this.store.doc.environment;
    }

    /** Whether the sky shown takes its sun from the key light (see Environment.atmosphere.followLight). */
    private followsLight(): boolean {
        const env = this.shownEnvironment;
        return (env.sky === 'atmospheric' || env.sky === 'physical') && env.atmosphere.followLight;
    }

    /**
     * Weather and the time of day (Environment.weather), once a frame: the
     * time passes by its Day Length, and when what it gives changes (at
     * most a few times a second: the sky is drawn again) the sky, key light,
     * grass wind and rain follow. The key light turns with it every frame.
     */
    private updateWeather(eye: number[]) {
        const env = this.envOverride ?? this.store.doc.environment;
        const w = env.weather;
        const now = performance.now();
        if (!w.enable) {
            if (this.weather) {
                this.weather = null;
                this.weatherKey = '';
                this.weatherChanged();
                const key = this.keyLight();
                const entry = key && this.entries.get(key.id);
                if (key && entry) this.applyTransform(entry, key);
            }
            return;
        }
        if (w.time !== this.weatherTime) {
            this.weatherTime = w.time;
            this.weatherStart = now;
        }
        const time = w.cycle > 0 ? (w.time + ((now - this.weatherStart) / 60000 / w.cycle) * 24) % 24 : w.time;
        const key = JSON.stringify([env.weather, env.clouds, env.fog, env.atmosphere, env.sky, Math.round(time * 240)]);
        if (key !== this.weatherKey && (!this.weather || now - this.weatherAt > 200)) {
            this.weatherKey = key;
            this.weatherAt = now;
            this.weather = weatherNow(env, time);
            this.weatherChanged();
        }
        const light = this.keyLight();
        const entry = light && this.entries.get(light.id);
        if (entry && this.weather) {
            const r = this.weather.light.rotation;
            const t = entry.obj.transform;
            if (Math.abs(t.rotationX - r[0]) + Math.abs(t.rotationY - r[1]) + Math.abs(t.rotationZ - r[2]) > 1e-3) t.localRotation = new Vector3(r[0], r[1], r[2]);
        }
        // Rain around the camera, its box resting a little under it.
        const rain = this.weather?.rain ?? 0;
        if (rain > 0) {
            if (!this.weatherRain) {
                this.shaders.ensure(RAIN_SHADER);
                this.weatherRain = new RainVolume(this.runtime.scene, this.shaders);
            }
            const lean = Math.max(-0.5, Math.min(0.5, (this.weather!.wind.speed * Math.cos((this.weather!.wind.direction * Math.PI) / 180)) / 40));
            this.weatherRain.update({ ...defaults(Rain), size: [36, 24, 36], amount: rain, wind: lean }, { center: [eye[0], eye[1] + 4, eye[2]], shelter: null, light: null }, true);
        } else if (this.weatherRain) {
            this.weatherRain.setVisible(false);
        }
    }

    /**
     * The sunlight the clouds get (linear rgb times brightness), when the sky follows the key
     * light: through the thinner air at their height, brighter and more golden at sunset than
     * on the ground, and still there a while after the sun has set below. Null otherwise.
     */
    private cloudSunlight(): [number, number, number] | null {
        const key = this.followsLight() ? this.keyLight() : null;
        const env = this.shownEnvironment;
        if (!key?.light || !env.clouds.enable || this.weather?.night) return null;
        const elevation = this.weather ? this.weather.sun.elevation : (skySunOf(key.rotation).sunY - 0.5) * 180;
        const air = sunlightThroughAir(elevation, env.atmosphere.altitude + env.clouds.bottom + env.clouds.thickness * 0.3);
        const c = hexToColor(key.light.color);
        // Its dimming eased (as eyes adapt to dusk): sunset clouds glow gold and red rather than turning brown.
        const k = Math.max(0, key.light.intensity) * Math.sqrt(air.strength) * (this.weather?.sunlight ?? 1);
        // And its color deepened a little (tone mapping washes bright orange toward white).
        const [r, g, b] = air.color.map((v) => Math.pow(v, 1.4));
        return [c.r * r * k, c.g * g * k, c.b * b * k];
    }

    /** The weather changed: the sky, key light, stars, grass wind and wet ground follow. */
    private weatherChanged() {
        this.runtime.invalidateEnvironment();
        this.runtime.setStars(this.weather?.stars ?? 0);
        this.applySkyEnvironment();
        this.refreshKeyLight();
        for (const entry of this.grasses) {
            const doc = this.store.node(entry.id)?.grass;
            if (doc && entry.grass) entry.grass.apply(this.windOn(doc));
        }
        for (const t of this.terrainStates) t.wet = '';
    }

    /** A grass field's wind as the weather blows it (its own without weather). */
    private windOn(doc: GrassDoc): GrassDoc {
        const wind = this.weather?.wind;
        if (!wind) return doc;
        const k = Math.max(0.2, Math.min(3, wind.speed / 5));
        return { ...doc, wind: doc.wind * k, windSpeed: doc.windSpeed * k, windDirection: wind.direction };
    }

    /** The key light: the first shown directional light (as apply_key_light picks it). */
    private keyLight(): NodeDoc | null {
        return this.store.doc.nodes.find((n) => n.light?.type === 'directional' && n.visible && this.entries.get(n.id)?.visible !== false) ?? null;
    }

    /** Applies the environment, its sky's sun where the key light comes from when it follows the light. */
    private applySkyEnvironment() {
        const env = this.shownEnvironment;
        // With weather the sky's sun is the sun, wherever the key light (the moon at night) is.
        if (this.weather) {
            this.runtime.applyEnvironment({ ...env, ...skySunOf(this.weather.sun.rotation) });
            return;
        }
        const key = this.followsLight() ? this.keyLight() : null;
        this.runtime.applyEnvironment(key ? { ...env, ...skySunOf(key.rotation) } : env);
    }

    /** Applies the key light again (its color and brightness follow the sky's air), and the light it was before. */
    private refreshKeyLight() {
        const key = this.keyLight();
        const ids = new Set([key?.id, this.tintedLight].filter((x): x is string => !!x));
        for (const id of ids) {
            const node = this.store.node(id);
            const entry = this.entries.get(id);
            if (!node || !entry) continue;
            entry.lightKey = '';
            this.applyLight(entry, node.light);
        }
    }

    /**
     * The key light's color and brightness through the air, when the sky
     * follows it: white and full with the sun high, warmer and dimmer near
     * the horizon, none below it. Null for other lights and skies.
     */
    private sunlightTint(id: string): { color: [number, number, number]; strength: number } | null {
        if (!this.followsLight()) return null;
        const key = this.keyLight();
        if (!key || key.id !== id) return null;
        if (this.weather) return this.weather.light;
        const elevation = (skySunOf(key.rotation).sunY - 0.5) * 180;
        return sunlightThroughAir(elevation, this.shownEnvironment.atmosphere.altitude);
    }

    /** Shows and hides objects as they and their parents are visible (all, or `ids` and what is below them). */
    private updateVisibility(ids?: readonly string[]) {
        if (ids) {
            for (const id of ids) {
                const node = this.store.node(id);
                if (!node) continue;
                let shown = true;
                for (let p = this.store.node(node.parent); p && shown; p = this.store.node(p.parent)) shown = p.visible;
                this.showBranch(node, shown);
            }
            return;
        }
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
            if (entry) this.setEnabled(entry, resolve(node) && (this.inView(node.id) || (!!node.light && !this.isolateLights)));
        }
    }

    private showBranch(node: NodeDoc, parentShown: boolean) {
        const shown = parentShown && node.visible;
        const entry = this.entries.get(node.id);
        if (entry) this.setEnabled(entry, shown && (this.inView(node.id) || (!!node.light && !this.isolateLights)));
        for (const child of this.store.children(node.id)) this.showBranch(child, shown);
    }

    private setEnabled(entry: Entry, visible: boolean, force = false) {
        if (entry.visible === visible && !force) return;
        entry.visible = visible;
        // Its group takes it in or leaves it out, once the change is done (flushGroups).
        if (entry.group) this.dirtyGroups.add(entry.group);
        if (entry.mesh) entry.mesh.enable = visible && !this.instanced.has(entry.mesh);
        if (entry.light) entry.light.enable = visible;
        if (entry.particles) entry.particles.enable = visible;
        if (entry.mirror) entry.mirror.enable = visible;
        entry.grass?.setVisible(visible);
        entry.rain?.setVisible(visible);
        entry.terrain?.view.setVisible(visible);
        entry.scatter?.view.setVisible(visible);
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
        const all = () => [
            ...this.prefabs.values(), ...Array.from(this.groupPrefabs.values(), (g) => g.prefab), ...this.textures.values(), ...this.terrainLoads,
            ...this.scatterModels.values(), ...(this.scatterPending ? [this.scatterPending] : []),
        ];
        for (;;) {
            const pending = all();
            await Promise.allSettled(pending);
            // Loaded models can ask for more textures (their overrides).
            if (all().every((p) => pending.includes(p))) return;
        }
    }

    private loadPrefab(assetId: string): Promise<Object3D> {
        let p = this.prefabs.get(assetId);
        if (!p) {
            p = (async () => {
                const meta = this.store.doc.assets.find((a) => a.id === assetId);
                if (!meta) throw new Error('Model asset is missing from this project.');
                const res = this.runtime.engine.res;
                let prefab: Object3D | null = null;
                const copy = await this.textureSource?.model?.(meta).catch(() => null);
                if (copy) {
                    try {
                        prefab = await res.loadGltf(copy);
                    } catch (e) {
                        console.warn(`[editor] the compressed copy of "${meta.name}" failed, loading the file`, e);
                    }
                }
                if (!prefab) {
                    const url = await getAssetUrl(meta);
                    if (!url) throw new Error(`"${meta.name}" is not stored in this browser.`);
                    prefab = await res.loadGltf(url);
                    this.textureSource?.used?.(meta, 'model');
                }
                normalizeModelMaterials(prefab, this.runtime.engine.context3D);
                // Parts whose bounds hold what they draw are culled when out of view (their copies inherit it).
                prefab.traverse((o: Object3D) => {
                    o.components.forEach((c) => {
                        if (c instanceof MeshRenderer) c.frustumCulled = !(c instanceof SkinnedMeshRenderer || c instanceof SkinnedMeshRenderer2) && !c.morphData?.enable;
                    });
                });
                return prefab;
            })();
            p.catch(() => this.prefabs.delete(assetId));
            this.prefabs.set(assetId, p);
        }
        return p;
    }

    /**
     * The texture of a texture asset for a role: colors are sampled as sRGB,
     * normal and data maps (metallic-roughness, occlusion) as linear. It
     * shows the asset's compressed copy for the role when there is one,
     * else the file itself.
     */
    loadTexture(assetId: string, role: TextureRole = 'color'): Promise<Texture | null> {
        const key = `${assetId}|${role}`;
        let p = this.textures.get(key);
        if (!p) {
            p = (async () => {
                const meta = this.store.doc.assets.find((a) => a.id === assetId);
                if (!meta || meta.kind !== 'texture') return null;
                let tex = this.assetTextures.get(key);
                if (!tex) {
                    tex = new CompressedTexture2D(this.runtime.engine.context3D, role === 'color' ? 'srgb' : 'linear');
                    tex.name = meta.name;
                    tex.maxSize = this.textureMaxSize;
                    tex.maxAnisotropy = QUALITY[this.runtime.qualityLevel].anisotropy;
                    // Known before it has data, so a refresh meanwhile runs after this fill.
                    this.assetTextures.set(key, tex);
                }
                await this.fill(key, tex, assetId, role);
                return tex;
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
     * Shows a texture asset's current data again, in place: after its file
     * was replaced, or when its compressed copy was made or its options
     * changed. Everything showing the texture keeps it.
     */
    refreshTexture(assetId: string, role?: TextureRole) {
        for (const [key, tex] of this.assetTextures) {
            const [id, r] = key.split('|') as [string, TextureRole];
            if (id !== assetId || (role && r !== role)) continue;
            const done: Promise<Texture | null> = this.fill(key, tex, assetId, r).then(
                () => tex,
                (e) => {
                    console.error('[editor] texture reload failed', e);
                    // Never filled: nothing may bind it (a texture without data has no view).
                    if (tex.textureDescriptor) return tex;
                    if (this.textures.get(key) === done) this.textures.delete(key);
                    return null;
                },
            );
            // whenLoaded waits for it.
            this.textures.set(key, done);
        }
    }

    /** Fills a texture with the asset's data for its role; fills of one texture run in order, each with the asset as it is then. */
    private fill(key: string, tex: CompressedTexture2D, assetId: string, role: TextureRole): Promise<void> {
        const run = async () => {
            const meta = this.store.doc.assets.find((a) => a.id === assetId);
            if (!meta || meta.kind !== 'texture') throw new Error('Texture asset is missing from this project.');
            const copy = await this.textureSource?.resolve(meta, role).catch(() => null);
            if (copy) {
                try {
                    await tex.loadKTX2(copy);
                    return;
                } catch (e) {
                    console.warn(`[editor] the compressed copy of "${meta.name}" failed, showing the file`, e);
                }
            }
            const url = await getAssetUrl(meta);
            if (!url) throw new Error(`"${meta.name}" is not stored in this browser.`);
            const res = await fetch(url);
            if (!res.ok && res.status !== 0) throw new Error(`"${meta.name}" failed to load (${res.status}).`);
            const blob = await res.blob();
            if (isKTX2(await blob.slice(0, 12).arrayBuffer())) await tex.loadKTX2(blob);
            else tex.setImage(await decodeImage(blob, this.textureMaxSize));
            this.textureSource?.used?.(meta, role);
        };
        const next = (this.fills.get(key) ?? Promise.resolve()).then(run, run);
        this.fills.set(key, next.catch(() => {}));
        return next;
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

/**
 * An image file decoded as the engine decodes textures (BitmapTexture2D):
 * colors kept under alpha, at least 32 pixels a side, and here at most
 * `maxSize` on the longer side.
 */
async function decodeImage(blob: Blob, maxSize = Infinity): Promise<ImageBitmap> {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
    const k = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
    const width = Math.max(32, Math.round(bmp.width * k));
    const height = Math.max(32, Math.round(bmp.height * k));
    if (width === bmp.width && height === bmp.height) return bmp;
    const out = await createImageBitmap(bmp, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high', premultiplyAlpha: 'none' });
    bmp.close();
    return out;
}

/**
 * The solid copies of a scatter: a trunk stands where its model reaches the
 * ground, as tall as the model; a box is the model's box, turned with the
 * copy (a copy leaning with the ground keeps its box upright).
 */
function scatterSolids(doc: ScatterDoc, placements: readonly Placement[], models: readonly (ScatterModel | null)[]): ScatterSolid[] {
    const out: ScatterSolid[] = [];
    for (const p of placements) {
        const kind = doc.sources[p.source]?.solid;
        const m = models[p.source]?.piece(p.variant);
        if (!m || !kind || kind === 'none' || !(m.max[1] >= m.min[1])) continue;
        const s = p.scale;
        const c = Math.cos(p.yaw), n = Math.sin(p.yaw);
        // A point of the model's x-z plane, turned by the copy's yaw.
        const turn = (x: number, z: number) => [c * x + n * z, -n * x + c * z];
        if (kind === 'trunk') {
            const [dx, dz] = turn(m.trunk.x * s, m.trunk.z * s);
            out.push({
                kind: 'trunk',
                center: [p.position[0] + dx, p.position[1] + m.min[1] * s, p.position[2] + dz],
                size: [m.trunk.radius * s, (m.max[1] - m.min[1]) * s, m.trunk.radius * s],
                yaw: 0,
            });
        } else {
            const [dx, dz] = turn(((m.min[0] + m.max[0]) / 2) * s, ((m.min[2] + m.max[2]) / 2) * s);
            out.push({
                kind: 'box',
                center: [p.position[0] + dx, p.position[1] + ((m.min[1] + m.max[1]) / 2) * s, p.position[2] + dz],
                size: [((m.max[0] - m.min[0]) / 2) * s, ((m.max[1] - m.min[1]) / 2) * s, ((m.max[2] - m.min[2]) / 2) * s],
                yaw: p.yaw,
            });
        }
    }
    return out;
}

function errorMaterial(ctx: any): Material {
    // The classic "shader missing" magenta.
    const mat = new UnLitMaterial(ctx);
    mat.baseColor = new Color(1, 0, 1, 1);
    return mat;
}

/**
 * One draw for a shape made of several contiguous index ranges (a
 * cylinder's side and caps): the editor shows it with one material, so
 * drawing the parts apart only costs draw calls, in every pass.
 */
function oneRange(g: GeometryBase): GeometryBase {
    const subs = g.subGeometries;
    if (subs.length < 2) return g;
    let start = Infinity, end = 0, total = 0;
    for (const s of subs) {
        const d = s.lodLevels[0];
        if (!d) return g;
        start = Math.min(start, d.indexStart);
        end = Math.max(end, d.indexStart + d.indexCount);
        total += d.indexCount;
    }
    if (end - start !== total) return g;
    subs.length = 0;
    g.addSubGeometry({ indexStart: start, indexCount: total, vertexStart: 0, vertexCount: 0, firstStart: 0, index: 0, topology: 0 });
    return g;
}

/** The renderers under an object that keep their shape (not skinned, not morphing): those that can have simpler levels. */
function staticRenderers(root: Object3D): RenderNode[] {
    const out: RenderNode[] = [];
    root.traverse((o: Object3D) => {
        o.components.forEach((c) => {
            if (!(c instanceof MeshRenderer) || c instanceof SkinnedMeshRenderer || c instanceof SkinnedMeshRenderer2) return;
            if (!c.geometry || (c as any).morphData?.enable) return;
            out.push(c);
        });
    });
    return out;
}

/** How far a shape's top is above its origin (shapes are centered on it): where a mirror on it reflects. */
function shapeTop(g: GeometryDoc): number {
    switch (g.type) {
        case 'plane':
            return 0;
        case 'sphere':
            return g.radius;
        case 'torus':
            return g.tube;
        default:
            return g.height / 2;
    }
}

/** Renderers an instancer can draw: opaque (the instancer draws with the opaque ones), not mirrors, not skinned or morphing. */
function instanceable(r: MeshRenderer): boolean {
    return InstanceDrawComponent.canInstance(r) && r.renderOrder < 3000 && !r.hasMask(MirrorComponent.MIRROR_MASK);
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
            return oneRange(new CylinderGeometry(Math.max(0, g.radiusTop), Math.max(0, g.radiusBottom), pos(g.height), seg(g.segments), 1));
        case 'cone':
            return new ConeGeometry(pos(g.radius), pos(g.height), seg(g.segments));
        case 'torus':
            return new TorusGeometry(pos(g.radius), pos(g.tube), seg(g.segments), seg(g.segments / 2));
        case 'ramp':
            return new RampGeometry(pos(g.width), pos(g.height), pos(g.depth));
        case 'stairs':
            return new StairsGeometry(pos(g.width), pos(g.height), pos(g.depth), seg(g.steps, 1));
        case 'capsule':
            return new CapsuleGeometry(pos(g.radius), pos(g.height), seg(g.segments, 6));
        default:
            return new BoxGeometry(1, 1, 1);
    }
}

/** The color the ground under grass fields takes (linear rgb, as their blades look from afar) and how far they reach, or null. */
function grassTint(fields: GrassDoc[]): { color: number[]; distance: number } {
    const color = [0, 0, 0];
    let area = 0, distance = 0;
    for (const f of fields) {
        const a = f.size[0] * f.size[1];
        const lo = hexToColor(f.bottomColor), hi = hexToColor(f.topColor);
        const c = [lo.r + (hi.r - lo.r) * 0.6, lo.g + (hi.g - lo.g) * 0.6, lo.b + (hi.b - lo.b) * 0.6];
        // Its dry patches (as the grass shader makes them), on about a third of the field.
        const dry = f.dryness * 0.35;
        const tint = [1 + 0.35 * dry, 1 + 0.1 * dry, 1 - 0.55 * dry];
        for (let k = 0; k < 3; k++) color[k] += c[k] * tint[k] * a;
        area += a;
        distance = Math.max(distance, f.distance);
    }
    return { color: color.map((v) => v / Math.max(area, 1e-6)), distance };
}


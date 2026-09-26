import {
    Engine3D, LitMaterial, Material, Object3D, PassType, RenderNode, Shader, SkinnedMeshRenderer2, Texture, Vector4,
    VertexAttributeName,
} from '@orillusion/core';
import type { MaterialOverride, ModelDoc, PartOverride, SlotShading, Vec3 } from '../core/types';
import { colorToHex, hexToColor } from './color';
import { applyAlpha, applyUVTransform, createBuiltinMaterial, EngineAlpha, engineAlpha, MaterialMaps, BASE_MAP } from './materials';
import { applyProps, MODEL_MAPS, type ShaderManager } from './shaders';

// An imported model is a single document node whose engine object is a
// clone of the parsed glTF prefab. Its meshes ("parts") and materials
// ("slots") are not document nodes; they are enumerated here once the
// model has loaded and edited through per-instance overrides stored in
// ModelDoc.materials / ModelDoc.parts.

export interface SlotValues {
    color: string;
    opacity: number;
    metallic: number;
    roughness: number;
    emissive: string;
    emissiveIntensity: number;
    doubleSide: boolean;
    /** The source material has its own base color texture. */
    hasMap: boolean;
    /** How the file's material handles alpha. */
    alpha: EngineAlpha;
    alphaCutoff: number;
    normalScale: number;
    clearcoat: number;
    clearcoatRoughness: number;
    transmission: number;
    ior: number;
    /** The file's material is the engine's PBR material (the PBR fields apply). */
    pbr: boolean;
}

export interface ModelPart {
    /** Stable key: object names from the model root, e.g. "Body/Mesh_0". */
    path: string;
    name: string;
    /** Object holding the renderer. */
    obj: Object3D;
    /** Object whose transform the part's position / rotation / scale edit. */
    target: Object3D;
    renderer: RenderNode;
    /** Slot key of the material the part has in the file. */
    slot: string;
    /** Index of the part's own material in its slot's `materials`. */
    variant: number;
    /** Skinned renderers need material instances of their own. */
    skinned: boolean;
    vertices: number;
    triangles: number;
    base: { position: Vec3; rotation: Vec3; scale: Vec3; castShadow: boolean; receiveShadow: boolean };
}

export interface ModelSlot {
    key: string;
    /** First material of the slot; its values are the slot's defaults. */
    material: Material;
    /**
     * Every distinct material object with this slot's name. The loader
     * keeps separate copies for skinned and static meshes, so overrides
     * are applied per copy.
     */
    materials: Material[];
    parts: string[];
    base: SlotValues;
}

export interface ModelInfo {
    parts: ModelPart[];
    slots: ModelSlot[];
    part(path: string): ModelPart | undefined;
    slot(key: string): ModelSlot | undefined;
    /** Part path of a renderer, for viewport picking. */
    pathOf(renderer: RenderNode): string | undefined;
}

const UNNAMED = /^[0-9A-F]{16}$/;

/** Current alpha handling of a material, read from its color pass. */
export function alphaOf(mat: Material): EngineAlpha {
    const pass = mat.shader.getDefaultColorShader();
    if (pass.shaderState.transparent) return 'BLEND';
    if (pass.shaderState.alphaToCoverageEnabled || pass.defineValue?.['USE_ALPHACUT']) return 'MASK';
    return 'OPAQUE';
}

function readSlot(mat: Material, white: Texture): SlotValues {
    const sh: any = mat.shader;
    const color = safe(() => sh.getUniformColor('baseColor'));
    const emissive = safe(() => sh.getUniformColor('emissiveColor'));
    const num = (k: string, d: number) => {
        const v = safe(() => sh.getUniformFloat(k));
        return typeof v === 'number' && Number.isFinite(v) ? v : d;
    };
    const map = safe(() => sh.getTexture('baseMap'));
    const cutoff = num('alphaCutoff', 0);
    return {
        color: colorToHex(color),
        opacity: color && Number.isFinite(color.a) ? color.a : 1,
        metallic: num('metallic', 0),
        roughness: num('roughness', 1),
        emissive: colorToHex(emissive ?? { r: 0, g: 0, b: 0 }),
        emissiveIntensity: num('emissiveIntensity', 0),
        doubleSide: !!safe(() => mat.doubleSide),
        hasMap: !!map && map !== white,
        alpha: alphaOf(mat),
        alphaCutoff: cutoff > 0 && cutoff < 1 ? cutoff : 0.5,
        normalScale: num('normalScale', 1),
        clearcoat: num('clearcoatFactor', 0),
        clearcoatRoughness: num('clearcoatRoughnessFactor', 0),
        transmission: num('transmissionFactor', 0),
        ior: num('ior', 1.5),
        pbr: mat instanceof LitMaterial,
    };
}

/** Destroys a shader that shares its textures with other materials, leaving the textures alone. */
function destroyKeepTextures(shader: Shader) {
    for (const list of shader.passShader.values()) {
        for (const pass of list) pass.textures = {};
    }
    shader.destroy();
}

/**
 * Copies a material for per-instance changes. Only the color passes are
 * copied: derived passes (shadow, depth, GI) are rebuilt by the renderer
 * for the new material, and copying them through Shader.clone() fails for
 * pass classes whose constructors take other arguments. A copy of a
 * LitMaterial stays a LitMaterial: the renderer sends transmissive (glass)
 * materials to their own pass by asking for `transmissionFactor`.
 */
export function cloneMaterial(src: Material, ctx?: any): Material {
    const shader = new Shader();
    for (const pass of src.shader.getSubShaders(PassType.COLOR)) shader.addRenderPass(pass.clone());
    let mat: Material;
    if (src instanceof LitMaterial) {
        const lit = new LitMaterial(ctx);
        const unused = lit.shader;
        lit.shader = shader;
        destroyKeepTextures(unused);
        mat = lit;
    } else {
        mat = new Material();
        mat.shader = shader;
    }
    mat.name = src.name;
    mat.oitMode = src.oitMode;
    return mat;
}

function safe<T>(fn: () => T): T | undefined {
    try {
        return fn();
    } catch {
        return undefined;
    }
}

/** Enumerates the renderers and materials of a loaded model instance. */
export function inspectModel(root: Object3D, ctx?: any): ModelInfo {
    const white = Engine3D.resFor(ctx).whiteTexture;
    const parts: ModelPart[] = [];
    const slots: ModelSlot[] = [];
    const slotOf = new Map<Material, string>();
    const byRenderer = new Map<RenderNode, string>();
    let unnamed = 0;

    const slotKey = (mat: Material): string => {
        let key = slotOf.get(mat);
        if (key) return key;
        const name = (mat.name || '').trim();
        key = name && !UNNAMED.test(name) ? name : `Material ${++unnamed}`;
        slotOf.set(mat, key);
        let slot = slots.find((s) => s.key === key);
        if (!slot) {
            slot = { key, material: mat, materials: [], parts: [], base: readSlot(mat, white) };
            slots.push(slot);
        }
        if (!slot.materials.includes(mat)) slot.materials.push(mat);
        return key;
    };

    const walk = (obj: Object3D, prefix: string) => {
        const counts = new Map<string, number>();
        for (const child of obj.entityChildren as Object3D[]) {
            if (!(child instanceof Object3D)) continue;
            const base = (child.name || 'node').replace(/\//g, '_');
            const n = counts.get(base) ?? 0;
            counts.set(base, n + 1);
            const seg = n ? `${base}~${n}` : base;
            const path = prefix ? `${prefix}/${seg}` : seg;
            let k = 0;
            child.components.forEach((c) => {
                if (!(c instanceof RenderNode)) return;
                const r = c as RenderNode;
                const mat = r.materials?.[0];
                if (!r.geometry || !mat) return;
                const p = k++ ? `${path}#${k - 1}` : path;
                const pos = r.geometry.getAttribute(VertexAttributeName.position)?.data;
                const idx = r.geometry.getAttribute(VertexAttributeName.indices)?.data;
                const key = slotKey(mat);
                // The loader puts each primitive in its own child named after
                // the mesh; the glTF node above it has the meaningful name.
                const siblings = (obj.entityChildren as Object3D[]).filter((o) => o instanceof Object3D && Array.from(o.components.values()).some((c) => c instanceof RenderNode));
                const own = obj !== root && !!obj.name && siblings.length === 1;
                const name = own ? obj.name : child.name || 'Mesh';
                // Moving "Head" should move the glTF node (and what hangs below it),
                // not the primitive object inside it.
                const target = own ? obj : child;
                const part: ModelPart = {
                    path: p,
                    name,
                    obj: child,
                    target,
                    renderer: r,
                    slot: key,
                    variant: slots.find((s) => s.key === key)!.materials.indexOf(mat),
                    skinned: r instanceof SkinnedMeshRenderer2,
                    vertices: pos ? Math.floor(pos.length / 3) : 0,
                    triangles: idx ? Math.floor(idx.length / 3) : 0,
                    base: {
                        position: [target.x, target.y, target.z],
                        rotation: [target.rotationX, target.rotationY, target.rotationZ],
                        scale: [target.scaleX, target.scaleY, target.scaleZ],
                        castShadow: r.castShadow,
                        receiveShadow: (r as any).receiveShadow ?? true,
                    },
                };
                parts.push(part);
                slots.find((s) => s.key === key)!.parts.push(p);
                byRenderer.set(r, p);
            });
            walk(child, path);
        }
    };
    walk(root, '');

    const partIndex = new Map(parts.map((p) => [p.path, p]));
    const slotIndex = new Map(slots.map((s) => [s.key, s]));
    return {
        parts,
        slots,
        part: (path) => partIndex.get(path),
        slot: (key) => slotIndex.get(key),
        pathOf: (r) => byRenderer.get(r),
    };
}

function isEmpty(o: object | undefined): boolean {
    return !o || Object.keys(o).length === 0;
}

interface OverrideMaterial {
    material: Material;
    structure: string;
    maps: MaterialMaps;
    /** Asset textures of custom shader params, by property name. */
    paramAssets: Record<string, string>;
}

export interface OverrideDeps {
    shaders: ShaderManager;
    loadTexture(assetId: string, linear?: boolean): Promise<Texture | null>;
    dispose(mat: Material): void;
    ctx: any;
}

/** How a slot is rendered: the file's material, a built-in material, or a custom shader. */
export function slotShading(o: MaterialOverride | undefined, shaders: ShaderManager): SlotShading | 'shader' {
    if (o?.shader && shaders.isValid(o.shader)) return 'shader';
    return o?.shading ?? 'model';
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Applies a ModelDoc's overrides to one loaded model instance. Materials
 * of the file are shared by every instance of the model, so an overridden
 * slot gets its own copy for this instance.
 */
export class ModelOverrides {
    private mats = new Map<string, OverrideMaterial>();
    /** Per slot: index of a material that only static (not skinned) parts use. */
    private staticVariant = new Map<string, number>();

    constructor(readonly info: ModelInfo, private deps: OverrideDeps) {
        const skinnedUse = new Set<Material>();
        for (const part of info.parts) {
            const mat = info.slot(part.slot)?.materials[part.variant];
            if (mat && part.skinned) skinnedUse.add(mat);
        }
        for (const slot of info.slots) {
            const i = slot.materials.findIndex((m) => !skinnedUse.has(m));
            if (i >= 0) this.staticVariant.set(slot.key, i);
        }
    }

    apply(model: ModelDoc, nodeVisible: boolean) {
        const materials = model.materials ?? {};
        const parts = model.parts ?? {};

        const wanted = new Set<string>();
        for (const part of this.info.parts) {
            const po: PartOverride = parts[part.path] ?? {};
            const moved = !!po.material && po.material !== part.slot && !!this.info.slot(po.material);
            const slot = this.info.slot(moved ? po.material! : part.slot)!;
            const mo = materials[slot.key];

            // Which file material the part renders with, and the key of this
            // instance's copy of it. A part moved to another slot must not
            // share a skinned material: a skinned renderer's passes are built
            // for its own geometry and skeleton.
            let source: Material;
            let key: string;
            let copy = !!mo && !isEmpty(mo);
            if (!moved) {
                source = slot.materials[part.variant] ?? slot.material;
                key = `${slot.key}|${part.variant}`;
            } else if (part.skinned) {
                source = slot.material;
                key = `${slot.key}|part|${part.path}`;
                copy = true;
            } else {
                const v = this.staticVariant.get(slot.key);
                source = v !== undefined ? slot.materials[v] : slot.material;
                key = `${slot.key}|${v ?? 'static'}`;
                if (v === undefined) copy = true;
            }

            let mat = source;
            if (copy) {
                if (!wanted.has(key)) {
                    wanted.add(key);
                    this.refreshSlot(key, slot, source, mo ?? {});
                }
                mat = this.mats.get(key)!.material;
            }
            if (part.renderer.materials[0] !== mat) part.renderer.materials = [mat];

            part.renderer.castShadow = po.castShadow ?? part.base.castShadow;
            (part.renderer as any).receiveShadow = po.receiveShadow ?? part.base.receiveShadow;
            const visible = nodeVisible && po.visible !== false;
            if (part.renderer.enable !== visible) part.renderer.enable = visible;

            const p = po.position ?? part.base.position;
            const r = po.rotation ?? part.base.rotation;
            const s = po.scale ?? part.base.scale;
            const o = part.target;
            if (o.x !== p[0] || o.y !== p[1] || o.z !== p[2]) {
                o.x = p[0];
                o.y = p[1];
                o.z = p[2];
            }
            if (o.rotationX !== r[0] || o.rotationY !== r[1] || o.rotationZ !== r[2]) {
                o.rotationX = r[0];
                o.rotationY = r[1];
                o.rotationZ = r[2];
            }
            if (o.scaleX !== s[0] || o.scaleY !== s[1] || o.scaleZ !== s[2]) {
                o.scaleX = nz(s[0]);
                o.scaleY = nz(s[1]);
                o.scaleZ = nz(s[2]);
            }
        }
        for (const [key, om] of Array.from(this.mats)) {
            if (wanted.has(key)) continue;
            this.mats.delete(key);
            this.deps.dispose(om.material);
        }
    }

    /** Only visibility changed: cheaper than a full apply. */
    setVisible(model: ModelDoc, nodeVisible: boolean) {
        const parts = model.parts ?? {};
        for (const part of this.info.parts) {
            const visible = nodeVisible && parts[part.path]?.visible !== false;
            if (part.renderer.enable !== visible) part.renderer.enable = visible;
        }
    }

    dispose() {
        for (const om of this.mats.values()) this.deps.dispose(om.material);
        this.mats.clear();
    }

    /** Builds (when its structure changed) and updates this instance's material for a slot. */
    private refreshSlot(key: string, slot: ModelSlot, source: Material, o: MaterialOverride) {
        const { shaders, ctx } = this.deps;
        const shading = slotShading(o, shaders);
        const shaderId = shading === 'shader' ? o.shader! : null;
        const base = slot.base;
        const opacity = o.opacity ?? base.opacity;
        const structure = JSON.stringify({ shading, shader: shaderId, version: shaderId ? shaders.version(shaderId) : 0 });
        let om = this.mats.get(key);
        if (!om || om.structure !== structure) {
            if (om) this.deps.dispose(om.material);
            let material: Material | null = null;
            if (shaderId) {
                material = shaders.createMaterial(shaderId);
            } else if (shading === 'unlit' || shading === 'lambert') {
                material = createBuiltinMaterial(shading, ctx);
                // Texture repeat and offset as the file has them.
                const uv = safe(() => source.shader.getUniformVector4('baseMapOffsetSize')) as Vector4 | undefined;
                if (uv) applyUVTransform(material, [uv.z, uv.w], [uv.x, uv.y]);
            }
            if (material) {
                // A replacement keeps the file's color texture.
                const map = safe(() => source.shader.getTexture('baseMap'));
                if (map) material.shader.setTexture('baseMap', map);
                material.setDefine('USE_SRGB_ALBEDO', !!source.shader.getDefaultColorShader().defineValue?.['USE_SRGB_ALBEDO']);
            } else {
                material = cloneMaterial(source, ctx);
            }
            material.name = source.name;
            om = { material, structure, maps: new MaterialMaps(material, ctx, (id, linear) => this.deps.loadTexture(id, linear)), paramAssets: {} };
            this.mats.set(key, om);
        }
        const mat = om.material;
        const sh = mat.shader;
        sh.setUniformColor('baseColor', hexToColor(o.color ?? base.color, opacity));
        if (shading === 'model' || shading === 'shader') {
            sh.setUniformFloat('metallic', clamp01(o.metallic ?? base.metallic));
            sh.setUniformFloat('roughness', clamp01(o.roughness ?? base.roughness));
            sh.setUniformColor('emissiveColor', hexToColor(o.emissive ?? base.emissive));
            sh.setUniformFloat('emissiveIntensity', Math.max(0, o.emissiveIntensity ?? base.emissiveIntensity));
        }
        if (mat instanceof LitMaterial && shading === 'model') {
            // Only touch what the override sets: the file's values stay as loaded.
            if (o.normalScale !== undefined) sh.setUniformFloat('normalScale', Math.max(0, o.normalScale));
            if (o.clearcoat !== undefined || o.clearcoatRoughness !== undefined) {
                const coat = clamp01(o.clearcoat ?? base.clearcoat);
                sh.setUniformFloat('clearcoatFactor', coat);
                sh.setUniformFloat('clearcoatRoughnessFactor', clamp01(o.clearcoatRoughness ?? base.clearcoatRoughness));
                mat.setDefine('USE_CLEARCOAT', coat > 0);
            }
            if (o.transmission !== undefined) {
                const t = clamp01(o.transmission);
                if (t !== mat.transmissionFactor) mat.transmissionFactor = t;
            }
            if (o.ior !== undefined) mat.ior = Math.min(3, Math.max(1, o.ior));
        }
        mat.doubleSide = o.doubleSide ?? base.doubleSide;

        // Alpha: an explicit mode wins; otherwise keep the file's blending
        // and blend when the opacity override makes the material see-through.
        const cutoff = clamp01(o.alphaCutoff ?? base.alphaCutoff);
        if (o.alphaMode && o.alphaMode !== 'auto') applyAlpha(mat, engineAlpha(o.alphaMode, opacity), cutoff);
        else if (base.alpha === 'BLEND') applyAlpha(mat, 'BLEND', cutoff);
        else applyAlpha(mat, opacity < 0.999 ? 'BLEND' : base.alpha, cutoff);

        if (shaderId) {
            // Texture properties named after the model's maps get the file's maps.
            const fallback = (name: string) => (MODEL_MAPS.includes(name) ? (safe(() => source.shader.getTexture(name)) as Texture | undefined) : undefined);
            const assets = applyProps(sh, shaders.props(shaderId), o.params ?? {}, ctx, fallback);
            this.loadParamTextures(om, assets);
        }

        // The color map: the file's own (missing `map`), none (null) or a texture asset.
        if (o.map === undefined) om.maps.set(BASE_MAP, null);
        else if (o.map === null) {
            om.maps.set(BASE_MAP, null);
            sh.setTexture('baseMap', Engine3D.resFor(ctx).whiteTexture);
            mat.setDefine('USE_SRGB_ALBEDO', false);
        } else om.maps.set(BASE_MAP, o.map);
    }

    private loadParamTextures(om: OverrideMaterial, assets: { name: string; asset: string }[]) {
        for (const { name, asset } of assets) {
            if (om.paramAssets[name] === asset) continue;
            om.paramAssets[name] = asset;
            void this.deps.loadTexture(asset).then((tex) => {
                if (tex && om.paramAssets[name] === asset) om.material.shader.setTexture(name, tex);
            });
        }
    }
}

function nz(v: number): number {
    return Math.abs(v) < 1e-5 ? (v < 0 ? -1e-5 : 1e-5) : v;
}

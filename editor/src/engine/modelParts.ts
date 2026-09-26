import { Engine3D, Material, Object3D, PassType, RenderNode, Shader, Texture, VertexAttributeName } from '@orillusion/core';
import type { MaterialOverride, ModelDoc, PartOverride, Vec3 } from '../core/types';
import { colorToHex, hexToColor } from './color';
import { applyProps, setBlended, type ShaderManager } from './shaders';

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

function readSlot(mat: Material, white: Texture): SlotValues {
    const sh: any = mat.shader;
    const color = safe(() => sh.getUniformColor('baseColor'));
    const emissive = safe(() => sh.getUniformColor('emissiveColor'));
    const num = (k: string, d: number) => {
        const v = safe(() => sh.getUniformFloat(k));
        return typeof v === 'number' && Number.isFinite(v) ? v : d;
    };
    const map = safe(() => sh.getTexture('baseMap'));
    return {
        color: colorToHex(color),
        opacity: color && Number.isFinite(color.a) ? color.a : 1,
        metallic: num('metallic', 0),
        roughness: num('roughness', 1),
        emissive: colorToHex(emissive ?? { r: 0, g: 0, b: 0 }),
        emissiveIntensity: num('emissiveIntensity', 0),
        doubleSide: !!safe(() => mat.doubleSide),
        hasMap: !!map && map !== white,
    };
}

/**
 * Copies a material for per-instance changes. Only the color passes are
 * copied: derived passes (shadow, depth, GI) are rebuilt by the renderer
 * for the new material, and copying them through Shader.clone() fails for
 * pass classes whose constructors take other arguments.
 */
export function cloneMaterial(src: Material): Material {
    const shader = new Shader();
    for (const pass of src.shader.getSubShaders(PassType.COLOR)) shader.addRenderPass(pass.clone());
    const mat = new Material();
    mat.shader = shader;
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
    /** Texture asset currently requested for the base map. */
    mapAsset: string | null | undefined;
    /** Asset textures of custom shader params, by property name. */
    paramAssets: Record<string, string>;
}

export interface OverrideDeps {
    shaders: ShaderManager;
    loadTexture(assetId: string): Promise<Texture | null>;
    dispose(mat: Material): void;
    ctx: any;
}

/**
 * Applies a ModelDoc's overrides to one loaded model instance. Materials
 * of the file are shared by every instance of the model, so an overridden
 * slot gets its own copy for this instance.
 */
export class ModelOverrides {
    private mats = new Map<string, OverrideMaterial>();

    constructor(readonly info: ModelInfo, private deps: OverrideDeps) {}

    apply(model: ModelDoc, nodeVisible: boolean) {
        const materials = model.materials ?? {};
        const parts = model.parts ?? {};

        const wanted = new Set<string>();
        for (const part of this.info.parts) {
            const po: PartOverride = parts[part.path] ?? {};
            const moved = !!po.material && po.material !== part.slot && !!this.info.slot(po.material);
            const slot = this.info.slot(moved ? po.material! : part.slot)!;
            const variant = moved ? 0 : part.variant;
            const mo = materials[slot.key];
            let mat = slot.materials[variant] ?? slot.material;
            if (mo && !isEmpty(mo)) {
                // Build or refresh this instance's copy of the slot material.
                const key = `${slot.key}|${variant}`;
                if (!wanted.has(key)) {
                    wanted.add(key);
                    this.refreshSlot(key, slot, variant, mo);
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

    private refreshSlot(key: string, slot: ModelSlot, variant: number, o: MaterialOverride) {
        const source = slot.materials[variant] ?? slot.material;
        const shaderId = o.shader || null;
        const shaders = this.deps.shaders;
        const useShader = !!shaderId && shaders.isValid(shaderId);
        const base = slot.base;
        const opacity = o.opacity ?? base.opacity;
        const structure = JSON.stringify({
            shader: useShader ? shaderId : null,
            version: useShader ? shaders.version(shaderId!) : 0,
        });
        let om = this.mats.get(key);
        if (!om || om.structure !== structure) {
            if (om) this.deps.dispose(om.material);
            let material: Material | null = null;
            if (useShader) {
                material = shaders.createMaterial(shaderId!);
                // Keep the model's own base texture unless replaced.
                const map = safe(() => source.shader.getTexture('baseMap'));
                if (material && map) material.shader.setTexture('baseMap', map);
            }
            if (!material) material = cloneMaterial(source);
            material.name = source.name;
            om = { material, structure, mapAsset: undefined, paramAssets: {} };
            this.mats.set(key, om);
        }
        const mat = om.material;
        const sh = mat.shader;
        sh.setUniformColor('baseColor', hexToColor(o.color ?? base.color, opacity));
        sh.setUniformFloat('metallic', clamp01(o.metallic ?? base.metallic));
        sh.setUniformFloat('roughness', clamp01(o.roughness ?? base.roughness));
        sh.setUniformColor('emissiveColor', hexToColor(o.emissive ?? base.emissive));
        sh.setUniformFloat('emissiveIntensity', Math.max(0, o.emissiveIntensity ?? base.emissiveIntensity));
        mat.doubleSide = o.doubleSide ?? base.doubleSide;
        const sourceBlended = !!source.shader.getDefaultColorShader().shaderState.transparent;
        if (!sourceBlended || useShader) setBlended(mat, opacity < 0.999 || (useShader && sourceBlended));

        if (useShader) {
            const assets = applyProps(sh, shaders.props(shaderId!), o.params ?? {}, this.deps.ctx);
            this.loadParamTextures(om, assets);
        }

        if (om.mapAsset !== o.map) {
            om.mapAsset = o.map;
            const white = Engine3D.resFor(this.deps.ctx).whiteTexture;
            if (o.map === undefined) {
                const src = source.shader.getDefaultColorShader();
                const map = safe(() => source.shader.getTexture('baseMap'));
                sh.setTexture('baseMap', map ?? white);
                sh.setDefine('USE_SRGB_ALBEDO', !!src.defineValue?.['USE_SRGB_ALBEDO']);
            } else if (o.map === null) {
                sh.setTexture('baseMap', white);
                sh.setDefine('USE_SRGB_ALBEDO', false);
            } else {
                const asset = o.map;
                void this.deps.loadTexture(asset).then((tex) => {
                    if (!tex || this.mats.get(key) !== om || om!.mapAsset !== asset) return;
                    sh.setDefine('USE_SRGB_ALBEDO', (tex as any).format === 'rgba8unorm-srgb');
                    sh.setTexture('baseMap', tex);
                });
            }
        }
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

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function nz(v: number): number {
    return Math.abs(v) < 1e-5 ? (v < 0 ? -1e-5 : 1e-5) : v;
}

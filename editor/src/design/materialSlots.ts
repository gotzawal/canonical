// Material slots: named surfaces of the level (DesignDoc.materials). Every
// mesh material linked to a slot (MaterialDoc.slot) renders with the world
// space triplanar shader and takes the slot's swatch, color, roughness,
// metallic and tile size, so a surface is changed in one place. Textures
// keep their real size on every mesh, which makes them a scale reference.

import { uid } from '../core/ids';
import { makeMaterialSlot } from '../core/design';
import { OLD_TRIPLANAR_CODES, OLD_TRIPLANAR_MARKER, TRIPLANAR_CODE, TRIPLANAR_MARKER } from '../core/templates';
import type { ChangeHint, Store } from '../core/store';
import type { AssetMeta, MaterialDoc, MaterialSlotDoc, NodeDoc, SceneDoc, ShaderDoc, TerrainLayerDoc } from '../core/types';
import { getSwatch, swatchAsset, swatchSide, type SwatchMap } from './swatches';

export const TRIPLANAR_NAME = 'Triplanar.wgsl';


/** The project's triplanar shader, if it has one. */
export function findTriplanar(doc: SceneDoc): ShaderDoc | undefined {
    const marked = (code: string) => code.includes(TRIPLANAR_MARKER) || code.includes(OLD_TRIPLANAR_MARKER);
    return doc.shaders.find((s) => s.kind === 'material' && marked(s.code)) ?? doc.shaders.find((s) => s.name === TRIPLANAR_NAME && s.kind === 'material');
}

/**
 * The triplanar shader's id, adding the shader to the project when missing
 * (inside a commit). A project's copy of an earlier version, unchanged,
 * becomes the current one (normal and ARM maps, fewer texture reads).
 */
export function ensureTriplanar(doc: SceneDoc): string {
    const found = findTriplanar(doc);
    if (found) {
        if (found.code !== TRIPLANAR_CODE && OLD_TRIPLANAR_CODES.includes(found.code)) found.code = TRIPLANAR_CODE;
        return found.id;
    }
    const shader: ShaderDoc = { id: uid('sh'), name: TRIPLANAR_NAME, kind: 'material', lighting: 'lit', code: TRIPLANAR_CODE };
    doc.shaders.push(shader);
    return shader.id;
}

/**
 * Rewrites a material to show its slot: the triplanar shader with the
 * slot's swatch and maps, or, for a slot without a swatch (empty, or a
 * plain color), the plain lit material, which reads no texture.
 */
export function applySlot(m: MaterialDoc, slot: MaterialSlotDoc, shaderId: string) {
    if (!slot.swatch) {
        m.type = 'lit';
        m.shader = null;
        delete m.params;
    } else {
        m.type = 'shader';
        m.shader = shaderId;
        const maps = (slot.normal ? 1 : 0) + (slot.arm ? 2 : 0);
        m.params = { ...(m.params ?? {}), albedo: slot.swatch, normalTex: slot.normal ?? 'normal', armTex: slot.arm ?? 'data', tile: slot.tile, maps };
    }
    m.color = slot.color;
    m.roughness = slot.roughness;
    m.metallic = slot.metallic;
    m.map = null;
    m.slot = slot.id;
}

/** Puts a slot on a terrain layer: its swatch, normal, ARM and height maps, tile size, color and roughness (the layer follows it from then on). */
export function layerFromSlot(layer: TerrainLayerDoc, slot: MaterialSlotDoc) {
    layer.slot = slot.id;
    layer.albedo = slot.swatch ?? null;
    layer.normal = slot.swatch ? slot.normal ?? null : null;
    layer.arm = slot.swatch ? slot.arm ?? null : null;
    layer.heightMap = slot.swatch ? slot.heightMap ?? null : null;
    layer.tile = slot.tile;
    layer.color = slot.color;
    layer.roughness = slot.roughness;
}

/** Terrain layers that follow a slot. */
function linkedLayers(doc: SceneDoc): TerrainLayerDoc[] {
    return doc.nodes.flatMap((n) => (n.terrain?.layers ?? []).filter((l) => !!l.slot));
}

/** Every material that follows a slot: scene meshes and the parts of prefab templates. */
function linkedMaterials(doc: SceneDoc): { m: MaterialDoc; owner: NodeDoc }[] {
    const out: { m: MaterialDoc; owner: NodeDoc }[] = [];
    for (const n of doc.nodes) if (n.mesh?.material.slot) out.push({ m: n.mesh.material, owner: n });
    for (const p of doc.prefabs) for (const n of p.nodes) if (n.mesh?.material.slot) out.push({ m: n.mesh.material, owner: n });
    return out;
}

/** Brings the linked materials in line with their slots (inside a commit); links to missing slots are dropped. */
export function syncSlots(doc: SceneDoc, only?: string) {
    const slots = new Map(doc.design.materials.map((s) => [s.id, s]));
    for (const layer of linkedLayers(doc)) {
        if (only && layer.slot !== only) continue;
        const slot = slots.get(layer.slot!);
        if (slot) layerFromSlot(layer, slot);
        else layer.slot = null;
    }
    const linked = linkedMaterials(doc).filter(({ m }) => !only || m.slot === only);
    if (!linked.length) return;
    const shaderId = ensureTriplanar(doc);
    for (const { m } of linked) {
        const slot = slots.get(m.slot!);
        if (slot) applySlot(m, slot, shaderId);
        else delete m.slot;
    }
}

/** Mesh nodes and terrains that follow a slot (scene nodes, prefab parts count once per instance). */
export function slotUsers(doc: SceneDoc, slotId: string): NodeDoc[] {
    return doc.nodes.filter((n) => n.mesh?.material.slot === slotId || n.terrain?.layers.some((l) => l.slot === slotId));
}

export interface SlotPatch {
    name?: string;
    description?: string;
    color?: string;
    roughness?: number;
    metallic?: number;
    tile?: number;
    swatch?: string | null;
    flat?: boolean;
}

/** Creates a slot, or changes one (by id); linked materials follow. Returns the slot. */
export function upsertSlot(store: Store, patch: SlotPatch & { id?: string }, label?: string): MaterialSlotDoc {
    let id = patch.id ?? '';
    const hint = slotChangeHint(store, id);
    store.commit(label ?? (patch.id ? 'Edit Material Slot' : 'Add Material Slot'), (d) => {
        let slot = id ? d.design.materials.find((s) => s.id === id) : undefined;
        if (!slot) {
            slot = makeMaterialSlot(patch.name?.trim() || `Material ${d.design.materials.length + 1}`);
            if (id) slot.id = id;
            d.design.materials.push(slot);
            id = slot.id;
        }
        if (patch.name !== undefined && patch.name.trim()) slot.name = patch.name.trim();
        if (patch.description !== undefined) slot.description = patch.description;
        if (patch.color !== undefined) slot.color = patch.color;
        if (patch.roughness !== undefined) slot.roughness = Math.min(1, Math.max(0, patch.roughness));
        if (patch.metallic !== undefined) slot.metallic = Math.min(1, Math.max(0, patch.metallic));
        if (patch.tile !== undefined) slot.tile = Math.min(1000, Math.max(0.01, patch.tile));
        if (patch.swatch !== undefined) slot.swatch = patch.swatch;
        if (patch.flat !== undefined) {
            if (patch.flat) slot.flat = true;
            else delete slot.flat;
        }
        syncSlots(d, id);
    }, hint);
    return store.doc.design.materials.find((s) => s.id === id)!;
}

/**
 * Change hint of a slot edit: with linked meshes their materials change
 * too, so the scene follows (a design-only hint skips the engine sync).
 */
function slotChangeHint(store: Store, slotId: string): ChangeHint | undefined {
    const followed = linkedMaterials(store.doc).some(({ m }) => m.slot === slotId) || linkedLayers(store.doc).some((l) => l.slot === slotId);
    return slotId && followed ? undefined : { design: true };
}

/**
 * Links meshes to a slot. Parts of prefab instances link the matching parts
 * (by name) of the prefab, so every instance follows. Returns how many
 * materials were linked.
 */
export function assignSlot(store: Store, slotId: string, nodeIds: string[]): number {
    const doc = store.doc;
    if (!doc.design.materials.some((s) => s.id === slotId)) return 0;
    let count = 0;
    store.commit('Assign Material Slot', (d) => {
        const shaderId = ensureTriplanar(d);
        const slot = d.design.materials.find((s) => s.id === slotId)!;
        const touched = new Set<string>();
        const link = (n: NodeDoc) => {
            if (!n.mesh) return;
            applySlot(n.mesh.material, slot, shaderId);
            count++;
        };
        const visit = (n: NodeDoc) => {
            if (touched.has(n.id)) return;
            touched.add(n.id);
            if (n.prefab || n.prefabChild) {
                // A prefab instance or one of its parts: link the prefab's own parts.
                const root = n.prefab ? n : rootOf(d, n);
                const prefab = root ? d.prefabs.find((p) => p.id === root.prefab) : undefined;
                if (prefab) {
                    const parts = n.prefab ? prefab.nodes : prefab.nodes.filter((t) => t.name === n.name);
                    for (const t of parts) link(t);
                }
                return;
            }
            link(n);
        };
        for (const id of nodeIds) {
            const n = d.nodes.find((x) => x.id === id);
            if (n) visit(n);
        }
        // The generated parts of every instance of the prefabs that changed.
        for (const p of d.prefabs) {
            const names = new Set(p.nodes.filter((t) => t.mesh?.material.slot === slotId).map((t) => t.name));
            if (!names.size) continue;
            for (const c of d.nodes) {
                if (!c.prefabChild || !c.mesh || !names.has(c.name)) continue;
                const root = rootOf(d, c);
                if (root?.prefab === p.id) applySlot(c.mesh.material, slot, shaderId);
            }
        }
    });
    return count;
}

/** Unlinks meshes from their slots; they keep their current look. */
export function unassignSlot(store: Store, nodeIds: string[]) {
    store.commit('Unlink Material Slot', (d) => {
        for (const id of nodeIds) {
            const n = d.nodes.find((x) => x.id === id);
            if (n?.mesh?.material.slot) delete n.mesh.material.slot;
        }
    });
}

/** Deletes a slot; its meshes keep their current look. */
export function deleteSlot(store: Store, slotId: string) {
    // The meshes lose their link to it: then not only the design changes (undo has to bring the links back).
    const hint = slotChangeHint(store, slotId);
    store.commit('Delete Material Slot', (d) => {
        d.design.materials = d.design.materials.filter((s) => s.id !== slotId);
        for (const { m } of linkedMaterials(d)) if (m.slot === slotId) delete m.slot;
    }, hint);
}

function rootOf(doc: SceneDoc, n: NodeDoc): NodeDoc | undefined {
    let cur: NodeDoc | undefined = n;
    while (cur && !cur.prefab) {
        const parent: string | null = cur.parent;
        cur = parent ? doc.nodes.find((x) => x.id === parent) : undefined;
    }
    return cur;
}

/**
 * Puts a library swatch on a slot: the swatch's maps (albedo, and normal
 * and ARM where it has them) are copied into the project as textures
 * (once), sized for the surface from the first: they compress to its tile
 * times the design's texel density (Specs.texelDensity), no larger than
 * they are. The slot takes the tile size (the texture's real size),
 * roughness and metallic where the swatch has them (with an ARM map they
 * are factors: 1), and white as its color. Returns the slot and the
 * textures copied in (to compress).
 */
export async function useSwatch(store: Store, slotId: string, swatchId: string): Promise<MaterialSlotDoc & { added: string[] }> {
    const rec = await getSwatch(swatchId);
    if (!rec) throw new Error('That swatch is not in the library of this browser.');
    const side = swatchSide(rec.tile, store.doc.design.specs.texelDensity);
    const compress = side < rec.size ? { maxSize: side } : undefined;
    const maps: Partial<Record<SwatchMap, { meta: AssetMeta; added: boolean }>> = {};
    for (const map of ['albedo', 'normal', 'arm', 'height'] as const) {
        const got = await swatchAsset(store, rec, map, compress);
        if (got) maps[map] = got;
    }
    const albedo = maps.albedo!;
    const hint = slotChangeHint(store, slotId);
    store.commit('Use Swatch', (d) => {
        for (const m of Object.values(maps)) if (m.added && !d.assets.some((a) => a.id === m.meta.id)) d.assets.push(m.meta);
        const slot = d.design.materials.find((s) => s.id === slotId);
        if (!slot) return;
        slot.swatch = albedo.meta.id;
        if (maps.normal) slot.normal = maps.normal.meta.id;
        else delete slot.normal;
        if (maps.arm) slot.arm = maps.arm.meta.id;
        else delete slot.arm;
        if (maps.height) slot.heightMap = maps.height.meta.id;
        else delete slot.heightMap;
        slot.color = '#ffffff';
        slot.tile = rec.tile;
        if (maps.arm) {
            slot.roughness = 1;
            slot.metallic = 1;
        } else {
            if (rec.roughness !== undefined) slot.roughness = rec.roughness;
            if (rec.metallic !== undefined) slot.metallic = rec.metallic;
        }
        delete slot.flat;
        syncSlots(d, slotId);
    }, hint);
    const slot = store.doc.design.materials.find((s) => s.id === slotId);
    if (!slot) throw new Error('No such material slot.');
    return { ...slot, added: Object.values(maps).filter((m) => m.added).map((m) => m.meta.id) };
}

/** A surface to look at in the reference room (viewport/referenceRoom.ts). */
export interface RoomSample {
    name: string;
    /** Albedo texture (an image blob, or a project texture asset id); none for a plain color. */
    texture?: Blob | string | null;
    color: string;
    roughness: number;
    metallic: number;
    /** Meters per texture tile. */
    tile: number;
}

/** The slot's sample for the reference room. */
export function roomSample(doc: SceneDoc, slot: MaterialSlotDoc): RoomSample {
    return { name: slot.name, texture: slot.swatch && doc.assets.some((a) => a.id === slot.swatch) ? slot.swatch : null, color: slot.color, roughness: slot.roughness, metallic: slot.metallic, tile: slot.tile };
}

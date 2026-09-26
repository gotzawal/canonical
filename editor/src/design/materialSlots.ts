// Material slots: named surfaces of the level (DesignDoc.materials). Every
// mesh material linked to a slot (MaterialDoc.slot) renders with the world
// space triplanar shader and takes the slot's swatch, color, roughness,
// metallic and tile size, so a surface is changed in one place. Textures
// keep their real size on every mesh, which makes them a scale reference.

import { uid } from '../core/ids';
import { makeMaterialSlot } from '../core/design';
import { TRIPLANAR_CODE, TRIPLANAR_MARKER } from '../core/templates';
import type { MaterialDoc, MaterialSlotDoc, NodeDoc, SceneDoc, ShaderDoc } from '../core/types';
import type { Editor } from '../editor';
import { getSwatch, swatchAsset } from './swatches';

export const TRIPLANAR_NAME = 'Triplanar.wgsl';


/** The project's triplanar shader, if it has one. */
export function findTriplanar(doc: SceneDoc): ShaderDoc | undefined {
    return doc.shaders.find((s) => s.kind === 'material' && s.code.includes(TRIPLANAR_MARKER)) ?? doc.shaders.find((s) => s.name === TRIPLANAR_NAME && s.kind === 'material');
}

/** The triplanar shader's id, adding the shader to the project when missing (inside a commit). */
export function ensureTriplanar(doc: SceneDoc): string {
    const found = findTriplanar(doc);
    if (found) return found.id;
    const shader: ShaderDoc = { id: uid('sh'), name: TRIPLANAR_NAME, kind: 'material', lighting: 'lit', code: TRIPLANAR_CODE };
    doc.shaders.push(shader);
    return shader.id;
}

/** Rewrites a material to show its slot. */
export function applySlot(m: MaterialDoc, slot: MaterialSlotDoc, shaderId: string) {
    m.type = 'shader';
    m.shader = shaderId;
    m.params = { ...(m.params ?? {}), albedo: slot.swatch ?? 'white', tile: slot.tile };
    m.color = slot.color;
    m.roughness = slot.roughness;
    m.metallic = slot.metallic;
    m.map = null;
    m.slot = slot.id;
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
    const linked = linkedMaterials(doc).filter(({ m }) => !only || m.slot === only);
    if (!linked.length) return;
    const shaderId = ensureTriplanar(doc);
    for (const { m } of linked) {
        const slot = slots.get(m.slot!);
        if (slot) applySlot(m, slot, shaderId);
        else delete m.slot;
    }
}

/** Mesh nodes that follow a slot (scene nodes, prefab parts count once per instance). */
export function slotUsers(doc: SceneDoc, slotId: string): NodeDoc[] {
    return doc.nodes.filter((n) => n.mesh?.material.slot === slotId);
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
export function upsertSlot(editor: Editor, patch: SlotPatch & { id?: string }, label?: string): MaterialSlotDoc {
    let id = patch.id ?? '';
    editor.store.commit(label ?? (patch.id ? 'Edit Material Slot' : 'Add Material Slot'), (d) => {
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
    }, { design: true });
    return editor.store.doc.design.materials.find((s) => s.id === id)!;
}

/**
 * Links meshes to a slot. Parts of prefab instances link the matching parts
 * (by name) of the prefab, so every instance follows. Returns how many
 * materials were linked.
 */
export function assignSlot(editor: Editor, slotId: string, nodeIds: string[]): number {
    const doc = editor.store.doc;
    if (!doc.design.materials.some((s) => s.id === slotId)) return 0;
    let count = 0;
    editor.store.commit('Assign Material Slot', (d) => {
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
export function unassignSlot(editor: Editor, nodeIds: string[]) {
    editor.store.commit('Unlink Material Slot', (d) => {
        for (const id of nodeIds) {
            const n = d.nodes.find((x) => x.id === id);
            if (n?.mesh?.material.slot) delete n.mesh.material.slot;
        }
    });
}

/** Deletes a slot; its meshes keep their current look. */
export function deleteSlot(editor: Editor, slotId: string) {
    editor.store.commit('Delete Material Slot', (d) => {
        d.design.materials = d.design.materials.filter((s) => s.id !== slotId);
        for (const { m } of linkedMaterials(d)) if (m.slot === slotId) delete m.slot;
    }, { design: true });
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
 * Puts a library swatch on a slot: the swatch is copied into the project as
 * a texture (once) and the slot takes its tile size (the texture's real
 * size), roughness and metallic where it has them, and white as its color.
 */
export async function useSwatch(editor: Editor, slotId: string, swatchId: string): Promise<MaterialSlotDoc> {
    const rec = await getSwatch(swatchId);
    if (!rec) throw new Error('That swatch is not in the library of this browser.');
    const { meta, added } = await swatchAsset(editor, rec);
    editor.store.commit('Use Swatch', (d) => {
        if (added && !d.assets.some((a) => a.id === meta.id)) d.assets.push(meta);
        const slot = d.design.materials.find((s) => s.id === slotId);
        if (!slot) return;
        slot.swatch = meta.id;
        slot.color = '#ffffff';
        slot.tile = rec.tile;
        if (rec.roughness !== undefined) slot.roughness = rec.roughness;
        if (rec.metallic !== undefined) slot.metallic = rec.metallic;
        delete slot.flat;
        syncSlots(d, slotId);
    }, { design: true });
    const slot = editor.store.doc.design.materials.find((s) => s.id === slotId);
    if (!slot) throw new Error('No such material slot.');
    return slot;
}

/** The slot's samples for the reference room. */
export function roomSample(doc: SceneDoc, slot: MaterialSlotDoc) {
    return { name: slot.name, texture: slot.swatch && doc.assets.some((a) => a.id === slot.swatch) ? slot.swatch : null, color: slot.color, roughness: slot.roughness, metallic: slot.metallic, tile: slot.tile };
}

/**
 * The glTF extensions this loader reads. A file that requires any other
 * extension cannot be drawn correctly, so it fails with a message naming
 * them instead of loading wrong.
 *
 * @internal
 * @group Loader
 */
export const SUPPORTED_GLTF_EXTENSIONS: readonly string[] = [
    'EXT_meshopt_compression',
    'EXT_texture_avif',
    'EXT_texture_webp',
    'KHR_draco_mesh_compression',
    'KHR_lights_punctual',
    'KHR_materials_clearcoat',
    'KHR_materials_emissive_strength',
    'KHR_materials_ior',
    'KHR_materials_sheen',
    'KHR_materials_specular',
    'KHR_materials_transmission',
    'KHR_materials_unlit',
    'KHR_materials_variants',
    'KHR_materials_volume',
    'KHR_mesh_quantization',
    'KHR_meshopt_compression',
    'KHR_texture_basisu',
    'KHR_texture_transform',
];

/** The required extensions of a glTF this loader does not read. */
export function unsupportedGltfExtensions(gltf: { extensionsRequired?: unknown }): string[] {
    const required = Array.isArray(gltf?.extensionsRequired) ? gltf.extensionsRequired : [];
    return required.filter((name) => typeof name === 'string' && !SUPPORTED_GLTF_EXTENSIONS.includes(name));
}

/** Throws when the glTF requires an extension this loader does not read. */
export function assertSupportedGltfExtensions(gltf: { extensionsRequired?: unknown }): void {
    const missing = unsupportedGltfExtensions(gltf);
    if (missing.length) throw new Error(`glTF requires unsupported extension${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
}

/**
 * The images a glTF texture can show, best first: KTX2 (KHR_texture_basisu),
 * WebP, AVIF, then its plain source. Loaders fetch the first up front and
 * the others only when the ones before fail.
 */
export function textureSources(texture: { source?: number; extensions?: { [name: string]: any } } | undefined | null): number[] {
    const ext = texture?.extensions;
    const out: number[] = [];
    for (const s of [ext?.KHR_texture_basisu?.source, ext?.EXT_texture_webp?.source, ext?.EXT_texture_avif?.source, texture?.source]) {
        if (typeof s === 'number' && !out.includes(s)) out.push(s);
    }
    return out;
}

/** The images the textures of a glTF prefer: the ones to load up front. */
export function preferredImages(gltf: { textures?: any[] }): Set<number> {
    const out = new Set<number>();
    for (const t of gltf?.textures ?? []) {
        const first = textureSources(t)[0];
        if (first !== undefined) out.add(first);
    }
    return out;
}

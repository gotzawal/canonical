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

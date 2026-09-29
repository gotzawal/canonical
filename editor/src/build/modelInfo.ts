// What a model file needs from the player, read from its glTF JSON without
// loading it: the extensions it uses (Draco, meshopt, KTX2 textures).

/** The extensions a .glb or .gltf file lists; null when its JSON cannot be read. */
export async function gltfExtensions(blob: Blob): Promise<string[] | null> {
    try {
        const head = new DataView(await blob.slice(0, 20).arrayBuffer());
        let json: any;
        if (head.byteLength >= 20 && head.getUint32(0, true) === 0x46546c67) {
            // GLB: a 12-byte header, then the JSON chunk's length and type.
            const length = head.getUint32(12, true);
            json = JSON.parse(await blob.slice(20, 20 + length).text());
        } else {
            json = JSON.parse(await blob.text());
        }
        const names = [...(json?.extensionsUsed ?? []), ...(json?.extensionsRequired ?? [])];
        return Array.from(new Set(names.filter((n) => typeof n === 'string')));
    } catch {
        return null;
    }
}

/** The optional player decoders a model's extensions call for. */
export function decodersFor(extensions: string[] | null): { ktx2: boolean; draco: boolean; meshopt: boolean } {
    // Unreadable: bring them all rather than a game that cannot load it.
    if (!extensions) return { ktx2: true, draco: true, meshopt: true };
    return {
        ktx2: extensions.includes('KHR_texture_basisu'),
        draco: extensions.includes('KHR_draco_mesh_compression'),
        meshopt: extensions.includes('EXT_meshopt_compression') || extensions.includes('KHR_meshopt_compression'),
    };
}

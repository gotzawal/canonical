// The engine's Draco mesh decoding worker. It runs right after
// draco_wasm_wrapper_gltf.js in one classic worker script (see
// src/loader/parser/gltf/extends/KHR_draco_mesh_compression.ts), and stays
// plain JavaScript loaded as text so that no bundler renames anything in it.
//
// In:  { type: 'init', wasm: ArrayBuffer }
//      { type: 'decode', id, buffer: ArrayBuffer, attributes: { NAME: uniqueId } }
// Out: { type: 'done', id, result: { NAME: { data, numComponents, normalize }, indices } }
//      { type: 'error', id, message }
/* global DracoDecoderModule */
let draco = null;

self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'init') {
        draco = new Promise((resolve, reject) => {
            // Wrapped in an object: the module itself looks like a promise.
            const config = {
                wasmBinary: msg.wasm,
                onModuleLoaded: (module) => resolve({ module }),
                onAbort: (why) => reject(new Error('the Draco decoder stopped: ' + why)),
            };
            DracoDecoderModule(config);
        });
        // Decode requests report the failure.
        draco.catch(() => {});
        return;
    }
    if (msg.type === 'decode') {
        Promise.resolve(draco).then((loaded) => {
            if (!loaded) throw new Error('the Draco worker was not initialised');
            const result = decode(loaded.module, msg.buffer, msg.attributes);
            const transfer = Object.keys(result).map((name) => result[name].data.buffer);
            self.postMessage({ type: 'done', id: msg.id, result }, transfer);
        }).catch((err) => {
            self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
        });
    }
};

function decode(draco, buffer, attributes) {
    const decoder = new draco.Decoder();
    const decoderBuffer = new draco.DecoderBuffer();
    let geometry = null;
    try {
        decoderBuffer.Init(new Int8Array(buffer), buffer.byteLength);
        const type = decoder.GetEncodedGeometryType(decoderBuffer);
        if (type !== draco.TRIANGULAR_MESH) throw new Error('Draco data is not a triangle mesh (type ' + type + ')');
        geometry = new draco.Mesh();
        const status = decoder.DecodeBufferToMesh(decoderBuffer, geometry);
        if (!status.ok() || geometry.ptr === 0) throw new Error('Draco decoding failed: ' + status.error_msg());

        const result = {};
        const points = geometry.num_points();
        for (const name in attributes) {
            const attribute = decoder.GetAttributeByUniqueId(geometry, attributes[name]);
            if (!attribute || attribute.ptr === 0) throw new Error('Draco data has no attribute ' + name);
            const numComponents = attribute.num_components();
            const count = points * numComponents;
            const byteLength = count * Float32Array.BYTES_PER_ELEMENT;
            const ptr = draco._malloc(byteLength);
            try {
                decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, draco.DT_FLOAT32, byteLength, ptr);
                result[name] = { data: new Float32Array(draco.HEAPF32.buffer, ptr, count).slice(), numComponents, normalize: false };
            } finally {
                draco._free(ptr);
            }
        }

        const indexCount = geometry.num_faces() * 3;
        const byteLength = indexCount * 4;
        const ptr = draco._malloc(byteLength);
        try {
            decoder.GetTrianglesUInt32Array(geometry, byteLength, ptr);
            result.indices = { data: new Uint32Array(draco.HEAPF32.buffer, ptr, indexCount).slice(), numComponents: 1, normalize: false };
        } finally {
            draco._free(ptr);
        }
        return result;
    } finally {
        if (geometry) draco.destroy(geometry);
        draco.destroy(decoder);
        draco.destroy(decoderBuffer);
    }
}

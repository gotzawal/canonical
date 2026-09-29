/**
 * Integer vertex and animation data of glTF (KHR_mesh_quantization,
 * gltfpack, normalized weights and rotations) turned into the floats the
 * engine draws and animates with.
 *
 * @internal
 * @group Loader
 */

type IntArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;

/**
 * Floats of a normalized integer array, by the glTF rules: signed values
 * divide by their largest positive value and stop at -1, unsigned values
 * divide by their largest value. Float arrays come back as they are.
 */
export function dequantizeNormalized(data: ArrayLike<number>): Float32Array {
    if (data instanceof Float32Array) return data;
    const out = new Float32Array(data.length);
    if (data instanceof Int8Array) {
        for (let i = 0; i < data.length; i++) out[i] = Math.max(data[i] / 127, -1);
    } else if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
        for (let i = 0; i < data.length; i++) out[i] = data[i] / 255;
    } else if (data instanceof Int16Array) {
        for (let i = 0; i < data.length; i++) out[i] = Math.max(data[i] / 32767, -1);
    } else if (data instanceof Uint16Array) {
        for (let i = 0; i < data.length; i++) out[i] = data[i] / 65535;
    } else {
        for (let i = 0; i < data.length; i++) out[i] = data[i];
    }
    return out;
}

/** Floats of any number array by value, or the array itself when it already is one. */
export function toFloat32(data: ArrayLike<number>): Float32Array {
    return data instanceof Float32Array ? data : Float32Array.from(data as IntArray);
}

/**
 * The index array the GPU draws `data` with: 32-bit when there are more
 * than 65535 indices or any index is above 65535 (a short list can point
 * far into a large vertex buffer), 16-bit otherwise.
 */
export function fitIndices(data: ArrayLike<number>): Uint16Array | Uint32Array {
    let wide = data.length > 65535;
    for (let i = 0; !wide && i < data.length; i++) wide = data[i] > 65535;
    if (wide) return data instanceof Uint32Array ? data : Uint32Array.from(data as IntArray);
    return data instanceof Uint16Array ? data : Uint16Array.from(data as IntArray);
}

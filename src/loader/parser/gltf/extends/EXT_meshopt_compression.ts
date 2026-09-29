/// <reference path="./meshoptimizer.d.ts" />
// https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Vendor/EXT_meshopt_compression

/**
 * One compressed bufferView: `count` elements of `byteStride` bytes packed
 * by meshoptimizer into `byteLength` bytes of `buffer`.
 * @internal
 */
export interface MeshoptBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride: number;
    count: number;
    mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';
    filter?: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL' | 'COLOR';
}

type Decoder = typeof import('meshoptimizer/decoder').MeshoptDecoder;

/**
 * EXT_meshopt_compression and its Khronos twin KHR_meshopt_compression:
 * vertex, index and animation data packed by meshoptimizer (gltfpack).
 * The WebAssembly decoder is imported only when a file uses it, and the
 * fallback buffers such files carry are never read.
 * @internal
 * @group Loader
 */
export class EXT_meshopt_compression {
    private static _loading: Promise<Decoder> | null = null;
    private static _decoder: Decoder | null = null;

    /** The meshopt extension of a bufferView, if it has one. */
    public static extOf(bufferView: { extensions?: { [name: string]: any } } | undefined): MeshoptBufferView | undefined {
        const ext = bufferView?.extensions;
        return ext?.EXT_meshopt_compression ?? ext?.KHR_meshopt_compression;
    }

    /** True when any bufferView of the glTF is meshopt compressed. */
    public static isUsed(gltf: { bufferViews?: any[] }): boolean {
        return !!gltf?.bufferViews?.some((view) => !!this.extOf(view));
    }

    /** A buffer that only stands in for compressed data (it may have no bytes at all). */
    public static isFallback(buffer: { extensions?: { [name: string]: any } } | undefined): boolean {
        const ext = buffer?.extensions;
        return !!(ext?.EXT_meshopt_compression?.fallback || ext?.KHR_meshopt_compression?.fallback);
    }

    /** Loads the decoder once; `decode` can run after this settles. */
    public static ready(): Promise<Decoder> {
        this._loading ??= import('meshoptimizer/decoder').then(async ({ MeshoptDecoder }) => {
            await MeshoptDecoder.ready;
            this._decoder = MeshoptDecoder;
            return MeshoptDecoder;
        }).catch((e) => {
            this._loading = null;
            throw new Error(`meshopt decoder failed to load: ${e?.message ?? e}`);
        });
        return this._loading;
    }

    /** The unpacked bytes of a compressed bufferView whose source buffer is `source`. */
    public static decode(ext: MeshoptBufferView, source: ArrayBuffer): ArrayBuffer {
        const decoder = this._decoder;
        if (!decoder) throw new Error('meshopt decoder used before ready()');
        const out = new Uint8Array(ext.count * ext.byteStride);
        const src = new Uint8Array(source, ext.byteOffset ?? 0, ext.byteLength);
        decoder.decodeGltfBuffer(out, ext.count, ext.byteStride, src, ext.mode, ext.filter ?? 'NONE');
        return out.buffer;
    }
}

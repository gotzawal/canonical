// The part of meshoptimizer's decoder the loader uses, for builds that
// resolve packages the old way (moduleResolution "node" ignores package
// exports, and the packages in packages/* compile the engine that way).
declare module 'meshoptimizer/decoder' {
    export const MeshoptDecoder: {
        supported: boolean;
        ready: Promise<void>;
        decodeGltfBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string): void;
    };
}

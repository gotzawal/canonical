//https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_draco_mesh_compression

import { GLTF_Primitives } from "../GLTFInfo";
import { GLTFSubParser } from "../GLTFSubParser";

/** Where the Draco decoder comes from: its script, the worker around it and its WebAssembly. */
export interface DracoDecoderAssets {
    wrapperJs: string;
    workerJs: string;
    wasmUrl: string;
}

interface Pending {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
}

/**
 * Meshes packed with Draco, decoded in one worker the page shares. The
 * decoder ships with the engine (packages/draco) and is fetched the first
 * time a Draco model loads.
 * @internal
 * @group Loader
 */
export class KHR_draco_mesh_compression {
    /** Loads the decoder files; replace it to host them somewhere else. */
    public static assets: () => Promise<DracoDecoderAssets> = () => import('./_DracoAssets');

    private static _worker: Promise<Worker> | null = null;
    private static _pending = new Map<number, Pending>();
    private static _nextId = 1;
    /** Decoded primitives by bufferView, so primitives that share one decode once. */
    private static _decoded = new WeakMap<object, Map<string, Promise<any>>>();

    public static async apply(parser: GLTFSubParser, primitive: GLTF_Primitives) {
        const args = primitive.extensions?.['KHR_draco_mesh_compression'];
        if (!args) return;

        const view = parser.gltf.bufferViews[args.bufferView];
        const layout = JSON.stringify(args.attributes);
        let byLayout = this._decoded.get(view);
        if (!byLayout) this._decoded.set(view, (byLayout = new Map()));
        let decoded = byLayout.get(layout);
        if (!decoded) {
            // A copy goes to the worker; the parsed bufferView stays whole.
            const buffer: ArrayBuffer = parser.parseBufferView(args.bufferView);
            decoded = this.decode(buffer.slice(0), args.attributes);
            byLayout.set(layout, decoded);
            decoded.catch(() => byLayout.delete(layout));
        }
        return decoded;
    }

    /** Kept for callers that end a load; the shared worker stays for the next Draco model. */
    public static unload(_gltf: any) {}

    /** Stop the worker; pending decodes fail. The next Draco model starts it again. */
    public static dispose() {
        const worker = this._worker;
        this._worker = null;
        worker?.then((w) => w.terminate(), () => {});
        this.failAll(new Error('the Draco decoder was disposed'));
    }

    private static async decode(buffer: ArrayBuffer, attributes: { [name: string]: number }): Promise<any> {
        const worker = await this.worker();
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            worker.postMessage({ type: 'decode', id, buffer, attributes }, [buffer]);
        });
    }

    private static worker(): Promise<Worker> {
        this._worker ??= (async () => {
            const { wrapperJs, workerJs, wasmUrl } = await this.assets();
            const response = await fetch(wasmUrl);
            if (!response.ok) throw new Error(`the Draco decoder failed to load (${response.status})`);
            const wasm = await response.arrayBuffer();
            const url = URL.createObjectURL(new Blob([wrapperJs, '\n', workerJs], { type: 'text/javascript' }));
            const worker = new Worker(url, { name: 'draco-decoder' });
            worker.onmessage = (e) => {
                const msg = e.data;
                const p = this._pending.get(msg?.id);
                if (!p) return;
                this._pending.delete(msg.id);
                if (msg.type === 'done') p.resolve(msg.result);
                else p.reject(new Error(msg.message || 'Draco decoding failed'));
            };
            worker.onerror = (e) => {
                e.preventDefault?.();
                worker.terminate();
                this._worker = null;
                this.failAll(new Error(`the Draco decoder stopped: ${e.message || 'worker error'}`));
            };
            worker.postMessage({ type: 'init', wasm }, [wasm]);
            return worker;
        })();
        this._worker.catch(() => (this._worker = null));
        return this._worker;
    }

    private static failAll(error: Error) {
        for (const [, p] of this._pending) p.reject(error);
        this._pending.clear();
    }
}

import { BasisEncoding, CompressedTextureSupport, rankTargets } from './KTX2TranscodeTarget';

/** One mip level of a transcoded texture. */
export interface KTX2Level {
    width: number;
    height: number;
    data: Uint8Array;
}

/** A KTX2 file transcoded for this device. */
export interface KTX2Image {
    width: number;
    height: number;
    alpha: boolean;
    encoding: BasisEncoding;
    /** The linear GPU format the levels are in. */
    format: GPUTextureFormat;
    /** The file says its colors are sRGB encoded. */
    srgb: boolean;
    levels: KTX2Level[];
}

/** Where the transcoder comes from: its script, the worker around it and its WebAssembly. */
export interface KTX2TranscoderAssets {
    transcoderJs: string;
    workerJs: string;
    wasmUrl: string;
}

interface Slot {
    worker: Worker;
    busy: number;
}

interface Pending {
    slot: Slot;
    resolve: (image: KTX2Image) => void;
    reject: (error: Error) => void;
}

/**
 * Transcodes KTX2 (Basis Universal) files in a small pool of workers.
 * The transcoder is fetched the first time a KTX2 texture loads; it holds
 * no GPU state, so one pool serves every engine of the page.
 *
 * @group Texture
 */
export class KTX2Transcoder {
    private static _shared: KTX2Transcoder | null = null;

    /** The page's transcoder. */
    public static get shared(): KTX2Transcoder {
        return (this._shared ??= new KTX2Transcoder());
    }

    /** Loads the transcoder files; replace it to host them somewhere else. */
    public static assets: () => Promise<KTX2TranscoderAssets> = () => import('./_KTX2Assets');

    /** Workers at most; each holds its own transcoder instance. */
    public maxWorkers = Math.max(1, Math.min(2, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));

    private _slots: Slot[] = [];
    private _pending = new Map<number, Pending>();
    private _nextId = 1;
    private _source: Promise<{ url: string; wasm: ArrayBuffer }> | null = null;

    /**
     * Transcode a KTX2 file for a device that can sample `support`.
     * `data` is transferred to a worker, so pass a copy you do not need.
     */
    public async transcode(data: ArrayBuffer, support: Partial<CompressedTextureSupport> | null | undefined): Promise<KTX2Image> {
        const slot = await this.slot();
        const id = this._nextId++;
        return new Promise<KTX2Image>((resolve, reject) => {
            this._pending.set(id, { slot, resolve, reject });
            slot.busy++;
            slot.worker.postMessage({ type: 'transcode', id, buffer: data, table: rankTargets(support) }, [data]);
        });
    }

    /** Stop the workers; pending transcodes fail. The next transcode starts again. */
    public dispose() {
        for (const slot of this._slots) slot.worker.terminate();
        this._slots = [];
        for (const [, p] of this._pending) p.reject(new Error('the KTX2 transcoder was disposed'));
        this._pending.clear();
        const source = this._source;
        this._source = null;
        source?.then(({ url }) => URL.revokeObjectURL(url), () => {});
    }

    private source() {
        this._source ??= (async () => {
            const { transcoderJs, workerJs, wasmUrl } = await KTX2Transcoder.assets();
            const response = await fetch(wasmUrl);
            if (!response.ok) throw new Error(`the Basis transcoder failed to load (${response.status})`);
            const wasm = await response.arrayBuffer();
            const url = URL.createObjectURL(new Blob([transcoderJs, '\n', workerJs], { type: 'text/javascript' }));
            return { url, wasm };
        })();
        this._source.catch(() => (this._source = null));
        return this._source;
    }

    /** The least busy worker, starting another while there is room. */
    private async slot(): Promise<Slot> {
        const { url, wasm } = await this.source();
        const idle = this._slots.reduce<Slot | null>((best, s) => (!best || s.busy < best.busy ? s : best), null);
        if (idle && (idle.busy === 0 || this._slots.length >= this.maxWorkers)) return idle;
        const slot: Slot = { worker: new Worker(url, { name: 'ktx2-transcoder' }), busy: 0 };
        slot.worker.onmessage = (e) => this.answer(e.data);
        slot.worker.onerror = (e) => {
            e.preventDefault?.();
            this.drop(slot, new Error(`the KTX2 transcoder stopped: ${e.message || 'worker error'}`));
        };
        slot.worker.postMessage({ type: 'init', wasm: wasm.slice(0) });
        this._slots.push(slot);
        return slot;
    }

    private answer(msg: any) {
        const p = this._pending.get(msg?.id);
        if (!p) return;
        this._pending.delete(msg.id);
        p.slot.busy--;
        if (msg.type === 'done') {
            p.resolve({ width: msg.width, height: msg.height, alpha: msg.alpha, encoding: msg.encoding, format: msg.format, srgb: msg.srgb, levels: msg.levels });
        } else {
            p.reject(new Error(msg.message || 'KTX2 transcoding failed'));
        }
    }

    /** A worker that crashed: fail what it had and let the next transcode start a new one. */
    private drop(slot: Slot, error: Error) {
        slot.worker.terminate();
        this._slots = this._slots.filter((s) => s !== slot);
        for (const [id, p] of this._pending) {
            if (p.slot !== slot) continue;
            this._pending.delete(id);
            p.reject(error);
        }
    }
}

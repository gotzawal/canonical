// What the editor asks WebGPU for, counted at the API: draw calls, render
// passes and GPU commands per frame, and the bytes of the buffers and
// textures that are alive (an estimate of GPU memory: drivers pad and tile,
// and the browser allocates for itself). The engine's own counters see only
// its older draw path, so the WebGPU methods are wrapped instead, once and
// before the engine starts. Every wrapper forwards its call unchanged and
// never throws. No engine imports: the unit tests run it on fake classes.

/** What one frame asked the GPU to do. */
export interface FrameCounts {
    draws: number;
    triangles: number;
    instances: number;
    renderPasses: number;
    computePasses: number;
    dispatches: number;
    /** setPipeline calls. */
    pipelines: number;
    /** setBindGroup calls. */
    bindGroups: number;
    submits: number;
    /** Bytes written to buffers and textures from the CPU. */
    uploadBytes: number;
}

/** Textures by what fills them: images and data from the CPU, what passes draw into, the rest. */
export type TextureClass = 'image' | 'target' | 'other';
/** Buffers by use; staging buffers come and go with the GPU's lag, so they stay out of the stable total. */
export type BufferClass = 'vertex' | 'index' | 'uniform' | 'storage' | 'staging' | 'other';

export interface Tally {
    bytes: number;
    count: number;
}

export interface GpuMemory {
    textures: Record<TextureClass, Tally>;
    buffers: Record<BufferClass, Tally>;
    /** Everything but staging buffers. */
    stable: number;
}

export interface GpuSnapshot {
    /** The last whole frame. */
    frame: FrameCounts;
    /** The most of each count over the recent frames (a frame that skipped passes does not read as 0). */
    peak: FrameCounts;
    memory: GpuMemory;
    /** Render and compute pipelines made so far. */
    pipelinesCreated: number;
    /** CPU milliseconds of the engine's update and draw calls per frame, over the recent frames. */
    cpu: { median: number; p95: number; frames: number };
}

const RECENT = 120;
const WRAPPED = Symbol.for('morglay.gpuStats.wrapped');
const INSTALLED = Symbol.for('morglay.gpuStats');

// GPUBufferUsage and GPUTextureUsage flags (the constants are not there in Node).
const MAP_READ = 0x1, MAP_WRITE = 0x2, INDEX = 0x10, VERTEX = 0x20, UNIFORM = 0x40, STORAGE = 0x80;
const RENDER_ATTACHMENT = 0x10;

const zero = (): FrameCounts => ({ draws: 0, triangles: 0, instances: 0, renderPasses: 0, computePasses: 0, dispatches: 0, pipelines: 0, bindGroups: 0, submits: 0, uploadBytes: 0 });

function addCounts(to: FrameCounts, from: FrameCounts) {
    for (const k in to) (to as any)[k] += (from as any)[k];
}

/** [bytes per block, block width, block height] of a texture format; unknown formats count 4 bytes a texel. */
export function formatInfo(format: string): [number, number, number] {
    const f = format || '';
    const bc = /^bc(\d)/.exec(f);
    if (bc) return [bc[1] === '1' || bc[1] === '4' ? 8 : 16, 4, 4];
    if (f.startsWith('etc2') || f.startsWith('eac')) return [/rgba8|rg11/.test(f) ? 16 : 8, 4, 4];
    const astc = /^astc-(\d+)x(\d+)/.exec(f);
    if (astc) return [16, Number(astc[1]), Number(astc[2])];
    switch (f) {
        case 'stencil8':
            return [1, 1, 1];
        case 'depth16unorm':
            return [2, 1, 1];
        case 'depth24plus':
        case 'depth24plus-stencil8':
        case 'depth32float':
        case 'rgb10a2unorm':
        case 'rgb10a2uint':
        case 'rg11b10ufloat':
        case 'rgb9e5ufloat':
            return [4, 1, 1];
        case 'depth32float-stencil8':
            return [8, 1, 1];
    }
    const m = /^(r|rg|rgba|bgra)(8|16|32)/.exec(f);
    if (m) return [(m[1] === 'bgra' ? 4 : m[1].length) * (Number(m[2]) / 8), 1, 1];
    return [4, 1, 1];
}

/** Bytes of a texture with all its mip levels, layers and samples. */
export function textureBytes(desc: { size: any; format: string; mipLevelCount?: number; sampleCount?: number; dimension?: string }): number {
    const s = desc.size;
    const w = Math.max(1, Number(Array.isArray(s) ? s[0] : s?.width) || 1);
    const h = Math.max(1, Number(Array.isArray(s) ? (s[1] ?? 1) : (s?.height ?? 1)) || 1);
    const layers = Math.max(1, Number(Array.isArray(s) ? (s[2] ?? 1) : (s?.depthOrArrayLayers ?? 1)) || 1);
    const [bpb, bw, bh] = formatInfo(desc.format);
    const mips = Math.max(1, desc.mipLevelCount ?? 1);
    const is3d = desc.dimension === '3d';
    let bytes = 0;
    for (let l = 0; l < mips; l++) {
        const lw = Math.max(1, w >> l);
        const lh = Math.max(1, h >> l);
        const ld = is3d ? Math.max(1, layers >> l) : layers;
        bytes += Math.ceil(lw / bw) * Math.ceil(lh / bh) * bpb * ld;
    }
    return bytes * Math.max(1, desc.sampleCount ?? 1);
}

export function bufferClass(usage: number): BufferClass {
    if (usage & (MAP_READ | MAP_WRITE)) return 'staging';
    if (usage & INDEX) return 'index';
    if (usage & VERTEX) return 'vertex';
    if (usage & UNIFORM) return 'uniform';
    if (usage & STORAGE) return 'storage';
    return 'other';
}

/** Triangles of `count` vertices or indices drawn as `topology`. */
function triangles(topology: string, count: number): number {
    if (topology === 'triangle-list') return Math.floor(count / 3);
    if (topology === 'triangle-strip') return Math.max(0, count - 2);
    return 0;
}

interface Resource {
    kind: 'texture' | 'buffer';
    cls: TextureClass | BufferClass;
    bytes: number;
    alive: boolean;
}

export class GpuStats {
    /** The frame being drawn. */
    private current = zero();
    private recent: FrameCounts[] = [];
    private cpuRecent: number[] = [];
    private last = zero();
    readonly memory: GpuMemory = {
        textures: { image: { bytes: 0, count: 0 }, target: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 } },
        buffers: { vertex: { bytes: 0, count: 0 }, index: { bytes: 0, count: 0 }, uniform: { bytes: 0, count: 0 }, storage: { bytes: 0, count: 0 }, staging: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 } },
        stable: 0,
    };
    pipelinesCreated = 0;

    /** @internal Counts go to the frame being drawn. */
    get counts(): FrameCounts {
        return this.current;
    }

    /** Starts counting a frame (the runtime calls it before the engine updates). */
    beginFrame() {
        this.current = zero();
    }

    /** Ends the frame: its counts become the last frame's; `cpuMs` is the engine's CPU time in it. */
    endFrame(cpuMs?: number) {
        this.last = this.current;
        this.recent.push(this.current);
        if (this.recent.length > RECENT) this.recent.shift();
        if (cpuMs !== undefined && Number.isFinite(cpuMs)) {
            this.cpuRecent.push(cpuMs);
            if (this.cpuRecent.length > RECENT) this.cpuRecent.shift();
        }
        this.current = zero();
    }

    /** The most of each count over the last `frames` frames. */
    peak(frames = RECENT): FrameCounts {
        const out = zero();
        for (const f of this.recent.slice(-frames)) for (const k in out) (out as any)[k] = Math.max((out as any)[k], (f as any)[k]);
        return out;
    }

    snapshot(frames = RECENT): GpuSnapshot {
        const cpu = this.cpuRecent.slice(-frames).sort((a, b) => a - b);
        const at = (q: number) => (cpu.length ? cpu[Math.min(cpu.length - 1, Math.floor(q * cpu.length))] : 0);
        return {
            frame: { ...this.last },
            peak: this.peak(frames),
            memory: JSON.parse(JSON.stringify(this.memory)),
            pipelinesCreated: this.pipelinesCreated,
            cpu: { median: at(0.5), p95: at(0.95), frames: cpu.length },
        };
    }

    /** @internal */
    track(r: Resource) {
        const t = this.tallyOf(r);
        t.bytes += r.bytes;
        t.count++;
        if (r.cls !== 'staging') this.memory.stable += r.bytes;
    }

    /** @internal Takes a destroyed (or collected) resource out, once. */
    untrack(r: Resource) {
        if (!r.alive) return;
        r.alive = false;
        const t = this.tallyOf(r);
        t.bytes -= r.bytes;
        t.count--;
        if (r.cls !== 'staging') this.memory.stable -= r.bytes;
    }

    /** @internal A texture that got pixels from the CPU is an image. */
    reclassify(r: Resource, cls: TextureClass) {
        if (!r.alive || r.cls === cls) return;
        this.untrack(r);
        r.alive = true;
        r.cls = cls;
        this.track(r);
    }

    private tallyOf(r: Resource): Tally {
        return r.kind === 'texture' ? this.memory.textures[r.cls as TextureClass] : this.memory.buffers[r.cls as BufferClass];
    }
}

/**
 * Wraps the WebGPU methods of `g` (the page) once and returns the counter.
 * Call it before the engine makes its device: buffers and textures made
 * before are not counted. Classes `g` lacks are left out.
 */
export function installGpuStats(g: any = globalThis): GpuStats {
    if (g[INSTALLED]) return g[INSTALLED];
    const stats = new GpuStats();
    g[INSTALLED] = stats;

    const resources = new WeakMap<object, Resource>();
    const topologies = new WeakMap<object, string>();
    /** The topology of the pipeline set on a pass or bundle encoder. */
    const drawing = new WeakMap<object, string>();
    const bundleCounts = new WeakMap<object, FrameCounts>();
    const bundleOf = new WeakMap<object, FrameCounts>();
    const collected = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry<Resource>((r) => stats.untrack(r)) : null;

    const wrap = (cls: any, name: string, after: (self: any, args: any[], result: any) => void) => {
        const proto = cls?.prototype;
        const orig = proto?.[name];
        if (typeof orig !== 'function' || orig[WRAPPED]) return;
        const wrapped = function (this: any, ...args: any[]) {
            const result = orig.apply(this, args);
            try {
                after(this, args, result);
            } catch {
                // Counting never breaks drawing.
            }
            return result;
        };
        (wrapped as any)[WRAPPED] = true;
        proto[name] = wrapped;
    };

    const remember = (obj: any, r: Resource) => {
        if (!obj || typeof obj !== 'object') return;
        resources.set(obj, r);
        stats.track(r);
        collected?.register(obj, r, obj);
    };
    const forget = (obj: any) => {
        const r = obj && resources.get(obj);
        if (!r) return;
        stats.untrack(r);
        collected?.unregister(obj);
    };

    wrap(g.GPUDevice, 'createBuffer', (_d, [desc], buf) => {
        remember(buf, { kind: 'buffer', cls: bufferClass(Number(desc?.usage) || 0), bytes: Number(desc?.size) || 0, alive: true });
    });
    wrap(g.GPUDevice, 'createTexture', (_d, [desc], tex) => {
        const usage = Number(desc?.usage) || 0;
        remember(tex, { kind: 'texture', cls: usage & RENDER_ATTACHMENT ? 'target' : 'other', bytes: textureBytes(desc), alive: true });
    });
    wrap(g.GPUBuffer, 'destroy', (buf) => forget(buf));
    wrap(g.GPUTexture, 'destroy', (tex) => forget(tex));

    const topologyOf = (desc: any) => desc?.primitive?.topology ?? 'triangle-list';
    wrap(g.GPUDevice, 'createRenderPipeline', (_d, [desc], pipeline) => {
        stats.pipelinesCreated++;
        if (pipeline) topologies.set(pipeline, topologyOf(desc));
    });
    wrap(g.GPUDevice, 'createRenderPipelineAsync', (_d, [desc], promise) => {
        stats.pipelinesCreated++;
        Promise.resolve(promise).then((pipeline) => pipeline && topologies.set(pipeline, topologyOf(desc)), () => {});
    });
    wrap(g.GPUDevice, 'createComputePipeline', () => stats.pipelinesCreated++);
    wrap(g.GPUDevice, 'createComputePipelineAsync', () => stats.pipelinesCreated++);

    wrap(g.GPUCommandEncoder, 'beginRenderPass', () => stats.counts.renderPasses++);
    wrap(g.GPUCommandEncoder, 'beginComputePass', () => stats.counts.computePasses++);
    wrap(g.GPUComputePassEncoder, 'dispatchWorkgroups', () => stats.counts.dispatches++);
    wrap(g.GPUComputePassEncoder, 'dispatchWorkgroupsIndirect', () => stats.counts.dispatches++);

    // Draws on a pass count in the frame; draws recorded into a bundle count each time the bundle runs.
    const countsFor = (enc: any): FrameCounts => bundleCounts.get(enc) ?? stats.counts;
    const draw = (enc: any, count: number, instances: number) => {
        const c = countsFor(enc);
        c.draws++;
        c.instances += instances;
        c.triangles += triangles(drawing.get(enc) ?? 'triangle-list', count) * instances;
    };
    for (const cls of [g.GPURenderPassEncoder, g.GPURenderBundleEncoder]) {
        wrap(cls, 'setPipeline', (enc, [pipeline]) => {
            drawing.set(enc, topologies.get(pipeline) ?? 'triangle-list');
            countsFor(enc).pipelines++;
        });
        wrap(cls, 'setBindGroup', (enc) => countsFor(enc).bindGroups++);
        wrap(cls, 'draw', (enc, [count, instances]) => draw(enc, Number(count) || 0, instances === undefined ? 1 : Number(instances) || 0));
        wrap(cls, 'drawIndexed', (enc, [count, instances]) => draw(enc, Number(count) || 0, instances === undefined ? 1 : Number(instances) || 0));
        // Indirect draws: the counts are on the GPU.
        wrap(cls, 'drawIndirect', (enc) => countsFor(enc).draws++);
        wrap(cls, 'drawIndexedIndirect', (enc) => countsFor(enc).draws++);
    }
    wrap(g.GPUDevice, 'createRenderBundleEncoder', (_d, _a, enc) => enc && bundleCounts.set(enc, zero()));
    wrap(g.GPURenderBundleEncoder, 'finish', (enc, _a, bundle) => {
        const c = bundleCounts.get(enc);
        if (bundle && c) bundleOf.set(bundle, c);
    });
    wrap(g.GPURenderPassEncoder, 'executeBundles', (_enc, [bundles]) => {
        for (const b of bundles ?? []) {
            const c = bundleOf.get(b);
            if (c) addCounts(stats.counts, c);
        }
    });

    wrap(g.GPUQueue, 'submit', () => stats.counts.submits++);
    wrap(g.GPUQueue, 'writeBuffer', (_q, [, , data, dataOffset, size]) => {
        // With a typed array, the offset and size count its elements.
        const unit = ArrayBuffer.isView(data) ? ((data as any).BYTES_PER_ELEMENT ?? 1) : 1;
        const n = size !== undefined ? Number(size) * unit : (data?.byteLength ?? 0) - (Number(dataOffset) || 0) * unit;
        stats.counts.uploadBytes += Math.max(0, n || 0);
    });
    const image = (dest: any) => {
        const r = dest?.texture && resources.get(dest.texture);
        if (r) stats.reclassify(r, 'image');
    };
    wrap(g.GPUQueue, 'writeTexture', (_q, [dest, data]) => {
        image(dest);
        stats.counts.uploadBytes += data?.byteLength ?? 0;
    });
    wrap(g.GPUQueue, 'copyExternalImageToTexture', (_q, [, dest]) => image(dest));

    return stats;
}

/** The counter of the page, if installed. */
export function gpuStats(g: any = globalThis): GpuStats | null {
    return g[INSTALLED] ?? null;
}

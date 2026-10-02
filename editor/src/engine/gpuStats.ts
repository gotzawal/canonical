// What the editor asks WebGPU for, counted at the API: draw calls, render
// passes and GPU commands per frame, and the bytes of the buffers and
// textures that are alive (an estimate of GPU memory: drivers pad and tile,
// and the browser allocates for itself). The engine's own counters see only
// its older draw path, so the WebGPU methods are wrapped instead, once and
// before the engine starts. Every wrapper forwards its call unchanged (a
// profiled pass gets timestamp writes added) and never throws. No engine
// imports: the unit tests run it on fake classes.
//
// For the Profiler, it also keeps every live texture, the draws and CPU time
// of each render graph pass (the runtime names them with passBegin/passEnd),
// and, while profiling on a device with timestamp queries, their GPU time.

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

/**
 * Textures by what they are: images and data from the CPU, shadow maps
 * (depth arrays and the depth targets named for shadows), environment cube
 * maps (the sky, reflections), what passes draw into, and the rest (mostly
 * what compute passes write: post effects, the depth pyramid, GI atlases).
 */
export type TextureClass = 'image' | 'data' | 'shadow' | 'environment' | 'target' | 'other';

export const TEXTURE_CLASSES: TextureClass[] = ['image', 'data', 'shadow', 'environment', 'target', 'other'];

/** A live texture, for the list of what takes the memory. */
export interface TextureInfo {
    label: string;
    format: string;
    width: number;
    height: number;
    layers: number;
    mips: number;
    samples: number;
    bytes: number;
    cls: TextureClass;
}

/** A live buffer, for the report. */
export interface BufferInfo {
    label: string;
    bytes: number;
    cls: BufferClass;
}

/** What one render graph pass (or the work around the graph) did in a frame. */
export interface PassStats {
    name: string;
    /** CPU milliseconds encoding it, GPU milliseconds (null without timestamps), draws and triangles. */
    cpu: number;
    gpu: number | null;
    draws: number;
    triangles: number;
}
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
const QUERY_RESOLVE = 0x200, COPY_SRC = 0x4, COPY_DST = 0x8;
/** Work outside the render graph's passes. */
const OUTSIDE = 'Outside the graph';
/** Passes a frame can time on the GPU. */
const TIMED_PASSES = 256;

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
    /** Textures: what the list shows. */
    info?: Omit<TextureInfo, 'bytes' | 'cls'>;
    /** Buffers: their label. */
    label?: string;
}

/** The class of a new texture, from its descriptor. */
export function textureClass(desc: any): TextureClass {
    const s = desc?.size;
    const w = Number(Array.isArray(s) ? s[0] : s?.width) || 1;
    const h = Number(Array.isArray(s) ? (s[1] ?? 1) : (s?.height ?? 1)) || 1;
    const layers = Number(Array.isArray(s) ? (s[2] ?? 1) : (s?.depthOrArrayLayers ?? 1)) || 1;
    const depth = /^(depth|stencil)/.test(String(desc?.format ?? ''));
    if (depth && (layers > 1 || /shadow/i.test(String(desc?.label ?? '')))) return 'shadow';
    if (!depth && desc?.dimension !== '3d' && w === h && layers >= 6 && layers % 6 === 0) return 'environment';
    return (Number(desc?.usage) || 0) & RENDER_ATTACHMENT ? 'target' : 'other';
}

interface PassFrame {
    cpu: number;
    draws: number;
    triangles: number;
}

export class GpuStats {
    /** The frame being drawn. */
    private current = zero();
    private recent: FrameCounts[] = [];
    private cpuRecent: number[] = [];
    private last = zero();
    readonly memory: GpuMemory = {
        textures: {
            image: { bytes: 0, count: 0 }, data: { bytes: 0, count: 0 }, shadow: { bytes: 0, count: 0 }, environment: { bytes: 0, count: 0 },
            target: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 },
        },
        buffers: { vertex: { bytes: 0, count: 0 }, index: { bytes: 0, count: 0 }, uniform: { bytes: 0, count: 0 }, storage: { bytes: 0, count: 0 }, staging: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 } },
        stable: 0,
    };
    pipelinesCreated = 0;
    /** Live textures. */
    private live = new Set<Resource>();
    /** The pass being recorded, its start, and per pass what the frame being drawn did. */
    scope = OUTSIDE;
    private scopeStart = 0;
    private passFrame = new Map<string, PassFrame>();
    private passRecent: Map<string, PassFrame>[] = [];
    /** GPU milliseconds per pass of the frames timed lately (a few frames apart). */
    private gpuRecent: Map<string, number>[] = [];
    /** Time the passes on the GPU (while a profiler looks, on devices with timestamp queries). */
    profileGpu = false;
    /** @internal Set up by installGpuStats. */
    timing: { supported(): boolean; resolve(): void } | null = null;
    /** @internal Its own GPU calls are not counted. */
    internal = false;
    /** Work timed before the engine's frame (addCpu), outside its CPU time. */
    private before = new Set<string>();
    /** Milliseconds given to addCpu so far (work timed within other work subtracts it). */
    added = 0;

    /** @internal Counts go to the frame being drawn. */
    get counts(): FrameCounts {
        return this.current;
    }

    /** @internal What the pass being recorded did. */
    passCounts(): PassFrame {
        let p = this.passFrame.get(this.scope);
        if (!p) this.passFrame.set(this.scope, (p = { cpu: 0, draws: 0, triangles: 0 }));
        return p;
    }

    /** Starts counting a frame (the runtime calls it before the engine updates). */
    beginFrame() {
        this.current = zero();
        this.passFrame = new Map();
        this.scope = OUTSIDE;
        this.outer = [];
    }

    /**
     * A render graph pass starts recording (its draws and GPU time count for
     * it). Passes nest (each post effect inside the post pass): the time of
     * one inside another counts for it alone.
     */
    passBegin(name: string) {
        const now = performance.now();
        if (this.scope !== OUTSIDE) {
            this.passCounts().cpu += now - this.scopeStart;
            this.outer.push(this.scope);
        }
        this.scope = name;
        this.scopeStart = now;
    }

    passEnd(name: string) {
        if (this.scope !== name) return;
        const now = performance.now();
        this.passCounts().cpu += now - this.scopeStart;
        this.scope = this.outer.pop() ?? OUTSIDE;
        this.scopeStart = now;
    }
    /** The passes a nested pass is inside of. */
    private outer: string[] = [];

    /** CPU time of work before the engine's frame (scripts in Play), shown as a pass of its own. */
    addCpu(name: string, ms: number) {
        this.added += ms;
        this.before.add(name);
        let p = this.passFrame.get(name);
        if (!p) this.passFrame.set(name, (p = { cpu: 0, draws: 0, triangles: 0 }));
        p.cpu += ms;
    }

    /** Ends the frame: its counts become the last frame's; `cpuMs` is the engine's CPU time in it. */
    endFrame(cpuMs?: number) {
        this.last = this.current;
        this.recent.push(this.current);
        if (this.recent.length > RECENT) this.recent.shift();
        if (cpuMs !== undefined && Number.isFinite(cpuMs)) {
            this.cpuRecent.push(cpuMs);
            if (this.cpuRecent.length > RECENT) this.cpuRecent.shift();
            // The engine's time not spent in the graph's passes: its updates, compute work and the rest.
            let passes = 0;
            for (const [name, p] of this.passFrame) if (name !== OUTSIDE && !this.before.has(name)) passes += p.cpu;
            let outside = this.passFrame.get(OUTSIDE);
            if (!outside) this.passFrame.set(OUTSIDE, (outside = { cpu: 0, draws: 0, triangles: 0 }));
            outside.cpu += Math.max(0, cpuMs - passes);
        }
        this.passRecent.push(this.passFrame);
        if (this.passRecent.length > RECENT) this.passRecent.shift();
        this.timing?.resolve();
        this.current = zero();
        this.passFrame = new Map();
        this.scope = OUTSIDE;
    }

    /** @internal GPU milliseconds per pass of a timed frame. */
    gpuFrame(times: Map<string, number>) {
        this.gpuRecent.push(times);
        if (this.gpuRecent.length > 16) this.gpuRecent.shift();
    }

    /** Whether passes can be timed on the GPU (the device has timestamp queries). */
    get gpuTimed(): boolean {
        return !!this.timing?.supported();
    }

    /**
     * What each pass did on average over the last `frames` frames, in the
     * order they ran (work outside the graph first): CPU time, draws and
     * triangles, and GPU time over the frames timed lately.
     */
    passes(frames = 60): PassStats[] {
        const recent = this.passRecent.slice(-frames);
        const out = new Map<string, PassStats>();
        const at = (name: string) => {
            let p = out.get(name);
            if (!p) out.set(name, (p = { name, cpu: 0, gpu: null, draws: 0, triangles: 0 }));
            return p;
        };
        at(OUTSIDE);
        for (const f of recent) {
            for (const [name, c] of f) {
                const p = at(name);
                p.cpu += c.cpu / recent.length;
                p.draws += c.draws / recent.length;
                p.triangles += c.triangles / recent.length;
            }
        }
        if (this.gpuRecent.length) {
            for (const f of this.gpuRecent) for (const [name, ms] of f) {
                const p = at(name);
                p.gpu = (p.gpu ?? 0) + ms / this.gpuRecent.length;
            }
        }
        return [...out.values()];
    }

    /** Every live texture, the largest first. */
    textures(): TextureInfo[] {
        const out: TextureInfo[] = [];
        for (const r of this.live) if (r.info) out.push({ ...r.info, bytes: r.bytes, cls: r.cls as TextureClass });
        return out.sort((a, b) => b.bytes - a.bytes);
    }

    /** Every live buffer but staging ones, the largest first. */
    buffers(): BufferInfo[] {
        const out: BufferInfo[] = [];
        for (const r of this.live) if (r.kind === 'buffer' && r.cls !== 'staging') out.push({ label: r.label ?? '', bytes: r.bytes, cls: r.cls as BufferClass });
        return out.sort((a, b) => b.bytes - a.bytes);
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
        if (r.kind === 'texture' || r.cls !== 'staging') this.live.add(r);
    }

    /** @internal Takes a destroyed (or collected) resource out, once. */
    untrack(r: Resource) {
        if (!r.alive) return;
        r.alive = false;
        const t = this.tallyOf(r);
        t.bytes -= r.bytes;
        t.count--;
        if (r.cls !== 'staging') this.memory.stable -= r.bytes;
        this.live.delete(r);
    }

    /**
     * @internal A texture that got pixels from the CPU is an image (or data,
     * from a buffer); shadow maps and cube maps stay what they are.
     */
    reclassify(r: Resource, cls: TextureClass) {
        if (!r.alive || r.cls === cls || r.cls === 'shadow' || r.cls === 'environment') return;
        if (cls === 'data' && r.cls === 'image') return;
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
        remember(buf, { kind: 'buffer', cls: bufferClass(Number(desc?.usage) || 0), bytes: Number(desc?.size) || 0, alive: true, label: String(desc?.label ?? '') });
    });
    wrap(g.GPUDevice, 'createTexture', (_d, [desc], tex) => {
        const s = desc?.size;
        const info = {
            label: String(desc?.label ?? ''),
            format: String(desc?.format ?? ''),
            width: Number(Array.isArray(s) ? s[0] : s?.width) || 1,
            height: Number(Array.isArray(s) ? (s[1] ?? 1) : (s?.height ?? 1)) || 1,
            layers: Number(Array.isArray(s) ? (s[2] ?? 1) : (s?.depthOrArrayLayers ?? 1)) || 1,
            mips: Number(desc?.mipLevelCount) || 1,
            samples: Number(desc?.sampleCount) || 1,
        };
        remember(tex, { kind: 'texture', cls: textureClass(desc), bytes: textureBytes(desc), alive: true, info });
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

    // The device of each command encoder, for timing its passes.
    const deviceOf = new WeakMap<object, any>();
    wrap(g.GPUDevice, 'createCommandEncoder', (device, _a, enc) => enc && deviceOf.set(enc, device));
    const timer = gpuTimer(stats, g);
    stats.timing = timer;
    wrapBefore(g.GPUCommandEncoder, 'beginRenderPass', (enc, args) => timer.timed(deviceOf.get(enc), args), () => {
        if (!stats.internal) stats.counts.renderPasses++;
    });
    wrapBefore(g.GPUCommandEncoder, 'beginComputePass', (enc, args) => timer.timed(deviceOf.get(enc), args), () => {
        if (!stats.internal) stats.counts.computePasses++;
    });
    wrap(g.GPUComputePassEncoder, 'dispatchWorkgroups', () => stats.counts.dispatches++);
    wrap(g.GPUComputePassEncoder, 'dispatchWorkgroupsIndirect', () => stats.counts.dispatches++);

    // Draws on a pass count in the frame; draws recorded into a bundle count each time the bundle runs.
    const countsFor = (enc: any): FrameCounts => bundleCounts.get(enc) ?? stats.counts;
    const draw = (enc: any, count: number, instances: number) => {
        const c = countsFor(enc);
        const tris = triangles(drawing.get(enc) ?? 'triangle-list', count) * instances;
        c.draws++;
        c.instances += instances;
        c.triangles += tris;
        if (c === stats.counts) {
            const p = stats.passCounts();
            p.draws++;
            p.triangles += tris;
        }
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
            if (!c) continue;
            addCounts(stats.counts, c);
            const p = stats.passCounts();
            p.draws += c.draws;
            p.triangles += c.triangles;
        }
    });

    wrap(g.GPUQueue, 'submit', () => {
        if (!stats.internal) stats.counts.submits++;
    });
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
    // Textures filled from buffers hold data: lookup tables, generated or decoded textures.
    wrap(g.GPUCommandEncoder, 'copyBufferToTexture', (_e, [, dest]) => {
        const r = dest?.texture && resources.get(dest.texture);
        if (r) stats.reclassify(r, 'data');
    });

    return stats;

    /** Like wrap, with `before` changing the arguments first. */
    function wrapBefore(cls: any, name: string, before: (self: any, args: any[]) => any[], after: () => void) {
        const proto = cls?.prototype;
        const orig = proto?.[name];
        if (typeof orig !== 'function' || orig[WRAPPED]) return;
        const wrapped = function (this: any, ...args: any[]) {
            let a = args;
            try {
                a = before(this, args);
            } catch {
                a = args;
            }
            const result = orig.apply(this, a);
            try {
                after();
            } catch {
                // Counting never breaks drawing.
            }
            return result;
        };
        (wrapped as any)[WRAPPED] = true;
        proto[name] = wrapped;
    }
}

/**
 * Times passes on the GPU while `stats.profileGpu` is on: every pass of a
 * frame gets timestamp writes into a query set, which the end of the frame
 * resolves and reads back; frames are timed while no read-back is pending.
 */
function gpuTimer(stats: GpuStats, g: any) {
    let device: any = null;
    /** The device the query set is for (set up once). */
    let setFor: any = null;
    let querySet: any = null;
    let resolveBuf: any = null;
    let readBuf: any = null;
    let used = 0;
    let names: string[] = [];
    let pending = false;
    let pendingSince = 0;
    /** Frames read back, and whether any had real times (some devices write zeros). */
    let reads = 0;
    let valid = false;
    const ok = (d: any) => !!d?.features?.has?.('timestamp-query') && typeof d.createQuerySet === 'function';
    const setup = (d: any) => {
        if (setFor === d) return !!querySet;
        setFor = d;
        querySet = null;
        stats.internal = true;
        try {
            querySet = d.createQuerySet({ type: 'timestamp', count: TIMED_PASSES * 2 });
            resolveBuf = d.createBuffer({ size: TIMED_PASSES * 16, usage: QUERY_RESOLVE | COPY_SRC });
            readBuf = d.createBuffer({ size: TIMED_PASSES * 16, usage: (g.GPUBufferUsage?.MAP_READ ?? MAP_READ) | COPY_DST });
        } catch {
            querySet = null;
        } finally {
            stats.internal = false;
        }
        return !!querySet;
    };
    return {
        // Some devices write zeros, and a read-back that never comes back means none arrive.
        supported: () => ok(device) && (valid || reads < 4) && !(pending && performance.now() - pendingSince > 5000),
        /** The pass descriptor, with timestamp writes when this pass is timed. */
        timed(d: any, args: any[]): any[] {
            if (!d) return args;
            if (!device && ok(d)) device = d;
            if (!stats.profileGpu || pending || stats.internal || used + 2 > TIMED_PASSES * 2 || !ok(d)) return args;
            const desc = args[0];
            if (desc?.timestampWrites || !setup(d)) return args;
            const at = used;
            used += 2;
            names.push(stats.scope);
            return [{ ...(desc ?? {}), timestampWrites: { querySet, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 } }, ...args.slice(1)];
        },
        /** Ends a timed frame: resolves its timestamps and reads them back. */
        resolve() {
            if (!used || pending || !querySet) {
                used = 0;
                names = [];
                return;
            }
            const count = used;
            const passNames = names;
            used = 0;
            names = [];
            pending = true;
            pendingSince = performance.now();
            stats.internal = true;
            try {
                const enc = device.createCommandEncoder();
                enc.resolveQuerySet(querySet, 0, count, resolveBuf, 0);
                enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, count * 8);
                device.queue.submit([enc.finish()]);
            } catch {
                pending = false;
                return;
            } finally {
                stats.internal = false;
            }
            readBuf.mapAsync(g.GPUMapMode?.READ ?? 1, 0, count * 8).then(
                () => {
                    const t = new BigInt64Array(readBuf.getMappedRange(0, count * 8).slice(0));
                    readBuf.unmap();
                    const times = new Map<string, number>();
                    for (let i = 0; i < passNames.length; i++) {
                        const ns = Number(t[2 * i + 1] - t[2 * i]);
                        // A pass whose encoder was never submitted reads 0s.
                        if (!(ns > 0 && ns < 1e9)) continue;
                        times.set(passNames[i], (times.get(passNames[i]) ?? 0) + ns / 1e6);
                    }
                    reads++;
                    if (times.size) {
                        valid = true;
                        stats.gpuFrame(times);
                    }
                    pending = false;
                },
                () => {
                    pending = false;
                },
            );
        },
    };
}

/** The counter of the page, if installed. */
export function gpuStats(g: any = globalThis): GpuStats | null {
    return g[INSTALLED] ?? null;
}

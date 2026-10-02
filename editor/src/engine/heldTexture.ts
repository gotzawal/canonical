// Textures the editor makes on the GPU itself and binds to materials like
// the engine's: a terrain's layer arrays (its layers' swatches copied into
// one texture array each, with their mip levels) and data it uploads (a
// splat map, a height table). The engine has no array texture with mip
// levels, so the layers are drawn into place: any texture the engine
// loaded (KTX2 copies of any format too) goes in at the array's size, and
// several maps can share a layer, each in its own channels.

import { Texture, type Context3D } from '@orillusion/core';

/**
 * A GPU texture made here, held behind an engine Texture so material
 * passes can bind it. hold() swaps in another one; the passes that bound
 * this rebind it.
 */
export class HeldTexture extends Texture {
    private held: GPUTexture | null = null;

    constructor(ctx: Context3D, private dimension: GPUTextureViewDimension, sampleType: GPUTextureSampleType = 'float', repeat = true) {
        super(1, 1, 1);
        this._ensureBound(ctx);
        this.textureBindingLayout = { sampleType, viewDimension: dimension, multisampled: false };
        const filter = sampleType === 'float';
        this.samplerBindingLayout = { type: filter ? 'filtering' : 'non-filtering' };
        this.minFilter = filter ? 'linear' : 'nearest';
        this.magFilter = filter ? 'linear' : 'nearest';
        this.mipmapFilter = filter ? 'linear' : 'nearest';
        this.addressModeU = repeat ? 'repeat' : 'clamp-to-edge';
        this.addressModeV = repeat ? 'repeat' : 'clamp-to-edge';
        this.maxAnisotropy = 1;
    }

    /** The texture in use (null before the first hold). */
    get current(): GPUTexture | null {
        return this.held;
    }

    /** Filters with anisotropy (1 to 16) where it samples at an angle (a terrain seen along the ground). */
    setAnisotropy(n: number) {
        const v = Math.max(1, Math.min(16, Math.round(n)));
        if (v === this.maxAnisotropy) return;
        this.maxAnisotropy = v;
        this.noticeChange();
    }

    /** Holds `tex` from now on (the one before is destroyed once the GPU is done with it). */
    hold(tex: GPUTexture) {
        const old = this.held;
        this.held = tex;
        this.gpuTexture = tex;
        this.view = tex.createView({ dimension: this.dimension });
        this.width = tex.width;
        this.height = tex.height;
        this.numberLayer = tex.depthOrArrayLayers;
        this.mipmapCount = tex.mipLevelCount;
        this.format = tex.format;
        this.noticeChange();
        if (old) Texture.delayDestroyTexture(this._boundCtx!, old);
    }

    /** Frees the texture it holds. */
    release() {
        if (this.held) Texture.delayDestroyTexture(this._boundCtx!, this.held);
        this.held = null;
    }
}

const BLIT = /* wgsl */ `
struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    var o: Out;
    o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2f(p.x, 1.0 - p.y);
    return o;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> lod: vec4f;
@fragment fn fs(v: Out) -> @location(0) vec4f {
    let c = textureSampleLevel(src, smp, v.uv, lod.x);
    // lod.y picks where the source's channels go (the target's write mask keeps the rest).
    if (lod.y > 2.5) { return vec4f(0.0, 0.0, c.g, c.r); }
    if (lod.y > 1.5) { return vec4f(0.0, 0.0, 0.0, c.r); }
    return c;
}`;

/**
 * Where a source's channels go in its layer: 'rgb' or 'rg' as they are
 * (the rest kept), 'a' its red in alpha (a height map), 'ba' its green and
 * red in blue and alpha (an ARM map's roughness and occlusion).
 */
export type LayerChannels = 'rgba' | 'rgb' | 'rg' | 'a' | 'ba';

const CHANNELS: Record<LayerChannels, { mask: number; mode: number }> = {
    rgba: { mask: 0xf, mode: 0 },
    rgb: { mask: 0x7, mode: 0 },
    rg: { mask: 0x3, mode: 0 },
    a: { mask: 0x8, mode: 2 },
    ba: { mask: 0xc, mode: 3 },
};

const pipelines = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();

function blitPipeline(device: GPUDevice, format: GPUTextureFormat, writeMask: number): GPURenderPipeline {
    let byFormat = pipelines.get(device);
    if (!byFormat) pipelines.set(device, (byFormat = new Map()));
    const key = `${format}|${writeMask}`;
    let p = byFormat.get(key);
    if (!p) {
        const module = device.createShaderModule({ code: BLIT, label: 'morglay-layer-blit' });
        p = device.createRenderPipeline({
            label: `morglay-layer-blit-${format}-${writeMask}`,
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format, writeMask }] },
            primitive: { topology: 'triangle-list' },
        });
        byFormat.set(key, p);
    }
    return p;
}

/** A layer of an array: its fill color, with loaded textures drawn over it into their channels. */
export interface ArrayLayer {
    sources: { texture: Texture | null; channels: LayerChannels }[];
    fill: [number, number, number, number];
}

/**
 * A 2D array texture of `size` with a full mip chain, each layer cleared
 * to its fill color and its sources drawn into their channels (every mip
 * level from the source's matching one).
 */
export function buildLayerArray(ctx: Context3D, layers: ArrayLayer[], size: number, format: GPUTextureFormat, label: string): GPUTexture {
    const device = ctx.device;
    const mips = Math.floor(Math.log2(size)) + 1;
    const tex = device.createTexture({
        label,
        size: { width: size, height: size, depthOrArrayLayers: Math.max(1, layers.length) },
        format,
        mipLevelCount: mips,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
    const encoder = device.createCommandEncoder({ label });
    const buffers: GPUBuffer[] = [];
    layers.forEach((layer, l) => {
        const sources = layer.sources.flatMap((s) => {
            const src = s.texture?.getGPUTexture?.() as GPUTexture | undefined;
            if (!src) return [];
            const { mask, mode } = CHANNELS[s.channels];
            return [{ src, view: src.createView({ dimension: '2d' }), pipeline: blitPipeline(device, format, mask), mode }];
        });
        for (let m = 0; m < mips; m++) {
            const view = tex.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1, baseMipLevel: m, mipLevelCount: 1 });
            const [r, g, b, a] = layer.fill;
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a } }],
            });
            for (const s of sources) {
                const dst = Math.max(1, size >> m);
                const lod = Math.max(0, Math.log2(Math.max(s.src.width, s.src.height) / dst));
                const ub = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                device.queue.writeBuffer(ub, 0, new Float32Array([lod, s.mode, 0, 0]));
                buffers.push(ub);
                const group = device.createBindGroup({
                    layout: s.pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: s.view },
                        { binding: 1, resource: sampler },
                        { binding: 2, resource: { buffer: ub } },
                    ],
                });
                pass.setPipeline(s.pipeline);
                pass.setBindGroup(0, group);
                pass.draw(3);
            }
            pass.end();
        }
    });
    device.queue.submit([encoder.finish()]);
    // The uniforms are only needed by the work just sent.
    void device.queue.onSubmittedWorkDone().then(() => buffers.forEach((b) => b.destroy()));
    return tex;
}

/** A 2D texture filled from bytes (RGBA8 or R32F rows), without mip levels. */
export function uploadTexture(ctx: Context3D, width: number, height: number, format: 'rgba8unorm' | 'r32float', data: ArrayBufferView, label: string): GPUTexture {
    const device = ctx.device;
    const tex = device.createTexture({ label, size: { width, height }, format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    // Both take four bytes a texel.
    device.queue.writeTexture({ texture: tex }, data as BufferSource, { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
    return tex;
}

/**
 * Block compression on the GPU: a compute shader packs each 4x4 block of
 * every layer and level of an RGBA8 array into BC3 (16 bytes: 8 for alpha,
 * 8 for color), a quarter of the memory and bandwidth. Real-time quality:
 * the block's color range (inset a little) and the nearest of its four
 * colors and eight alphas. `swizzle` moves a normal layer's channels
 * (x, y, roughness, occlusion) to (roughness, y, occlusion, x): x gets the
 * eight bit alpha, y the six bit green; readers swap them back.
 */
const BC3 = /* wgsl */ `
struct Params { blocks: vec2u, stride: u32, mip: u32, swizzle: u32, srgb: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4u>;
@group(0) @binding(2) var<uniform> params: Params;

fn toSrgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}
fn to565(c: vec3f) -> u32 {
    let q = vec3u(round(clamp(c, vec3f(0.0), vec3f(1.0)) * vec3f(31.0, 63.0, 31.0)));
    return (q.x << 11u) | (q.y << 5u) | q.z;
}
fn from565(v: u32) -> vec3f {
    return vec3f(f32((v >> 11u) & 31u) / 31.0, f32((v >> 5u) & 63u) / 63.0, f32(v & 31u) / 31.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= params.blocks.x || id.y >= params.blocks.y) { return; }
    let size = vec2i(textureDimensions(src, i32(params.mip)));
    var px: array<vec4f, 16>;
    var lo = vec4f(1.0);
    var hi = vec4f(0.0);
    for (var i = 0u; i < 16u; i++) {
        let at = min(vec2i(id.xy * 4u + vec2u(i % 4u, i / 4u)), size - 1);
        var c = textureLoad(src, at, i32(id.z), i32(params.mip));
        if (params.srgb == 1u) { c = vec4f(toSrgb(c.rgb), c.a); }
        if (params.swizzle == 1u) { c = vec4f(c.b, c.g, c.a, c.r); }
        px[i] = c;
        lo = min(lo, c);
        hi = max(hi, c);
    }
    // Color: the box's ends, pulled in by a sixteenth of it.
    let inset = (hi.rgb - lo.rgb) / 16.0;
    let c0 = to565(hi.rgb - inset);
    let c1 = to565(lo.rgb + inset);
    let p0 = from565(c0);
    let p1 = from565(c1);
    let pal = array<vec3f, 4>(p0, p1, (2.0 * p0 + p1) / 3.0, (p0 + 2.0 * p1) / 3.0);
    var colorBits = 0u;
    // Alpha: eight steps between the block's highest and lowest.
    let a0 = u32(round(hi.a * 255.0));
    let a1 = u32(round(lo.a * 255.0));
    var aLo = 0u;
    var aHi = 0u;
    for (var i = 0u; i < 16u; i++) {
        let c = px[i];
        var best = 0u;
        var bestD = 1e9;
        for (var k = 0u; k < 4u; k++) {
            let d = c.rgb - pal[k];
            let dd = dot(d, d);
            if (dd < bestD) { bestD = dd; best = k; }
        }
        colorBits |= best << (2u * i);
        var ai = 0u;
        if (a0 > a1) {
            let a = c.a * 255.0;
            var bestA = abs(a - f32(a0));
            let d1 = abs(a - f32(a1));
            if (d1 < bestA) { bestA = d1; ai = 1u; }
            for (var k = 2u; k < 8u; k++) {
                let v = (f32(8u - k) * f32(a0) + f32(k - 1u) * f32(a1)) / 7.0;
                let d = abs(a - v);
                if (d < bestA) { bestA = d; ai = k; }
            }
        }
        let bit = 3u * i;
        if (bit < 32u) { aLo |= ai << bit; }
        if (bit + 3u > 32u) { aHi |= select(ai << (bit - 32u), ai >> (32u - bit), bit < 32u); }
    }
    let w0 = a0 | (a1 << 8u) | ((aLo & 0xffffu) << 16u);
    let w1 = (aLo >> 16u) | (aHi << 16u);
    out[(id.z * params.blocks.y + id.y) * params.stride + id.x] = vec4u(w0, w1, c0 | (c1 << 16u), colorBits);
}`;

const bc3Pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();

/** Whether the device can sample BC formats (most computers; few phones). */
export function canCompressBC(ctx: Context3D): boolean {
    return !!ctx.device.features?.has('texture-compression-bc');
}

/**
 * A BC3 copy of an RGBA8 2D array with all its levels (`swizzle` for a
 * normal array, see BC3), or null where the device cannot sample BC.
 * The source stays; the caller lets it go.
 */
export function compressLayerArray(ctx: Context3D, src: GPUTexture, swizzle: boolean, label: string): GPUTexture | null {
    if (!canCompressBC(ctx)) return null;
    const device = ctx.device;
    const srgb = src.format === 'rgba8unorm-srgb';
    if (!srgb && src.format !== 'rgba8unorm') return null;
    let pipeline = bc3Pipelines.get(device);
    if (!pipeline) {
        pipeline = device.createComputePipeline({ label: 'morglay-bc3', layout: 'auto', compute: { module: device.createShaderModule({ code: BC3, label: 'morglay-bc3' }), entryPoint: 'main' } });
        bc3Pipelines.set(device, pipeline);
    }
    const layers = src.depthOrArrayLayers;
    const dst = device.createTexture({
        label,
        size: { width: src.width, height: src.height, depthOrArrayLayers: layers },
        format: srgb ? 'bc3-rgba-unorm-srgb' : 'bc3-rgba-unorm',
        mipLevelCount: src.mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const view = src.createView({ dimension: '2d-array' });
    const encoder = device.createCommandEncoder({ label });
    const temp: GPUBuffer[] = [];
    for (let m = 0; m < src.mipLevelCount; m++) {
        const w = Math.max(1, src.width >> m), h = Math.max(1, src.height >> m);
        const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
        // Rows of whole 256 bytes, as copies from a buffer want them.
        const stride = Math.ceil((bw * 16) / 256) * 16;
        const out = device.createBuffer({ size: stride * 16 * bh * layers, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(params, 0, new Uint32Array([bw, bh, stride, m, swizzle ? 1 : 0, srgb ? 1 : 0, 0, 0]));
        temp.push(out, params);
        const pass = encoder.beginComputePass({ label });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: { buffer: out } },
                { binding: 2, resource: { buffer: params } },
            ],
        }));
        pass.dispatchWorkgroups(Math.ceil(bw / 8), Math.ceil(bh / 8), layers);
        pass.end();
        encoder.copyBufferToTexture(
            { buffer: out, bytesPerRow: stride * 16, rowsPerImage: bh },
            { texture: dst, mipLevel: m },
            { width: bw * 4, height: bh * 4, depthOrArrayLayers: layers },
        );
    }
    device.queue.submit([encoder.finish()]);
    void device.queue.onSubmittedWorkDone().then(() => temp.forEach((b) => b.destroy()));
    return dst;
}

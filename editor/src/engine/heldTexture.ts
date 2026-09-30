// Textures the editor makes on the GPU itself and binds to materials like
// the engine's: a terrain's layer arrays (its layers' swatches copied into
// one texture array each, with their mip levels) and data it uploads (a
// splat map, a height table). The engine has no array texture with mip
// levels, so the layers are drawn into place: any texture the engine
// loaded (KTX2 copies of any format too) goes in at the array's size.

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
    return textureSampleLevel(src, smp, v.uv, lod.x);
}`;

const pipelines = new WeakMap<GPUDevice, Map<GPUTextureFormat, GPURenderPipeline>>();

function blitPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
    let byFormat = pipelines.get(device);
    if (!byFormat) pipelines.set(device, (byFormat = new Map()));
    let p = byFormat.get(format);
    if (!p) {
        const module = device.createShaderModule({ code: BLIT, label: 'morglay-layer-blit' });
        p = device.createRenderPipeline({
            label: `morglay-layer-blit-${format}`,
            layout: 'auto',
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });
        byFormat.set(format, p);
    }
    return p;
}

/** A layer of an array: a loaded texture drawn in, or a plain color where there is none. */
export interface ArrayLayer {
    source: Texture | null;
    fill: [number, number, number, number];
}

/**
 * A 2D array texture of `size` with a full mip chain, each layer drawn
 * from its source (every mip level from the source's matching one) or
 * cleared to its fill color.
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
    const pipeline = blitPipeline(device, format);
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
    const encoder = device.createCommandEncoder({ label });
    const buffers: GPUBuffer[] = [];
    layers.forEach((layer, l) => {
        const src = layer.source?.getGPUTexture?.() as GPUTexture | undefined;
        const srcView = src ? src.createView({ dimension: '2d' }) : null;
        for (let m = 0; m < mips; m++) {
            const view = tex.createView({ dimension: '2d', baseArrayLayer: l, arrayLayerCount: 1, baseMipLevel: m, mipLevelCount: 1 });
            const [r, g, b, a] = layer.fill;
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a } }],
            });
            if (src && srcView) {
                const dst = Math.max(1, size >> m);
                const lod = Math.max(0, Math.log2(Math.max(src.width, src.height) / dst));
                const ub = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                device.queue.writeBuffer(ub, 0, new Float32Array([lod, 0, 0, 0]));
                buffers.push(ub);
                const group = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: srcView },
                        { binding: 1, resource: sampler },
                        { binding: 2, resource: { buffer: ub } },
                    ],
                });
                pass.setPipeline(pipeline);
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

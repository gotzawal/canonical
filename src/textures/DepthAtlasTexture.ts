import { GPUFilterMode, GPUTextureFormat } from '../gfx/graphics/webGpu/WebGPUConst';
import { ITexture } from '../gfx/graphics/webGpu/core/texture/ITexture';
import { Texture } from '../gfx/graphics/webGpu/core/texture/Texture';
import { Context3D } from '../gfx/graphics/webGpu/Context3D';

/**
 * A depth texture that holds many shadow maps side by side (the
 * point and spot lights' faces, each light at its own size), drawn into
 * through viewports and sampled as texture_depth_2d.
 * @internal
 * @group Texture
 */
export class DepthAtlasTexture extends Texture implements ITexture {

    constructor(size: number, ctx?: Context3D) {
        super(size, size, 1);
        this.format = GPUTextureFormat.depth32float;
        this.mipmapCount = 1;
        this._ensureBound(ctx);
        this.init();
    }

    internalCreateBindingLayoutDesc() {
        this.textureBindingLayout.sampleType = `depth`;
        this.textureBindingLayout.viewDimension = `2d`;
        // See Depth2DTextureArray: a depth texture pairs with a comparison or
        // a non-filtering sampler, never a filtering one.
        this.samplerBindingLayout.type = `non-filtering`;
        this.sampler_comparisonBindingLayout.type = `comparison`;
    }

    internalCreateTexture() {
        this.textureDescriptor = {
            format: this.format,
            size: { width: this.width, height: this.height, depthOrArrayLayers: 1 },
            dimension: '2d',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            label: 'pointShadowAtlas',
        };
        this.gpuTexture = this.getGPUTexture();
    }

    internalCreateView() {
        this.viewDescriptor = { dimension: `2d` };
        this.view = this.getGPUView();
    }

    internalCreateSampler() {
        this._ensureBound();
        const device = this._boundCtx!.device;
        // Raw depth reads (PCSS blocker search) take one texel at a time.
        this.gpuSampler = device.createSampler({
            minFilter: GPUFilterMode.nearest,
            magFilter: GPUFilterMode.nearest,
        });
        // Linear compare filters 2x2 texels for free; the shader keeps its
        // taps half a texel inside a face's tile, so none reaches the next.
        this.gpuSampler_comparison = device.createSampler({
            compare: 'less',
            minFilter: 'linear',
            magFilter: 'linear',
            label: 'sampler_comparison',
        });
    }

    /** Makes the atlas this size (its contents are lost); the pipelines that sample it take the new texture. */
    public resize(width: number, height: number = width): void {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        this.updateGPUTexture();
        this.internalCreateTexture();
        this.internalCreateView();
        this.noticeChange();
        this.internalCreateSampler();
    }
}

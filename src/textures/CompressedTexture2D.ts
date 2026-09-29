import { Texture } from '../gfx/graphics/webGpu/core/texture/Texture';
import { Context3D, bindCtx } from '../gfx/graphics/webGpu/Context3D';
import { formatBlockInfo, isCompressedFormat, levelsToSkip, toSrgbFormat } from '../gfx/graphics/webGpu/core/texture/TextureFormatUtil';
import { LoaderBase } from '../loader/LoaderBase';
import { LoaderFunctions } from '../loader/LoaderFunctions';
import { StringUtil } from '../util/StringUtil';
import { TextureColorSpace } from './BitmapTexture2D';
import { isKTX2 } from './ktx2/KTX2Container';
import { KTX2Level, KTX2Transcoder } from './ktx2/KTX2Transcoder';

/**
 * A 2D texture filled with ready-made mip levels, usually block compressed
 * (BC, ETC2, ASTC) from a KTX2 file: it stays compressed on the GPU, a
 * quarter or less of the memory of the same image as RGBA8.
 *
 * Block-compressed GPU textures can only be sampled and copied, so this
 * texture is never a render target and never mipmapped on the GPU; the
 * levels it gets are the levels it has. Uncompressed data with a single
 * level (a KTX2 file transcoded to RGBA8) still gets its mips made.
 *
 * It can also show a plain image (`setImage`, RGBA8 with mips made on the
 * GPU) and switch between the two in place: materials using it rebind, so
 * an image can show until its compressed copy is ready.
 *
 * @group Texture
 */
export class CompressedTexture2D extends Texture {
    /** `'srgb'` samples the data as sRGB-encoded color (base color, emissive); `'linear'` as data. */
    public colorSpace: TextureColorSpace;

    /** Levels larger than this (the longer side, pixels) are left out when the data has smaller ones. */
    public maxSize = Infinity;

    private _levels: KTX2Level[] | null = null;
    private _makeMips = false;
    /** Filled from levels (else from an image, or not yet). */
    private _fromLevels = false;

    constructor(ctx?: Context3D, colorSpace: TextureColorSpace = 'linear') {
        super();
        this.colorSpace = colorSpace;
        // A filtering sampler; the mips come with the data.
        this.useMipmap = true;
        this.lodMinClamp = 0;
        this.lodMaxClamp = 4;
        if (ctx) bindCtx(this, ctx);
    }

    /**
     * Take the texture's levels, largest first. The GPU texture is made and
     * filled the first time it is used; the CPU copy is dropped then.
     */
    public setLevels(format: GPUTextureFormat, width: number, height: number, levels: KTX2Level[]) {
        if (!levels?.length) throw new Error('a texture needs at least one level');
        // A file may claim more levels than its size has; WebGPU rejects such a texture.
        const most = Math.floor(Math.log2(Math.max(width, height, 1))) + 1;
        if (levels.length > most) levels = levels.slice(0, most);
        // Too large for this device's tier: start from a smaller level.
        const skip = levelsToSkip(format, levels, this.maxSize);
        if (skip) {
            levels = levels.slice(skip);
            width = levels[0].width;
            height = levels[0].height;
        }
        const block = formatBlockInfo(format);
        if (isCompressedFormat(format) && (width % block.w || height % block.h)) {
            throw new Error(`${format} needs a size in whole ${block.w}x${block.h} blocks, not ${width}x${height}`);
        }
        this.dropSourceImage();
        this._levels = levels;
        this._fromLevels = true;
        this.width = width;
        this.height = height;
        this._makeMips = !isCompressedFormat(format) && levels.length === 1 && Math.max(width, height) > 1;
        this.mipmapCount = this._makeMips ? this.getMipmapCount() : levels.length;
        let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
        if (this._makeMips) usage |= GPUTextureUsage.RENDER_ATTACHMENT;
        this.createTextureDescriptor(width, height, this.mipmapCount, format, usage);
        this.updateGPUTexture();
        this.noticeChange();
    }

    /**
     * Show an image: RGBA8 (sRGB for the 'srgb' color space) with its mips
     * made on the GPU, as BitmapTexture2D shows it.
     */
    public setImage(image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas) {
        this._levels = null;
        this._fromLevels = false;
        this._makeMips = false;
        this.format = this.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
        this.generate(image);
    }

    /** Fetch a KTX2 file and transcode it for this device. Rejects when either fails. */
    public async load(url: string, loaderFunctions?: LoaderFunctions): Promise<boolean> {
        // Relative URLs are origin-absolute, as BitmapTexture2D.load and LoaderBase make them.
        if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('/') && typeof location !== 'undefined') {
            url = '/' + url;
        }
        this.url = url;
        this.name ||= StringUtil.getURLName(url);
        const response = await fetch(url, { headers: loaderFunctions?.headers });
        if (!response.ok && response.status !== 0) throw new Error(`${url} failed to load (${response.status})`);
        const bytes = await LoaderBase.read(url, response, loaderFunctions);
        return this.loadKTX2(bytes);
    }

    /** Transcode KTX2 data for this device. The data is copied, never taken. */
    public async loadKTX2(data: ArrayBuffer | ArrayBufferView | Blob): Promise<boolean> {
        const ctx = this._ensureBound();
        const bytes = data instanceof Blob
            ? await data.arrayBuffer()
            : ArrayBuffer.isView(data)
                ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
                : data.slice(0);
        if (!isKTX2(bytes)) throw new Error(`${this.name || 'texture'} is not a KTX2 file`);
        const image = await KTX2Transcoder.shared.transcode(bytes, ctx.compressedTextureSupport);
        const format = this.colorSpace === 'srgb' ? toSrgbFormat(image.format) : image.format;
        this.setLevels(format, image.width, image.height, image.levels);
        return true;
    }

    protected _isAutoMipmappable(): boolean {
        return (this._fromLevels ? this._makeMips : true) && super._isAutoMipmappable();
    }

    protected uploadInitialData(tex: GPUTexture) {
        if (!this._fromLevels) {
            super.uploadInitialData(tex);
            return;
        }
        const levels = this._levels;
        if (!levels) return;
        const device = this._ensureBound().device;
        const block = formatBlockInfo(this.format);
        levels.forEach((level, mipLevel) => {
            // Copies cover whole blocks, even for levels smaller than a block.
            const bx = Math.ceil(level.width / block.w);
            const by = Math.ceil(level.height / block.h);
            device.queue.writeTexture(
                { texture: tex, mipLevel },
                level.data as Uint8Array<ArrayBuffer>,
                { bytesPerRow: bx * block.bytes, rowsPerImage: by },
                { width: bx * block.w, height: by * block.h },
            );
        });
        this._levels = null;
    }

    public destroy(force?: boolean) {
        if (force) this._levels = null;
        super.destroy(force);
    }
}

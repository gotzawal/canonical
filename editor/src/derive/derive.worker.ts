// Encodes textures to KTX2 (Basis Universal) off the main thread, for the
// derived copies games ship (derive/derivedAssets.ts). The encoder's
// WebAssembly (3.3 MB) loads on the first texture, and only the editor
// loads this worker: games never include it.

/// <reference lib="webworker" />
import BASIS from 'basis-encoder';
import type { DerivedOptions } from '../core/derived';
import type { TextureRole } from '../core/types';
import { encodedSize, encoderSettings } from './encode';

export type DeriveIn =
    | { type: 'init'; wasmUrl: string }
    | { type: 'texture'; id: number; blob: Blob; role: TextureRole; opts: DerivedOptions };

export type DeriveOut =
    | { type: 'done'; id: number; data: ArrayBuffer; width: number; height: number; levels: number; alpha: boolean }
    | { type: 'failed'; id: number; message: string };

declare const self: DedicatedWorkerGlobalScope;

let wasmUrl = '';
let basis: Promise<any> | null = null;

self.onmessage = (e: MessageEvent<DeriveIn>) => {
    const msg = e.data;
    if (msg.type === 'init') {
        wasmUrl = msg.wasmUrl;
        return;
    }
    if (msg.type === 'texture') {
        encode(msg).then(
            (out) => self.postMessage({ type: 'done', id: msg.id, ...out } satisfies DeriveOut, [out.data]),
            (err) => self.postMessage({ type: 'failed', id: msg.id, message: String(err?.message || err) } satisfies DeriveOut),
        );
    }
};

function encoder(): Promise<any> {
    basis ??= (async () => {
        const res = await fetch(wasmUrl);
        if (!res.ok) throw new Error(`The texture encoder failed to load (${res.status}).`);
        const module = await BASIS({ wasmBinary: await res.arrayBuffer() });
        module.initializeBasis();
        return module;
    })();
    basis.catch(() => (basis = null));
    return basis;
}

async function encode(msg: Extract<DeriveIn, { type: 'texture' }>) {
    const module = await encoder();
    // Decoded as the engine decodes it (BitmapTexture2D): colors under
    // transparent pixels kept, the image's color profile applied.
    const source = await createImageBitmap(msg.blob, { premultiplyAlpha: 'none' });
    const size = encodedSize(source.width, source.height, msg.opts.maxSize);
    let bitmap = source;
    if (size.width !== source.width || size.height !== source.height) {
        bitmap = await createImageBitmap(msg.blob, { premultiplyAlpha: 'none', resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
        source.close();
    }
    const pixels = readPixels(bitmap);
    bitmap.close();
    let alpha = false;
    for (let i = 3; i < pixels.length && !alpha; i += 4) alpha = pixels[i] < 255;

    const s = encoderSettings(msg.role, msg.opts);
    const enc = new module.BasisEncoder();
    try {
        enc.setCreateKTX2File(true);
        enc.setTexType(0);
        enc.setUASTC(s.uastc);
        enc.setPerceptual(s.srgb);
        enc.setKTX2AndBasisSRGBTransferFunc(s.srgb);
        enc.setMipSRGB(s.srgb);
        enc.setMipGen(true);
        if (s.normalMap) {
            enc.setNormalMapPreset();
            enc.setMipRenormalize(true);
        }
        if (s.uastc) {
            enc.setPackUASTCFlags(s.uastcLevel);
            enc.setKTX2UASTCSupercompression(s.zstd);
        } else {
            enc.setQualityLevel(s.quality);
            enc.setETC1SCompressionLevel(s.effort);
        }
        if (enc.setSliceSourceImage(0, pixels, size.width, size.height, 0) === false) throw new Error('The encoder refused the image.');
        // Room for the base level and its mips uncompressed, and the header.
        let capacity = Math.ceil(size.width * size.height * 4 * (4 / 3)) + 65536;
        for (let attempt = 0; attempt < 2; attempt++, capacity *= 2) {
            const out = new Uint8Array(capacity);
            const length = enc.encode(out);
            if (length > 0) {
                const levels = Math.floor(Math.log2(Math.max(size.width, size.height))) + 1;
                return { data: out.slice(0, length).buffer as ArrayBuffer, width: size.width, height: size.height, levels, alpha };
            }
        }
        throw new Error('The texture could not be encoded.');
    } finally {
        enc.delete();
    }
}

/** RGBA bytes of an image, top row first, colors under transparent pixels kept. */
function readPixels(bitmap: ImageBitmap): Uint8Array {
    const { width: w, height: h } = bitmap;
    const canvas = new OffscreenCanvas(w, h);
    // WebGL keeps colors where alpha is 0; a 2D canvas stores them premultiplied and loses them.
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (gl) {
        const tex = gl.createTexture();
        const fb = gl.createFramebuffer();
        try {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            const out = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
            if (gl.getError() === gl.NO_ERROR) return out;
        } finally {
            gl.deleteFramebuffer(fb);
            gl.deleteTexture(tex);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    }
    const g = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0);
    return new Uint8Array(g.getImageData(0, 0, w, h).data.buffer);
}

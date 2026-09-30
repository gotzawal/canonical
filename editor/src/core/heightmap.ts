// Terrain heightmaps. The editor stores them as 16-bit grayscale PNG files
// (what terrain tools export), read and written here with the platform's
// CompressionStream, and also reads raw 16-bit files (.r16, .raw) and 8-bit
// PNGs. Heights are normalized values 0..1, row by row from the terrain's
// -z edge (the image's top) to its +z edge, columns along +x.

import { crc32 } from './zip';

export interface Heightmap {
    /** Samples along x and along z. */
    width: number;
    height: number;
    /** Normalized heights 0..1, width * height of them. */
    data: Float32Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
    return SIGNATURE.every((b, i) => bytes[i] === b);
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A decoded PNG: its size, channels and 8 or 16 bits a channel, rows unfiltered. */
interface PngImage {
    width: number;
    height: number;
    channels: number;
    depth: 8 | 16;
    pixels: Uint8Array;
}

async function decodePngImage(bytes: Uint8Array): Promise<PngImage> {
    if (!isPng(bytes)) throw new Error('Not a PNG file.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = 0;
    const idat: Uint8Array[] = [];
    for (let at = 8; at + 8 <= bytes.length; ) {
        const length = view.getUint32(at);
        const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
        const body = bytes.subarray(at + 8, at + 8 + length);
        if (type === 'IHDR') {
            width = view.getUint32(at + 8);
            height = view.getUint32(at + 12);
            depth = bytes[at + 16];
            colorType = bytes[at + 17];
            if (bytes[at + 20] !== 0) throw new Error('Interlaced PNG heightmaps are not supported: save it without interlacing.');
        } else if (type === 'IDAT') idat.push(body);
        else if (type === 'IEND') break;
        at += 12 + length;
    }
    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
    if (!channels || (depth !== 8 && depth !== 16)) throw new Error('The heightmap must be a grayscale or RGB PNG with 8 or 16 bits a channel.');
    if (!width || !height) throw new Error('The PNG has no size.');
    let total = 0;
    for (const part of idat) total += part.length;
    const joined = new Uint8Array(total);
    total = 0;
    for (const part of idat) {
        joined.set(part, total);
        total += part.length;
    }
    const raw = await inflate(joined);
    const bpp = (channels * depth) / 8;
    const stride = width * bpp;
    if (raw.length < height * (stride + 1)) throw new Error('The PNG data is cut short.');
    const pixels = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1;
        const row = y * stride;
        const prev = row - stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? pixels[row + x - bpp] : 0;
            const b = y > 0 ? pixels[prev + x] : 0;
            const c = y > 0 && x >= bpp ? pixels[prev + x - bpp] : 0;
            const v = raw[src + x];
            pixels[row + x] = filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : paeth(a, b, c) + v;
        }
    }
    return { width, height, channels, depth: depth as 8 | 16, pixels };
}

/** A PNG heightmap: the first channel (gray, or red) of each pixel. */
export async function decodePngHeightmap(bytes: Uint8Array): Promise<Heightmap> {
    const img = await decodePngImage(bytes);
    const data = new Float32Array(img.width * img.height);
    const step = (img.channels * img.depth) / 8;
    for (let i = 0; i < data.length; i++) {
        const at = i * step;
        data[i] = img.depth === 16 ? ((img.pixels[at] << 8) | img.pixels[at + 1]) / 65535 : img.pixels[at] / 255;
    }
    return { width: img.width, height: img.height, data };
}

/** A PNG's pixels as 8-bit RGBA (a splat map), without the browser's premultiplied alpha. */
export async function decodePngRgba(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
    const img = await decodePngImage(bytes);
    const out = new Uint8Array(img.width * img.height * 4);
    const step = (img.channels * img.depth) / 8;
    const byte = img.depth === 16 ? 2 : 1;
    for (let i = 0; i < img.width * img.height; i++) {
        for (let c = 0; c < 4; c++) {
            const ch = img.channels >= 3 ? c : c < 3 ? 0 : 1;
            out[i * 4 + c] = ch < img.channels ? img.pixels[i * step + ch * byte] : c === 3 ? 255 : 0;
        }
    }
    return { width: img.width, height: img.height, data: out };
}

/** Raw 16-bit little-endian heights of a square map (.r16, .raw from terrain tools). */
export function decodeRawHeightmap(bytes: Uint8Array): Heightmap {
    const n = Math.round(Math.sqrt(bytes.length / 2));
    if (n < 2 || n * n * 2 !== bytes.length) throw new Error('A raw heightmap must be a square of 16-bit samples (for example 513 x 513).');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const data = new Float32Array(n * n);
    for (let i = 0; i < data.length; i++) data[i] = view.getUint16(i * 2, true) / 65535;
    return { width: n, height: n, data };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
}

/** Filters each row with the filter that leaves the smallest bytes (Up or Paeth), as encoders do. */
function filterRows(pixels: Uint8Array, stride: number, rows: number, bpp: number): Uint8Array {
    const out = new Uint8Array(rows * (stride + 1));
    const up = new Uint8Array(stride);
    const pa = new Uint8Array(stride);
    for (let y = 0; y < rows; y++) {
        const row = y * stride;
        let costUp = 0;
        let costPaeth = 0;
        for (let x = 0; x < stride; x++) {
            const v = pixels[row + x];
            const a = x >= bpp ? pixels[row + x - bpp] : 0;
            const b = y > 0 ? pixels[row - stride + x] : 0;
            const c = y > 0 && x >= bpp ? pixels[row - stride + x - bpp] : 0;
            up[x] = v - b;
            pa[x] = v - paeth(a, b, c);
            costUp += up[x] < 128 ? up[x] : 256 - up[x];
            costPaeth += pa[x] < 128 ? pa[x] : 256 - pa[x];
        }
        out[y * (stride + 1)] = costPaeth < costUp ? 4 : 2;
        out.set(costPaeth < costUp ? pa : up, y * (stride + 1) + 1);
    }
    return out;
}

async function encodePng(width: number, height: number, colorType: number, depth: 8 | 16, pixels: Uint8Array): Promise<Uint8Array> {
    const channels = ({ 0: 1, 6: 4 } as Record<number, number>)[colorType];
    const bpp = (channels * depth) / 8;
    const header = new Uint8Array(13);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    header[8] = depth;
    header[9] = colorType;
    const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', header), chunk('IDAT', await deflate(filterRows(pixels, width * bpp, height, bpp))), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** A heightmap as a 16-bit grayscale PNG. */
export function encodePngHeightmap(map: Heightmap): Promise<Uint8Array> {
    const pixels = new Uint8Array(map.width * map.height * 2);
    for (let i = 0; i < map.data.length; i++) {
        const v = Math.round(Math.min(1, Math.max(0, map.data[i])) * 65535);
        pixels[i * 2] = v >> 8;
        pixels[i * 2 + 1] = v & 0xff;
    }
    return encodePng(map.width, map.height, 0, 16, pixels);
}

/** 8-bit RGBA pixels (a splat map) as a PNG. */
export function encodePngRgba(width: number, height: number, data: Uint8Array): Promise<Uint8Array> {
    return encodePng(width, height, 6, 8, data);
}

/** Reads a heightmap file: a PNG (8 or 16 bits), or raw 16-bit samples (.r16, .raw). */
export async function readHeightmap(blob: Blob, name: string): Promise<Heightmap> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (isPng(bytes)) return decodePngHeightmap(bytes);
    if (/\.(r16|raw)$/i.test(name)) return decodeRawHeightmap(bytes);
    throw new Error(`${name} is not a heightmap: use a 16-bit grayscale PNG or a raw 16-bit file (.r16, .raw).`);
}

/** The height at a point given in samples (x along a row, z down the rows), bilinear, clamped to the edges. */
export function heightAt(map: Heightmap, x: number, z: number): number {
    const w = map.width;
    const h = map.height;
    const fx = Math.min(Math.max(x, 0), w - 1);
    const fz = Math.min(Math.max(z, 0), h - 1);
    const x0 = Math.min(Math.floor(fx), w - 2);
    const z0 = Math.min(Math.floor(fz), h - 2);
    const tx = fx - x0;
    const tz = fz - z0;
    const d = map.data;
    const i = z0 * w + x0;
    const top = d[i] + (d[i + 1] - d[i]) * tx;
    const bottom = d[i + w] + (d[i + w + 1] - d[i + w]) * tx;
    return top + (bottom - top) * tz;
}

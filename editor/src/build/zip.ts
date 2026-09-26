// Minimal ZIP writer (PKWARE APPNOTE 6.3): text files are deflated with the
// browser's CompressionStream, already compressed files (images, models)
// are stored. No ZIP64, so each file and the archive stay below 4 GB.

export interface ZipEntry {
    path: string;
    data: Blob | Uint8Array | string;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

async function bytes(data: ZipEntry['data']): Promise<Uint8Array> {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(await data.arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
    if (typeof CompressionStream === 'undefined') return null;
    try {
        const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
        return null;
    }
}

const COMPRESSIBLE = /\.(html?|js|mjs|css|json|txt|svg|wgsl|gltf|obj|md)$/i;

function dosDateTime(d: Date): { time: number; date: number } {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

/** Builds a .zip archive of `entries` (paths use forward slashes). */
export async function createZip(entries: ZipEntry[]): Promise<Blob> {
    const encoder = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = encoder.encode(entry.path.replace(/^\/+/, ''));
        const raw = await bytes(entry.data);
        const crc = crc32(raw);
        let method = 0;
        let body = raw;
        if (COMPRESSIBLE.test(entry.path) && raw.length > 64) {
            const packed = await deflate(raw);
            if (packed && packed.length < raw.length) {
                method = 8;
                body = packed;
            }
        }

        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true); // version needed
        lv.setUint16(6, 0x0800, true); // UTF-8 names
        lv.setUint16(8, method, true);
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, body.length, true);
        lv.setUint32(22, raw.length, true);
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);
        local.set(name, 30);
        parts.push(local, body);

        const cd = new Uint8Array(46 + name.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true); // version made by
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, method, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, body.length, true);
        cv.setUint32(24, raw.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        cd.set(name, 46);
        central.push(cd);

        offset += local.length + body.length;
    }

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end] as BlobPart[], { type: 'application/zip' });
}

async function inflate(data: Blob): Promise<Blob> {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack compressed zip files.');
    const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).blob();
}

/**
 * Reads a .zip archive into its files by path. Stored and deflated entries
 * are supported (what createZip and common zip tools write); folders are
 * skipped.
 */
export async function readZip(zip: Blob): Promise<Map<string, Blob>> {
    const size = zip.size;
    // The end of central directory record sits in the last 22 + 65535 bytes.
    const tailStart = Math.max(0, size - 22 - 0xffff);
    const tail = new DataView(await zip.slice(tailStart).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('Not a zip file.');
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOffset = tail.getUint32(eocd + 16, true);
    if (cdOffset + cdSize > size) throw new Error('The zip file is damaged or uses ZIP64, which is not supported.');
    const cd = new DataView(await zip.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const decoder = new TextDecoder();
    const files = new Map<string, Blob>();
    let p = 0;
    for (let n = 0; n < count; n++) {
        if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
        const method = cd.getUint16(p + 10, true);
        const compressed = cd.getUint32(p + 20, true);
        const nameLen = cd.getUint16(p + 28, true);
        const extraLen = cd.getUint16(p + 30, true);
        const commentLen = cd.getUint16(p + 32, true);
        const localOffset = cd.getUint32(p + 42, true);
        const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/')) continue;
        const local = new DataView(await zip.slice(localOffset, localOffset + 30).arrayBuffer());
        if (local.getUint32(0, true) !== 0x04034b50) throw new Error(`The zip entry ${name} is damaged.`);
        const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        const body = zip.slice(start, start + compressed);
        if (method === 0) files.set(name, body);
        else if (method === 8) files.set(name, await inflate(body));
        else throw new Error(`The zip entry ${name} uses an unsupported compression method.`);
    }
    return files;
}

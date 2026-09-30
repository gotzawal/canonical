// Packs a .gltf and the files it references (buffers, images) into one GLB,
// the self-contained file the editor stores: for .gltf links, and for a
// .gltf dropped together with its files.

/** The external files a .gltf names (not data: URIs). */
export function externalUris(json: any): string[] {
    const out: string[] = [];
    for (const list of [json?.buffers, json?.images]) {
        for (const x of Array.isArray(list) ? list : []) {
            if (typeof x?.uri === 'string' && !x.uri.startsWith('data:')) out.push(x.uri);
        }
    }
    return out;
}

function dataUri(uri: string): Uint8Array {
    const comma = uri.indexOf(',');
    const head = uri.slice(0, comma);
    const body = uri.slice(comma + 1);
    if (head.endsWith(';base64')) {
        const bin = atob(body);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
}

const align4 = (n: number) => (n + 3) & ~3;

const IMAGE_TYPES: [RegExp, string][] = [
    [/\.png$/i, 'image/png'],
    [/\.jpe?g$/i, 'image/jpeg'],
    [/\.webp$/i, 'image/webp'],
    [/\.ktx2$/i, 'image/ktx2'],
];

/**
 * The GLB of a glTF document: every buffer becomes one binary chunk (the
 * buffer views move with them) and every image a view into it. `read`
 * returns the bytes of a file the document names (its URI as written).
 */
export async function packGltf(gltf: any, read: (uri: string) => Promise<ArrayBuffer>): Promise<Blob> {
    const json = JSON.parse(JSON.stringify(gltf));
    const parts: Uint8Array[] = [];
    let length = 0;
    const append = (bytes: Uint8Array): number => {
        const at = length;
        parts.push(bytes);
        length = align4(at + bytes.byteLength);
        const pad = length - at - bytes.byteLength;
        if (pad) parts.push(new Uint8Array(pad));
        return at;
    };
    const bytesOf = async (uri: string) => (uri.startsWith('data:') ? dataUri(uri) : new Uint8Array(await read(uri)));
    const buffers: any[] = Array.isArray(json.buffers) ? json.buffers : [];
    const offsets: number[] = [];
    for (const b of buffers) {
        if (typeof b.uri !== 'string') throw new Error('The .gltf has a buffer without a file.');
        offsets.push(append(await bytesOf(b.uri)));
    }
    for (const view of Array.isArray(json.bufferViews) ? json.bufferViews : []) {
        view.byteOffset = (view.byteOffset ?? 0) + offsets[view.buffer];
        view.buffer = 0;
    }
    json.bufferViews ??= [];
    for (const img of Array.isArray(json.images) ? json.images : []) {
        if (typeof img.uri !== 'string') continue;
        const bytes = await bytesOf(img.uri);
        const at = append(bytes);
        img.mimeType ??= img.uri.startsWith('data:') ? img.uri.slice(5, img.uri.indexOf(';')) : IMAGE_TYPES.find(([re]) => re.test(img.uri))?.[1] ?? 'image/png';
        delete img.uri;
        img.bufferView = json.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: bytes.byteLength }) - 1;
    }
    if (!json.bufferViews.length) delete json.bufferViews;
    json.buffers = length ? [{ byteLength: length }] : undefined;
    if (!json.buffers) delete json.buffers;

    const text = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = align4(text.byteLength);
    const total = 12 + 8 + jsonLength + (length ? 8 + length : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); // glTF
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLength, true);
    dv.setUint32(16, 0x4e4f534a, true); // JSON
    out.set(text, 20);
    out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
    if (length) {
        let at = 20 + jsonLength;
        dv.setUint32(at, length, true);
        dv.setUint32(at + 4, 0x004e4942, true); // BIN
        at += 8;
        for (const p of parts) {
            out.set(p, at);
            at += p.byteLength;
        }
    }
    return new Blob([out], { type: 'model/gltf-binary' });
}

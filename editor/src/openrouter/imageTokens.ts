// What the images sent to a language model cost in prompt tokens. Providers
// fold them into the prompt tokens they report, so the usage statistics
// estimate them from each image's pixel size and the provider's published
// rules (a report of image tokens, where a route sends one, wins).

/** Width and height of a PNG, JPEG, WebP or GIF data URL, read from its header; null for other URLs. */
export function dataUrlSize(url: string): { w: number; h: number } | null {
    const comma = url.indexOf(',');
    if (!url.startsWith('data:') || comma < 0 || !url.slice(0, comma).endsWith(';base64')) return null;
    // Headers are near the start; a JPEG's frame header can follow large metadata.
    for (const chars of [4096, 65536, 1 << 20]) {
        const bytes = decode(url, comma + 1, chars);
        const size = pngSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes) ?? jpegSize(bytes);
        if (size) return size;
        if (comma + 1 + chars >= url.length) break;
    }
    return null;
}

function decode(url: string, from: number, chars: number): Uint8Array {
    const b64 = url.slice(from, from + chars);
    const s = atob(b64.slice(0, b64.length - (b64.length % 4)));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

function pngSize(b: Uint8Array) {
    if (b.length < 24 || b[0] !== 0x89 || tag(b, 12) !== 'IHDR') return null;
    return { w: be32(b, 16), h: be32(b, 20) };
}

function gifSize(b: Uint8Array) {
    if (b.length < 10 || !tag(b, 0).startsWith('GIF')) return null;
    return { w: le16(b, 6), h: le16(b, 8) };
}

function webpSize(b: Uint8Array) {
    if (b.length < 30 || tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WEBP') return null;
    const chunk = tag(b, 12);
    if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === 'VP8 ') return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
}

function jpegSize(b: Uint8Array) {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker === 0xff) {
            // Fill byte.
            i++;
            continue;
        }
        // Frame headers (SOF0-15, not DHT, JPG or DAC) carry the size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: be16(b, i + 7), h: be16(b, i + 5) };
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }
        i += 2 + be16(b, i + 2);
    }
    return null;
}

/**
 * Prompt tokens of one image of w x h pixels for a model (an OpenRouter id):
 * OpenAI counts 512 px tiles of the image fitted in 2048 px and 768 px on its
 * short side (a flat 85 at low detail), Google 768 px tiles (258 tokens each,
 * one for an image within 384 px), and Anthropic, like the others here,
 * about one token per 750 pixels of the image fitted in 1568 px and 1.15
 * megapixels.
 */
export function imageTokens(model: string, w: number, h: number, detail?: 'low' | 'high' | 'auto'): number {
    if (!(w > 0 && h > 0)) return 0;
    const id = model.toLowerCase();
    if (id.startsWith('openai/')) {
        if (detail === 'low') return 85;
        let s = Math.min(1, 2048 / Math.max(w, h));
        s *= Math.min(1, 768 / (Math.min(w, h) * s));
        return 85 + 170 * Math.ceil((w * s) / 512) * Math.ceil((h * s) / 512);
    }
    if (id.startsWith('google/')) return w <= 384 && h <= 384 ? 258 : 258 * Math.ceil(w / 768) * Math.ceil(h / 768);
    const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));
    return Math.ceil((w * s * h * s) / 750);
}

// A small software renderer for the library's model thumbnails: the model
// seen from the front right and above, each triangle one color (the base
// color texture at its middle, times the material's and the vertices'
// colors) lit by one light. Low-poly packs read well that way, and it needs
// no GPU, so the mirror script runs anywhere.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

const YAW = (35 * Math.PI) / 180;
const PITCH = (28 * Math.PI) / 180;
const LIGHT = norm([-0.45, 0.8, 0.55]);
/** Rendered this many times larger, then averaged down (anti-aliasing). */
const SS = 3;

function norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

function transform(m, p) {
    return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
}

// ------------------------------------------------------------------- PNG

/** RGBA pixels of an 8-bit, non-interlaced PNG, or null for any other kind. */
export function decodePng(buf) {
    if (buf.length < 33 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
    let pos = 8;
    let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
    let palette = null, alpha = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const kind = buf.toString('latin1', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (kind === 'IHDR') {
            w = data.readUInt32BE(0);
            h = data.readUInt32BE(4);
            depth = data[8];
            type = data[9];
            interlace = data[12];
        } else if (kind === 'PLTE') palette = data;
        else if (kind === 'tRNS') alpha = data;
        else if (kind === 'IDAT') idat.push(data);
        else if (kind === 'IEND') break;
        pos += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (depth !== 8 || interlace || !channels) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * channels;
    const px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1;
        const row = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? px[row + x - channels] : 0;
            const b = y ? px[row - stride + x] : 0;
            const c = x >= channels && y ? px[row - stride + x - channels] : 0;
            let v = raw[src + x];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            px[row + x] = v & 255;
        }
    }
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const s = i * channels;
        let r, g, b, al = 255;
        if (type === 3) {
            const k = px[s];
            [r, g, b] = [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2]];
            if (alpha && k < alpha.length) al = alpha[k];
        } else if (type === 0 || type === 4) {
            r = g = b = px[s];
            if (type === 4) al = px[s + 1];
        } else {
            [r, g, b] = [px[s], px[s + 1], px[s + 2]];
            if (type === 6) al = px[s + 3];
        }
        out.set([r, g, b, al], i * 4);
    }
    return { width: w, height: h, data: out };
}

/** An RGBA image as a PNG file. */
export function encodePng(width, height, rgba) {
    const chunk = (kind, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(kind, 4, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
        return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ------------------------------------------------------------- triangles

/** The model's triangles in world space, each with its color. */
function triangles(doc) {
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const images = new Map();
    const imageOf = (texture) => {
        if (!texture) return null;
        if (!images.has(texture)) images.set(texture, texture.getMimeType() === 'image/png' ? decodePng(Buffer.from(texture.getImage())) : null);
        return images.get(texture);
    };
    const out = [];
    const visit = (node) => {
        const mesh = node.getMesh();
        if (mesh) {
            const m = node.getWorldMatrix();
            for (const prim of mesh.listPrimitives()) {
                if (prim.getMode() !== 4) continue;
                const pos = prim.getAttribute('POSITION');
                if (!pos) continue;
                const uv = prim.getAttribute('TEXCOORD_0');
                const col = prim.getAttribute('COLOR_0');
                const mat = prim.getMaterial();
                const factor = mat?.getBaseColorFactor() ?? [1, 1, 1, 1];
                const img = imageOf(mat?.getBaseColorTexture());
                const idx = prim.getIndices();
                const count = idx ? idx.getCount() : pos.getCount();
                const at = (i) => (idx ? idx.getScalar(i) : i);
                const el = [];
                for (let t = 0; t + 2 < count; t += 3) {
                    const ids = [at(t), at(t + 1), at(t + 2)];
                    const p = ids.map((i) => transform(m, pos.getElement(i, el).slice()));
                    let c = [factor[0], factor[1], factor[2]];
                    if (img && uv) {
                        let u = 0, v = 0;
                        for (const i of ids) {
                            const e = uv.getElement(i, el);
                            u += e[0] / 3;
                            v += e[1] / 3;
                        }
                        u -= Math.floor(u);
                        v -= Math.floor(v);
                        const x = Math.min(img.width - 1, Math.floor(u * img.width));
                        const y = Math.min(img.height - 1, Math.floor(v * img.height));
                        const k = (y * img.width + x) * 4;
                        // The texture is sRGB; the factor and vertex colors are linear.
                        c = c.map((f, j) => f * (img.data[k + j] / 255) ** 2.2);
                    }
                    if (col) {
                        const s = [0, 0, 0];
                        for (const i of ids) {
                            const e = col.getElement(i, el);
                            for (let j = 0; j < 3; j++) s[j] += e[j] / 3;
                        }
                        c = c.map((f, j) => f * s[j]);
                    }
                    out.push({ p, c });
                }
            }
        }
        node.listChildren().forEach(visit);
    };
    scene?.listChildren().forEach(visit);
    return out;
}

// ---------------------------------------------------------------- render

/** A PNG of the model, `size` pixels square with a transparent background, or null without triangles. */
export function renderThumbnail(doc, size = 160) {
    const tris = triangles(doc);
    if (!tris.length) return null;
    // View space: turned by the yaw around y, then tilted down by the pitch.
    const cy = Math.cos(YAW), sy = Math.sin(YAW), cp = Math.cos(PITCH), sp = Math.sin(PITCH);
    const view = (v) => {
        const x = cy * v[0] - sy * v[2];
        const z = sy * v[0] + cy * v[2];
        return [x, cp * v[1] - sp * z, sp * v[1] + cp * z];
    };
    const light = view(LIGHT);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tris) {
        t.v = t.p.map(view);
        for (const v of t.v) {
            minX = Math.min(minX, v[0]);
            maxX = Math.max(maxX, v[0]);
            minY = Math.min(minY, v[1]);
            maxY = Math.max(maxY, v[1]);
        }
    }
    const n = size * SS;
    const pad = 0.08 * n;
    const k = (n - 2 * pad) / Math.max(maxX - minX, maxY - minY, 1e-6);
    const ox = (n - (maxX - minX) * k) / 2;
    const oy = (n - (maxY - minY) * k) / 2;
    const depth = new Float32Array(n * n).fill(-Infinity);
    const color = new Float32Array(n * n * 3);
    for (const t of tris) {
        const s = t.v.map((v) => [ox + (v[0] - minX) * k, n - (oy + (v[1] - minY) * k), v[2]]);
        const e1 = [t.v[1][0] - t.v[0][0], t.v[1][1] - t.v[0][1], t.v[1][2] - t.v[0][2]];
        const e2 = [t.v[2][0] - t.v[0][0], t.v[2][1] - t.v[0][1], t.v[2][2] - t.v[0][2]];
        let nrm = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
        // Toward the viewer, whichever way the triangle winds (a view along -z sees +z).
        if (nrm[2] < 0) nrm = nrm.map((x) => -x);
        const lit = 0.42 + 0.58 * Math.max(0, nrm[0] * light[0] + nrm[1] * light[1] + nrm[2] * light[2]);
        const rgb = t.c.map((c) => c * lit);
        const area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
        const x1 = Math.min(n - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
        const y0 = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
        const y1 = Math.min(n - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((s[1][0] - px) * (s[2][1] - py) - (s[2][0] - px) * (s[1][1] - py)) / area;
                const w1 = ((s[2][0] - px) * (s[0][1] - py) - (s[0][0] - px) * (s[2][1] - py)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * s[0][2] + w1 * s[1][2] + w2 * s[2][2];
                const i = y * n + x;
                // Nearer is larger z (the view looks along -z).
                if (z <= depth[i]) continue;
                depth[i] = z;
                color.set(rgb, i * 3);
            }
        }
    }
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let j = 0; j < SS; j++) {
                for (let i = 0; i < SS; i++) {
                    const q = (y * SS + j) * n + x * SS + i;
                    if (depth[q] === -Infinity) continue;
                    r += color[q * 3];
                    g += color[q * 3 + 1];
                    b += color[q * 3 + 2];
                    a++;
                }
            }
            if (!a) continue;
            // Average in linear light, then to sRGB.
            const o = (y * size + x) * 4;
            out[o] = Math.round(255 * Math.min(1, r / a) ** (1 / 2.2));
            out[o + 1] = Math.round(255 * Math.min(1, g / a) ** (1 / 2.2));
            out[o + 2] = Math.round(255 * Math.min(1, b / a) ** (1 / 2.2));
            out[o + 3] = Math.round((255 * a) / (SS * SS));
        }
    }
    return encodePng(size, size, out);
}

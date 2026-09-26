// Shot comparison without a model: a capture and its target image are
// reduced to a small grid (the target cropped to the shot's shape) and
// compared in CIE Lab. Gray mode looks at lightness only (the value
// structure), color mode at the whole color. The numbers are a reference;
// people judge by eye.

import { canvas } from './images';

export type CompareMode = 'gray' | 'color';

export interface CompareResult {
    mode: CompareMode;
    /** 0..100, 100 when the images are the same: 100 minus twice the mean difference (L* in gray mode, delta E in color mode). */
    score: number;
    /** Correlation of the two lightness maps, -100..100: the value structure regardless of exposure. */
    structure: number;
    /** Mean lightness (L*, 0..100) of the capture and of the target. */
    brightness: [number, number];
    /** Spread of lightness (standard deviation of L*) of each: contrast. */
    contrast: [number, number];
    /** Mean lightness difference, capture minus target, in a 3 x 3 grid (top row first). */
    zones: number[];
    /** Mean chroma (saturation) of each. */
    chroma: [number, number];
    /** Color cast of the capture against the target: mean a* (green - / red +) and b* (blue - / yellow +) difference. */
    cast: { a: number; b: number };
    /** Where the capture is darker (blue) or brighter (red) than the target, as a small PNG data URL. */
    heat: string;
}

const GRID = 64;

/** Compares a capture with a target image; `aspect` is the shot's (width / height). */
export async function compareImages(capture: Blob, target: Blob, aspect: number, mode: CompareMode): Promise<CompareResult> {
    const w = GRID;
    const h = Math.max(8, Math.min(160, Math.round(GRID / Math.max(0.2, aspect))));
    const [a, b] = await Promise.all([labGrid(capture, w, h), labGrid(target, w, h)]);
    const n = w * h;
    let sumA = 0, sumB = 0, sumDiff = 0, sumE = 0, sumCa = 0, sumCb = 0, sumDa = 0, sumDb = 0;
    for (let i = 0; i < n; i++) {
        const la = a[i * 3], lb = b[i * 3];
        sumA += la;
        sumB += lb;
        sumDiff += Math.abs(la - lb);
        const da = a[i * 3 + 1] - b[i * 3 + 1];
        const db = a[i * 3 + 2] - b[i * 3 + 2];
        sumE += Math.sqrt((la - lb) ** 2 + da * da + db * db);
        sumCa += Math.hypot(a[i * 3 + 1], a[i * 3 + 2]);
        sumCb += Math.hypot(b[i * 3 + 1], b[i * 3 + 2]);
        sumDa += da;
        sumDb += db;
    }
    const meanA = sumA / n, meanB = sumB / n;
    let varA = 0, varB = 0, cov = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i * 3] - meanA, db = b[i * 3] - meanB;
        varA += da * da;
        varB += db * db;
        cov += da * db;
    }
    const structure = varA > 1e-6 && varB > 1e-6 ? cov / Math.sqrt(varA * varB) : varA <= 1e-6 && varB <= 1e-6 ? 1 : 0;
    const zones: number[] = [];
    for (let zy = 0; zy < 3; zy++) {
        for (let zx = 0; zx < 3; zx++) {
            let s = 0, c = 0;
            for (let y = Math.floor((zy * h) / 3); y < Math.floor(((zy + 1) * h) / 3); y++) {
                for (let x = Math.floor((zx * w) / 3); x < Math.floor(((zx + 1) * w) / 3); x++) {
                    const i = y * w + x;
                    s += a[i * 3] - b[i * 3];
                    c++;
                }
            }
            zones.push(round1(c ? s / c : 0));
        }
    }
    const meanDiff = mode === 'gray' ? sumDiff / n : sumE / n;
    return {
        mode,
        score: Math.round(Math.max(0, Math.min(100, 100 - 2 * meanDiff))),
        structure: Math.round(structure * 100),
        brightness: [round1(meanA), round1(meanB)],
        contrast: [round1(Math.sqrt(varA / n)), round1(Math.sqrt(varB / n))],
        zones,
        chroma: [round1(sumCa / n), round1(sumCb / n)],
        cast: { a: round1(sumDa / n), b: round1(sumDb / n) },
        heat: heatMap(a, b, w, h),
    };
}

/** Plain words for the numbers, for people and the assistant. */
export function describeComparison(r: CompareResult): string[] {
    const out: string[] = [];
    const dl = r.brightness[0] - r.brightness[1];
    if (Math.abs(dl) >= 4) out.push(`The capture is ${dl < 0 ? 'darker' : 'brighter'} overall (L* ${r.brightness[0]} vs ${r.brightness[1]}).`);
    const dc = r.contrast[0] - r.contrast[1];
    if (Math.abs(dc) >= 4) out.push(`It has ${dc < 0 ? 'less' : 'more'} contrast (spread ${r.contrast[0]} vs ${r.contrast[1]}).`);
    const names = ['top left', 'top', 'top right', 'left', 'center', 'right', 'bottom left', 'bottom', 'bottom right'];
    // Zones off by themselves, beyond the overall shift.
    const off = r.zones.map((z, i) => ({ z, name: names[i] })).filter((x) => Math.abs(x.z) >= 8 && Math.abs(x.z - dl) >= 6);
    for (const x of off.sort((p, q) => Math.abs(q.z) - Math.abs(p.z)).slice(0, 3)) out.push(`The ${x.name} is ${x.z < 0 ? 'darker' : 'brighter'} than in the target (${x.z > 0 ? '+' : ''}${x.z}).`);
    if (r.structure < 60) out.push('The value structure differs: lights and darks sit in other places.');
    if (r.mode === 'color') {
        const ds = r.chroma[0] - r.chroma[1];
        if (Math.abs(ds) >= 4) out.push(`Colors are ${ds < 0 ? 'less' : 'more'} saturated (chroma ${r.chroma[0]} vs ${r.chroma[1]}).`);
        const cast: string[] = [];
        if (r.cast.b >= 4) cast.push('warmer (more yellow)');
        if (r.cast.b <= -4) cast.push('cooler (more blue)');
        if (r.cast.a >= 4) cast.push('more red / magenta');
        if (r.cast.a <= -4) cast.push('more green');
        if (cast.length) out.push(`The capture looks ${cast.join(' and ')}.`);
    }
    if (!out.length) out.push('Close to the target.');
    return out;
}

function round1(v: number): number {
    return Math.round(v * 10) / 10;
}

/** Lab values (L*, a*, b* per cell) of an image scaled and center-cropped to w x h. */
async function labGrid(src: Blob, w: number, h: number): Promise<Float32Array> {
    const bmp = await createImageBitmap(src);
    try {
        // Crop to the grid's shape, then halve step by step (a single large
        // downscale skips pixels).
        const ar = w / h;
        const sr = bmp.width / bmp.height;
        let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
        if (sr > ar) {
            sw = bmp.height * ar;
            sx = (bmp.width - sw) / 2;
        } else {
            sh = bmp.width / ar;
            sy = (bmp.height - sh) / 2;
        }
        let cw = Math.max(w, Math.round(sw)), ch = Math.max(h, Math.round(sh));
        let cur = canvas(cw, ch);
        cur.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, cw, ch);
        while (cw > w * 2) {
            cw = Math.max(w, Math.round(cw / 2));
            ch = Math.max(h, Math.round(ch / 2));
            const next = canvas(cw, ch);
            const g = next.getContext('2d')!;
            g.imageSmoothingQuality = 'high';
            g.drawImage(cur, 0, 0, cw, ch);
            cur = next;
        }
        const out = canvas(w, h);
        const g = out.getContext('2d', { willReadFrequently: true })!;
        g.imageSmoothingQuality = 'high';
        g.drawImage(cur, 0, 0, w, h);
        const px = g.getImageData(0, 0, w, h).data;
        const lab = new Float32Array(w * h * 3);
        for (let i = 0; i < w * h; i++) {
            const [L, A, B] = srgbToLab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
            lab[i * 3] = L;
            lab[i * 3 + 1] = A;
            lab[i * 3 + 2] = B;
        }
        return lab;
    } finally {
        bmp.close();
    }
}

function lin(c: number): number {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** CIE L*a*b* (D65) of an 8 bit sRGB color. */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
    const R = lin(r), G = lin(g), B = lin(b);
    const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Blue where the capture is darker than the target, red where brighter. */
function heatMap(a: Float32Array, b: Float32Array, w: number, h: number): string {
    const c = canvas(w, h);
    const g = c.getContext('2d')!;
    const img = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
        const d = a[i * 3] - b[i * 3];
        const t = Math.min(1, Math.abs(d) / 30);
        const base = 34;
        const [cr, cg, cb] = d < 0 ? [70, 130, 255] : [255, 110, 60];
        img.data[i * 4] = base + (cr - base) * t;
        img.data[i * 4 + 1] = base + (cg - base) * t;
        img.data[i * 4 + 2] = base + (cb - base) * t;
        img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
}

/**
 * The capture and the target side by side (the target cropped to the
 * shot's shape), optionally without color, as a JPEG data URL.
 */
export async function sideBySide(capture: Blob, target: Blob, aspect: number, gray: boolean, width = 1024): Promise<string> {
    const half = Math.round(width / 2);
    const hgt = Math.max(16, Math.round(half / Math.max(0.2, aspect)));
    const c = canvas(half * 2 + 8, hgt);
    const g = c.getContext('2d')!;
    g.fillStyle = '#0c0d10';
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    if (gray) g.filter = 'grayscale(1)';
    const draw = async (src: Blob, x: number) => {
        const bmp = await createImageBitmap(src);
        try {
            const ar = half / hgt;
            const sr = bmp.width / bmp.height;
            let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
            if (sr > ar) {
                sw = bmp.height * ar;
                sx = (bmp.width - sw) / 2;
            } else {
                sh = bmp.width / ar;
                sy = (bmp.height - sh) / 2;
            }
            g.drawImage(bmp, sx, sy, sw, sh, x, 0, half, hgt);
        } finally {
            bmp.close();
        }
    };
    await draw(capture, 0);
    await draw(target, half + 8);
    return c.toDataURL('image/jpeg', 0.85);
}

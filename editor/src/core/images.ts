// Image helpers on 2D canvases: resizing for the assistant, grayscale and
// comparison scores for the pipeline, encoding to files.

import { getAssetBlob } from './assets';

export function canvas(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
}

export async function bitmapOf(src: Blob | string): Promise<ImageBitmap> {
    if (typeof src !== 'string') return createImageBitmap(src);
    const res = await fetch(src);
    return createImageBitmap(await res.blob());
}

/** Draws an image scaled to fit within `max` pixels (never enlarged). */
export function fitCanvas(img: CanvasImageSource & { width: number; height: number }, max: number): HTMLCanvasElement {
    const k = Math.min(1, max / Math.max(img.width, img.height, 1));
    const c = canvas(img.width * k, img.height * k);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
}

export function canvasBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality));
}

/** JPEG data URL of an image no larger than `max` pixels (to send to a model). */
export async function resizedDataUrl(src: Blob | string, max = 1280, quality = 0.85): Promise<string> {
    const bmp = await bitmapOf(src);
    try {
        const c = fitCanvas(bmp, max);
        return c.toDataURL('image/jpeg', quality);
    } finally {
        bmp.close();
    }
}

/** Resized data URL of an image asset, or null when it is not stored here. */
export async function assetImageDataUrl(id: string, max = 1280): Promise<string | null> {
    const blob = await getAssetBlob(id);
    if (!blob) return null;
    return resizedDataUrl(blob, max);
}

export async function dataUrlToBlob(url: string): Promise<Blob> {
    const res = await fetch(url);
    return res.blob();
}

/** Rec. 709 luma of 8 bit sRGB values, 0..1. */
export function luma(r: number, g: number, b: number): number {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

/**
 * Re-encodes a lossless raster image (PNG, BMP) as WebP when that is
 * smaller, as generated paintings usually are; other files stay as they are.
 */
export async function compactImage(blob: Blob, quality = 0.92): Promise<Blob> {
    if (!/^image\/(png|bmp|x-ms-bmp)$/.test(blob.type)) return blob;
    const bmp = await createImageBitmap(blob);
    try {
        const c = canvas(bmp.width, bmp.height);
        c.getContext('2d')!.drawImage(bmp, 0, 0);
        const out = await canvasBlob(c, 'image/webp', quality).catch(() => null);
        return out && out.type === 'image/webp' && out.size < blob.size ? out : blob;
    } finally {
        bmp.close();
    }
}

/** File extension for an image type. */
export function imageExt(type: string): string {
    return type === 'image/jpeg' ? 'jpg' : type === 'image/svg+xml' ? 'svg' : type.startsWith('image/') ? type.slice(6) : 'png';
}

/** Images in a grid with a number in each corner, as one JPEG data URL (to show a model several at once). */
export async function contactSheet(images: Blob[], cell = 192, columns = 4): Promise<string> {
    const cols = Math.max(1, Math.min(columns, images.length));
    const rows = Math.ceil(images.length / cols);
    const gap = 6;
    const c = canvas(cols * cell + (cols - 1) * gap, rows * cell + (rows - 1) * gap);
    const g = c.getContext('2d')!;
    g.fillStyle = '#0c0d10';
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    for (let i = 0; i < images.length; i++) {
        const x = (i % cols) * (cell + gap);
        const y = Math.floor(i / cols) * (cell + gap);
        const bmp = await createImageBitmap(images[i]).catch(() => null);
        if (bmp) {
            const side = Math.min(bmp.width, bmp.height);
            g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, x, y, cell, cell);
            bmp.close();
        }
        g.fillStyle = 'rgba(0, 0, 0, 0.7)';
        g.fillRect(x, y, 26, 22);
        g.fillStyle = '#ffffff';
        g.font = 'bold 14px sans-serif';
        g.fillText(String(i + 1), x + 6, y + 16);
    }
    return c.toDataURL('image/jpeg', 0.85);
}

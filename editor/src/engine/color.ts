import { Color } from '@orillusion/core';

/**
 * Parses #rgb / #rrggbb (sRGB, as shown by color pickers) into an engine
 * Color in linear space, which is what material factors, light colors and
 * the HDR sky expect.
 */
export function hexToColor(hex: string, alpha = 1): Color {
    const rgb = parseHex(hex);
    return new Color(srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2]), alpha);
}

export function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function parseHex(hex: string): [number, number, number] {
    let h = (hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : 0xffffff;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function toHex(r: number, g: number, b: number): string {
    const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

export function normalizeHex(hex: string): string {
    const [r, g, b] = parseHex(hex);
    return toHex(r, g, b);
}

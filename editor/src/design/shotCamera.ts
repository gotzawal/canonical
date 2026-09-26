// Shot framing math. A shot stores the editor camera (orbit target, yaw,
// pitch, distance) and the vertical field of view of its frame, a
// rectangle with the concept image's aspect ratio centered in the viewport.
// Showing the frame inside a viewport of another shape needs a wider
// camera field of view; these helpers convert between the two.

import { DEG } from '../core/math';

/** Margin of the frame drawn over the viewport while a shot is shown. */
export const FRAME_MARGIN = 0.9;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Largest rectangle of `aspect` (width / height) centered in w x h, shrunk by `margin`. */
export function frameRect(aspect: number, w: number, h: number, margin = 1): Rect {
    let fw = w * margin;
    let fh = fw / aspect;
    if (fh > h * margin) {
        fh = h * margin;
        fw = fh * aspect;
    }
    return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
}

/** Camera field of view that shows `frameFov` (vertical, degrees) over a frame `frameH` pixels high in a view `viewH` high. */
export function cameraFov(frameFov: number, frameH: number, viewH: number): number {
    const t = Math.tan((frameFov * DEG) / 2) * (viewH / Math.max(1, frameH));
    return Math.min(170, (2 * Math.atan(t)) / DEG);
}

/** Inverse of cameraFov: the frame's vertical field of view for a camera fov. */
export function frameFov(camFov: number, frameH: number, viewH: number): number {
    const t = Math.tan((camFov * DEG) / 2) * (Math.max(1, frameH) / Math.max(1, viewH));
    return (2 * Math.atan(t)) / DEG;
}

// What the chunked drawers (terrain, grass, scatter, loose stones) share
// about their pieces and the camera: how far a piece's box is, and which of
// three levels of detail a distance calls for. One place to swap for the
// GPU's own culling and level picking.

/** Meters from `eye` to the box (min, max), 0 inside it. */
export function boxDistance(min: ArrayLike<number>, max: ArrayLike<number>, eye: ArrayLike<number>): number {
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
        const e = Math.max(min[k] - eye[k], 0, eye[k] - max[k]);
        d2 += e * e;
    }
    return Math.sqrt(d2);
}

/**
 * The level of detail (0 near, 1, 2 far) at distance `d` with levels
 * changing at `near` and `far`, from the level `current`: a margin keeps a
 * piece at a limit from flickering between two.
 */
export function levelAt(d: number, near: number, far: number, current: number): number {
    return d > far * (current === 2 ? 0.95 : 1.05) ? 2 : d > near * (current === 0 ? 1.05 : 0.95) ? 1 : 0;
}

// Small stones on the ground near the camera (TerrainLayer.debris, and a
// ring around what stands on a terrain): where they lie in one cell of the
// ground, the same every time for the same cell. Pure: engine/clutter.ts
// draws them, a merged mesh a cell.

/** What the stones of a cell read from the ground under them. */
export interface ClutterGround {
    /** The ground's height and normal y at (x, z), or null off the ground. */
    at(x: number, z: number): { y: number; ny: number } | null;
    /** How many stones lie at (x, z), 0 to 1, and the layer that shows most there. */
    amount(x: number, z: number): { amount: number; layer: number };
}

export interface Stone {
    x: number;
    y: number;
    z: number;
    /** Meters across. */
    size: number;
    yaw: number;
    /** Height over width, 0.35 (a flat stone) to 0.9. */
    flat: number;
    /** Which of the stone shapes. */
    shape: number;
    /** The layer it takes its color from, and its shade (0 to 1). */
    layer: number;
    shade: number;
}

/** Stones a cell can hold at most (at an amount of 1), per square meter. */
export const STONES_PER_M2 = 3;

/** The stones of cell (ci, cj) of `size` meters. */
export function clutterCell(ci: number, cj: number, size: number, ground: ClutterGround, shapes: number): Stone[] {
    let h = (Math.imul(ci, 374761393) ^ Math.imul(cj, 668265263) ^ 0x2545f491) >>> 0;
    const random = () => {
        h = (h + 0x6d2b79f5) >>> 0;
        let t = Math.imul(h ^ (h >>> 15), h | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out: Stone[] = [];
    const tries = Math.round(size * size * STONES_PER_M2);
    for (let n = 0; n < tries; n++) {
        const x = (ci + random()) * size, z = (cj + random()) * size;
        const keep = random(), grow = random(), yaw = random(), flat = random(), shape = random(), shade = random();
        const g = ground.at(x, z);
        if (!g || g.ny < 0.6) continue;
        const { amount, layer } = ground.amount(x, z);
        if (keep >= amount) continue;
        // Mostly small, a few larger.
        const s = 0.03 + 0.15 * grow * grow * grow;
        out.push({ x, y: g.y - s * 0.15, z, size: s, yaw: yaw * Math.PI * 2, flat: 0.35 + 0.55 * flat, shape: Math.floor(shape * shapes), layer, shade });
    }
    return out;
}

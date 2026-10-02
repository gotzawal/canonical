// Adaptive resolution: when frames keep taking longer than the frame rate
// aims at, the viewport (and a game) draws at fewer pixels, a step at a
// time; when they keep coming in time, it tries a step back up, waiting
// longer each time a step up did not hold. Pure: Runtime feeds it frame
// times and applies its scale.

/** Shares of the chosen resolution, sharpest first. */
export const ADAPTIVE_SCALES = [1, 0.85, 0.72, 0.6, 0.5] as const;

/** Frames are measured over windows this long, ms. */
const WINDOW_MS = 1000;
/** A window this much over the frame time aims at is slow; under GOOD is in time. */
const SLOW = 1.2;
const GOOD = 1.1;
/** Slow windows in a row before a step down. */
const SLOW_WINDOWS = 2;
/** A step down this soon after a step up means the step up did not hold, ms. */
const FAILED_MS = 6000;

export class AdaptiveResolution {
    /** Index into ADAPTIVE_SCALES. */
    level = 0;
    private sum = 0;
    private count = 0;
    private windowStart = -1;
    private slow = 0;
    private good = 0;
    /** In-time windows in a row before a step up (doubles when a step up fails). */
    private wait = 6;
    private steppedUpAt = -Infinity;

    get scale(): number {
        return ADAPTIVE_SCALES[this.level];
    }

    /** Starts over at full resolution. */
    reset() {
        this.level = 0;
        this.sum = this.count = this.slow = this.good = 0;
        this.windowStart = -1;
        this.wait = 6;
        this.steppedUpAt = -Infinity;
    }

    /**
     * A frame took `dt` ms while frames should take `target` ms; `now` is
     * the time, ms. True when the scale changed.
     */
    frame(dt: number, target: number, now: number): boolean {
        // A hidden tab or a one-off stall (loading) says nothing about the load.
        if (!(dt > 0) || dt > 400) return false;
        if (this.windowStart < 0) this.windowStart = now;
        this.sum += dt;
        this.count++;
        if (now - this.windowStart < WINDOW_MS) return false;
        const avg = this.sum / this.count;
        this.sum = this.count = 0;
        this.windowStart = now;
        if (avg > target * SLOW) {
            this.slow++;
            this.good = 0;
        } else if (avg < target * GOOD) {
            this.good++;
            this.slow = 0;
        } else {
            this.slow = this.good = 0;
        }
        if (this.slow >= SLOW_WINDOWS && this.level < ADAPTIVE_SCALES.length - 1) {
            if (now - this.steppedUpAt < FAILED_MS) this.wait = Math.min(this.wait * 2, 120);
            this.level++;
            this.slow = this.good = 0;
            return true;
        }
        if (this.good >= this.wait && this.level > 0) {
            this.level--;
            this.steppedUpAt = now;
            this.slow = this.good = 0;
            return true;
        }
        return false;
    }
}

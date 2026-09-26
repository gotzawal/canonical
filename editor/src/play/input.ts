/**
 * Keyboard and mouse state for scripts. Key names are lower case and match
 * either KeyboardEvent.key ("w", "arrowup", "shift") or KeyboardEvent.code
 * ("keyw", "digit1"); the space bar is "space".
 */
export class Input {
    private held = new Set<string>();
    private pressed = new Set<string>();
    private released = new Set<string>();
    private buttons = new Set<number>();
    private buttonsDown = new Set<number>();
    private buttonsUp = new Set<number>();

    /** Pointer position in CSS pixels relative to the viewport, and movement this frame. */
    readonly mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0 };

    /** True while the key is held. */
    key(name: string): boolean {
        return this.held.has(name.toLowerCase());
    }

    /** True in the frame the key went down. */
    keyDown(name: string): boolean {
        return this.pressed.has(name.toLowerCase());
    }

    /** True in the frame the key was released. */
    keyUp(name: string): boolean {
        return this.released.has(name.toLowerCase());
    }

    /** -1..1 from WASD and the arrow keys: 'horizontal' (A/D, left/right) or 'vertical' (S/W, down/up). */
    axis(name: 'horizontal' | 'vertical'): number {
        if (name === 'horizontal') {
            return (this.key('d') || this.key('arrowright') ? 1 : 0) - (this.key('a') || this.key('arrowleft') ? 1 : 0);
        }
        return (this.key('w') || this.key('arrowup') ? 1 : 0) - (this.key('s') || this.key('arrowdown') ? 1 : 0);
    }

    /** True while the mouse button is held (0 left, 1 middle, 2 right). */
    mouseButton(button = 0): boolean {
        return this.buttons.has(button);
    }

    mouseDown(button = 0): boolean {
        return this.buttonsDown.has(button);
    }

    mouseUp(button = 0): boolean {
        return this.buttonsUp.has(button);
    }

    // ------------------------------------------------ fed by the player

    /** @internal */
    keyEvent(e: KeyboardEvent, down: boolean) {
        const names = keyNames(e);
        for (const n of names) {
            if (down) {
                if (!this.held.has(n)) this.pressed.add(n);
                this.held.add(n);
            } else {
                this.held.delete(n);
                this.released.add(n);
            }
        }
        return names[0];
    }

    /** @internal */
    pointerMove(x: number, y: number) {
        this.mouse.dx += x - this.mouse.x;
        this.mouse.dy += y - this.mouse.y;
        this.mouse.x = x;
        this.mouse.y = y;
    }

    /** @internal */
    pointerButton(button: number, down: boolean) {
        if (down) {
            this.buttons.add(button);
            this.buttonsDown.add(button);
        } else {
            this.buttons.delete(button);
            this.buttonsUp.add(button);
        }
    }

    /** @internal */
    wheel(delta: number) {
        this.mouse.wheel += delta;
    }

    /** @internal Clears per-frame state; call after scripts updated. */
    endFrame() {
        this.pressed.clear();
        this.released.clear();
        this.buttonsDown.clear();
        this.buttonsUp.clear();
        this.mouse.dx = 0;
        this.mouse.dy = 0;
        this.mouse.wheel = 0;
    }

    /** @internal Releases everything, e.g. when the window loses focus. */
    reset() {
        for (const k of this.held) this.released.add(k);
        this.held.clear();
        for (const b of this.buttons) this.buttonsUp.add(b);
        this.buttons.clear();
    }
}

function keyNames(e: KeyboardEvent): string[] {
    const out: string[] = [];
    const key = e.key === ' ' ? 'space' : (e.key || '').toLowerCase();
    if (key) out.push(key);
    const code = (e.code || '').toLowerCase();
    if (code && code !== key) out.push(code);
    return out;
}

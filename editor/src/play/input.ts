/**
 * Keyboard, mouse and touch state for scripts. Key names are lower case and
 * match either KeyboardEvent.key ("w", "arrowup", "shift") or
 * KeyboardEvent.code ("keyw", "digit1"); the space bar is "space". On touch
 * screens the on-screen joystick adds to the axes and its buttons press keys
 * (the jump button is "space").
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

    /** The on-screen joystick, -1..1 (x right, y forward); active while a finger holds it. */
    readonly stick = { x: 0, y: 0, active: false };

    /** Camera look from fingers this frame: drag in CSS pixels, and pinch zoom (> 0 zooms out). */
    readonly look = { dx: 0, dy: 0, zoom: 0 };

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

    /**
     * -1..1 from WASD, the arrow keys and the on-screen joystick:
     * 'horizontal' (A/D, left/right) or 'vertical' (S/W, down/up).
     */
    axis(name: 'horizontal' | 'vertical'): number {
        const keys = name === 'horizontal'
            ? (this.key('d') || this.key('arrowright') ? 1 : 0) - (this.key('a') || this.key('arrowleft') ? 1 : 0)
            : (this.key('w') || this.key('arrowup') ? 1 : 0) - (this.key('s') || this.key('arrowdown') ? 1 : 0);
        return Math.max(-1, Math.min(1, keys + (name === 'horizontal' ? this.stick.x : this.stick.y)));
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
        for (const n of names) this.setKey(n, down);
        return names[0];
    }

    /** @internal A key pressed by an on-screen button. */
    virtualKey(name: string, down: boolean) {
        this.setKey(name.toLowerCase(), down);
    }

    private setKey(n: string, down: boolean) {
        if (down) {
            if (!this.held.has(n)) this.pressed.add(n);
            this.held.add(n);
        } else {
            this.held.delete(n);
            this.released.add(n);
        }
    }

    /** @internal */
    setStick(x: number, y: number, active: boolean) {
        this.stick.x = Math.max(-1, Math.min(1, x));
        this.stick.y = Math.max(-1, Math.min(1, y));
        this.stick.active = active;
    }

    /** @internal */
    addLook(dx: number, dy: number, zoom = 0) {
        this.look.dx += dx;
        this.look.dy += dy;
        this.look.zoom += zoom;
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
        this.look.dx = 0;
        this.look.dy = 0;
        this.look.zoom = 0;
    }

    /** @internal Releases everything, e.g. when the window loses focus. */
    reset() {
        for (const k of this.held) this.released.add(k);
        this.held.clear();
        for (const b of this.buttons) this.buttonsUp.add(b);
        this.buttons.clear();
        this.setStick(0, 0, false);
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

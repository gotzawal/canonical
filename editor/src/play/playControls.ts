// On-screen controls of the player controller: a joystick that appears
// where the left thumb touches, a jump button, the rest of the view to look
// around (one finger drags, two pinch), and a short hint of the controls
// when Play starts. Used by the editor's Play mode and by built games.

import './playControls.css';
import type { Input } from './input';

/** Radius the joystick knob travels, CSS pixels. */
const STICK_RADIUS = 56;
/** Touches starting left of this share of the width move; the others look. */
const STICK_ZONE = 0.45;
/** A touch that moved less than this and lasted less than TAP_MS is a tap (a click for scripts). */
const TAP_PX = 10;
const TAP_MS = 350;

export function hasTouch(): boolean {
    return (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints ?? 0) > 0;
}

interface LookTouch {
    x: number;
    y: number;
    x0: number;
    y0: number;
    at: number;
    moved: boolean;
}

export class PlayControls {
    readonly el: HTMLElement;
    /** Showing for a Play session with a player controller. */
    active = false;
    private base: HTMLElement;
    private knob: HTMLElement;
    private jumpBtn: HTMLButtonElement;
    private hint: HTMLElement;
    private stick: { id: number; x: number; y: number } | null = null;
    private looks = new Map<number, LookTouch>();
    private pinch = 0;
    private hintTimer = 0;
    private touchSeen = false;
    private jump = false;

    constructor(host: HTMLElement, private input: Input, private tap: (x: number, y: number) => void) {
        this.base = document.createElement('div');
        this.base.className = 'play-stick';
        this.knob = document.createElement('div');
        this.knob.className = 'play-stick-knob';
        this.base.appendChild(this.knob);
        this.jumpBtn = document.createElement('button');
        this.jumpBtn.type = 'button';
        this.jumpBtn.className = 'play-jump';
        this.jumpBtn.textContent = 'Jump';
        this.jumpBtn.setAttribute('aria-label', 'Jump');
        const press = (down: boolean) => (e: PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (down) this.jumpBtn.setPointerCapture(e.pointerId);
            this.jumpBtn.classList.toggle('down', down);
            this.input.virtualKey('space', down);
        };
        this.jumpBtn.addEventListener('pointerdown', press(true));
        this.jumpBtn.addEventListener('pointerup', press(false));
        this.jumpBtn.addEventListener('pointercancel', press(false));
        this.jumpBtn.addEventListener('contextmenu', (e) => e.preventDefault());
        this.hint = document.createElement('div');
        this.hint.className = 'play-hint';
        this.el = document.createElement('div');
        this.el.className = 'play-controls';
        this.el.hidden = true;
        this.el.append(this.base, this.jumpBtn, this.hint);
        host.appendChild(this.el);
    }

    /** Shows the controls while a player controller plays. */
    start(opts: { jump: boolean }) {
        this.active = true;
        this.jump = opts.jump;
        this.touchSeen = hasTouch();
        this.el.hidden = false;
        this.base.hidden = true;
        this.update();
        this.showHint();
    }

    stop() {
        this.active = false;
        this.el.hidden = true;
        this.release();
        clearTimeout(this.hintTimer);
    }

    /** Lets go of every touch (Stop, the window lost focus). */
    release() {
        this.stick = null;
        this.looks.clear();
        this.base.hidden = true;
        this.input.setStick(0, 0, false);
        if (this.jumpBtn.classList.contains('down')) {
            this.jumpBtn.classList.remove('down');
            this.input.virtualKey('space', false);
        }
    }

    private update() {
        this.jumpBtn.hidden = !(this.jump && this.touchSeen);
    }

    private showHint() {
        this.hint.textContent = this.touchSeen
            ? `Left thumb: move${this.jump ? '  ·  Button: jump' : ''}  ·  Drag: look  ·  Pinch: zoom`
            : `WASD / arrows: move  ·  Shift: run${this.jump ? '  ·  Space: jump' : ''}  ·  Drag: look  ·  Wheel: zoom`;
        this.hint.classList.add('visible');
        clearTimeout(this.hintTimer);
        this.hintTimer = window.setTimeout(() => this.hint.classList.remove('visible'), 5000);
    }

    /**
     * A touch on the view (CSS pixels relative to it). Touches starting on
     * the left move, the others look; a short touch that stays put is a tap.
     */
    pointer(type: 'down' | 'move' | 'up' | 'cancel', id: number, x: number, y: number) {
        if (!this.touchSeen) {
            this.touchSeen = true;
            this.update();
            this.showHint();
        }
        if (type === 'down') {
            const width = this.el.clientWidth || window.innerWidth;
            if (!this.stick && x < width * STICK_ZONE) {
                this.stick = { id, x, y };
                this.base.style.left = `${x}px`;
                this.base.style.top = `${y}px`;
                this.knob.style.transform = '';
                this.base.hidden = false;
                this.input.setStick(0, 0, true);
                return;
            }
            this.looks.set(id, { x, y, x0: x, y0: y, at: performance.now(), moved: false });
            this.pinch = this.pinchDistance();
            return;
        }
        if (this.stick?.id === id) {
            if (type === 'move') {
                let dx = x - this.stick.x;
                let dy = y - this.stick.y;
                const len = Math.hypot(dx, dy);
                if (len > STICK_RADIUS) {
                    dx *= STICK_RADIUS / len;
                    dy *= STICK_RADIUS / len;
                }
                this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
                this.input.setStick(dx / STICK_RADIUS, -dy / STICK_RADIUS, true);
            } else {
                this.stick = null;
                this.base.hidden = true;
                this.input.setStick(0, 0, false);
            }
            return;
        }
        const t = this.looks.get(id);
        if (!t) return;
        if (type === 'move') {
            const dx = x - t.x;
            const dy = y - t.y;
            t.x = x;
            t.y = y;
            if (Math.hypot(x - t.x0, y - t.y0) > TAP_PX) t.moved = true;
            if (this.looks.size >= 2) {
                const dist = this.pinchDistance();
                if (this.pinch > 0 && dist > 0) this.input.addLook(0, 0, Math.log(this.pinch / dist));
                this.pinch = dist;
            } else this.input.addLook(dx, dy);
            return;
        }
        this.looks.delete(id);
        this.pinch = this.pinchDistance();
        if (type === 'up' && !t.moved && performance.now() - t.at < TAP_MS) this.tap(x, y);
    }

    private pinchDistance(): number {
        const [a, b] = Array.from(this.looks.values());
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    }
}

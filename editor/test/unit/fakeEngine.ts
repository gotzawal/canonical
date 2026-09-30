// Stand-ins for the engine objects the level ray casts use, for tests and
// benchmarks in Node: objects with a transform that, like Orillusion's,
// fires LOCAL_ONCHANGE on itself and on every transform below it when it
// moves, and box meshes with bounds and triangles.

import type { Object3D, RenderNode } from '@orillusion/core';
import { Emitter } from '../../src/core/events';
import { compose, mul, quatFromEuler } from '../../src/core/math';
import type { Store } from '../../src/core/store';
import type { Vec3 } from '../../src/core/types';
import type { SceneSync } from '../../src/engine/sync';

type Listener = { fn: () => void; self: unknown };

export class FakeObject {
    readonly children: FakeObject[] = [];
    parentObj: FakeObject | null = null;
    private pos: Vec3 = [0, 0, 0];
    private rot: Vec3 = [0, 0, 0];
    private scl: Vec3 = [1, 1, 1];
    readonly components = new Map<unknown, unknown>();
    readonly transform: any;
    private listeners: Listener[] = [];

    constructor() {
        const self = this;
        this.transform = {
            worldMatrix: { rawData: new Float64Array(16) },
            get parent() {
                return self.parentObj ? { object3D: self.parentObj } : null;
            },
            eventDispatcher: {
                addEventListener: (_type: string, fn: () => void, thisObj: unknown) => {
                    if (!self.listeners.some((l) => l.fn === fn && l.self === thisObj)) self.listeners.push({ fn, self: thisObj });
                },
                removeEventListener: (_type: string, fn: () => void, thisObj: unknown) => {
                    self.listeners = self.listeners.filter((l) => !(l.fn === fn && l.self === thisObj));
                },
            },
        };
        this.update();
    }

    get listenerCount(): number {
        return this.listeners.length;
    }

    get x() {
        return this.pos[0];
    }
    set x(v: number) {
        this.set(this.pos, 0, v);
    }
    get y() {
        return this.pos[1];
    }
    set y(v: number) {
        this.set(this.pos, 1, v);
    }
    get z() {
        return this.pos[2];
    }
    set z(v: number) {
        this.set(this.pos, 2, v);
    }
    set rotationY(v: number) {
        this.set(this.rot, 1, v);
    }
    set scaleX(v: number) {
        this.set(this.scl, 0, v);
    }

    addChild(child: FakeObject) {
        child.parentObj?.children.splice(child.parentObj.children.indexOf(child), 1);
        child.parentObj = this;
        this.children.push(child);
        child.notify();
    }

    removeFromParent() {
        if (!this.parentObj) return;
        this.parentObj.children.splice(this.parentObj.children.indexOf(this), 1);
        this.parentObj = null;
        this.notify();
    }

    private set(v: Vec3, i: number, value: number) {
        if (v[i] === value) return;
        v[i] = value;
        this.notify();
    }

    /** Like Transform.notifyLocalChange: this and everything below it moved. */
    private notify() {
        this.update();
        for (const c of this.children) c.notify();
        for (const l of this.listeners.slice()) l.fn.call(l.self);
    }

    private update() {
        const local = compose(this.pos, quatFromEuler(this.rot), this.scl);
        const world = this.parentObj ? mul(this.parentObj.transform.worldMatrix.rawData, local) : local;
        this.transform.worldMatrix.rawData.set(world);
    }
}

/** A box mesh centered on its object: bounds, 8 corners and 12 triangles. */
export function boxRenderer(obj: FakeObject, size: Vec3 = [1, 1, 1]): RenderNode {
    const [hx, hy, hz] = size.map((s) => s / 2);
    const pos: number[] = [];
    for (let i = 0; i < 8; i++) pos.push(i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz);
    // Two triangles for each face of the cube (corner bits: x 1, y 2, z 4).
    const faces = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]];
    const idx: number[] = [];
    for (const [a, b, c, d] of faces) idx.push(a, b, c, a, c, d);
    const geometry = {
        bounds: { min: { x: -hx, y: -hy, z: -hz }, max: { x: hx, y: hy, z: hz } },
        getAttribute: (name: string) => (name === 'position' ? { data: new Float32Array(pos) } : name === 'indices' ? { data: new Uint16Array(idx) } : undefined),
    };
    const r = { enable: true, geometry, materials: [], object3D: obj };
    obj.components.set('renderer', r);
    return r as unknown as RenderNode;
}

/** What LevelRays reads of SceneSync: the objects of the nodes, whether shown, and their renderers. */
export class FakeSync extends Emitter<{ model: string }> {
    readonly entries = new Map<string, { obj: FakeObject; visible: boolean }>();
    readonly detached = new Set<string>();
    private renderers = new Map<string, RenderNode[]>();

    add(id: string, obj: FakeObject, renderers: RenderNode[]) {
        this.entries.set(id, { obj, visible: true });
        this.renderers.set(id, renderers);
    }

    renderersOf(id: string): RenderNode[] {
        return this.renderers.get(id) ?? [];
    }

    shown(r: RenderNode): boolean {
        return r.enable;
    }

    /** No terrains in these levels. */
    terrains(): [] {
        return [];
    }

    asSync(): SceneSync {
        return this as unknown as SceneSync;
    }
}

export const asObject = (o: FakeObject) => o as unknown as Object3D;
export type { Store };

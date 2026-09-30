// View > Navigation Mesh: the navigation mesh the characters walk on in
// Play, drawn over the level as a translucent surface. It is baked the way
// Play bakes it (in a worker, reused for the same level) and made again a
// moment after the level changes.

import { Color, GeometryBase, MeshRenderer, Object3D, UnLitMaterial, VertexAttributeName } from '@orillusion/core';
import type { Store } from '../core/store';
import type { Runtime } from '../engine/runtime';
import type { SceneSync } from '../engine/sync';
import { levelTriangles, navAgent, navigationFor } from '../play/navmesh';

/** Seconds after the last change of the level before the mesh is made again. */
const SETTLE = 0.8;

export class NavOverlay {
    private obj: Object3D | null = null;
    private visible = false;
    private timer = 0;
    /** Raised by every rebuild: an older bake that finishes late is dropped. */
    private version = 0;
    /** What the last bake said, for the status line. */
    status = '';

    constructor(private runtime: Runtime, private store: Store, private sync: SceneSync, private onStatus: (text: string) => void = () => {}) {
        store.on('change', (hint) => {
            if (!this.visible || hint?.env || hint?.meta || hint?.design || hint?.behavior) return;
            clearTimeout(this.timer);
            this.timer = window.setTimeout(() => void this.rebuild(), SETTLE * 1000);
        });
        store.on('load', () => this.visible && void this.rebuild());
    }

    setVisible(on: boolean) {
        if (on === this.visible) return;
        this.visible = on;
        clearTimeout(this.timer);
        if (on) void this.rebuild();
        else {
            this.version++;
            this.clear();
        }
    }

    private clear() {
        if (!this.obj) return;
        this.obj.removeFromParent();
        this.obj.destroy();
        this.obj = null;
    }

    private async rebuild() {
        const version = ++this.version;
        await this.sync.whenLoaded();
        if (version !== this.version) return;
        const doc = this.store.doc;
        const characters = doc.nodes.filter((n) => n.character).map((n) => n.character!);
        const level = levelTriangles(this.store, this.sync);
        this.say('Making the navigation mesh...');
        let tris: { positions: Float32Array; indices: Uint32Array } | null = null;
        try {
            const nav = await navigationFor(level, navAgent(doc, characters));
            if (nav) {
                tris = nav.triangles();
                nav.destroy();
            }
        } catch (e: any) {
            if (version === this.version) this.say(`No navigation mesh: ${e?.message || e}`);
            return;
        }
        if (version !== this.version) return;
        this.clear();
        if (!tris || !tris.indices.length) {
            this.say('Nothing to walk on: the level has no floor for the characters\' size.');
            return;
        }
        const { positions, indices } = tris;
        // A little above the floor it lies on, so it shows.
        const lifted = positions.slice();
        for (let i = 1; i < lifted.length; i += 3) lifted[i] += 0.04;
        const normals = new Float32Array(lifted.length);
        for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
        const uv = new Float32Array((lifted.length / 3) * 2);
        const geo = new GeometryBase();
        geo.setIndices(lifted.length / 3 > 65535 ? indices : new Uint16Array(indices));
        geo.setAttribute(VertexAttributeName.position, lifted);
        geo.setAttribute(VertexAttributeName.normal, normals);
        geo.setAttribute(VertexAttributeName.uv, uv);
        geo.setAttribute(VertexAttributeName.TEXCOORD_1, uv);
        geo.addSubGeometry({ indexStart: 0, indexCount: indices.length, vertexStart: 0, vertexCount: 0, firstStart: 0, index: 0, topology: 0 });
        const mat = new UnLitMaterial(this.runtime.engine.context3D);
        mat.alphaMode = 'BLEND';
        mat.baseColor = new Color(0.15, 0.75, 1, 0.4);
        mat.doubleSide = true;
        const obj = new Object3D();
        obj.name = 'Navigation Mesh';
        const mr = obj.addComponent(MeshRenderer);
        mr.geometry = geo;
        mr.material = mat;
        mr.castShadow = false;
        mr.receiveShadow = false;
        mr.castGI = false;
        this.runtime.scene.addChild(obj);
        this.obj = obj;
        this.say(`Navigation mesh: ${indices.length / 3} triangles.`);
    }

    private say(text: string) {
        this.status = text;
        this.onStatus(text);
    }
}

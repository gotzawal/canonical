import {
    BoxGeometry, DirectLight, LitMaterial, MeshRenderer, Object3D, PlaneGeometry, SphereGeometry, Texture, Vector3,
} from '@orillusion/core';
import type { Editor } from '../editor';
import type { CameraState, EnvironmentDoc } from '../core/types';
import { hexToColor } from '../engine/color';
import { applyUVTransform } from '../engine/materials';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';

/** A surface to look at in the room. */
export interface RoomSample {
    name: string;
    /** Albedo texture (an image blob, or a project texture asset id); none for a plain color. */
    texture?: Blob | string | null;
    color: string;
    roughness: number;
    metallic: number;
    /** Meters per texture tile. */
    tile: number;
}

/** Mid gray, 18% reflectance. */
const GRAY = '#767676';

/**
 * The reference room: swatches under neutral light next to a gray ball and
 * a chrome ball, to check them apart from the level's lighting. It is shown
 * in the same view like prefab editing: the scene is hidden (lights too),
 * a plain gray sky and a white sun take over, and closing brings the scene,
 * its environment and the camera back.
 */
export class ReferenceRoom {
    active = false;
    private root: Object3D | null = null;
    private camera: CameraState | null = null;
    private hud: HTMLElement;
    private list: HTMLElement;
    private urls: string[] = [];
    private offs: (() => void)[] = [];

    constructor(private editor: Editor, viewportEl: HTMLElement) {
        this.list = h('div', { class: 'room-list' });
        const close = h('button', { class: 'btn small', attrs: { type: 'button' } }, icon('close', 14), h('span', { text: 'Leave the room' }));
        close.addEventListener('click', () => this.close());
        this.hud = h(
            'div',
            { class: 'room-hud', attrs: { hidden: true } },
            h('div', { class: 'room-head' }, icon('sun', 15), h('strong', { text: 'Reference room' }), h('span', { class: 'muted small', text: 'Neutral light, 18% gray ball and chrome ball. Samples are 1 m cubes at real scale.' }), h('div', { class: 'spacer' }), close),
            this.list,
        );
        viewportEl.appendChild(this.hud);
    }

    /** Shows the room with these samples (up to eight). */
    async open(samples: RoomSample[]) {
        if (this.active) this.close();
        const ed = this.editor;
        if (ed.player.state !== 'stopped') ed.stopPlay();
        if (ed.walk?.active) ed.walk.stop();
        if (ed.isolated) ed.finishPrefabEdit(false);
        ed.pipeline.showShot(null);
        this.active = true;
        ed.store.select([]);
        this.camera = { ...ed.store.camera, target: [...ed.store.camera.target] as CameraState['target'] };
        ed.sync.setIsolation(new Set(), true);
        ed.sync.setEnvironmentOverride(neutralEnv(ed.store.doc.environment));
        ed.runtime.setGridVisible(false);

        const root = new Object3D();
        root.name = 'ReferenceRoom';
        this.root = root;
        const n = Math.min(8, samples.length);
        const width = Math.max(6, n * 1.6 + 3);
        this.add(root, new PlaneGeometry(width, 6), lit(GRAY, 0.9, 0), [0, 0, 0]);
        const wall = this.add(root, new PlaneGeometry(width, 4), lit(GRAY, 0.9, 0), [0, 2, -2.2]);
        wall.rotationX = 90;
        const x0 = -((n - 1) * 1.6) / 2;
        this.add(root, new SphereGeometry(0.35, 48, 24), lit(GRAY, 0.5, 0), [x0 - 1.6, 0.35, 0.9]);
        this.add(root, new SphereGeometry(0.35, 48, 24), lit('#ffffff', 0.05, 1), [x0 - 1.6, 0.35, -0.3]);
        for (let i = 0; i < n; i++) {
            const s = samples[i];
            const mat = lit(s.color, s.roughness, s.metallic);
            this.add(root, new BoxGeometry(1, 1, 1), mat, [x0 + i * 1.6, 0.5, 0]);
            const tex = await this.texture(s.texture ?? null);
            if (!this.active || this.root !== root) return;
            if (tex) {
                mat.baseMap = tex;
                mat.setDefine('USE_SRGB_ALBEDO', (tex as any).format === 'rgba8unorm-srgb');
                // One tile covers `tile` meters of the 1 m faces.
                const k = 1 / Math.max(0.01, s.tile);
                applyUVTransform(mat, [k, k], [0, 0]);
            }
        }
        const sun = new Object3D();
        sun.name = 'RoomSun';
        sun.rotationX = 50;
        sun.rotationY = 150;
        const light = sun.addComponent(DirectLight);
        light.lightColor = hexToColor('#ffffff');
        light.intensity = 3;
        light.castShadow = true;
        root.addChild(sun);
        ed.runtime.scene.addChild(root);
        ed.camera.jump({ ...ed.store.camera, target: [0, 0.6, 0], distance: Math.max(5.5, width * 0.7), yaw: 0, pitch: -14 });
        this.renderList(samples.slice(0, n));
        this.hud.hidden = false;
        const store = ed.store;
        this.offs.push(store.on('load', () => this.close()));
        this.offs.push(ed.on('walk', (on) => on && this.close()));
        this.offs.push(ed.on('isolate', (id) => id && this.close()));
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || document.querySelector('.dialog-backdrop')) return;
            e.stopPropagation();
            this.close();
        };
        window.addEventListener('keydown', onKey, true);
        this.offs.push(() => window.removeEventListener('keydown', onKey, true));
    }

    close() {
        if (!this.active) return;
        this.active = false;
        const ed = this.editor;
        for (const off of this.offs) off();
        this.offs = [];
        if (this.root) {
            ed.runtime.scene.removeChild(this.root);
            const root = this.root;
            this.root = null;
            // Free the GPU resources once no frame uses them.
            ed.sync.disposeLater({ destroy: () => root.destroy() });
        }
        for (const url of this.urls) URL.revokeObjectURL(url);
        this.urls = [];
        ed.sync.setIsolation(null);
        ed.sync.setEnvironmentOverride(null);
        ed.runtime.setGridVisible(ed.store.prefs.grid && !ed.store.playing);
        if (this.camera) ed.camera.jump(this.camera);
        this.camera = null;
        this.hud.hidden = true;
    }

    private add(root: Object3D, geometry: any, material: LitMaterial, pos: [number, number, number]): Object3D {
        const o = new Object3D();
        const mr = o.addComponent(MeshRenderer);
        mr.geometry = geometry;
        mr.material = material;
        mr.castShadow = true;
        mr.receiveShadow = true;
        o.localPosition = new Vector3(pos[0], pos[1], pos[2]);
        root.addChild(o);
        return o;
    }

    private async texture(src: Blob | string | null): Promise<Texture | null> {
        if (!src) return null;
        if (typeof src === 'string') return this.editor.sync.loadTexture(src);
        const url = URL.createObjectURL(src);
        this.urls.push(url);
        try {
            return (await this.editor.runtime.engine.res.loadTexture(url + '#swatch.webp', undefined, false, 'srgb')) as Texture;
        } catch (e) {
            console.warn('[editor] swatch preview failed', e);
            return null;
        }
    }

    private renderList(samples: RoomSample[]) {
        this.list.replaceChildren(
            ...samples.map((s, i) =>
                h(
                    'div',
                    { class: 'room-item' },
                    h('span', { class: 'room-index', text: String(i + 1) }),
                    h('span', { class: 'swatch', style: { background: s.color } }),
                    h('span', { text: s.name }),
                    h('span', { class: 'muted small', text: `${s.tile} m tile · R ${s.roughness} · M ${s.metallic}` }),
                ),
            ),
        );
    }
}

function lit(color: string, roughness: number, metallic: number): LitMaterial {
    const m = new LitMaterial();
    m.baseColor = hexToColor(color);
    m.roughness = roughness;
    m.metallic = metallic;
    return m;
}

/** Plain mid gray sky, no fog, bloom or GI, exposure 1. */
function neutralEnv(env: EnvironmentDoc): EnvironmentDoc {
    return {
        ...env,
        sky: 'color',
        skyColor: '#808080',
        skyExposure: 1,
        exposure: 1,
        bloom: { ...env.bloom, enable: false },
        fog: { ...env.fog, enable: false },
        gi: { ...env.gi, enable: false },
    };
}

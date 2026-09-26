import {
    AtmosphericComponent, BloomPost, Camera3D, Engine3D, GTAOPost, GlobalFog, GridObject,
    MeshRenderer, Object3D, PostBase, PostProcessingComponent, Scene3D, SkyRenderer, SolidColorSky, View3D,
} from '@orillusion/core';
import type { EnvironmentDoc } from '../core/types';
import { hexToColor } from './color';
import { GIController, giEngineSetting } from './gi';

type PostCtor = new () => PostBase;

/**
 * Owns the engine instance and the pieces of the scene that are not part of
 * the document: camera, sky, post effects and the editor grid.
 */
export class Runtime {
    readonly engine: Engine3D;
    readonly scene: Scene3D;
    readonly view: View3D;
    readonly camera: Camera3D;
    readonly grid: GridObject;
    readonly canvas: HTMLCanvasElement;
    /** Dynamic diffuse global illumination (DDGI). */
    readonly gi: GIController;

    fps = 0;
    private frameListeners = new Set<() => void>();
    private beforeListeners = new Set<() => void>();
    private graphListeners = new Set<() => void>();
    /** Custom post effects, in chain order (see setCustomPosts). */
    private customPosts: PostBase[] = [];
    private frames = 0;
    private fpsTime = performance.now();
    private atmosphere: AtmosphericComponent | null = null;
    private solidSky: SkyRenderer | null = null;
    private solidSkyTexture: SolidColorSky | null = null;
    private post: PostProcessingComponent;
    private lastEnv = '';
    /** Environment waiting for a sky component to finish starting. */
    private pendingEnv: EnvironmentDoc | null = null;

    private constructor(engine: Engine3D, canvas: HTMLCanvasElement) {
        this.engine = engine;
        this.canvas = canvas;
        this.scene = new Scene3D();
        this.scene.name = 'Scene';

        const camObj = new Object3D();
        camObj.name = 'EditorCamera';
        this.camera = camObj.addComponent(Camera3D);
        this.camera.perspective(50, engine.aspect, 0.05, 5000);
        this.scene.addChild(camObj);

        // 1 unit cells. Lifted a hair so it stays visible on a ground plane at y = 0.
        this.grid = new GridObject(40, 40);
        this.grid.name = 'EditorGrid';
        this.grid.y = 0.002;
        this.scene.addChild(this.grid);

        this.view = new View3D();
        this.view.scene = this.scene;
        this.view.camera = this.camera;
        engine.startRenderView(this.view);
        this.post = this.scene.addComponent(PostProcessingComponent);
        this.gi = new GIController(this);
    }

    static async create(canvas: HTMLCanvasElement): Promise<Runtime> {
        let runtime: Runtime | null = null;
        const engine = await Engine3D.init({
            canvasConfig: { canvas },
            setting: {
                // The editor does its own ray picking against the document.
                pick: { enable: false },
                shadow: { type: 'PCF', shadowBound: 60, shadowSize: 2048 },
                gi: giEngineSetting(),
                // Imported models keep the node matrices of their files
                // (unit scale, Z-up to Y-up), as other glTF viewers do.
                loader: { gltfNodeMatrix: true },
            },
            beforeRender: () => runtime?.beforeTick(),
            lateRender: () => runtime?.tick(),
        });
        runtime = new Runtime(engine, canvas);
        return runtime;
    }

    /** Called once per rendered frame, after the engine has drawn it. */
    onFrame(cb: () => void): () => void {
        this.frameListeners.add(cb);
        return () => this.frameListeners.delete(cb);
    }

    /** Called once per frame before the engine updates and draws (scripts run here). */
    onBeforeFrame(cb: () => void): () => void {
        this.beforeListeners.add(cb);
        return () => this.beforeListeners.delete(cb);
    }

    /** Called when passes were added to or replaced in the render graph. */
    onGraphChanged(cb: () => void): () => void {
        this.graphListeners.add(cb);
        return () => this.graphListeners.delete(cb);
    }

    notifyGraphChanged() {
        for (const cb of this.graphListeners) {
            try {
                cb();
            } catch (e) {
                console.error('[editor] graph listener failed', e);
            }
        }
    }

    private beforeTick() {
        for (const cb of this.beforeListeners) {
            try {
                cb();
            } catch (e) {
                console.error('[editor] before-frame listener failed', e);
            }
        }
    }

    /** The camera the view renders through: the editor camera, or a scene camera in Play mode. */
    get activeCamera(): Camera3D {
        return this.view.camera;
    }

    setActiveCamera(camera: Camera3D | null) {
        const cam = camera ?? this.camera;
        if (this.view.camera === cam) return;
        this.view.camera = cam;
        cam.updateProjection();
    }

    /** Forces the next applyEnvironment to push every setting again. */
    invalidateEnvironment() {
        this.lastEnv = '';
    }

    private tick() {
        if (this.pendingEnv) {
            const env = this.pendingEnv;
            this.pendingEnv = null;
            this.applyEnvironment(env);
        }
        this.frames++;
        const now = performance.now();
        if (now - this.fpsTime >= 500) {
            this.fps = (this.frames * 1000) / (now - this.fpsTime);
            this.frames = 0;
            this.fpsTime = now;
        }
        for (const cb of this.frameListeners) {
            try {
                cb();
            } catch (e) {
                console.error('[editor] frame listener failed', e);
            }
        }
    }

    get adapterInfo(): string {
        const info: any = (this.engine.context3D as any).adapter?.info;
        if (!info) return 'WebGPU';
        const parts = [info.vendor, info.architecture, info.description].filter((s: string) => s && s.length);
        return parts.length ? parts.join(' / ') : 'WebGPU';
    }

    setGridVisible(visible: boolean) {
        this.grid.traverse((o: Object3D) => {
            const mr = o.getComponent(MeshRenderer);
            if (mr) mr.enable = visible;
        });
    }

    // --------------------------------------------------------- environment

    applyEnvironment(env: EnvironmentDoc) {
        const key = JSON.stringify(env);
        if (key === this.lastEnv) return;
        this.lastEnv = key;

        const setting = this.engine.setting;
        setting.render.tonemap.exposure = env.exposure;
        if (!this.applySky(env)) {
            // Retry once the previous sky has started (see applySky).
            this.pendingEnv = env;
            this.lastEnv = '';
        }

        const pp = setting.render.postProcessing;
        pp.bloom.bloomIntensity = env.bloom.intensity;
        pp.bloom.luminanceThreshole = env.bloom.threshold;
        this.togglePost(BloomPost, env.bloom.enable);

        pp.gtao.darkFactor = Math.min(1, Math.max(0.01, env.ao.strength));
        pp.gtao.maxDistance = Math.min(50, Math.max(0.1, env.ao.distance));
        this.togglePost(GTAOPost, env.ao.enable);

        const fog = pp.globalFog;
        fog.fogType = 0;
        fog.fogColor = hexToColor(env.fog.color);
        // The engine's linear fog ramps from `end` (clear) to `start` (full).
        fog.end = Math.max(0, env.fog.near);
        fog.start = Math.max(fog.end + 0.01, env.fog.far);
        fog.ins = env.fog.intensity;
        fog.density = 0;
        this.togglePost(GlobalFog, env.fog.enable);

        const fxaa = this.postList()?.get('FXAAPost');
        if (fxaa) fxaa.enable = env.fxaa;

        this.gi.apply(env.gi);
    }

    /**
     * Returns false when the switch has to wait: a sky renderer builds its
     * geometry when it starts, and removing one before that throws inside
     * the engine, so a sky added this frame cannot be swapped out yet.
     */
    private applySky(env: EnvironmentDoc): boolean {
        if (env.sky === 'atmospheric') {
            if (this.solidSky) {
                if (!this.solidSky.geometry) return false;
                this.scene.removeComponent(SkyRenderer);
                this.solidSky = null;
                this.solidSkyTexture = null;
            }
            if (!this.atmosphere) this.atmosphere = this.scene.addComponent(AtmosphericComponent);
            this.atmosphere.sunX = env.sunX;
            this.atmosphere.sunY = env.sunY;
            this.atmosphere.exposure = env.skyExposure;
        } else {
            if (this.atmosphere) {
                if (!this.atmosphere.geometry) return false;
                this.scene.removeComponent(AtmosphericComponent);
                this.atmosphere = null;
            }
            const color = hexToColor(env.skyColor);
            if (!this.solidSky) {
                this.solidSky = this.scene.addComponent(SkyRenderer);
                this.solidSkyTexture = new SolidColorSky(color, this.engine.context3D);
                this.solidSky.map = this.solidSkyTexture;
                this.scene.envMap = this.solidSkyTexture;
            } else {
                this.solidSkyTexture!.color = color;
            }
            this.solidSky.exposure = env.skyExposure;
        }
        return true;
    }

    private postPass(): any {
        return this.view.renderGraph?.getPass('PostPass') ?? null;
    }

    private postList(): Map<string, PostBase> | null {
        return this.postPass()?.postList ?? null;
    }

    private togglePost(cls: PostCtor, enable: boolean) {
        let post = this.post.getPost(cls as any) as PostBase | null;
        if (!post) {
            if (!enable) return;
            post = this.post.addPost(cls as any) as PostBase;
            this.orderPosts();
        }
        post.enable = enable;
    }

    /**
     * Replaces the custom post effects. They run after the built-in effects
     * and before anti-aliasing and tone mapping, in the given order.
     */
    setCustomPosts(posts: PostBase[]) {
        const pass = this.postPass();
        if (!pass) return;
        for (const old of this.customPosts) {
            if (!posts.includes(old)) pass.detachPost(this.view, old);
        }
        this.customPosts = posts.slice();
        for (const p of posts) {
            if (!pass.postList.has(p.constructor.name)) pass.attachPost(this.view, p);
        }
        this.orderPosts();
    }

    /**
     * Posts run in the order of the pass's list: built-in effects, custom
     * effects, then FXAA so anti-aliasing sees the final image. Tone mapping
     * is flagged final and always runs last. Reordering the map avoids
     * detaching posts, which would re-create their resources.
     */
    private orderPosts() {
        const list = this.postList();
        if (!list) return;
        const custom = new Set(this.customPosts.map((p) => p.constructor.name));
        const entries = Array.from(list.entries());
        const rank = (name: string, post: PostBase) =>
            post.isFinalPass ? 3 : name === 'FXAAPost' ? 2 : custom.has(name) ? 1 : 0;
        const order = this.customPosts.map((p) => p.constructor.name);
        entries.sort((a, b) => {
            const ra = rank(a[0], a[1]), rb = rank(b[0], b[1]);
            if (ra !== rb) return ra - rb;
            if (ra === 1) return order.indexOf(a[0]) - order.indexOf(b[0]);
            return 0;
        });
        list.clear();
        for (const [k, v] of entries) list.set(k, v);
    }

    // -------------------------------------------------------------- helpers

    /**
     * JPEG data URL of the next rendered frame, at most `maxWidth` wide. The
     * canvas is read right after the engine drew it, while it still holds
     * the frame.
     */
    capture(maxWidth = 1024): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
                off();
                reject(new Error('No frame was rendered (is the tab in the background?).'));
            }, 5000);
            const off = this.onFrame(() => {
                off();
                clearTimeout(timer);
                try {
                    const src = this.canvas;
                    const k = Math.min(1, maxWidth / Math.max(1, src.width));
                    const c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(src.width * k));
                    c.height = Math.max(1, Math.round(src.height * k));
                    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
                    resolve(c.toDataURL('image/jpeg', 0.82));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** Current canvas size in CSS pixels. */
    get cssSize(): [number, number] {
        return [this.canvas.clientWidth, this.canvas.clientHeight];
    }
}

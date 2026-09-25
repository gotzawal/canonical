import {
    AtmosphericComponent, BloomPost, Camera3D, Engine3D, GTAOPost, GlobalFog, GridObject,
    MeshRenderer, Object3D, PostBase, PostProcessingComponent, Scene3D, SkyRenderer, SolidColorSky, View3D,
} from '@orillusion/core';
import type { EnvironmentDoc } from '../core/types';
import { hexToColor } from './color';

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

    fps = 0;
    private frameListeners = new Set<() => void>();
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
    }

    static async create(canvas: HTMLCanvasElement): Promise<Runtime> {
        let runtime: Runtime | null = null;
        const engine = await Engine3D.init({
            canvasConfig: { canvas },
            setting: {
                // The editor does its own ray picking against the document.
                pick: { enable: false },
                shadow: { type: 'PCF', shadowBound: 60, shadowSize: 2048 },
            },
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

    private postList(): Map<string, PostBase> | null {
        const pass: any = this.view.renderGraph?.getPass('PostPass');
        return pass?.postList ?? null;
    }

    private togglePost(cls: PostCtor, enable: boolean) {
        let post = this.post.getPost(cls as any) as PostBase | null;
        if (!post) {
            if (!enable) return;
            post = this.post.addPost(cls as any) as PostBase;
            this.keepFxaaLast();
        }
        post.enable = enable;
    }

    /** Posts run in attach order; anti-aliasing should see the final image. */
    private keepFxaaLast() {
        const list = this.postList();
        const pass: any = this.view.renderGraph?.getPass('PostPass');
        const fxaa = list?.get('FXAAPost');
        if (!pass || !fxaa) return;
        const enabled = fxaa.enable;
        pass.detachPost(this.view, fxaa);
        pass.attachPost(this.view, fxaa);
        fxaa.enable = enabled;
    }

    // -------------------------------------------------------------- helpers

    /** Current canvas size in CSS pixels. */
    get cssSize(): [number, number] {
        return [this.canvas.clientWidth, this.canvas.clientHeight];
    }
}

import {
    AtmosphericComponent, BloomPost, Camera3D, CSM, DirectLight, Engine3D, GTAOPost, GlobalFog, GodRayPost, GridObject,
    MeshRenderer, MirrorComponent, Object3D, PostBase, PostProcessingComponent, RenderGraph, Scene3D, ShadowLightsCollect, SkyRenderer, SolidColorSky, SSRPost,
    Texture, View3D, VolumetricFogPost,
} from '@orillusion/core';
import { AtmosphericComponent as PhysicalSkyComponent } from '@orillusion/atmosphere';
import { QUALITY, resolveQuality, sunScatterToLine, type QualityLevel, type QualitySetting } from '../core/quality';
import { skyParams } from '../core/sky';
import type { ViewportFps, ViewportQuality } from '../core/store';
import type { EnvironmentDoc } from '../core/types';
import { hexToColor } from './color';
import { GIController, giEngineSetting } from './gi';
import { installGpuStats, type GpuStats } from './gpuStats';

type PostCtor = new () => PostBase;

/** The built-in effects in the order they run: reflections over ambient occlusion, fog over them, light shafts over fog, bloom of it all. */
const BUILTIN_ORDER = ['GTAOPost', 'SSRPost', 'GlobalFog', 'VolumetricFogPost', 'GodRayPost', 'BloomPost'];
const FOG_TYPES = { linear: 0, exponential: 1, height: 3 } as const;
/** Least time between two bakes of the physical sky with clouds, ms. */
const CLOUD_BAKE_MS = 250;

/** The viewport's frame rate limits (View > Viewport Frame Rate). */
export const VIEWPORT_FPS: { value: ViewportFps; label: string }[] = [
    { value: 30, label: '30 fps' },
    { value: 60, label: '60 fps' },
    { value: 0, label: 'As Fast as the Display' },
];

/** The screen's pixels per CSS pixel, as the engine uses them (at most 2). */
const screenRatio = () => Math.min(window.devicePixelRatio || 1, 2);

/**
 * The viewport's resolutions (View > Viewport Quality): the canvas's pixels
 * per CSS pixel, a share of the screen's, but never below what keeps the
 * picture readable. The overlay (gizmo, helpers) is always sharp.
 */
export const VIEWPORT_QUALITY: { value: ViewportQuality; name: string; detail: string; ratio: () => number }[] = [
    { value: 'low', name: 'Low', detail: 'half resolution', ratio: () => Math.min(screenRatio(), Math.max(0.75, screenRatio() * 0.5)) },
    { value: 'medium', name: 'Medium', detail: 'three quarters', ratio: () => Math.min(screenRatio(), Math.max(1, screenRatio() * 0.75)) },
    { value: 'high', name: 'High', detail: 'full resolution', ratio: screenRatio },
];

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
    /** Draw calls and GPU memory, counted at the WebGPU API (null when not asked for). */
    readonly stats: GpuStats | null;
    /**
     * The quality tier of this device (the editor: high). Its shadow map
     * sizes were fixed when the engine started; the rest of a tier is
     * applied with the environment.
     */
    readonly deviceQuality: QualityLevel;
    /** A tier previewed instead of the document's (View > Graphics Quality, ?quality=). */
    private qualityOverride: QualityLevel | null = null;
    private qualitySetting: QualitySetting = 'auto';
    /** Directional shadows: meters covered, whether around the camera, and whether the sun's are cascaded. */
    private shadowRange = 60;
    private shadowFollow = false;
    private shadowCascades = false;
    private lastEnvDoc: EnvironmentDoc | null = null;

    fps = 0;
    /** The viewport's frame rate limit; 0 for none (see setViewport). */
    fpsLimit = 0;
    private quality: ViewportQuality | null = null;
    /** Follows the screen's pixel ratio (browser zoom, another screen) once the resolution is set. */
    private watchingRatio = false;
    /** Captures in progress, which draw at full resolution. */
    private sharp = 0;
    private frameListeners = new Set<() => void>();
    private beforeListeners = new Set<() => void>();
    private graphListeners = new Set<() => void>();
    /** Custom post effects, in chain order (see setCustomPosts). */
    private customPosts: PostBase[] = [];
    private frames = 0;
    private fpsTime = performance.now();
    /** When the engine started its update and draw calls this frame. */
    private engineStart = 0;
    private atmosphere: AtmosphericComponent | null = null;
    /** The physical sky (packages/atmosphere), for sky 'physical'. */
    private physical: PhysicalSkyComponent | null = null;
    private solidSky: SkyRenderer | null = null;
    private solidSkyTexture: SolidColorSky | null = null;
    private post: PostProcessingComponent;
    private lastEnv = '';
    /** Environment waiting for a sky component to finish starting. */
    private pendingEnv: EnvironmentDoc | null = null;
    /** When the physical sky with clouds last took new settings, and the ones waiting for their turn. */
    private cloudBakeAt = 0;
    private cloudsLater: EnvironmentDoc | null = null;

    private constructor(engine: Engine3D, canvas: HTMLCanvasElement, stats: GpuStats | null, quality: QualityLevel) {
        this.engine = engine;
        this.canvas = canvas;
        this.stats = stats;
        this.deviceQuality = quality;
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
        // Mirrors leave it out, as they leave each other out.
        this.grid.traverse((o: Object3D) => o.getComponent(MeshRenderer)?.addMask(MirrorComponent.MIRROR_MASK));

        this.view = new View3D();
        this.view.scene = this.scene;
        this.view.camera = this.camera;
        engine.startRenderView(this.view);
        this.post = this.scene.addComponent(PostProcessingComponent);
        this.gi = new GIController(this);
    }

    /**
     * `stats` counts draw calls and GPU memory (the editor's status bar); it
     * has to start before the engine. `quality` is the device's tier (the
     * editor: high): its shadow map sizes are fixed from here on.
     */
    static async create(canvas: HTMLCanvasElement, opts: { stats?: boolean; quality?: QualityLevel } = {}): Promise<Runtime> {
        let runtime: Runtime | null = null;
        const stats = opts.stats === false ? null : installGpuStats();
        // The Profiler's CPU time, draws and GPU time per pass.
        if (stats) RenderGraph.passHook = { begin: (name) => stats.passBegin(name), end: (name) => stats.passEnd(name) };
        const quality = opts.quality ?? 'high';
        const tier = QUALITY[quality];
        const engine = await Engine3D.init({
            canvasConfig: { canvas },
            setting: {
                // The editor does its own ray picking against the document.
                pick: { enable: false },
                // The map size has to be the size the shadows are filtered and biased for.
                shadow: {
                    type: 'PCF',
                    shadowBound: 60,
                    shadowSize: tier.shadowMapSize,
                    maxShadowMapWidth: tier.shadowMapSize,
                    maxShadowMapHeight: tier.shadowMapSize,
                    pointShadowSize: tier.pointShadowSize,
                },
                gi: giEngineSetting(),
                // Imported models keep the node matrices of their files
                // (unit scale, Z-up to Y-up), as other glTF viewers do.
                loader: { gltfNodeMatrix: true },
            },
            beforeRender: () => runtime?.beforeTick(),
            lateRender: () => runtime?.tick(),
        });
        runtime = new Runtime(engine, canvas, stats, quality);
        return runtime;
    }

    /**
     * Limits how often the viewport draws and sets its resolution (the
     * editor's preferences; games play without a limit, at full resolution).
     */
    setViewport(fps: ViewportFps, quality: ViewportQuality) {
        this.fpsLimit = fps;
        // The engine draws as often as the display refreshes from 360 on.
        this.engine.frameRate = fps > 0 ? fps : 360;
        this.quality = quality;
        this.applyResolution();
        this.watchRatio();
    }

    /** Sets the resolution again when the screen's pixel ratio changes (the engine's own resize keeps the ratio it was given). */
    private watchRatio() {
        if (this.watchingRatio || typeof matchMedia !== 'function') return;
        this.watchingRatio = true;
        const watch = () => {
            matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => {
                this.applyResolution();
                watch();
            }, { once: true });
        };
        watch();
    }

    /** The frame rate the viewport aims at: its limit, or 60 without one. */
    get fpsTarget(): number {
        return this.fpsLimit || 60;
    }

    /** Sets the canvas's pixels per CSS pixel; true when that changed its size. */
    private applyResolution(): boolean {
        if (!this.quality) return false;
        const ctx = this.engine.context3D;
        const ratio = this.sharp > 0 ? screenRatio() : VIEWPORT_QUALITY.find((q) => q.value === this.quality)!.ratio();
        if (ctx.canvasConfig?.devicePixelRatio === ratio) return false;
        ctx.canvasConfig = { ...ctx.canvasConfig, devicePixelRatio: ratio };
        const size = [ctx.windowWidth, ctx.windowHeight];
        ctx.updateSize();
        if (size[0] === ctx.windowWidth && size[1] === ctx.windowHeight) return false;
        // As the engine does on a resize: the old render targets go once the GPU is done with them.
        void ctx.device.queue.onSubmittedWorkDone().then(
            () => Texture.destroyTexture(ctx),
            () => {},
        );
        return true;
    }

    /** Runs a capture at full resolution, whatever the viewport's quality; `extra` frames wait for a resize to show. */
    private async sharpened<T>(capture: (extra: number) => Promise<T>): Promise<T> {
        this.sharp++;
        const resized = this.applyResolution();
        try {
            return await capture(resized ? 1 : 0);
        } finally {
            this.sharp--;
            this.applyResolution();
        }
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
        this.stats?.beginFrame();
        this.fitShadowLights();
        const start = performance.now();
        for (const cb of this.beforeListeners) {
            try {
                cb();
            } catch (e) {
                console.error('[editor] before-frame listener failed', e);
            }
        }
        this.engineStart = performance.now();
        // Play (scripts, behavior trees, physics) and the walk camera run here.
        if (this.beforeListeners.size) this.stats?.addCpu('Play and walk', this.engineStart - start);
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

    /** The tier drawn now: the previewed one, else the document's, else the device's. */
    get qualityLevel(): QualityLevel {
        return resolveQuality(this.qualitySetting, this.deviceQuality, this.qualityOverride);
    }

    /** Draws another tier than the document's (null: the document's); shadow map sizes stay the device's. */
    setQualityOverride(level: QualityLevel | null) {
        if (this.qualityOverride === level) return;
        this.qualityOverride = level;
        this.lastEnv = '';
        if (this.lastEnvDoc) this.applyEnvironment(this.lastEnvDoc);
    }

    /**
     * Directional shadows cover `shadowRange` meters around their light
     * (or the camera), and as far toward the light as that, so tall
     * casters do not lose their tops. With cascades the sun (the first
     * directional light that casts shadows) covers the range from the
     * camera out in cascades instead, while its cascades and the other
     * lights fit the shadow map's layers. Lights that start later get it
     * on the next frame; the setters do nothing when nothing changed.
     */
    private fitShadowLights() {
        const lights = ShadowLightsCollect.directionLightList?.get(this.scene);
        if (!lights?.length) return;
        const r = this.shadowRange;
        const cascaded = this.shadowCascades && lights.length - 1 + CSM.Cascades <= this.engine.setting.shadow.maxShadowMapNum;
        lights.forEach((l, i) => {
            if (!(l instanceof DirectLight)) return;
            const csm = cascaded && i === 0;
            if (l.enableCSM !== csm) {
                l.csmSplitFunction = this.cascadeSplit;
                l.enableCSM = csm;
            }
            if (csm) return;
            l.shadowBoundWidth = r;
            l.shadowBoundHeight = r;
            l.shadowBoundNear = -r;
            l.shadowBoundFar = r;
            l.shadowFollow = this.shadowFollow;
        });
    }

    /**
     * Where the sun's cascades end (`index` counts their bounds, 0 at the
     * camera's near plane): from the camera out to the shadow range,
     * mostly on a logarithmic scale so the near ones are small and sharp,
     * partly even so the far ones do not grow too wide.
     */
    private cascadeSplit = (near: number, far: number, index: number, bounds: number): number => {
        if (index <= 0) return near;
        const from = Math.max(near, 0.1);
        const end = Math.max(from + 1, Math.min(far, this.shadowRange));
        const t = index / (bounds - 1);
        return 0.75 * from * Math.pow(end / from, t) + 0.25 * (from + (end - from) * t);
    };

    private tick() {
        this.stats?.endFrame(performance.now() - this.engineStart);
        if (this.pendingEnv) {
            const env = this.pendingEnv;
            this.pendingEnv = null;
            this.applyEnvironment(env);
        }
        if (this.cloudsLater && performance.now() - this.cloudBakeAt >= CLOUD_BAKE_MS) {
            const env = this.cloudsLater;
            this.cloudsLater = null;
            if (!this.applySky(env)) this.cloudsLater = env;
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
        this.lastEnvDoc = env;
        this.qualitySetting = env.quality;
        const level = this.qualityLevel;
        const key = JSON.stringify(env) + '|' + level;
        if (key === this.lastEnv) return;
        this.lastEnv = key;
        const tier = QUALITY[level];

        const setting = this.engine.setting;
        setting.render.tonemap.exposure = env.exposure;
        if (!this.applySky(env)) {
            // Retry once the previous sky has started (see applySky).
            this.pendingEnv = env;
            this.lastEnv = '';
        }

        // The engine's default settings have every post effect.
        const pp = setting.render.postProcessing;
        const bloom = pp.bloom!;
        bloom.bloomIntensity = env.bloom.intensity;
        bloom.luminanceThreshole = env.bloom.threshold;
        this.togglePost(BloomPost, env.bloom.enable);

        const gtao = pp.gtao!;
        gtao.darkFactor = Math.min(1, Math.max(0.01, env.ao.strength));
        gtao.maxDistance = Math.min(50, Math.max(0.1, env.ao.distance));
        this.togglePost(GTAOPost, env.ao.enable && tier.ao);

        const ssr = pp.ssr!;
        ssr.reflectionRatio = env.ssr.strength;
        ssr.roughnessThreshold = env.ssr.roughness;
        ssr.fadeDistanceMax = env.ssr.distance;
        ssr.fadeDistanceMin = env.ssr.distance * 0.5;
        if (tier.ssrScale > 0 && ssr.pixelRatio !== tier.ssrScale) {
            ssr.pixelRatio = tier.ssrScale;
            // Made at the old size: traced again at the new one.
            (this.post.getPost(SSRPost as any) as SSRPost | null)?.onResize();
        }
        this.togglePost(SSRPost, env.ssr.enable && tier.ssrScale > 0);

        const fog = pp.globalFog!;
        const f = env.fog;
        fog.fogType = FOG_TYPES[f.mode] ?? 0;
        fog.fogColor = hexToColor(f.color);
        // The engine's fog is clear up to `end`; linear fog is full at `start`.
        fog.end = Math.max(0, f.near);
        fog.start = Math.max(fog.end + 0.01, f.far);
        fog.ins = f.intensity;
        fog.density = f.mode === 'linear' ? 0 : Math.max(0, f.density);
        fog.fogHeightScale = Math.max(0.001, f.heightFalloff);
        fog.heightBase = f.height;
        // The engine's older height term stays off.
        fog.rayLength = 0;
        fog.overrideSkyFactor = f.sky;
        fog.dirHeightLine = sunScatterToLine(f.sunScatter);
        fog.scatteringExponent = f.sunFocus;
        this.togglePost(GlobalFog, f.enable);

        const vf = env.volumetricFog;
        const vol = (pp as any).volumetricFog;
        if (vol) {
            vol.density = vf.density;
            vol.scatteringIntensity = vf.scattering;
            vol.anisotropy = vf.anisotropy;
            vol.maxDistance = vf.distance;
            vol.stepCount = tier.fogSteps;
            const a = hexToColor(vf.ambient);
            vol.ambient = { r: a.r, g: a.g, b: a.b };
        }
        this.togglePost(VolumetricFogPost, vf.enable && tier.fogSteps > 0);

        const gr = env.godRays;
        const god = pp.godRay!;
        god.blendColor = true;
        god.rayMarchCount = Math.min(20, Math.max(8, tier.godRaySteps));
        god.scatteringExponent = Math.min(40, Math.max(1, gr.focus));
        god.intensity = Math.min(5, Math.max(0.01, gr.intensity));
        this.togglePost(GodRayPost, gr.enable && tier.godRaySteps > 0);

        const shadow = setting.shadow;
        this.shadowRange = Math.min(env.shadow.range, tier.shadowRangeMax);
        // Cascades cover the range from the camera; a tier without them keeps one map around the camera.
        this.shadowCascades = env.shadow.cascades && tier.cascades;
        this.shadowFollow = env.shadow.follow || env.shadow.cascades;
        shadow.shadowBound = this.shadowRange;
        shadow.pcfKernelScale = env.shadow.softness;
        shadow.updateFrameRate = tier.shadowEvery;
        this.fitShadowLights();

        const fxaa = this.postList()?.get('FXAAPost');
        if (fxaa) fxaa.enable = env.fxaa;

        this.gi.apply(tier.giRealtime ? env.gi : { ...env.gi, realtime: false });
    }

    /**
     * Returns false when the switch has to wait: a sky renderer builds its
     * geometry when it starts, and removing one before that throws inside
     * the engine, so a sky added this frame cannot be swapped out yet.
     */
    private applySky(env: EnvironmentDoc): boolean {
        const sky = env.sky;
        // A newer environment replaces any waiting cloudy one.
        this.cloudsLater = null;
        // The other skies go first: removing any sky clears the scene's sky, even a newer one.
        if (sky !== 'atmospheric' && this.atmosphere) {
            if (!this.atmosphere.geometry) return false;
            this.scene.removeComponent(AtmosphericComponent);
            this.atmosphere = null;
        }
        if (sky !== 'physical' && this.physical) {
            if (!this.physical.geometry) return false;
            this.scene.removeComponent(PhysicalSkyComponent);
            this.physical = null;
        }
        if (sky !== 'color' && this.solidSky) {
            if (!this.solidSky.geometry) return false;
            this.scene.removeComponent(SkyRenderer);
            this.solidSky = null;
            this.solidSkyTexture = null;
        }
        const p = skyParams(env);
        if (sky === 'atmospheric' || sky === 'physical') {
            let c: AtmosphericComponent | PhysicalSkyComponent;
            if (sky === 'physical') {
                // With clouds a bake takes long: changes (a slider drag) are taken a few times a second, the last one always.
                const now = performance.now();
                if (this.physical && (p.enableClouds || this.physical.enableClouds) && now - this.cloudBakeAt < CLOUD_BAKE_MS) {
                    this.cloudsLater = env;
                    return true;
                }
                this.cloudBakeAt = now;
                if (!this.physical) {
                    this.physical = this.scene.addComponent(PhysicalSkyComponent);
                    // Its own default has clouds; the first bake uses what is set before it starts.
                    this.physical.enableClouds = false;
                }
                this.physical.enableClouds = p.enableClouds;
                c = this.physical;
            } else {
                this.atmosphere ??= this.scene.addComponent(AtmosphericComponent);
                c = this.atmosphere;
            }
            // Setters re-bake the sky only when a value changes.
            c.sunX = p.sunX;
            c.sunY = p.sunY;
            c.eyePos = p.eyePos;
            c.sunRadius = p.sunRadius;
            c.sunBrightness = p.sunBrightness;
            c.displaySun = p.displaySun;
            c.exposure = p.exposure;
        } else {
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
        // Built-in effects the editor does not know keep their place after those it does.
        const builtin = (name: string) => {
            const i = BUILTIN_ORDER.indexOf(name);
            return i < 0 ? BUILTIN_ORDER.length : i;
        };
        entries.sort((a, b) => {
            const ra = rank(a[0], a[1]), rb = rank(b[0], b[1]);
            if (ra !== rb) return ra - rb;
            if (ra === 1) return order.indexOf(a[0]) - order.indexOf(b[0]);
            if (ra === 0) return builtin(a[0]) - builtin(b[0]);
            return 0;
        });
        list.clear();
        for (const [k, v] of entries) list.set(k, v);
    }

    // -------------------------------------------------------------- helpers

    /**
     * Runs `read` right after the engine drew the frame `frames` frames from
     * now, while the canvas still holds it. Hidden pages get no frame
     * callbacks, so there the frames are drawn from here (the assistant may
     * capture while the user is in another tab).
     */
    private afterFrames<T>(frames: number, read: () => T | Promise<T>, timeout = 20000): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let left = Math.max(1, frames);
            let done = false;
            const finish = () => {
                done = true;
                off();
                clearTimeout(timer);
            };
            const timer = window.setTimeout(() => {
                finish();
                reject(new Error('No frame was rendered.'));
            }, timeout);
            const off = this.onFrame(() => {
                if (--left > 0) return;
                finish();
                try {
                    Promise.resolve(read()).then(resolve, reject);
                } catch (e) {
                    reject(e);
                }
            });
            void (async () => {
                while (!done) {
                    if (!document.hidden) {
                        await new Promise((r) => setTimeout(r, 200));
                        continue;
                    }
                    const before = left;
                    try {
                        await Engine3D.renderNow();
                    } catch {
                        return;
                    }
                    // Nothing was drawn (a lost device): leave it to the timeout.
                    if (!done && left === before) return;
                }
            })();
        });
    }

    /** JPEG data URL of the next rendered frame, at most `maxWidth` wide. */
    capture(maxWidth = 1024): Promise<string> {
        return this.sharpened((extra) => this.afterFrames(1 + extra, () => {
            const src = this.canvas;
            const k = Math.min(1, maxWidth / Math.max(1, src.width));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(src.width * k));
            c.height = Math.max(1, Math.round(src.height * k));
            c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.82);
        }));
    }

    /**
     * Image of the next rendered frame, cropped to `crop` (CSS pixels of the
     * canvas) and at most `maxWidth` wide. `frames` waits that many frames
     * first, so a camera set just before shows up.
     */
    captureFrame(opts: { crop?: { x: number; y: number; w: number; h: number }; maxWidth?: number; type?: string; quality?: number; frames?: number } = {}): Promise<Blob> {
        return this.sharpened((extra) => this.afterFrames((opts.frames ?? 1) + extra, () => {
            const src = this.canvas;
            const sx = src.width / Math.max(1, src.clientWidth);
            const sy = src.height / Math.max(1, src.clientHeight);
            const crop = opts.crop ?? { x: 0, y: 0, w: src.clientWidth, h: src.clientHeight };
            const cx = Math.max(0, Math.round(crop.x * sx)), cy = Math.max(0, Math.round(crop.y * sy));
            const cw = Math.max(1, Math.min(src.width - cx, Math.round(crop.w * sx))), ch = Math.max(1, Math.min(src.height - cy, Math.round(crop.h * sy)));
            const k = Math.min(1, (opts.maxWidth ?? 1600) / cw);
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(cw * k));
            c.height = Math.max(1, Math.round(ch * k));
            const g = c.getContext('2d')!;
            g.imageSmoothingQuality = 'high';
            g.drawImage(src, cx, cy, cw, ch, 0, 0, c.width, c.height);
            return new Promise<Blob>((resolve, reject) =>
                c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the capture.'))), opts.type ?? 'image/jpeg', opts.quality ?? 0.9),
            );
        }));
    }

    /** Current canvas size in CSS pixels. */
    get cssSize(): [number, number] {
        return [this.canvas.clientWidth, this.canvas.clientHeight];
    }
}

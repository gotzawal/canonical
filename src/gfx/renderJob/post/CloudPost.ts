import { CloudComposite_cs, CloudEnvComposite_cs, CloudEnvDown_cs, CloudEnvMarch_cs, CloudMarch_cs } from '../../../assets/shader/compute/Cloud_cs';
import { Object3D } from '../../../core/entities/Object3D';
import { Scene3D } from '../../../core/Scene3D';
import { RenderNode } from '../../../components/renderer/RenderNode';
import { TextureCube } from '../../graphics/webGpu/core/texture/TextureCube';
import { Context3D } from '../../graphics/webGpu/Context3D';
import { View3D } from '../../../core/View3D';
import { Uint8ArrayTexture } from '../../../textures/Uint8ArrayTexture';
import { VirtualTexture } from '../../../textures/VirtualTexture';
import { Texture } from '../../graphics/webGpu/core/texture/Texture';
import { GlobalBindGroup } from '../../graphics/webGpu/core/bindGroups/GlobalBindGroup';
import { UniformGPUBuffer } from '../../graphics/webGpu/core/buffer/UniformGPUBuffer';
import { ComputeShader } from '../../graphics/webGpu/shader/ComputeShader';
import { GPUTextureFormat } from '../../graphics/webGpu/WebGPUConst';
import { WebGPUDescriptorCreator } from '../../graphics/webGpu/descriptor/WebGPUDescriptorCreator';
import { RTDescriptor } from '../../graphics/webGpu/descriptor/RTDescriptor';
import { GBufferFrame } from '../frame/GBufferFrame';
import { RTFrame } from '../frame/RTFrame';
import { EntityCollect } from '../collect/EntityCollect';
import { SkyRenderer } from '../../../components/renderer/SkyRenderer';
import { Engine3D } from '../../../Engine3D';
import { PostBase } from './PostBase';

/**
 * Volumetric clouds: a layer of clouds on a shell around the Earth, ray
 * marched at a quarter of the resolution each way (a different pixel of
 * each 4x4 block every frame) and gathered over frames at half resolution,
 * then put over the scene with their shadow on the ground. With
 * `reflections` the scene's environment cube becomes the sky with the
 * clouds in it (a face refreshed each frame), so reflections and the light
 * from the sky have them too; the sky drawn behind the scene stays clear.
 * See Cloud_cs. The settings are the public fields; the editor sets them.
 *
 * @group Post Effects
 */
export class CloudPost extends PostBase {
    /** Altitudes of the layer's bottom and top, meters. */
    public bottom = 1500;
    public top = 3500;
    /** How much of the sky they cover, 0 to 1. */
    public coverage = 0.45;
    /** How thick they are (1 as usual). */
    public density = 1;
    /** 0 flat sheets (stratus) to 1 tall heaps (cumulus). */
    public type = 0.6;
    /** How much their edges are worn into wisps, 0 to 1. */
    public detail = 0.6;
    /** Wind over the layer, m/s along x and z, and how fast shapes change, m/s. */
    public windX = 6;
    public windZ = 3;
    public evolve = 2;
    /** Air between the camera and far clouds (aerial perspective, 1 a clear day). */
    public haze = 1;
    /** How dark their shadows on the ground are, 0 to 1. */
    public shadows = 0.6;
    /** Steps along each ray (the graphics tier's budget). */
    public steps = 48;
    /** Clouds in the scene's environment cube (reflections, light from the sky). */
    public reflections = true;

    private _march: ComputeShader;
    private _composite: ComputeShader[] = [];
    private _settings: UniformGPUBuffer;
    private _noise: Uint8ArrayTexture;
    private _marchTex: VirtualTexture;
    private _history: VirtualTexture[] = [];
    private _outTex: VirtualTexture;
    private _rtFrame: RTFrame;
    private _frame = 0;
    private _windOffset = [0, 0];
    private _lastTime = 0;
    private _prevViewProj = new Float32Array(16);
    private _sky: Texture | null = null;
    private _env: Reflection | null = null;

    private _createResources() {
        const ctx = this._boundCtx!;
        const [w, h] = ctx.presentationSize;
        const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
        const make = (tw: number, th: number, name: string) => {
            const t = new VirtualTexture(Math.max(1, tw), Math.max(1, th), GPUTextureFormat.rgba16float, false, usage, 1, 0, 1, ctx);
            t.name = name;
            return t;
        };
        this._marchTex = make(Math.ceil(w / 4), Math.ceil(h / 4), 'CloudMarch');
        this._history = [make(Math.ceil(w / 2), Math.ceil(h / 2), 'CloudHistoryA'), make(Math.ceil(w / 2), Math.ceil(h / 2), 'CloudHistoryB')];
        this._outTex = make(w, h, 'CloudOut');
        const desc = new RTDescriptor();
        desc.loadOp = 'load';
        this._rtFrame = new RTFrame([this._outTex], [desc]);
        this._noise = new Uint8ArrayTexture().createQueued(ATLAS_W, CELL * 4, cloudNoise(), ctx);
        this._noise.addressModeU = 'clamp-to-edge';
        this._noise.addressModeV = 'clamp-to-edge';
    }

    private _createCompute(view: View3D) {
        const ctx = view.engine3D.context3D;
        this._settings = new UniformGPUBuffer(40);
        const lights = GlobalBindGroup.getLightEntries(view.scene).storageGPUBuffer;
        const gBuffer = GBufferFrame.getGBufferFrame(GBufferFrame.colorPass_GBuffer, ctx).getCompressGBufferTexture();
        this._march = new ComputeShader(CloudMarch_cs);
        this._march.setUniformBuffer('cloud', this._settings);
        this._march.setStorageBuffer('lightBuffer', lights);
        this._march.setSamplerTexture('gBufferTexture', gBuffer);
        this._march.setSamplerTexture('noiseTex', this._noise);
        this._march.setStorageTexture('outTex', this._marchTex);
        // Two composites: each reads one history and writes the other.
        this._composite = [0, 1].map((i) => {
            const c = new ComputeShader(CloudComposite_cs);
            c.setUniformBuffer('cloud', this._settings);
            c.setStorageBuffer('lightBuffer', lights);
            c.setSamplerTexture('gBufferTexture', gBuffer);
            c.setSamplerTexture('noiseTex', this._noise);
            c.setSamplerTexture('marchTex', this._marchTex);
            c.setSamplerTexture('historyTex', this._history[i]);
            c.setStorageTexture('historyOut', this._history[1 - i]);
            c.setStorageTexture('outTex', this._outTex);
            return c;
        });
    }

    private _skyTexture(view: View3D): Texture {
        const sky = EntityCollect.instance.getSky(view.scene);
        return sky instanceof SkyRenderer ? sky.map : (Engine3D.resFor(view.engine3D.context3D).defaultSky as Texture);
    }

    private _upload(view: View3D) {
        const now = performance.now() / 1000;
        const dt = this._lastTime ? Math.min(0.1, now - this._lastTime) : 0;
        this._lastTime = now;
        this._windOffset[0] += this.windX * dt;
        this._windOffset[1] += this.windZ * dt;
        // Over 16 frames each pixel of a 4x4 block is marched once (a Bayer order spreads them).
        const order = [0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12];
        const k = order[this._frame % 16];
        const s = this._settings;
        s.setFloat32Array('prevViewProj', this._prevViewProj);
        s.setFloat32Array('layer', new Float32Array([this.bottom, Math.max(this.top, this.bottom + 10), Math.min(1, Math.max(0, this.coverage)), Math.max(0, this.density)]));
        s.setFloat32Array('shape', new Float32Array([this.type, this.detail, this.evolve, now % 100000]));
        s.setFloat32Array('wind', new Float32Array([this._windOffset[0], this._windOffset[1], this.haze, this.shadows]));
        s.setFloat32Array('march', new Float32Array([this.steps, this._frame, k % 4, Math.floor(k / 4)]));
        // The reflection cube: all six faces when it is new, then one a frame.
        const env = this._env?.clear ? this._env : null;
        const face = env && env.fresh ? 0 : this._frame % 6;
        s.setFloat32Array('env', new Float32Array([face, Math.max(12, Math.round(this.steps * 0.5)), ENV_SIZE, env?.cloudSize ?? 0]));
        s.apply();
    }

    public render(view: View3D, command: GPUCommandEncoder) {
        if (!this._march) {
            this._createResources();
            this._createCompute(view);
            this.onResize();
            this.rendererPassState = WebGPUDescriptorCreator.createRendererPassState(view.engine3D.context3D, this._rtFrame, null);
            this.rendererPassState.label = 'Clouds';
        }
        const sky = this._skyTexture(view);
        if (sky !== this._sky) {
            this._sky = sky;
            this._march.setSamplerTexture('prefilterMap', sky);
        }
        const composite = this._composite[this._frame % 2];
        this.bindCamera(this._march, view);
        this.bindCamera(composite, view);
        this.bindUpstream(composite, 'inTex');
        this._updateReflection(view, sky);
        this._upload(view);
        const env = this._env?.clear ? this._env : null;
        const computes = [this._march, composite];
        if (env) {
            const faces = env.fresh ? 6 : 1;
            this.bindCamera(env.computes[0], view);
            for (const c of env.computes) c.workerSizeZ = faces;
            computes.push(...env.computes);
            env.fresh = false;
        }
        this._boundCtx!.gpuContext.computeCommand(command, computes);
        this._boundCtx!.gpuContext.lastRenderPassState = this.rendererPassState;
        this._prevViewProj.set(view.camera.pvMatrix.rawData);
        this._frame++;
    }

    public onResize() {
        const [w, h] = this._boundCtx!.presentationSize;
        if (!this._outTex) return;
        this._outTex.resize(w, h);
        this._marchTex.resize(Math.max(1, Math.ceil(w / 4)), Math.max(1, Math.ceil(h / 4)));
        for (const t of this._history) t.resize(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
        // History from before the resize does not fit: start again.
        this._frame = 0;
        if (this._march) {
            this._march.workerSizeX = Math.ceil(w / 4 / 8);
            this._march.workerSizeY = Math.ceil(h / 4 / 8);
            this._march.workerSizeZ = 1;
            for (const c of this._composite) {
                c.workerSizeX = Math.ceil(w / 8);
                c.workerSizeY = Math.ceil(h / 8);
                c.workerSizeZ = 1;
            }
        }
    }

    /**
     * Makes and keeps the reflection cube: the scene's environment map
     * becomes it (the sky renderer keeps the clear sky), and every material
     * bound to the clear sky is bound to it instead. Without `reflections`
     * the scene gets its clear sky back; the cube stays for when they return.
     */
    private _updateReflection(view: View3D, sky: Texture) {
        const scene = view.scene;
        if (this._env && this._env.scene !== scene) this._dropReflection();
        if (!this.reflections) {
            this._releaseReflection();
            return;
        }
        this._env ??= new Reflection(this._boundCtx!, scene, REFLECTION_SIZE, this._settings, this._noise, GlobalBindGroup.getLightEntries(scene).storageGPUBuffer);
        const env = this._env;
        env.setSky(sky);
        if (scene.envMap !== env.cube) {
            // A new sky (or the first): it stays on the sky renderer, everything else gets the cube.
            const clear = scene.envMap;
            if (!env.clear) env.fresh = true;
            env.cube.isHDRTexture = clear?.isHDRTexture;
            scene.envMap = env.cube;
            const dome = EntityCollect.instance.getSky(scene);
            if (dome instanceof SkyRenderer) dome.map = clear;
            rebind(scene, [clear, env.clear].filter((t): t is Texture => !!t && t !== env.cube), env.cube);
            env.clear = clear;
        }
    }

    /** Gives the scene its clear sky back (the cube stays). */
    private _releaseReflection() {
        const env = this._env;
        if (!env?.clear) return;
        const scene = env.scene;
        if (scene.envMap === env.cube) scene.envMap = env.clear;
        rebind(scene, [env.cube], scene.envMap);
        env.clear = null;
    }

    private _dropReflection() {
        this._releaseReflection();
        this._env?.destroy();
        this._env = null;
    }

    public destroy(force?: boolean) {
        this._dropReflection();
        this.destroyOwned(this._march, ...this._composite, this._settings, this._marchTex, ...this._history, this._outTex, this._noise);
        super.destroy(force);
    }
}

/** Texels along each face of the reflection cube's sharpest level (levels down to 16). */
const ENV_SIZE = 512;
/** Texels along each face of the small cube the reflected clouds are marched into. */
const REFLECTION_SIZE = 128;

/** One level of a cube texture as a 2D array of its six faces (to write in a compute shader). */
class CubeLevel extends Texture {
    constructor(cube: Texture, level: number, ctx: Context3D) {
        super(1, 1);
        this._ensureBound(ctx);
        const t = cube.getGPUTexture() as GPUTexture;
        this.view = t.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 6 });
    }
}

function makeCube(ctx: Context3D, size: number, name: string): TextureCube {
    const cube = new (class extends TextureCube {
        constructor() {
            super();
            this.name = name;
            this.format = GPUTextureFormat.rgba16float;
            this.useMipmap = true;
            let levels = 1;
            for (let s = size; s > 16; s /= 2) levels++;
            this.mipmapCount = levels;
            this.createTextureDescriptor(size, size, levels, this.format);
            this._ensureBound(ctx);
        }
    })();
    return cube;
}

/**
 * The reflection cube and what fills it: the clouds marched into a small
 * cube and its blurrier levels, then each level of the environment cube
 * (the clear sky through those clouds).
 */
class Reflection {
    /** The environment cube the scene's materials read. */
    public readonly cube: TextureCube;
    /** The clear sky the scene had before (what it goes back to). */
    public clear: Texture | null = null;
    /** Made this frame: all six faces get filled at once. */
    public fresh = true;
    public readonly computes: ComputeShader[] = [];
    private _clouds: TextureCube;
    private _views: Texture[] = [];
    private _composites: ComputeShader[] = [];
    private _march: ComputeShader;

    constructor(ctx: Context3D, public readonly scene: Scene3D, public readonly cloudSize: number, settings: UniformGPUBuffer, noise: Texture, lights: any) {
        this.cube = makeCube(ctx, ENV_SIZE, 'CloudReflection');
        this._clouds = makeCube(ctx, cloudSize, 'CloudReflectionClouds');
        const cloudLevels = this._clouds.mipmapCount;
        const cloudViews = Array.from({ length: cloudLevels }, (_, i) => new CubeLevel(this._clouds, i, ctx));
        const envViews = Array.from({ length: this.cube.mipmapCount }, (_, i) => new CubeLevel(this.cube, i, ctx));
        this._views = [...cloudViews, ...envViews];
        const sized = (c: ComputeShader, s: number) => {
            c.workerSizeX = c.workerSizeY = Math.ceil(s / 8);
            c.workerSizeZ = 1;
            return c;
        };
        this._march = sized(new ComputeShader(CloudEnvMarch_cs), cloudSize);
        this._march.setUniformBuffer('cloud', settings);
        this._march.setStorageBuffer('lightBuffer', lights);
        this._march.setSamplerTexture('noiseTex', noise);
        this._march.setStorageTexture('outTex', cloudViews[0]);
        this.computes.push(this._march);
        for (let i = 1; i < cloudLevels; i++) {
            const c = sized(new ComputeShader(CloudEnvDown_cs), cloudSize >> i);
            c.setUniformBuffer('cloud', settings);
            c.setSamplerTexture('inTex', cloudViews[i - 1]);
            c.setStorageTexture('outTex', cloudViews[i]);
            this.computes.push(c);
        }
        for (let i = 0; i < this.cube.mipmapCount; i++) {
            const c = sized(new ComputeShader(CloudEnvComposite_cs), ENV_SIZE >> i);
            c.setUniformBuffer('cloud', settings);
            c.setSamplerTexture('cloudCube', this._clouds);
            c.setStorageTexture('outTex', envViews[i]);
            this._composites.push(c);
            this.computes.push(c);
        }
    }

    private _sky: Texture | null = null;

    /** The clear sky the clouds are lit by and put over. */
    public setSky(sky: Texture) {
        if (sky === this._sky) return;
        this._sky = sky;
        this._march.setSamplerTexture('prefilterMap', sky);
        for (const c of this._composites) c.setSamplerTexture('prefilterMap', sky);
    }

    public destroy() {
        for (const c of this.computes) c.destroy(true);
        for (const v of this._views) v.destroy(true);
        this._clouds.destroy(true);
        this.cube.destroy(true);
    }
}

/** Binds every material in the scene that reads one of `from` as its environment to `to`. */
function rebind(scene: Scene3D, from: Texture[], to: Texture) {
    if (!from.length || !to) return;
    const visit = (o: Object3D) => {
        o.components.forEach((c) => {
            if (!(c instanceof RenderNode) || c instanceof SkyRenderer) return;
            for (const m of c.materials) {
                if (!m?.shader) continue;
                for (const passes of m.shader.passShader.values()) for (const p of passes) {
                    if (p.envMap && from.includes(p.envMap)) p.setTexture('envMap', to);
                    if (p.prefilterMap && from.includes(p.prefilterMap)) p.setTexture('prefilterMap', to);
                }
            }
        });
        for (const child of o.entityChildren) if (child instanceof Object3D) visit(child);
    };
    visit(scene);
}

/** Voxels along each side of the noise volume, and each slice's side with its wrapped border. */
const SIZE = 32;
const CELL = SIZE + 2;
/** The atlas's width: 8 slices, padded so each row is whole 256 bytes (as an upload needs). */
const ATLAS_W = 320;

/**
 * The noise volume (tiling, 32^3) as 32 slices of 34x34 (a wrapped border
 * each) in an 8x4 grid: red the base shape (Perlin carved by Worley),
 * green the erosion (Worley over three octaves). Made once, on the CPU.
 */
function cloudNoise(): Uint8Array {
    const rand = mulberry(7);
    const worley = (period: number) => {
        const pts = new Float32Array(period * period * period * 3).map(() => rand());
        return (x: number, y: number, z: number) => {
            const px = x * period, py = y * period, pz = z * period;
            const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
            let best = 9;
            for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const cx = ix + dx, cy = iy + dy, cz = iz + dz;
                const w = (v: number) => ((v % period) + period) % period;
                const o = (w(cz) * period * period + w(cy) * period + w(cx)) * 3;
                const d = Math.hypot(cx + pts[o] - px, cy + pts[o + 1] - py, cz + pts[o + 2] - pz);
                if (d < best) best = d;
            }
            return 1 - Math.min(1, best);
        };
    };
    const grads = Array.from({ length: 4 * 4 * 4 }, () => {
        const a = rand() * Math.PI * 2, z = rand() * 2 - 1, r = Math.sqrt(1 - z * z);
        return [r * Math.cos(a), r * Math.sin(a), z];
    });
    const perlin = (x: number, y: number, z: number) => {
        const p = 4;
        const px = x * p, py = y * p, pz = z * p;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const fx = px - ix, fy = py - iy, fz = pz - iz;
        const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
        let sum = 0;
        for (let k = 0; k < 8; k++) {
            const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
            const g = grads[(((iz + dz) % p) * p + ((iy + dy) % p)) * p + ((ix + dx) % p)];
            const v = g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz);
            sum += v * (dx ? fade(fx) : 1 - fade(fx)) * (dy ? fade(fy) : 1 - fade(fy)) * (dz ? fade(fz) : 1 - fade(fz));
        }
        return sum * 0.5 + 0.5;
    };
    const w4 = worley(4), w8 = worley(8), w16 = worley(16), w32 = worley(32);
    const vol = new Uint8Array(SIZE * SIZE * SIZE * 2);
    for (let z = 0; z < SIZE; z++) for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const u = (x + 0.5) / SIZE, v = (y + 0.5) / SIZE, w = (z + 0.5) / SIZE;
        const cells = w4(u, v, w) * 0.625 + w8(u, v, w) * 0.25 + w16(u, v, w) * 0.125;
        // Perlin carved by Worley lands mostly low (median about 0.22): stretched to fill 0..1.
        const base = Math.min(1, Math.max(0, ((perlin(u, v, w) - (1 - cells)) / Math.max(1e-3, cells) * 0.5 + cells * 0.5) / 0.52));
        const erosion = w8(u, v, w) * 0.625 + w16(u, v, w) * 0.25 + w32(u, v, w) * 0.125;
        const o = ((z * SIZE + y) * SIZE + x) * 2;
        vol[o] = Math.round(base * 255);
        vol[o + 1] = Math.round(erosion * 255);
    }
    const W = ATLAS_W, H = CELL * 4;
    const out = new Uint8Array(W * H * 4);
    for (let s = 0; s < SIZE; s++) {
        const ox = (s % 8) * CELL, oy = Math.floor(s / 8) * CELL;
        for (let j = 0; j < CELL; j++) for (let i = 0; i < CELL; i++) {
            const x = (i - 1 + SIZE) % SIZE, y = (j - 1 + SIZE) % SIZE;
            const src = ((s * SIZE + y) * SIZE + x) * 2;
            const dst = ((oy + j) * W + ox + i) * 4;
            out[dst] = vol[src];
            out[dst + 1] = vol[src + 1];
            out[dst + 3] = 255;
        }
    }
    return out;
}

function mulberry(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

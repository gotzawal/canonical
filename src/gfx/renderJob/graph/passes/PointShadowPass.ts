import { LightType } from '../../../../components/lights/LightData';
import { ILight } from '../../../../components/lights/ILight';
import { RenderNode } from '../../../../components/renderer/RenderNode';
import { Camera3D } from '../../../../core/Camera3D';
import { CameraType } from '../../../../core/CameraType';
import { View3D } from '../../../../core/View3D';
import { Vector3 } from '../../../../math/Vector3';
import { DepthAtlasTexture } from '../../../../textures/DepthAtlasTexture';
import { RenderTexture } from '../../../../textures/RenderTexture';
import { CameraUtil } from '../../../../util/CameraUtil';
import { Reference } from '../../../../util/Reference';
import { Time } from '../../../../util/Time';
import { GPUTextureFormat } from '../../../graphics/webGpu/WebGPUConst';
import { GlobalBindGroup } from '../../../graphics/webGpu/core/bindGroups/GlobalBindGroup';
import { WebGPUDescriptorCreator } from '../../../graphics/webGpu/descriptor/WebGPUDescriptorCreator';
import { ShadowLightsCollect } from '../../collect/ShadowLightsCollect';
import { worldBox } from '../../collect/FrustumCull';
import { RTFrame } from '../../frame/RTFrame';
import { PassType } from '../../passRenderer/state/PassType';
import { RendererPassState } from '../../passRenderer/state/RendererPassState';
import {
    ALL_SHADOW_FACES,
    AtlasTile,
    HASH_START,
    SHADOW_FACE_AXES,
    SHADOW_FACE_BASES,
    SHADOW_FACE_UPS,
    castsChangingShadow,
    hashCaster,
    hashFloats,
    packShadowAtlas,
    spotMaxFaces,
    spotShadowFaces,
} from '../../passRenderer/shadow/ShadowMaps';
import { RenderGraphBuilder, RenderGraphPass, RenderGraphPassContext } from '../RenderGraphPass';
import { dependOnIfRegistered, preInitPassPipelines } from './_helpers';

/**
 * Published handle name for the point and spot lights' shadow atlas: each
 * light's faces (+X, -X, +Y, -Y, +Z, -Z from the light) are tiles of one
 * depth texture, at the light's own size (LightData.shadowTiles).
 *
 * @group Graph
 */
export const POINT_SHADOW_ATLAS = '_PointShadowAtlas';

/**
 * @deprecated The point and spot shadows are an atlas now: {@link POINT_SHADOW_ATLAS}.
 * @group Graph
 */
export const POINT_SHADOW_CUBE_ARRAY = POINT_SHADOW_ATLAS;

/** A shadow-casting point or spot light's faces in the atlas. */
interface LightFaces {
    id: number;
    /** A camera per face, looking from the light. */
    cameras: Camera3D[];
    /** Face size in texels. */
    size: number;
    /** Tiles kept: six for a point light, as many as its cone can reach for a spot light. */
    slots: number;
    tiles: AtlasTile[];
    /** Per face, its tile this frame (-1: none). */
    faceTile: number[];
    /** Where the cameras are and what they reach. */
    at: Vector3;
    near: number;
    far: number;
}

let nextLightId = 1;

/**
 * Point and spot light shadow renderer. Owns the shadow atlas and its
 * packing: a point light takes six tiles, a spot light as many as its
 * cone can reach, each at the light's shadowMapSize (a power of two), in
 * the smallest square that holds them (halved to fit
 * setting.shadow.pointShadowAtlasMax). A face is drawn again only when it
 * would change (see LightBase.shadowUpdate), in one render pass for every
 * face drawn that frame: each face clears its tile and draws the casters
 * within the light's range in that face's direction.
 *
 * @group Graph
 */
export class PointShadowPass extends RenderGraphPass {
    public readonly name = 'PointShadowPass';

    public atlasTexture!: DepthAtlasTexture;
    public shadowPassCount: number = 0;
    /** Faces drawn in the last frame, and those kept as they were. */
    public drawnFaces: number = 0;
    public keptFaces: number = 0;

    /** @deprecated The shadows are an atlas now: {@link atlasTexture}. */
    public get cubeArrayTexture(): DepthAtlasTexture {
        return this.atlasTexture;
    }

    /** Face size used when a light asks for none (setting.shadow.pointShadowSize when set up). */
    public get shadowSize(): number {
        return this._defaultSize;
    }

    protected readonly _passType: PassType = PassType.POINT_SHADOW;
    protected readonly _lights = new Map<ILight, LightFaces>();
    protected _packKey = '';
    protected _state!: RendererPassState;
    protected _clearPipeline: GPURenderPipeline | null = null;
    protected _forceUpdate = false;
    protected _defaultSize = 1024;

    public setup(b: RenderGraphBuilder): void {
        const ctx = b.context3D;
        this._defaultSize = Math.max(64, ctx.engine?.setting.shadow.pointShadowSize || 1024);
        // Sized to the lights' tiles each frame; until one casts, a single texel.
        this.atlasTexture = new DepthAtlasTexture(1, ctx);
        Reference.getInstance().attached(this.atlasTexture, this);

        const rtFrame = new RTFrame([], []);
        rtFrame.depthTexture = this.atlasTexture as unknown as RenderTexture;
        rtFrame.label = 'pointShadowAtlas';
        rtFrame.customSize = true;
        rtFrame.depthCleanValue = 1;
        // Each face clears only its own tile (the others keep their faces).
        rtFrame.depthLoadOp = 'load';
        this._state = WebGPUDescriptorCreator.createRendererPassState(ctx, rtFrame);

        b.write(POINT_SHADOW_ATLAS, () => this.atlasTexture);

        dependOnIfRegistered(b, 'GPUCullPass');
    }

    /** Draws every light's faces again next frame. */
    public forceUpdate(): void {
        this._forceUpdate = true;
    }

    public execute(ctx: RenderGraphPassContext): void {
        const view = ctx.view;
        this.shadowPassCount = 0;
        this.drawnFaces = 0;
        this.keptFaces = 0;
        const shadow = view.engine3D.setting.shadow;
        if (!shadow.enable) return;

        const lights = ShadowLightsCollect.getPointShadowLightWhichScene(view.scene).filter(
            (l) => l.lightData.castShadowIndex > -1 && l.lightData.lightType !== LightType.DirectionLight && (l as any).castShadow !== false,
        );
        for (const [light] of this._lights) {
            if (!lights.includes(light)) {
                this._lights.delete(light);
                light.lightData.shadowTiles.fill(-1);
            }
        }
        this._pack(view, lights, shadow.pointShadowAtlasMax || 4096);

        const atlasW = this.atlasTexture.width;
        const atlasH = this.atlasTexture.height;
        // Faces to draw this frame, with what each is drawn from.
        const draws: { light: ILight; info: LightFaces; face: number; tile: AtlasTile; casters: RenderNode[] }[] = [];
        let all: RenderNode[] | null = null;
        const frame = view.engine3D.frameCount ?? Time.frame;
        for (const light of lights) {
            const info = this._lights.get(light)!;
            this._placeFaces(view, light, info, atlasW, atlasH);
            const force = this._forceUpdate || light.needUpdateShadow;
            if (shadow.autoUpdate === false && !force) {
                this.keptFaces += info.faceTile.filter((t) => t >= 0).length;
                continue;
            }
            all ||= this._casters(view, info.cameras[0]);
            const inRange = this._inRange(all, info.at, info.far, frame);
            const mode = light.shadowUpdate;
            for (let face = 0; face < 6; face++) {
                const t = info.faceTile[face];
                if (t < 0) continue;
                const tile = info.tiles[t];
                const casters = this._inFace(inRange, info.at, face, frame, mode === 'static');
                const sig = mode === 'every_frame' ? NaN : this._signature(info, tile, casters, mode === 'static');
                if (!force && mode !== 'every_frame' && sig === light._shadowSignatures[face]) {
                    this.keptFaces++;
                    continue;
                }
                light._shadowSignatures[face] = sig;
                draws.push({ light, info, face, tile, casters });
            }
            light.needUpdateShadow = false;
        }
        this._forceUpdate = false;
        if (draws.length) this._draw(view, draws);
    }

    /** Gives every light its tiles; packs the atlas again when the lights or their sizes change. */
    protected _pack(view: View3D, lights: ILight[], max: number): void {
        let key = '';
        for (const light of lights) {
            let info = this._lights.get(light);
            if (!info) {
                info = { id: nextLightId++, cameras: this._faceCameras(view, light), size: 0, slots: 6, tiles: [], faceTile: [-1, -1, -1, -1, -1, -1], at: new Vector3(NaN, NaN, NaN), near: 0, far: 0 };
                this._lights.set(light, info);
            }
            const asked = light.shadowMapSize || this._defaultSize;
            info.size = 1 << Math.round(Math.log2(Math.min(2048, Math.max(64, asked))));
            info.slots = light.lightData.lightType === LightType.SpotLight ? spotMaxFaces(light.lightData.outerAngle as number) : 6;
            key += `${info.id}:${info.size}:${info.slots};`;
        }
        if (key === this._packKey) return;
        this._packKey = key;
        const sizes: number[] = [];
        for (const light of lights) {
            const info = this._lights.get(light)!;
            for (let i = 0; i < info.slots; i++) sizes.push(info.size);
        }
        const packed = packShadowAtlas(sizes, max);
        let k = 0;
        for (const light of lights) {
            const info = this._lights.get(light)!;
            info.tiles = packed.tiles.slice(k, k + info.slots);
            k += info.slots;
            // Halved to fit the largest atlas: the size it has.
            info.size = info.tiles[0]?.size || info.size;
            light.shadowMapWidth = info.size;
            light.shadowMapHeight = info.size;
        }
        this.atlasTexture.resize(Math.max(1, packed.width), Math.max(1, packed.height));
        this._forceUpdate = true;
    }

    /** Six cameras looking from the light along +X, -X, +Y, -Y, +Z, -Z (as ShadowMaps' face bases). */
    protected _faceCameras(view: View3D, light: ILight): Camera3D[] {
        const cameras: Camera3D[] = [];
        for (let face = 0; face < 6; face++) {
            const camera = CameraUtil.createCamera3DObject(null, `${light.name ?? 'light'} shadow ${face}`);
            camera.isShadowCamera = true;
            camera.type = CameraType.shadow;
            camera._boundCtx ||= view.engine3D.context3D;
            cameras.push(camera);
        }
        return cameras;
    }

    /**
     * Points the faces' cameras from where the light is, sets which faces
     * are drawn (a spot light's cone reaches only some) and writes where
     * they are in the atlas into the light's data.
     */
    protected _placeFaces(view: View3D, light: ILight, info: LightFaces, atlasW: number, atlasH: number): void {
        const lb = light as any;
        const near = lb.shadowCameraNear > 0 ? lb.shadowCameraNear : 0.01;
        const range = light.lightData.range;
        const far = lb.shadowCameraFar > 0 ? lb.shadowCameraFar : range > 0 ? range : view.camera.far;
        const pos = light.transform.worldPosition;
        if (!pos.equals(info.at) || near !== info.near || far !== info.far) {
            info.at.copy(pos);
            info.near = near;
            info.far = far;
            for (let face = 0; face < 6; face++) {
                const camera = info.cameras[face];
                const [ax, ay, az] = SHADOW_FACE_AXES[face];
                const [ux, uy, uz] = SHADOW_FACE_UPS[face];
                camera.perspective(90, 1, near, far);
                camera.transform.lookAt(pos, new Vector3(pos.x + ax, pos.y + ay, pos.z + az), new Vector3(ux, uy, uz));
                camera.transform.updateWorldMatrix(true);
            }
        }

        let mask = ALL_SHADOW_FACES;
        if (light.lightData.lightType === LightType.SpotLight) {
            const d = light.lightData.direction;
            mask = spotShadowFaces(d.x, d.y, d.z, light.lightData.outerAngle as number);
        }
        const tiles = light.lightData.shadowTiles;
        let slot = 0;
        for (let face = 0; face < 6; face++) {
            const used = (mask & (1 << face)) !== 0 && slot < info.tiles.length && info.tiles[slot].size > 0;
            info.faceTile[face] = used ? slot++ : -1;
            const tile = used ? info.tiles[info.faceTile[face]] : null;
            tiles[face * 2] = tile ? tile.x / atlasW : -1;
            tiles[face * 2 + 1] = tile ? tile.y / atlasH : -1;
        }
        const data = light.lightData;
        data.shadowTileScale[0] = info.size / atlasW;
        data.shadowTileScale[1] = info.size / atlasH;
        data.shadowAtlasTexel[0] = 1 / atlasW;
        data.shadowAtlasTexel[1] = 1 / atlasH;
    }

    /** The renderers that cast shadows, by the pass's layers. */
    protected _casters(view: View3D, camera: Camera3D): RenderNode[] {
        const lists = this.collectLayered(view, camera);
        const out: RenderNode[] = [];
        for (const list of [lists.opaque, lists.transparent]) {
            for (const node of list) {
                if (node.castShadow && node.enable && node.transform.enable && !node.isDestroyed) out.push(node);
            }
        }
        return out;
    }

    /** Casters whose bounds come within `range` of the light (those without known bounds always). */
    protected _inRange(nodes: RenderNode[], at: Vector3, range: number, frame: number): RenderNode[] {
        const out: RenderNode[] = [];
        for (const node of nodes) {
            if (!node.frustumCulled || node.alwaysRender) {
                out.push(node);
                continue;
            }
            const b = worldBox(node, frame);
            if (b[3] < 0) {
                out.push(node);
                continue;
            }
            const dx = Math.max(0, Math.abs(at.x - b[0]) - b[3]);
            const dy = Math.max(0, Math.abs(at.y - b[1]) - b[4]);
            const dz = Math.max(0, Math.abs(at.z - b[2]) - b[5]);
            if (dx * dx + dy * dy + dz * dz <= range * range) out.push(node);
        }
        return out;
    }

    /** Casters in a face's direction from the light: inside its four side planes. */
    protected _inFace(nodes: RenderNode[], at: Vector3, face: number, frame: number, onlyStatic: boolean): RenderNode[] {
        const { x, y, z } = SHADOW_FACE_BASES[face];
        const out: RenderNode[] = [];
        for (const node of nodes) {
            if (onlyStatic && node.shadowCacheMode !== 'static') continue;
            if (node.frustumCulled && !node.alwaysRender) {
                const b = worldBox(node, frame);
                if (b[3] >= 0) {
                    const cx = b[0] - at.x, cy = b[1] - at.y, cz = b[2] - at.z;
                    let outside = false;
                    // Planes z - x, z + x, z - y, z + y: inside where n . p >= 0.
                    for (let k = 0; k < 4 && !outside; k++) {
                        const a = k < 2 ? x : y;
                        const s = k % 2 ? 1 : -1;
                        const nx = z[0] + s * a[0], ny = z[1] + s * a[1], nz = z[2] + s * a[2];
                        const d = nx * cx + ny * cy + nz * cz + Math.abs(nx) * b[3] + Math.abs(ny) * b[4] + Math.abs(nz) * b[5];
                        outside = d < 0;
                    }
                    if (outside) continue;
                }
            }
            out.push(node);
        }
        return out;
    }

    /**
     * What a face shows: where the light is, its reach and tile, and where
     * each caster in it is. NaN, never equal, while a caster that changes
     * shape where it stands is in it (not for a static light, whose casters
     * are only the static ones).
     */
    protected _signature(info: LightFaces, tile: AtlasTile, casters: RenderNode[], onlyStatic: boolean): number {
        let h = hashFloats(HASH_START, [info.at.x, info.at.y, info.at.z, info.near, info.far, tile.x, tile.y, tile.size, this.atlasTexture.width, this.atlasTexture.height]);
        for (const node of casters) {
            if (!onlyStatic && castsChangingShadow(node)) return NaN;
            h = hashCaster(h, node);
        }
        return Math.imul(h ^ casters.length, 16777619);
    }

    /** One render pass for the faces: each clears its tile, then draws its casters. */
    protected _draw(view: View3D, draws: { light: ILight; info: LightFaces; face: number; tile: AtlasTile; casters: RenderNode[] }[]): void {
        const ctx = view.engine3D.context3D;
        const gpu = ctx.gpuContext;
        const state = this._state;
        const clear = this._clearTilePipeline(ctx.device);
        for (const d of draws) {
            for (const node of d.casters) {
                if (!node.preInit(this._passType)) node.nodeUpdate(view, this._passType, state, undefined);
            }
        }
        preInitPassPipelines(view, this._passType, state);

        const command = gpu.beginCommandEncoder();
        const encoder = gpu.beginRenderPass(command, state);
        const render = view.engine3D.setting.render;
        for (const d of draws) {
            const { x, y, size } = d.tile;
            encoder.setViewport(x, y, size, size, 0, 1);
            encoder.setScissorRect(x, y, size, size);
            // Clear the tile: a triangle over it at depth 1.
            encoder.setPipeline(clear);
            encoder.draw(3);
            gpu.cleanCache();

            const camera = d.info.cameras[d.face];
            GlobalBindGroup.updateCameraGroup(camera);
            gpu.bindCamera(encoder, camera);
            const max = Math.min(d.casters.length, render.drawOpMax);
            let ready = true;
            for (let i = render.drawOpMin; i < max; i++) {
                const node = d.casters[i];
                node.renderPass2(view, this._passType, state, undefined, encoder);
                ready &&= this._ready(node);
            }
            // A caster whose pipeline was not built yet was left out: draw the face again next frame.
            if (!ready) d.light._shadowSignatures[d.face] = NaN;
            this.drawnFaces++;
        }
        gpu.endPass(encoder);
        gpu.endCommandEncoder(command);
        this.shadowPassCount++;
    }

    protected _ready(node: RenderNode): boolean {
        for (const material of node.materials) {
            const passes = material?.getPass(this._passType);
            if (passes?.some((p) => !p.pipeline)) return false;
        }
        return true;
    }

    /** A depth-only pipeline that writes 1 (far) over the viewport: clears a tile. */
    protected _clearTilePipeline(device: GPUDevice): GPURenderPipeline {
        if (this._clearPipeline) return this._clearPipeline;
        const module = device.createShaderModule({
            label: 'shadow atlas tile clear',
            code: /*wgsl*/ `
                @vertex
                fn main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
                    let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    return vec4<f32>(p[i], 1.0, 1.0);
                }
            `,
        });
        this._clearPipeline = device.createRenderPipeline({
            label: 'shadow atlas tile clear',
            layout: 'auto',
            vertex: { module, entryPoint: 'main' },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: GPUTextureFormat.depth32float, depthWriteEnabled: true, depthCompare: 'always' },
        });
        return this._clearPipeline;
    }
}

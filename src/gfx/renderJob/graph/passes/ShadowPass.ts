import { DirectLight } from '../../../../components/lights/DirectLight';
import { RenderNode } from '../../../../components/renderer/RenderNode';
import { Camera3D } from '../../../../core/Camera3D';
import { View3D } from '../../../../core/View3D';
import { Vector3 } from '../../../../math/Vector3';
import { Depth2DTextureArray } from '../../../../textures/Depth2DTextureArray';
import { RenderTexture } from '../../../../textures/RenderTexture';
import { VirtualTexture } from '../../../../textures/VirtualTexture';
import { Time } from '../../../../util/Time';
import { Reference } from '../../../../util/Reference';
import { Context3D } from '../../../graphics/webGpu/Context3D';
import { GPUTextureFormat } from '../../../graphics/webGpu/WebGPUConst';
import { GlobalBindGroup } from '../../../graphics/webGpu/core/bindGroups/GlobalBindGroup';
import { Texture } from '../../../graphics/webGpu/core/texture/Texture';
import { WebGPUDescriptorCreator } from '../../../graphics/webGpu/descriptor/WebGPUDescriptorCreator';
import { EntityCollect } from '../../collect/EntityCollect';
import { ShadowLightsCollect } from '../../collect/ShadowLightsCollect';
import { RTFrame } from '../../frame/RTFrame';
import { OcclusionSystem } from '../../occlusion/OcclusionSystem';
import { PassType } from '../../passRenderer/state/PassType';
import { RendererPassState } from '../../passRenderer/state/RendererPassState';
import { HASH_START, castsChangingShadow, hashCaster, hashFloats } from '../../passRenderer/shadow/ShadowMaps';
import { RenderGraphBuilder, RenderGraphPass, RenderGraphPassContext } from '../RenderGraphPass';
import { buildOpBundles, buildTrBundles, dependOnIfRegistered, preInitPassPipelines } from './_helpers';

/**
 * Published handle name for the directional-light shadow map array.
 * `_MainShadowMap` is the CSM cascade array texture. Each cascade
 * occupies one slice (0..maxCascades-1), successive directional
 * lights use subsequent slice ranges up to `shadow.maxShadowMapNum`.
 *
 * @group Graph
 */
export const MAIN_SHADOW_MAP = '_MainShadowMap';

type ShadowKind = 'all' | 'static' | 'dynamic';
type Lists = { opaque: RenderNode[]; transparent: RenderNode[] };

/**
 * One layer of the shadow map array as a render target: what a pass state
 * reads of its depth texture (the view follows the array when it is made
 * again at another size).
 */
class ShadowLayerTarget {
    public readonly name: string;
    constructor(public readonly array: Depth2DTextureArray, public readonly layer: number) {
        this.name = `shadowMapArray layer ${layer}`;
    }
    public get format(): GPUTextureFormat {
        return this.array.format;
    }
    public get width(): number {
        return this.array.width;
    }
    public get height(): number {
        return this.array.height;
    }
    public getGPUView(): GPUTextureView {
        return this.array.getLayerView(this.layer);
    }
    public getGPUTexture(): GPUTexture {
        return this.array.getGPUTexture() as GPUTexture;
    }
}

/**
 * Directional + cascade shadow map renderer. Owns the shadow array texture,
 * sized each frame to the lights that cast (the largest shadowMapSize asked
 * for, a layer per map and cascade) and drawn into layer by layer. A light's
 * map is drawn again only when it would change (see LightBase.shadowUpdate):
 * its camera moved, or a caster in it did. The CSM cascade loop and
 * static/dynamic split stay internal to this pass — splitting them into N
 * graph nodes would explode the DAG without scheduling benefit.
 *
 * @group Graph
 */
export class ShadowPass extends RenderGraphPass {
    public readonly name = 'ShadowPass';

    public depth2DArrayTexture!: Depth2DTextureArray;
    public shadowPassCount: number = 0;
    /** Maps (a cascade is one) drawn in the last frame, and those kept as they were. */
    public drawnMaps: number = 0;
    public keptMaps: number = 0;

    protected readonly _passType: PassType = PassType.SHADOW;
    /** Per layer: drawing into it from clear, and on top of what it holds. */
    protected _clearStates: RendererPassState[] = [];
    protected _loadStates: RendererPassState[] = [];
    protected _activeRendererPassState: RendererPassState | null = null;

    // Static-cache infra — allocated lazily when
    // setting.shadow.enableStaticCache is true and first frame hits the
    // static-cache code path.
    protected _staticDepthTextures: VirtualTexture[] = [];
    protected _staticPassStates: RendererPassState[] = [];
    protected _staticDirtyLayers: boolean[] = [];
    protected _forceUpdate = false;

    protected readonly _shadowPos = new Vector3();
    protected readonly _shadowCameraTarget = new Vector3();

    public setup(b: RenderGraphBuilder): void {
        const ctx = b.context3D;
        // Sized to the shadow-casting lights each frame (_fit); until one
        // casts, a single texel.
        this.depth2DArrayTexture = new Depth2DTextureArray(1, 1, GPUTextureFormat.depth32float, 1, ctx);
        Reference.getInstance().attached(this.depth2DArrayTexture, this);

        b.write(MAIN_SHADOW_MAP, () => this.depth2DArrayTexture);

        dependOnIfRegistered(b, 'GPUCullPass');
    }

    /** Draws every light's map again next frame. */
    public forceUpdate(): void {
        this._forceUpdate = true;
    }

    /** External API: mark a static-cache layer dirty. */
    public markStaticShadowDirty(shadowIndex: number = -1): void {
        if (shadowIndex < 0) {
            for (let i = 0; i < this._staticDirtyLayers.length; i++) this._staticDirtyLayers[i] = true;
        } else if (shadowIndex < this._staticDirtyLayers.length) {
            this._staticDirtyLayers[shadowIndex] = true;
        }
    }

    public execute(ctx: RenderGraphPassContext): void {
        ShadowLightsCollect.update(ctx.view);
        this._fit(ctx.view);
        this._render(ctx.view, ctx.occlusion);
    }

    /**
     * Sizes the array to the lights: as many layers as their maps and
     * cascades take, at the largest size they ask for (a single texel when
     * none casts). Making it again loses what it held: every map is drawn.
     */
    protected _fit(view: View3D): void {
        const shadow = view.engine3D.setting.shadow;
        const lights = ShadowLightsCollect.getDirectShadowLightWhichScene(view.scene) as DirectLight[];
        let layers = 0;
        let size = 0;
        for (const light of lights) {
            const index = light.lightData.castShadowIndex;
            if (index < 0) continue;
            layers = Math.max(layers, index + (light.enableCSM ? Math.max(1, light.lightData.csmShadowMapNum) : 1));
            size = Math.max(size, light.shadowMapSize || shadow.shadowSize);
        }
        size = layers ? Math.max(16, Math.min(Math.round(size), shadow.maxShadowMapWidth, shadow.maxShadowMapHeight)) : 1;
        layers = Math.max(1, layers);
        const tex = this.depth2DArrayTexture;
        if (tex.width !== size || tex.height !== size || tex.numberLayer !== layers) {
            tex.resize(size, size, layers);
            this._staticDepthTextures.forEach((t) => t.destroy(true));
            this._staticDepthTextures = [];
            this._staticPassStates = [];
            this._staticDirtyLayers = [];
            this._forceUpdate = true;
        }
        for (let i = this._clearStates.length; i < layers; i++) {
            this._clearStates[i] = this._layerState(view.engine3D.context3D, i, 'clear');
            this._loadStates[i] = this._layerState(view.engine3D.context3D, i, 'load');
        }
        shadow.mapSizeInUse = size;
        for (const light of lights) {
            light.shadowMapWidth = size;
            light.shadowMapHeight = size;
        }
    }

    protected _layerState(ctx: Context3D, layer: number, load: GPULoadOp): RendererPassState {
        const rtFrame = new RTFrame([], []);
        rtFrame.depthTexture = new ShadowLayerTarget(this.depth2DArrayTexture, layer) as unknown as RenderTexture;
        rtFrame.label = load === 'clear' ? 'shadowRender' : 'shadowDynamicAppend';
        rtFrame.customSize = true;
        rtFrame.depthCleanValue = 1;
        rtFrame.depthLoadOp = load;
        return WebGPUDescriptorCreator.createRendererPassState(ctx, rtFrame);
    }

    protected _render(view: View3D, occlusion: OcclusionSystem): void {
        const shadowSetting = view.engine3D.setting.shadow;
        this.shadowPassCount = 0;
        this.drawnMaps = 0;
        this.keptMaps = 0;
        if (!shadowSetting.enable) return;

        const camera = view.camera;
        if (!shadowSetting.needUpdate) return;
        // A lower graphics tier draws shadows every other frame or so; a
        // map that must be drawn again (new, resized) still is.
        const offFrame = Time.frame % Math.max(1, shadowSetting.updateFrameRate) !== 0;

        const shadowLightList = ShadowLightsCollect.getDirectShadowLightWhichScene(view.scene);
        for (const light of shadowLightList) {
            const dirLight = light as DirectLight;
            const shadowIndex = dirLight.shadowIndex;
            if (shadowIndex < 0 || !dirLight.castShadow) continue;
            const force = this._forceUpdate || dirLight.needUpdateShadow;
            // Without autoUpdate, maps are drawn only when asked for (needUpdateShadow).
            if ((offFrame || shadowSetting.autoUpdate === false) && !force) continue;
            const mode = dirLight.shadowUpdate;
            const useStaticCache = shadowSetting.enableStaticCache === true && mode !== 'static';

            let cameras: Camera3D[];
            if (dirLight.enableCSM) {
                dirLight.updateShadowCameraCSM(view.camera);
                dirLight.lightData.csmShadowMapIndex = shadowIndex;
                cameras = dirLight.csmShadowCamera.slice(0, Math.max(1, dirLight.cascadeNum));
            } else {
                const extents = camera.getShadowWorldExtents();
                this._poseShadowCamera(dirLight, camera, dirLight.direction, dirLight.shadowCamera, extents, camera.lookTarget);
                cameras = [dirLight.shadowCamera];
            }

            for (let c = 0; c < cameras.length; c++) {
                const shadowCamera = cameras[c];
                const layer = shadowIndex + c;
                (shadowCamera as any)._boundCtx ||= view.engine3D.context3D;
                const lists = this.collectLayered(view, shadowCamera, 'shadow');
                const sig = mode === 'every_frame' ? NaN : this._signature(shadowCamera, lists, mode === 'static');
                if (!force && mode !== 'every_frame' && sig === dirLight._shadowSignatures[c]) {
                    this.keptMaps++;
                    continue;
                }
                dirLight._shadowSignatures[c] = sig;
                this.drawnMaps++;
                preInitPassPipelines(view, this._passType, this._clearStates[layer]);
                if (useStaticCache) {
                    if (force) this._staticDirtyLayers[layer] = true;
                    this._renderLayerSplit(view, shadowCamera, occlusion, layer, lists);
                } else {
                    this._renderShadow(view, shadowCamera, occlusion, this._clearStates[layer], lists, mode === 'static' ? 'static' : 'all');
                }
            }
            dirLight.needUpdateShadow = false;
        }

        this._forceUpdate = false;
    }

    /**
     * What a map shows: its camera, and where each caster in it is (only
     * the static ones for a static light). NaN, never equal, while a caster
     * that changes shape where it stands is in it.
     */
    protected _signature(camera: Camera3D, lists: Lists, onlyStatic: boolean): number {
        let h = hashFloats(HASH_START, camera.pvMatrix.rawData, 16);
        let n = 0;
        for (const list of [lists.opaque, lists.transparent]) {
            for (const node of list) {
                if (!node.castShadow || !node.enable || !node.transform.enable || node.isDestroyed) continue;
                if (onlyStatic) {
                    if (node.shadowCacheMode !== 'static') continue;
                } else if (castsChangingShadow(node)) {
                    return NaN;
                }
                h = hashCaster(h, node);
                n++;
            }
        }
        return Math.imul(h ^ n, 16777619);
    }

    protected _ensureStaticCache(ctx: Context3D, layer: number): void {
        if (this._staticDepthTextures[layer]) return;
        const w = this.depth2DArrayTexture.width;
        const h = this.depth2DArrayTexture.height;
        const staticTex = new VirtualTexture(w, h, GPUTextureFormat.depth32float, false, undefined, 1, 0, 1, ctx);
        staticTex.name = `shadowStaticCache_${layer}`;
        this._staticDepthTextures[layer] = staticTex;
        this._staticDirtyLayers[layer] = true;

        const rtStatic = new RTFrame([], []);
        rtStatic.depthTexture = staticTex;
        rtStatic.label = 'shadowStaticRebuild';
        rtStatic.customSize = true;
        rtStatic.depthCleanValue = 1;
        rtStatic.depthLoadOp = 'clear';
        this._staticPassStates[layer] = WebGPUDescriptorCreator.createRendererPassState(ctx, rtStatic);
    }

    /** Static casters from their cache, then the others on top, into the layer. */
    protected _renderLayerSplit(view: View3D, shadowCamera: Camera3D, occlusion: OcclusionSystem, layer: number, lists: Lists): void {
        this._ensureStaticCache(view.engine3D.context3D, layer);
        if (this._staticDirtyLayers[layer]) {
            this._renderShadow(view, shadowCamera, occlusion, this._staticPassStates[layer], lists, 'static');
            this._staticDirtyLayers[layer] = false;
        }
        const tex = this.depth2DArrayTexture;
        this._copyDepthTexture(view, this._staticDepthTextures[layer], tex, layer, tex.width, tex.height);
        this._renderShadow(view, shadowCamera, occlusion, this._loadStates[layer], lists, 'dynamic');
    }

    protected _renderShadow(view: View3D, shadowCamera: Camera3D, occlusion: OcclusionSystem, state: RendererPassState, layered: Lists, kind: ShadowKind = 'all'): void {
        (shadowCamera as any)._boundCtx ||= view.engine3D.context3D;
        this._activeRendererPassState = state;
        this.shadowPassCount++;
        const gpu = view.engine3D.context3D.gpuContext;
        const command = gpu.beginCommandEncoder();
        const encoder = gpu.beginRenderPass(command, state);

        shadowCamera.transform.updateWorldMatrix();
        if (OcclusionSystem.enable) {
            occlusion.update(shadowCamera, view.scene);
            // Build a transient CollectInfo for the occlusion API; the
            // body of OcclusionSystem.collect is currently a no-op so
            // shape only has to satisfy the type.
            const localInfo = EntityCollect.instance.getRenderNodes(view.scene, shadowCamera);
            occlusion.collect(localInfo, shadowCamera);
        }
        GlobalBindGroup.updateCameraGroup(shadowCamera);
        gpu.bindCamera(encoder, shadowCamera);

        if (kind === 'all') {
            const opBundles = buildOpBundles(view, shadowCamera, this._passType, state, undefined, true);
            const trBundles = buildTrBundles(view, shadowCamera, this._passType, state, undefined, true);
            if (opBundles.length > 0) encoder.executeBundles(opBundles);
            this._drawShadowNodes(view, shadowCamera, encoder, layered.opaque, kind);
            if (trBundles.length > 0) encoder.executeBundles(trBundles);
            this._drawShadowNodes(view, shadowCamera, encoder, layered.transparent, kind);
        } else {
            this._drawShadowNodes(view, shadowCamera, encoder, layered.opaque, kind);
            this._drawShadowNodes(view, shadowCamera, encoder, layered.transparent, kind);
        }

        gpu.endPass(encoder);
        gpu.endCommandEncoder(command);
    }

    protected _drawShadowNodes(view: View3D, shadowCamera: Camera3D, encoder: GPURenderPassEncoder, nodes: RenderNode[], kind: ShadowKind): void {
        if (!nodes) return;
        GlobalBindGroup.updateCameraGroup(shadowCamera);
        view.engine3D.context3D.gpuContext.bindCamera(encoder, shadowCamera);
        const render = view.engine3D.setting.render;
        const max = Math.min(nodes.length, render.drawOpMax);
        for (let i = render.drawOpMin; i < max; ++i) {
            const node = nodes[i];
            if (!node.transform.enable) continue;
            if (!node.enable) continue;
            if (!node.castShadow) continue;
            if (node.isDestroyed) continue;
            // 'auto' defaults to dynamic so untagged renderers keep
            // every-frame behaviour.
            if (kind === 'static') {
                if (node.shadowCacheMode !== 'static') continue;
            } else if (kind === 'dynamic') {
                if (node.shadowCacheMode === 'static') continue;
            }
            if (!node.preInit(this._passType)) {
                node.nodeUpdate(view, this._passType, this._activeRendererPassState!, undefined);
            }
            node.renderPass2(view, this._passType, this._activeRendererPassState!, undefined, encoder);
        }
    }

    protected _copyDepthTexture(view: View3D, src: Texture, dst: Texture, dstIndex: number, w: number, h: number): void {
        const gpu = view.engine3D.context3D.gpuContext;
        const cmd = gpu.beginCommandEncoder();
        cmd.copyTextureToTexture(
            { texture: src.getGPUTexture(), mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
            { texture: dst.getGPUTexture(), mipLevel: 0, origin: { x: 0, y: 0, z: dstIndex } },
            { width: w, height: h, depthOrArrayLayers: 1 },
        );
        gpu.endCommandEncoder(cmd);
    }

    protected _poseShadowCamera(dirLight: DirectLight, viewCamera: Camera3D, direction: Vector3, shadowCamera: Camera3D, _extents: number, _lookAt: Vector3): void {
        if (dirLight.shadowFollow) {
            this._followCamera(dirLight, viewCamera, direction);
        } else {
            this._shadowPos.copy(dirLight.transform.worldPosition);
        }
        this._shadowCameraTarget.copy(direction).normalize(viewCamera.far);
        Vector3.add(this._shadowCameraTarget, this._shadowPos, this._shadowCameraTarget);
        shadowCamera.transform.lookAt(this._shadowPos, this._shadowCameraTarget);
        shadowCamera.orthoOffCenter(shadowCamera.left, shadowCamera.right, shadowCamera.bottom, shadowCamera.top, shadowCamera.near, shadowCamera.far);
    }

    /**
     * Puts the shadow's center (into _shadowPos) a quarter of its width in
     * front of the view camera, snapped to shadow texels in the light's
     * plane so the map's grid does not slide under the scene.
     */
    protected _followCamera(dirLight: DirectLight, viewCamera: Camera3D, direction: Vector3): void {
        const width = Math.max(dirLight.shadowBoundWidth || 1, dirLight.shadowBoundHeight || 1);
        const m = viewCamera.transform.worldMatrix.rawData;
        const center = this._shadowPos;
        center.set(m[12] + m[8] * width * 0.25, m[13] + m[9] * width * 0.25, m[14] + m[10] * width * 0.25);
        const forward = Vector3.HELP_3.copy(direction).normalize();
        const refUp = Math.abs(forward.y) < 0.99 ? Vector3.UP : Vector3.FORWARD;
        const right = Vector3.cross(refUp, forward, Vector3.HELP_4).normalize();
        const up = Vector3.cross(forward, right, Vector3.HELP_5).normalize();
        const texel = width / Math.max(1, dirLight.shadowMapWidth || 1);
        const cx = Math.round(Vector3.dot(center, right) / texel) * texel;
        const cy = Math.round(Vector3.dot(center, up) / texel) * texel;
        const cz = Vector3.dot(center, forward);
        center.set(0, 0, 0);
        Vector3.addScaledVector(center, right, cx, center);
        Vector3.addScaledVector(center, up, cy, center);
        Vector3.addScaledVector(center, forward, cz, center);
    }
}

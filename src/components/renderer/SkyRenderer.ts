
import { View3D } from '../../core/View3D';
import { MeshRenderer } from './MeshRenderer';
import { BoundingBox } from '../../core/bound/BoundingBox';
import { Texture } from '../../gfx/graphics/webGpu/core/texture/Texture';
import { EntityCollect } from '../../gfx/renderJob/collect/EntityCollect';
import { ClusterLightingBuffer } from '../../gfx/renderJob/passRenderer/cluster/ClusterLightingBuffer';
import { RendererMask } from '../../gfx/renderJob/passRenderer/state/RendererMask';
import { RendererPassState } from '../../gfx/renderJob/passRenderer/state/RendererPassState';
import { PassType } from '../../gfx/renderJob/passRenderer/state/PassType';
import { SkyMaterial } from '../../materials/SkyMaterial';
import { Vector3 } from '../../math/Vector3';
import { SphereGeometry } from '../../shape/SphereGeometry';
import { Object3D } from '../../core/entities/Object3D';
import { SphereReflection } from './SphereReflection';
import { CameraType } from '../../core/CameraType';
import { bindCtx } from '../../gfx/graphics/webGpu/Context3D';

/**
 *
 * Sky Box Renderer Component
 * @group Components
 */
export class SkyRenderer extends MeshRenderer {
    /**
     * The material used in the Sky Box.
     */
    public skyMaterial: SkyMaterial;
    /**
     * The sky reflections see when it is not the one drawn behind the
     * scene: volumetric clouds make the scene's environment map the sky
     * with the clouds in it, while the sky behind the scene stays clear
     * (they are drawn over it). Scene captures (mirrors) draw it; null
     * draws `map`.
     */
    public reflectedMap: Texture | null = null;
    /** What draws `reflectedMap`. */
    private _reflected: SkyMaterial | null = null;

    public init(): void {
        super.init();
        this.castShadow = false;
        this.castGI = true;
        this.addRendererMask(RendererMask.Sky);
        this.alwaysRender = true;

        this.object3D.bound = new BoundingBox(Vector3.ZERO.clone(), Vector3.MAX);
        this.skyMaterial ||= new SkyMaterial();
    }

    public onEnable(): void {
        if (!this.geometry) {
            const defaultFar = this.transform.view3D?.engine3D?.setting.sky.defaultFar ?? 5000;
            this.geometry = new SphereGeometry(defaultFar, 20, 20);
        }
        if (!this._readyPipeline) {
            this.initPipeline();
        } else {
            this.castNeedPass();

            if (!this._inRenderer && this.transform.scene3D) {
                EntityCollect.instance.setSky(this.transform.scene3D, this);
                this._inRenderer = true;
            }
        }
    }

    public onDisable(): void {
        if (this._inRenderer && this.transform.scene3D) {
            this._inRenderer = false;
            EntityCollect.instance.setSky(this.transform.scene3D, null);
        }
        super.onDisable();
    }

    public nodeUpdate(view: View3D, passType: PassType, renderPassState: RendererPassState, clusterLightingBuffer?: ClusterLightingBuffer) {
        super.nodeUpdate(view, passType, renderPassState, clusterLightingBuffer);
        const { type, aspect, near, far } = view.camera;
        this.skyMaterial.fixOrthProj(type == CameraType.ortho, aspect, near, far);
    }

    public renderPass2(view: View3D, passType: PassType, rendererPassState: RendererPassState, clusterLightingBuffer: ClusterLightingBuffer, encoder: GPURenderPassEncoder, useBundle: boolean = false) {
        // this.transform.updateWorldMatrix();
        super.renderPass2(view, passType, rendererPassState, clusterLightingBuffer, encoder, useBundle);
        // this.transform.localPosition = Camera3D.mainCamera.transform.localPosition ;
    }

    /**
     * Draws the sky as reflections see it: `reflectedMap` where there is
     * one, with the sky's exposure and roughness, else the sky itself.
     * Scene captures draw the sky with this.
     */
    public renderReflected(view: View3D, passType: PassType, rendererPassState: RendererPassState, clusterLightingBuffer: ClusterLightingBuffer, encoder: GPURenderPassEncoder) {
        const map = this.reflectedMap;
        if (!map) {
            if (!this.preInit(passType)) this.nodeUpdate(view, passType, rendererPassState, clusterLightingBuffer);
            this.renderPass2(view, passType, rendererPassState, clusterLightingBuffer, encoder);
            return;
        }
        const geometry = this._geometry;
        if (!this.enable || !geometry?.subGeometries) return;
        const mat = (this._reflected ??= new SkyMaterial());
        if (mat.baseMap !== map) mat.baseMap = map;
        if (mat.exposure !== this.skyMaterial.exposure) mat.exposure = this.skyMaterial.exposure;
        if (mat.roughness !== this.skyMaterial.roughness) mat.roughness = this.skyMaterial.roughness;
        const camera = rendererPassState.camera3D ?? view.camera;
        mat.fixOrthProj(camera.type == CameraType.ortho, camera.aspect, camera.near, camera.far);
        const ctx = view.engine3D.context3D;
        const pass = mat.getPass(passType)?.[0];
        if (!pass) return;
        if (!pass.shaderReflection) {
            bindCtx(pass, ctx);
            pass.preCompile(geometry);
            geometry.generate(pass.shaderReflection);
        }
        pass.apply(ctx, geometry, rendererPassState);
        if (!pass.pipeline) return;
        const gpu = ctx.gpuContext;
        gpu.bindGeometryBuffer(encoder, geometry);
        gpu.bindPipeline(encoder, pass);
        const lod = geometry.subGeometries[0].lodLevels[0];
        gpu.drawIndexed(encoder, lod.indexCount, 1, lod.indexStart, 0, this.object3D.transform._worldMatrix.index);
    }

    public beforeDestroy(force?: boolean) {
        // Not forced: the map it draws belongs to whoever made it (the clouds).
        this._reflected?.destroy(false);
        this._reflected = null;
        super.beforeDestroy(force);
    }

    /**
     * set environment texture
     */
    public set map(texture: Texture) {
        this.skyMaterial.baseMap = texture;
        if (this.skyMaterial.name == null) {
            this.skyMaterial.name = 'skyMaterial';
        }
        this.material = this.skyMaterial;
        // this.useSkyReflection();
    }

    /**
     * get environment texture
     */
    public get map(): Texture {
        return this.skyMaterial.baseMap;
    }

    public get exposure() {
        return this.skyMaterial.exposure;
    }

    public set exposure(value) {
        if (this.skyMaterial)
            this.skyMaterial.exposure = value;
    }

    public get roughness() {
        return this.skyMaterial.roughness;
    }

    public set roughness(value) {
        if (this.skyMaterial)
            this.skyMaterial.roughness = value;
    }

    public useSkyReflection() {
        let reflection = new Object3D();
        let ref = reflection.addComponent(SphereReflection);
        ref.autoUpdate = false;
        reflection.x = 0;
        reflection.y = 300;
        reflection.z = 0;
        this.object3D.addChild(reflection);
    }

}

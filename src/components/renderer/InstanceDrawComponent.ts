import { RTResourceMap } from "../../gfx/renderJob/frame/RTResourceMap";
import { RenderContext } from "../../gfx/renderJob/passRenderer/RenderContext";
import { MeshRenderer } from "./MeshRenderer";
import { RenderNode } from "./RenderNode";
import { StorageGPUBuffer } from "../../gfx/graphics/webGpu/core/buffer/StorageGPUBuffer";
import { View3D } from "../../core/View3D";
import { RendererPassState } from "../../gfx/renderJob/passRenderer/state/RendererPassState";
import { PassType } from "../../gfx/renderJob/passRenderer/state/PassType";
import { ClusterLightingBuffer } from "../../gfx/renderJob/passRenderer/cluster/ClusterLightingBuffer";
import { ComponentCollect } from "../../gfx/renderJob/collect/ComponentCollect";
import { RendererMask } from "../../gfx/renderJob/passRenderer/state/RendererMask";
import { Material } from "../../materials/Material";
import { RenderShaderPass } from "../../gfx/graphics/webGpu/shader/RenderShaderPass";

/**
 * Batches child {@link MeshRenderer}s that share the same geometry and
 * materials into GPU instanced draw calls. On start it groups the renderers
 * by a geometry+material key, uploads their world-matrix indices into a
 * storage buffer, and issues one instanced draw per group. The grouped
 * renderers are disabled; each instance keeps its own transform, so
 * moving them needs no regrouping.
 *
 * Grouping happens once, on start: after renderers are added, removed or
 * get other geometry or materials, call {@link rebuild} (with the list to
 * draw, or without to take the children again). Skinned and morphing
 * meshes are never grouped: they bind per-renderer state.
 *
 * The materials it draws are compiled for instanced drawing
 * (USE_INSTANCEDRAW) and stay so, reading its instance buffer: they must
 * not be shared with renderers drawn on their own, now or after it is
 * gone. Groups of different shapes may share them.
 * @group Components
 */
export class InstanceDrawComponent extends RenderNode {

    private _keyRenderGroup: Map<string, MeshRenderer[]>;
    /** Where each group's matrix indices start in the instance buffer. */
    private _keyOffsetGroup: Map<string, number>;
    /**
     * The matrix indices of all groups, one after another: every pass it
     * draws with binds this one buffer, and each group draws from its offset.
     */
    private _instanceBuffer: StorageGPUBuffer | null = null;
    /** How many indices the instance buffer holds. */
    private _capacity: number = 0;
    /** The materials it draws: the passes bound to the instance buffer are among theirs. */
    private _drawnMaterials: Set<Material> = new Set<Material>();

    /** Group the child renderers on start. Off when the owner hands the renderers to {@link rebuild} itself. */
    public autoGroup: boolean = true;

    /** Its instances are bound into its passes. */
    protected get hasPerNodeShaderState(): boolean {
        return true;
    }

    constructor() {
        super();
    }

    /** Initialize the internal grouping maps. */
    public init(param?: any): void {
        this._keyRenderGroup = new Map<string, MeshRenderer[]>();
        this._keyOffsetGroup = new Map<string, number>();
    }

    /** Group the child mesh renderers. */
    public start(): void {
        if (this.autoGroup) this.rebuild();
    }

    /** The renderers it draws now. */
    public get renderers(): MeshRenderer[] {
        const out: MeshRenderer[] = [];
        this._keyRenderGroup?.forEach((v) => out.push(...v));
        return out;
    }

    /** Draw calls it makes per pass: one per group of equal geometry, materials and shadow casting. */
    public get groupCount(): number {
        return this._keyRenderGroup?.size ?? 0;
    }

    /** Whether a renderer can be drawn instanced: not skinned, not morphing, with geometry and materials. */
    public static canInstance(mr: MeshRenderer): boolean {
        return !!mr.geometry && mr.materials.length > 0
            && !mr.hasMask(RendererMask.SkinnedMesh) && !mr.hasMask(RendererMask.MorphTarget)
            && !mr.morphData?.enable;
    }

    /**
     * Group `renderers` (by default every mesh renderer under this object),
     * by geometry, materials and whether they cast shadows, and disable
     * them: this component draws them. Renderers it drew before and not
     * now are left disabled; enable them again as they should be.
     */
    public rebuild(renderers?: MeshRenderer[]): void {
        if (!this._keyRenderGroup) this.init();
        this._keyRenderGroup.clear();
        this._keyOffsetGroup.clear();
        let meshRenders: MeshRenderer[] = renderers ?? [];
        if (!renderers) this.object3D.getComponents(MeshRenderer, meshRenders, true);

        const materials = new Set<Material>();
        for (let i = 0; i < meshRenders.length; i++) {
            const mr = meshRenders[i];
            if (!InstanceDrawComponent.canInstance(mr)) continue;
            mr.transform.updateWorldMatrix(true);
            mr.enable = false;

            let key = mr.geometry.instanceID;
            for (let j = 0; j < mr.materials.length; j++) {
                const mat = mr.materials[j];
                key += `|${mat.instanceID}`;
                materials.add(mat);
            }
            key += mr.castShadow ? '|shadow' : '';

            if (!this._keyRenderGroup.has(key)) {
                this._keyRenderGroup.set(key, [mr]);
            } else {
                this._keyRenderGroup.get(key).push(mr);
            }
        }

        this._drawnMaterials = materials;

        const ids: number[] = [];
        this._keyRenderGroup.forEach((v, k) => {
            this._keyOffsetGroup.set(k, ids.length);
            for (const mr of v) ids.push(mr.transform.worldMatrix.index);
        });
        this.writeInstances(ids);
    }

    /** Clear the current grouping and rebuild it from the child renderers. */
    public reset() {
        this.rebuild();
    }

    /**
     * Write the matrix indices into the instance buffer. Passes keep the
     * buffer they were built with, so it is only replaced (by a larger one)
     * when they do not fit, and the passes bound to it are built again.
     */
    private writeInstances(ids: number[]) {
        if (!this._instanceBuffer || ids.length > this._capacity) {
            const old = this._instanceBuffer;
            this._capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(ids.length, 1))));
            this._instanceBuffer = new StorageGPUBuffer(this._capacity);
            this._instanceBuffer.visibility = GPUShaderStage.VERTEX;
            this._instanceBuffer.setInt32Array("matrixIDs", new Int32Array(this._capacity));
            if (old) {
                this._drawnMaterials.forEach((mat) => mat.shader?.passShader.forEach((passes) => passes.forEach((pass) => {
                    if (pass.getStorageBuffer(`instanceDrawID`) !== old) return;
                    pass.setStorageBuffer(`instanceDrawID`, this._instanceBuffer);
                    InstanceDrawComponent.rebind(pass);
                })));
                old.destroy();
            }
        }
        this._instanceBuffer.setInt32Array("matrixIDs", new Int32Array(ids));
        this._instanceBuffer.apply();
    }

    /** Per-pass update: builds the pipelines of each group's passes (see {@link bindInstances}). */
    public nodeUpdate(view: View3D, passType: PassType, renderPassState: RendererPassState, clusterLightingBuffer?: ClusterLightingBuffer): void {
        this._keyRenderGroup.forEach((v, k) => this.bindInstances(view, passType, renderPassState, clusterLightingBuffer, k));
    }

    /**
     * Enables the USE_INSTANCEDRAW define and binds the instance buffer on
     * a group's material passes, then updates them through the group's
     * representative renderer.
     */
    private bindInstances(view: View3D, passType: PassType, renderPassState: RendererPassState, clusterLightingBuffer: ClusterLightingBuffer | undefined, key: string) {
        const renderNode = this._keyRenderGroup.get(key)[0];
        for (let i = 0; i < renderNode.materials.length; i++) {
            let passes = renderNode.materials[i].getPass(passType);
            if (!passes) continue;
            for (let j = 0; j < passes.length; j++) {
                const pass = passes[j];
                const bound = pass.getStorageBuffer(`instanceDrawID`);
                if (pass.defineValue[`USE_INSTANCEDRAW`] === true && bound === this._instanceBuffer) continue;
                pass.setDefine("USE_INSTANCEDRAW", true);
                pass.setStorageBuffer(`instanceDrawID`, this._instanceBuffer);
                InstanceDrawComponent.rebind(pass);
            }
        }
        renderNode.nodeUpdate(view, passType, renderPassState, clusterLightingBuffer);
    }

    /**
     * Has a built pass build its bind groups again on its next update: they
     * hold the buffers (and layout) they were made with.
     */
    private static rebind(pass: RenderShaderPass) {
        if (!pass.pipeline) return;
        pass.bindGroups.length = 0;
        pass.noticeValueChange();
    }


    /**
     * Encoder-direct instanced draw for the modern frame-graph pipeline.
     *
     * `drawNodesEncoder` (the main ColorPass draw path) calls `renderPass2`,
     * not the legacy `renderPass`. The base `RenderNode.renderPass2`
     * early-returns on `!_geometry`, and this component owns no geometry of
     * its own — so without this override the whole group is invisible (its
     * child MeshRenderers are disabled). Here we issue one instanced draw
     * per geometry+material group using the group's representative node,
     * writing straight to the pass encoder. The passes were updated by
     * {@link nodeUpdate}, which every pass runs before this.
     */
    public renderPass2(view: View3D, passType: PassType, rendererPassState: RendererPassState, clusterLightingBuffer: ClusterLightingBuffer, encoder: GPURenderPassEncoder, useBundle: boolean = false) {
        if (!this.enable)
            return;

        const gpu = view.engine3D.context3D.gpuContext;
        this._keyRenderGroup.forEach((v, k) => {
            let renderNode = v[0];
            // Groups are split by shadow casting, so one renderer speaks for its group.
            if (passType == PassType.SHADOW && !renderNode.castShadow)
                return;

            let geometry = renderNode.geometry;
            let subGeometries = geometry?.subGeometries;
            // A destroyed geometry has no sub-meshes left to draw.
            if (!subGeometries) return;
            const offset = this._keyOffsetGroup.get(k);
            // Iterate by max(materials, subGeometries) to mirror the base
            // renderPass2 — single-material meshes with multiple subGeometries
            // still draw every sub-mesh.
            const nCount = Math.max(renderNode.materials.length, subGeometries.length);
            for (let i = 0; i < nCount; i++) {
                const material = i >= renderNode.materials.length ? renderNode.materials[0] : renderNode.materials[i];
                if (!material.castShadow && passType == PassType.SHADOW)
                    continue;

                let passes = material.getPass(passType);
                if (!passes || passes.length == 0)
                    continue;

                gpu.bindGeometryBuffer(encoder, geometry);
                for (let j = 0; j < passes.length; j++) {
                    const renderShader = passes[j];
                    if (!renderShader.pipeline)
                        continue;
                    gpu.bindPipeline(encoder, renderShader);
                    const subGeometry = i >= subGeometries.length ? subGeometries[0] : subGeometries[i];
                    // A level the shape does not have (it could not be simplified) draws its own triangles.
                    let lodInfo = subGeometry.lodLevels[renderNode.lodLevel] ?? subGeometry.lodLevels[0];
                    // @builtin(instance_index) runs from firstInstance, the
                    // group's offset into instanceDrawID.matrixIDs.
                    gpu.drawIndexed(encoder, lodInfo.indexCount, v.length, lodInfo.indexStart, 0, offset);
                }
            }
        })
    }


    /** Issue one instanced draw per group, with instance count = group size. */
    public renderPass(view: View3D, passType: PassType, renderContext: RenderContext) {
        this._keyRenderGroup.forEach((v, k) => {
            if (passType == PassType.SHADOW && !v[0].castShadow) return;
            this.bindInstances(view, passType, renderContext.rendererPassState, undefined, k);
            this.renderItem(view, passType, v[0], renderContext, v.length, this._keyOffsetGroup.get(k));
        })
    }

    /**
     * Bind geometry/pipeline and emit the indexed draw of `count` instances,
     * reading matrix indices from `offset` on, for a group's representative
     * render node (its own instance count is left alone: it may be drawn on
     * its own again later).
     */
    public renderItem(view: View3D, passType: PassType, renderNode: RenderNode, renderContext: RenderContext, count: number = 1, offset: number = 0) {
        const gpu = view.engine3D.context3D.gpuContext;
        const subGeometries = renderNode.geometry?.subGeometries;
        if (!subGeometries) return;
        const nCount = Math.max(renderNode.materials.length, subGeometries.length);

        for (let i = 0; i < nCount; i++) {
            const material = i >= renderNode.materials.length ? renderNode.materials[0] : renderNode.materials[i];
            let passes = material.getPass(passType);

            if (!passes || passes.length == 0)
                continue;

            for (let j = 0; j < passes.length; j++) {
                let matPass = passes[j];
                if (!matPass.pipeline)
                    continue;

                gpu.bindGeometryBuffer(renderContext.encoder, renderNode.geometry);
                const renderShader = matPass;
                if (renderShader.shaderState.splitTexture) {
                    renderContext.endRenderPass();
                    RTResourceMap.WriteSplitColorTexture(view.engine3D.context3D, renderNode.instanceID);
                    renderContext.beginOpaqueRenderPass();

                    gpu.bindCamera(renderContext.encoder, view.camera);
                    gpu.bindGeometryBuffer(renderContext.encoder, renderNode.geometry);
                }
                gpu.bindPipeline(renderContext.encoder, renderShader);

                const subGeometry = i >= subGeometries.length ? subGeometries[0] : subGeometries[i];
                let lodInfo = subGeometry.lodLevels[renderNode.lodLevel] ?? subGeometry.lodLevels[0];
                gpu.drawIndexed(renderContext.encoder, lodInfo.indexCount, count, lodInfo.indexStart, 0, offset);
            }
        }
    }

    /** Release the grouping and the instance buffer and unregister from pending-start collection. */
    public beforeDestroy(force?: boolean): void {
        this._drawnMaterials.clear();
        this._instanceBuffer?.destroy();
        this._instanceBuffer = null;
        this._capacity = 0;
        //@ts-ignore
        this._keyRenderGroup = this._keyOffsetGroup = undefined;
        ComponentCollect.removeWaitStart(this.object3D, this);
    }
}

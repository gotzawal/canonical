import { View3D } from '../../../../core/View3D';
import { RenderTexture } from '../../../../textures/RenderTexture';
import { EntityCollect } from '../../collect/EntityCollect';
import { GPUTextureFormat } from '../../../graphics/webGpu/WebGPUConst';
import { RTResourceMap } from '../../frame/RTResourceMap';
import { RenderGraphBuilder, RenderGraphPass, RenderGraphPassContext } from '../RenderGraphPass';
import { SCENE_COLOR_PYRAMID } from './SceneColorPyramidPass';
import { TRANSPARENT_DRAW_CTX, TransparentDrawContext } from './_transparentDraw';

/**
 * Published handle (and RTResourceMap name) of the scene depth snapshot:
 * the main depth buffer as it is once the opaque world and the sky are
 * drawn, before materials that read the scene (Material.readsScene) and
 * transparent ones draw. Those sample it as `texture_depth_2d`; the depth
 * attachment itself cannot be sampled while those passes render into it.
 *
 * @group Graph
 */
export const SCENE_DEPTH_COPY = '_SceneDepthCopy';

/**
 * Copies the main depth buffer into {@link SCENE_DEPTH_COPY} right after
 * {@link SceneColorPyramidPass} takes the scene color, so the two match.
 *
 * Needs a single-sampled depth32float depth buffer: the z-prepass's
 * (`setting.render.zPrePass`, on by default). With MSAA or a
 * depth+stencil buffer it skips the copy (once warned) and readers see
 * the far plane.
 *
 * It costs nothing while no material that reads the scene is drawn: the
 * copy is skipped, and its texture is made the first time one is.
 *
 * @group Graph
 */
export class SceneDepthCopyPass extends RenderGraphPass {
    public readonly name = 'SceneDepthCopyPass';

    protected _copy: RenderTexture | null = null;
    protected _warned = false;

    public setup(b: RenderGraphBuilder): void {
        // After the opaque world and the sky: the pyramid is taken from them.
        b.read(SCENE_COLOR_PYRAMID);
        b.read(TRANSPARENT_DRAW_CTX);
        // Made once a reader is drawn (see execute); kept from then on.
        this._copy = RTResourceMap.getTexture(b.context3D, SCENE_DEPTH_COPY) ?? null;
        b.write(SCENE_DEPTH_COPY, () => this._copy);
    }

    public execute(ctx: RenderGraphPassContext): void {
        const state = ctx.get<TransparentDrawContext>(TRANSPARENT_DRAW_CTX);
        const ps = state?.rendererPassState;
        const src = ps?.zPreTexture ?? ps?.depthTexture;
        if (!src || !this._readersDrawn(ctx.view)) return;
        if (!this._copy) {
            // Named and sized like the prepass depth (PreDepthPass), so the
            // registry resizes it with the canvas the same way.
            const c3d = ctx.view.engine3D.context3D;
            const [w, h] = c3d.presentationSize;
            this._copy = RTResourceMap.createRTTexture(c3d, SCENE_DEPTH_COPY, Math.floor(w), Math.floor(h), GPUTextureFormat.depth32float, false);
        }
        const dst = this._copy;
        if (src.format !== GPUTextureFormat.depth32float || src.sampleCount > 1) {
            if (!this._warned) {
                this._warned = true;
                console.warn(`[SceneDepthCopyPass] the depth buffer (${src.format}, ${src.sampleCount} samples) cannot be copied: materials reading the scene depth see the far plane. Keep zPrePass on and MSAA off.`);
            }
            return;
        }
        // Mid-resize the two can differ for a frame.
        if (src.width !== dst.width || src.height !== dst.height) return;
        const gpu = ctx.view.engine3D.context3D.gpuContext;
        const command = gpu.beginCommandEncoder();
        command.copyTextureToTexture(
            { texture: src.getGPUTexture() },
            { texture: dst.getGPUTexture() },
            { width: src.width, height: src.height, depthOrArrayLayers: 1 },
        );
        gpu.endCommandEncoder(command);
    }

    /** Whether a shown renderer's material reads the scene (one look per shader: renderers of a shader share it). */
    protected _readersDrawn(view: View3D): boolean {
        const collect = EntityCollect.instance.getRenderShaderCollect(view);
        if (!collect) return false;
        for (const [, nodes] of collect) {
            for (const [, node] of nodes) {
                if (node.isDestroyed || !node.enable || !node.transform?.enable) continue;
                if ((node.materials?.[0] as { readsScene?: boolean } | undefined)?.readsScene) return true;
                break;
            }
        }
        return false;
    }
}

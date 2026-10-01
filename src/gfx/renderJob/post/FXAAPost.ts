import { ShaderLib } from '../../../assets/shader/ShaderLib';
import { Engine3D } from '../../../Engine3D';
import { Vector2 } from '../../../math/Vector2';
import { GPUTextureFormat } from '../../graphics/webGpu/WebGPUConst';
import { PostBase } from './PostBase';
import { View3D } from '../../../core/View3D';
import { FXAAShader } from '../../../assets/shader/post/FXAAShader';
import { ViewQuad } from '../../../core/ViewQuad';
import { RenderTexture } from '../../../textures/RenderTexture';
/**
 * FXAA(fast approximate antialiasing)
 * A deformation anti-aliasing method that pays more attention to performance. 
 * It only needs one pass to get the result. FXAA focuses on fast visual anti-aliasing effect, 
 * rather than pursuing perfect real anti-aliasing effect.
 * @group Post Effects
 */
export class FXAAPost extends PostBase {
    postQuad: ViewQuad;

    renderTexture: RenderTexture;
    constructor() {
        super();
        ShaderLib.register("FXAA_Shader", FXAAShader);
    }

    protected createResource(view: View3D) {
        let [w, h] = this._boundCtx!.presentationSize;
        this.renderTexture = this.createRTTexture(`FXAAPost`, w, h, GPUTextureFormat.rgba16float);
        this.postQuad = this.createViewQuad(`fxaa`, 'FXAA_Shader', this.renderTexture);
        this.postQuad.quadShader.setUniform("u_texel", new Vector2(1.0 / w, 1.0 / h));
        this.span = this.setting.render.postProcessing.fxaa.span ?? 4;
        this.postQuad.quadShader.setUniform("u_strength", this.span);
    }

    /** The edge span the shader was given last. */
    private span = 4;

    public onResize() {
        let [w, h] = this._boundCtx!.presentationSize;
        this.renderTexture.resize(w, h);
        // The edge search steps one pixel: its size changes with the view.
        this.postQuad?.quadShader.setUniform("u_texel", new Vector2(1.0 / w, 1.0 / h));
    }

    /**
     * @internal
     */
    onAttach(view: View3D,) {
        this.setting.render.postProcessing.fxaa.enable = true;
    }

    /**
     * @internal
     */
    onDetach(view: View3D,) {
        this.setting.render.postProcessing.fxaa.enable = false;
    }

    public render(view: View3D, command: GPUCommandEncoder) {
        this.compute(view);
        const span = this.setting.render.postProcessing.fxaa.span ?? 4;
        if (this.postQuad && span !== this.span) {
            this.span = span;
            this.postQuad.quadShader.setUniform("u_strength", span);
        }
        this.rtViewQuad.forEach((viewQuad, k) => {
            let lastTexture = this._boundCtx!.gpuContext.lastRenderPassState.getLastRenderTexture(this._boundCtx!);
            viewQuad.renderToViewQuad(view, viewQuad, command, lastTexture);
        });
    }
}

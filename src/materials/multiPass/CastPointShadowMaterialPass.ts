import { GPUCullMode } from "../../gfx/graphics/webGpu/WebGPUConst";
import { RenderShaderPass } from "../../gfx/graphics/webGpu/shader/RenderShaderPass";
import { PassType } from "../../gfx/renderJob/passRenderer/state/PassType";
import { Vector3 } from "../../math/Vector3";

/**
 * @internal
 * CastPointShadowMaterialPass
 */
export class CastPointShadowMaterialPass extends RenderShaderPass {
    constructor() {
        super(`castPointShadowMap_vert`, `shadowCastMap_frag`);
        this.passType = PassType.POINT_SHADOW;
        this.setShaderEntry("main", "main");
        this.setUniformFloat("cameraFar", 5000);
        this.setUniformVector3("lightWorldPos", Vector3.ZERO);
        this.shaderState.receiveEnv = false;
        this.shaderState.castShadow = false;
        this.shaderState.acceptShadow = false;

        // The faces toward the light are stored (PassGenerate gives the
        // pass its color pass's culling), as the directional cast does. The
        // receiver bias in PointShadow_frag covers acne; rasterizer slope
        // bias is kept tiny as a grazing-angle safety net.
        this.shaderState.cullMode = GPUCullMode.back;
        this.shaderState.depthBias = 0;
        this.shaderState.depthBiasSlopeScale = 0.5;
        this.shaderState.depthBiasClamp = 0;

        // As the directional cast: cut-outs only where the color pass cuts.
        this.setDefine(`USE_ALPHACUT`, false);
        this.setUniformFloat(`alphaCutoff`, 0.5);
    }
}

export function getLightData(maxCascades: number): string {
    return /*wgsl*/ `
    struct LightData {
        index:f32,
        lightType:i32,
        radius:f32,
        linear:f32,
        
        position:vec3<f32>,
        lightMatrixIndex:f32,

        direction:vec3<f32>,
        quadratic:f32,

        lightColor:vec3<f32>,
        intensity:f32,

        innerCutOff :f32,
        outerCutOff:f32,
        range :f32,
        castShadow:i32,

        lightTangent:vec3<f32>,
        ies:f32,

        csmShadowMapNum: f32,
        csmShadowMapIndex: f32,
        shadowFar: f32,
        softness: f32,

        shadowBias: array<f32, ${maxCascades}>,
        normalBias: array<f32, ${maxCascades}>,

        // Point and spot lights: each face's place in the shadow atlas, as
        // atlas uv (x, y) per face, two faces a vec4 (+X -X, +Y -Y, +Z -Z);
        // x < 0 for a face without one.
        shadowTiles: array<vec4<f32>, 3>,
        // A face's size in atlas uv, and one atlas texel in uv.
        shadowTileScale: vec2<f32>,
        shadowAtlasTexel: vec2<f32>,
    };
`
}

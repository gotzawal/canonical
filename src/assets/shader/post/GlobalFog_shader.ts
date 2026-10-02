/**
 * @internal
 */
export let GlobalFog_shader = /* wgsl */ `
    var<private> PI: f32 = 3.14159265359;
    #include "GlobalUniform"
    #include "GBufferStand" 
    
    #include "LightData"

    struct FogUniformData {
        fogColor : vec4<f32>,
        
        fogType : f32 ,
        fogHeightScale : f32 , 
        start: f32,
        end: f32,

        density : f32 ,
        ins : f32 ,
        falloff : f32 ,
        rayLength : f32 ,

        scatteringExponent : f32 ,
        dirHeightLine : f32 ,
        skyFactor: f32,
        skyRoughness: f32,

        overrideSkyFactor: f32,
        isSkyHDR: f32,
        // Height fog: the height where the fog is 'density' thick.
        slot0: f32,
        // Aerial perspective: the air's extinction per meter at height 0.
        slot1: f32,
    };


    @group(0) @binding(2) var<uniform> fogUniform: FogUniformData;
    @group(0) @binding(3) var<storage,read> lightBuffer: array<LightData>;
    @group(0) @binding(4) var inTex: texture_2d<f32>;
    @group(0) @binding(5) var prefilterMap: texture_cube<f32>;
    @group(0) @binding(6) var prefilterMapSampler: sampler;
    @group(0) @binding(7) var outTex : texture_storage_2d<rgba16float, write>;

    var<private> texSize: vec2<u32>;
    var<private> fragCoord: vec2<i32>;
    var<private> fragUV: vec2<f32>;

    var<private> texPosition: vec4<f32>;
    var<private> texNormal: vec4<f32>;
    var<private> texColor: vec4<f32>;

    fn getGroundWithSkyColor(worldPosition:vec3<f32>, skyRoughness:f32, isHDRTexture:bool) -> vec3<f32>
    {
        let rayDirection = normalize(vec3<f32>(worldPosition.xyz - globalUniform.CameraPos.xyz));
        let calcRoughness = clamp(skyRoughness, 0.0, 1.0);
        let MAX_REFLECTION_LOD  = f32(textureNumLevels(prefilterMap)) ;
        let prefilterColor = textureSampleLevel(prefilterMap, prefilterMapSampler, rayDirection, calcRoughness * MAX_REFLECTION_LOD);
        // prefilterMap stores linear HDR; keep linear so the fog
        // composite stays in linear space for the swapchain encode.
        return prefilterColor.xyz * globalUniform.skyExposure;
    }

    fn getSkyBluredColor(skyRoughness:f32, isHDRTexture:bool) -> vec3<f32>
    {
        var worldPosition = vec4f(getSkyPositionFromGBuffer(fragUV), 1.0);
        let rayDirection = normalize(vec3<f32>(worldPosition.xyz - globalUniform.CameraPos.xyz));
        let calcRoughness = clamp(skyRoughness, 0.0, 1.0);
        let MAX_REFLECTION_LOD  = f32(textureNumLevels(prefilterMap)) ;
        let prefilterColor = textureSampleLevel(prefilterMap, prefilterMapSampler, rayDirection, calcRoughness * MAX_REFLECTION_LOD);
        return prefilterColor.xyz * globalUniform.skyExposure;
    }

    @compute @workgroup_size( 8 , 8 , 1 )
    fn CsMain( @builtin(workgroup_id) workgroup_id : vec3<u32> , @builtin(global_invocation_id) globalInvocation_id : vec3<u32>)
    {
        fragCoord = vec2<i32>( globalInvocation_id.xy );
        texSize = textureDimensions(inTex).xy;
        if(fragCoord.x >= i32(texSize.x) || fragCoord.y >= i32(texSize.y)){
            return;
        }

        fragUV = vec2<f32>(fragCoord) / vec2<f32>(texSize - 1);

        var gBuffer = getGBuffer( fragCoord ) ;
        texNormal = vec4f(getWorldNormalFromGBuffer(gBuffer),1.0); 
        texPosition =  vec4f(getWorldPositionFromGBuffer(gBuffer,fragUV), 1.0);
        texColor = textureLoad(inTex, fragCoord, 0);
    
        var opColor = vec3<f32>(0.0);
        if(getRoughnessFromGBuffer(gBuffer) <= 0.0){
            //for sky
            if(fogUniform.overrideSkyFactor > 0.01){
                opColor = blendSkyColor();
            }else{
                opColor = texColor.xyz;
            }
        }else{
            //for ground
            let fogFactor = calcFogFactor();
            opColor = mix(aerialPerspective(texColor.rgb), fogUniform.fogColor.xyz, fogFactor);
            // The sun lights the fog it shines through: as much as there is fog.
            let sun = sunLight();
            opColor += inScatterIng(sun.direction, texPosition.xyz, sun.lightColor) * fogFactor;
        }

        textureStore(outTex, fragCoord , vec4<f32>(opColor.xyz, texColor.a));
    }

    // Distant ground seen through the air: it fades into the sky's color
    // toward the horizon in its direction (a blurred look at the sky), by
    // the air along the view, which thins with height (8 km scale).
    fn aerialPerspective(color: vec3<f32>) -> vec3<f32>
    {
        if (fogUniform.slot1 <= 0.0) {
            return color;
        }
        let cam = globalUniform.CameraPos.xyz;
        let toPoint = texPosition.xyz - cam;
        let dist = length(toPoint);
        let dir = toPoint / max(dist, 0.0001);
        let midHeight = max((cam.y + texPosition.y) * 0.5, 0.0);
        let air = 1.0 - exp(-fogUniform.slot1 * exp(-midHeight / 8000.0) * dist);
        let lod = f32(textureNumLevels(prefilterMap)) * 0.6;
        let horizon = normalize(vec3<f32>(dir.x, max(dir.y, 0.04), dir.z));
        let sky = textureSampleLevel(prefilterMap, prefilterMapSampler, horizon, lod).xyz * globalUniform.skyExposure;
        return mix(color, sky, air);
    }

    // The first directional light that casts shadows (the sun), else the first light.
    fn sunLight() -> LightData
    {
        if (globalUniform.nDirShadowEnd > globalUniform.nDirShadowStart) {
            let i = u32(globalUniform.nDirShadowStart);
            return lightBuffer[u32(globalUniform.shadowLights[i / 4u][i % 4u])];
        }
        return lightBuffer[0];
    }

    fn calcFogFactor() -> f32 
    {
        var cameraPos = globalUniform.cameraWorldMatrix[3].xyz  ;
        let dis = distance(cameraPos, texPosition.xyz);
        var fog = computeFog(dis);
        // The legacy height term, only with a ray length.
        if (fogUniform.rayLength > 0.0) {
            fog += cFog(-texPosition.y);
        }
        return clamp(fogUniform.ins * fog, 0.0, 1.0);
    }

        
    fn blendGroundColor(fogFactor:f32) -> vec3<f32>
    {
        var skyColorBlur = getGroundWithSkyColor(texPosition.xyz, fogUniform.skyRoughness, fogUniform.isSkyHDR > 0.5);
        let skyFactor = clamp(fogUniform.skyFactor - fogUniform.overrideSkyFactor * 0.5, 0.0, 1.0);
        var fogColor = mix(fogUniform.fogColor.xyz, skyColorBlur, skyFactor);
        return mix(texColor.rgb, fogColor.rgb, fogFactor);
    }

    fn blendSkyColor() -> vec3<f32>
    {
        let overrideSkyFactor = sqrt(fogUniform.overrideSkyFactor);
        var skyColorBlur = getSkyBluredColor(overrideSkyFactor * 0.3, fogUniform.isSkyHDR > 0.5);
        return mix(fogUniform.fogColor.xyz, skyColorBlur, 1.0 - overrideSkyFactor);
    }


    // How fogged a point 'z' meters away is: linear from end (clear) to
    // start (full); exponential (half fogged every 1 / density meters past
    // end); exponential squared; or height fog.
    fn computeFog(z:f32) -> f32 
    {
        let d = max(z - fogUniform.end, 0.0);
        var fog = 0.0;
        if( fogUniform.fogType < 0.5 ){
            fog = (fogUniform.end - z) / (fogUniform.end - fogUniform.start);
        }else if(fogUniform.fogType < 1.5 ){
            fog = 1.0 - exp2(-fogUniform.density * d);
        }else if(fogUniform.fogType < 2.5 ){
            let k = fogUniform.density * d;
            fog = 1.0 - exp2(-k * k);
        }else{
            fog = heightFog(z);
        }
        return max(fog,0.0);
    }

    // Height fog: 'density' thick at the base height (slot0), thinning by
    // e^-fogHeightScale for each meter up, integrated along the view ray
    // past the clear distance (end). Without falloff it is the exponential fog.
    fn heightFog(dist:f32) -> f32
    {
        let cam = globalUniform.cameraWorldMatrix[3].xyz;
        let t0 = clamp(fogUniform.end, 0.0, dist);
        let len = dist - t0;
        if (len <= 0.0) {
            return 0.0;
        }
        let dirY = (texPosition.y - cam.y) / max(dist, 0.0001);
        let b = max(fogUniform.fogHeightScale, 0.00001);
        let y0 = cam.y + dirY * t0;
        // ln(2): the same thickness as the exponential fog at the base height.
        let base = fogUniform.density * 0.6931472 * exp(clamp(-b * (y0 - fogUniform.slot0), -80.0, 80.0));
        let k = b * dirY;
        var optical = base * len;
        if (abs(k * len) > 0.0001) {
            optical = base * (1.0 - exp(clamp(-k * len, -80.0, 80.0))) / k;
        }
        return 1.0 - exp(-max(optical, 0.0));
    }

    fn cFog(y:f32) -> f32 
    {
        let fogDensity = fogUniform.density * exp(fogUniform.fogHeightScale * y);
        let fogFactor = (1.0 - exp2(-fogUniform.falloff)) / fogUniform.falloff ;
        let fog = fogDensity * fogFactor * max(fogUniform.rayLength - fogUniform.start, 0.0); 
        return max(fog,0.0);
    }

    fn inScatterIng(sunDir:vec3<f32>, worldPos:vec3<f32>, sunColor:vec3<f32>) -> vec3<f32> 
    {
        let viewDir = normalize(globalUniform.CameraPos.xyz - worldPos.xyz) ;
        let VoL = saturate(dot(viewDir,sunDir)) ;
        var scatter = pow(VoL,fogUniform.scatteringExponent);
        scatter *= (1.0-saturate(exp2(-fogUniform.dirHeightLine)));
        return vec3<f32>(scatter*sunColor);
    }

`;



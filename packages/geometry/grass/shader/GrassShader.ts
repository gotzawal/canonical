/**
 * @internal
 */
export let GrassShader = /* wgsl */`
    #include "WorldMatrixUniform"
    #include "GrassVertexAttributeShader"
    #include "GlobalUniform"
    #include "Inline_vert"
    #include "BRDF_frag"

    #include "Common_frag"
    #include "UnLit_frag"
    #include "MatrixShader"
    #include "BrdfLut_frag"
    #include "LightingFunction_frag"
    #include "ReflectionCG"
    
    struct MaterialUniform {
        baseColor: vec4<f32>,
        grassBottomColor: vec4<f32>,
        grassTopColor: vec4<f32>,
        materialF0: vec4<f32>,
        windBound: vec4<f32>,
        windDirection: vec2<f32>,
        windPower: f32,
        windSpeed: f32,
        translucent: f32,
        grassHeight: f32,
        curvature: f32,
        roughness: f32,
        soft: f32,
        specular: f32,
        // Meters from the camera where the last blades are gone (they thin out from half of it); 0 for none.
        drawDistance: f32,
        // The viewer (the shadow pass's camera is the light's) and how far from it blades cast shadows; 0 for all.
        shadowEyeX: f32,
        shadowEyeY: f32,
        shadowEyeZ: f32,
        shadowDistance: f32,
        // The ground's color (linear) the roots fade into, how much, and how dry patches are.
        groundR: f32,
        groundG: f32,
        groundB: f32,
        rootBlend: f32,
        dryness: f32,
    };
      
    @group(2) @binding(0)
    var<uniform> materialUniform: MaterialUniform;

    @group(1) @binding(auto)
    var baseMapSampler: sampler;
    @group(1) @binding(auto)
    var baseMap: texture_2d<f32>;

    @group(1) @binding(auto)
    var windMapSampler: sampler;
    @group(1) @binding(auto)
    var windMap: texture_2d<f32>;

    const DEGREES_TO_RADIANS : f32 = 3.1415926 / 180.0 ;
    const PI : f32 = 3.1415926 ;

    @vertex
    fn VertMain( vertex:VertexAttributes ) -> VertexOutput {
        var vertexData = vertex ;
        vertex_inline(vertexData);
        vert(vertexData);
        return ORI_VertexOut ;
    }

    fn transformVertex(position:vec3<f32>,normal:vec3<f32>,vertex:VertexAttributes) -> TransformVertex {
        var transformVertex:TransformVertex;
        let windDirection = normalize( vec3<f32>(materialUniform.windDirection.x,0.0,materialUniform.windDirection.y)) ;
        let windPower = materialUniform.windPower ;
        let localMatrix = models.matrix[i32(vertex.vIndex)]  ;
        let grassPivot = localMatrix[3].xyz ;
        let bound = materialUniform.windBound ;

        let time = TIME_time() * 0.001 ;
        let cycleTime = sin(time) ;

        //sampler wind noise texture by vertex shader 
        let size = textureDimensions(windMap);
        let cyclePos = ( abs(grassPivot.xz + windDirection.xz * time * 100.0 * materialUniform.windSpeed ) % vec2<f32>(size) ) ;
        var windNoise = textureLoad(windMap,vec2<i32>( cyclePos ),0);
    
        // weights0 x,y,z is grass blend dir , w is curvature random 
        let weights = vertex.weights0 ;
        var speed = windDirection.xz * ( windNoise.rg ) ; 
     
        var roat = localMatrix ;
        roat[3].x = 0.0 ;
        roat[3].y = 0.0 ;
        roat[3].z = 0.0 ;
        var finalMatrix:mat4x4<f32> = buildMatrix4x4() ;
        var uv = vertex.uv ;
        let weight = ( 1.0 - uv.y )  ;
        let limitAngle = 90.0 / 8.0 * DEGREES_TO_RADIANS + PI * 0.35 ;
        // if(uv.y < 1.0 ){
            for (var index:i32 = 1; index <= 5 ; index+=1) {
                let bios = f32(index) / 5.0 ;
                if(weight >= bios){
                    let rx = weights.x * weights.w + clamp(speed.y * windPower * pow(weight,materialUniform.curvature),-1.0,1.0)  ;
                    let rz = weights.z * weights.w + clamp(-speed.x * windPower * pow(weight,materialUniform.curvature),-1.0,1.0) ;

                    // A blade's node scales its height by its Y scale (its X scale widens it).
                    var rot = buildRotateXYZMat4(rx,0.0,rz,0.0,materialUniform.grassHeight*bios*length(localMatrix[1].xyz),0.0);
                    finalMatrix *= rot ;
                }
            }
        // }

        finalMatrix *= roat;
        //create grass pivot matrix 
        var translate = bulidTranslateMat4(grassPivot.x,grassPivot.y,grassPivot.z);
        transformVertex.position = ( translate * finalMatrix * vec4<f32>(position,1.0)).xyz;

        //generate vertex normal
        //build vertex normal matrix 
        let nMat = mat3x3<f32>(finalMatrix[0].xyz,finalMatrix[1].xyz,finalMatrix[2].xyz) ;
        ORI_NORMALMATRIX = transpose(inverse( nMat ));
        transformVertex.normal = ORI_NORMALMATRIX * normal;

        // Far blades thin out: past half the draw distance more and more of
        // them (picked by where they stand) fold to their root and draw nothing.
        let drawDistance = materialUniform.drawDistance;
        if (drawDistance > 0.0) {
            let d = distance(globalUniform.CameraPos.xyz, grassPivot);
            let keep = fract(sin(dot(grassPivot.xz, vec2<f32>(12.9898, 78.233))) * 43758.5453);
            if (keep < smoothstep(drawDistance * 0.5, drawDistance, d)) {
                transformVertex.position = grassPivot;
            }
        }

        return transformVertex ;
    }

    fn vert(inputData:VertexAttributes) -> VertexOutput {
        let input = inputData ;
        ORI_Vert(input) ;
        return ORI_VertexOut ;
    }

    // The sun: the first directional light that casts shadows (whose shadow
    // is directShadowVisibility[0]), else the first light.
    fn grassSun() -> LightData {
        if (globalUniform.nDirShadowEnd > globalUniform.nDirShadowStart) {
            let i = u32(globalUniform.nDirShadowStart);
            return lightBuffer[u32(globalUniform.shadowLights[i / 4u][i % 4u])];
        }
        return lightBuffer[0];
    }

    fn grassHash(p: vec2<f32>) -> f32 {
        return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
    }

    fn grassNoise(p: vec2<f32>) -> f32 {
        let i = floor(p);
        let f = p - i;
        let u = f * f * (3.0 - 2.0 * f);
        return mix(mix(grassHash(i), grassHash(i + vec2<f32>(1.0, 0.0)), u.x), mix(grassHash(i + vec2<f32>(0.0, 1.0)), grassHash(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
    }

    fn frag(){

        var normal = ORI_VertexVarying.vWorldNormal ;
        if(!ORI_VertexVarying.face){
            normal = -normal ;
        }
        normal = normalize(normal);

        useShadow();
         
        var uv = ORI_VertexVarying.fragUV0 ; 

        let color = textureSampleLevel(baseMap,baseMapSampler,uv,0.0) ;

        if(color.w < 0.3){
            discard ;
        }

        let viewDir = normalize(globalUniform.CameraPos.xyz - ORI_VertexVarying.vWorldPos.xyz) ;
        let sun = grassSun() ;
        let L = -normalize(sun.direction.xyz) ;
        // Lit as the engine's other surfaces are: the light's color times its intensity, over PI.
        let lightColor = sun.lightColor.rgb * sun.intensity ;
        let shadow = directShadowVisibility[0] ;

        // Root to tip, darker near the ground where the blades shade each other.
        let tip = 1.0 - uv.y ;
        var albedo = color.rgb * mix(materialUniform.grassBottomColor.rgb, materialUniform.grassTopColor.rgb, tip) ;
        // Drier, yellower patches over the field.
        let at = ORI_VertexVarying.vWorldPos.xz ;
        let patchy = grassNoise(at * 0.07) * 0.65 + grassNoise(at * 0.23 + vec2<f32>(7.1, 3.3)) * 0.35 ;
        albedo = mix(albedo, albedo * vec3<f32>(1.35, 1.1, 0.45), smoothstep(0.45, 0.8, patchy) * materialUniform.dryness) ;
        // Roots fading into the ground they grow from.
        let root = (1.0 - smoothstep(0.0, 0.35, tip)) * materialUniform.rootBlend ;
        albedo = mix(albedo, vec3<f32>(materialUniform.groundR, materialUniform.groundG, materialUniform.groundB), root * 0.8) ;
        let occlusion = mix(0.5, 1.0, tip) ;

        // Thin blades: light wraps around them, and shines through them seen against the sun.
        let wrap = clamp(dot(L, normal) * 0.5 + 0.5, 0.0, 1.0) ;
        let through = pow(clamp(dot(-viewDir, L), 0.0, 1.0), 4.0) * materialUniform.translucent ;
        let direct = albedo / PI * lightColor * (wrap + through) * shadow * occlusion ;
        let R = reflect(-L, normal) ;
        let specular = pow(max(dot(viewDir, R), 0.0), (1.0 - materialUniform.roughness + 0.001) * 200.0) * lightColor * materialUniform.specular * shadow / PI ;

        // Sky light from the rough end of the environment map, as the engine's diffuse IBL.
        let MAX_REFLECTION_LOD = f32(textureNumLevels(prefilterMap)) ;
        let irradiance = globalUniform.skyExposure * textureSampleLevel(prefilterMap, prefilterMapSampler, normal, 0.8 * MAX_REFLECTION_LOD).rgb ;
        let ambient = albedo * irradiance * occlusion / PI ;

        ORI_ShadingInput.BaseColor = vec4<f32>(direct + specular + ambient, 1.0) ;
        UnLit();
    }

 
`


/**
 * @internal
 * Point and spot light shadows, from the shadow atlas: each light's faces
 * (+X, -X, +Y, -Y, +Z, -Z as seen from the light) are tiles of one depth
 * texture, each light at its own size, and a direction from the light is
 * looked up in the face it falls in (shadowFaceOf / shadowFaceUV).
 * Three compile branches: USE_PCF_SHADOW / USE_SOFT_SHADOW / USE_HARD_SHADOW.
 * Depends on ShadowCommon, GlobalUniform, LightData, ORI_ShadingInput.
 */
export let PointShadow_frag: string = /*wgsl*/ `
    // Where a direction from the light is in the atlas; x < 0 when its face
    // has no tile (a spot light's cone does not reach it: lit). Kept half a
    // texel inside the tile, so filtering never reads the next one.
    fn pointShadowAtlasUV(light: LightData, d: vec3<f32>) -> vec2<f32> {
        let face = shadowFaceOf(d);
        let pair = light.shadowTiles[face / 2];
        let origin = select(pair.xy, pair.zw, (face % 2) == 1);
        if (origin.x < 0.0) { return vec2<f32>(-1.0); }
        let scale = light.shadowTileScale;
        let half = light.shadowAtlasTexel * 0.5;
        let uv = origin + shadowFaceUV(d, face) * scale;
        return clamp(uv, origin + half, origin + scale - half);
    }

    // 1 where the direction is lit at depth compareZ, 0 in shadow.
    fn pointShadowTap(light: LightData, d: vec3<f32>, compareZ: f32) -> f32 {
        let uv = pointShadowAtlasUV(light, d);
        if (uv.x < 0.0) { return 1.0; }
        return textureSampleCompareLevel(pointShadowMap, pointShadowMapSampler, uv, compareZ);
    }

    // The stored depth there (PCSS blocker search); 1 (nothing) without a tile.
    fn pointShadowDepth(light: LightData, d: vec3<f32>) -> f32 {
        let uv = pointShadowAtlasUV(light, d);
        if (uv.x < 0.0) { return 1.0; }
        return textureSampleLevel(pointShadowMap, pointShadowMapSamplerRaw, uv, 0i);
    }

    fn pointShadowMapCompare(){
      let worldPos = ORI_VertexVarying.vWorldPos.xyz;

      for (var i: i32 = globalUniform.nPointShadowStart; i < globalUniform.nPointShadowEnd; i = i + 1) {
          let ldx = globalUniform.shadowLights[u32(i) / 4u][u32(i) % 4u];
          let light = lightBuffer[u32(ldx)] ;
          if (light.castShadow < 0) { continue; }

          #if USE_SHADOWMAPING
              let lightPos = light.position.xyz;
              var shadow = 0.0;
              // RFC-003: shadowBias is a world-space distance subtracted from the
              // measured fragment-to-light distance; normalBias offsets the receiver
              // along its normal first to mitigate acne on grazing surfaces.
              //
              // IMPORTANT (cross-platform): normalize() of a zero-length vector is
              // undefined in WGSL. Metal returns (0,0,0), Dawn D3D12 returns NaN,
              // and once NaN is in compareZ the depth-compare sampler treats
              // NaN ref as "pass" on Windows, giving no shadows. Use select +
              // manual inverseSqrt to stay data-defined even for degenerate
              // normals or unset light.position.
              let Nraw = ORI_ShadingInput.Normal;
              let N_len2 = dot(Nraw, Nraw);
              let N = select(vec3<f32>(0.0, 1.0, 0.0), Nraw * inverseSqrt(max(N_len2, 1e-30)), N_len2 > 1e-8);
              let unshiftedLen = length(worldPos - lightPos.xyz);
              let lengthScale = min(unshiftedLen / max(light.range, 1.0), 1.0);
              let receiverPos = worldPos + N * (light.normalBias[0] * lengthScale);
              let frgToLight = receiverPos - lightPos.xyz;
              let frg_len2 = dot(frgToLight, frgToLight);
              var dir: vec3<f32> = select(vec3<f32>(1.0, 0.0, 0.0), frgToLight * inverseSqrt(max(frg_len2, 1e-30)), frg_len2 > 1e-8);
              var len = sqrt(max(frg_len2, 0.0));
              let shadowFarDecode = select(globalUniform.far, light.shadowFar, light.shadowFar > 0.0);
              // Analytic receiver-plane bias for shadow texel quantization. A
              // face texel's footprint on the receiver is a stretched ellipse
              // with semi-major ~ len / (mapSize * NoL). Depth variation within
              // one texel is bounded by that footprint; screen-space dpdx is
              // *not* the right metric here because the light's view and the
              // main camera's are independent. NoL floor 0.05 caps it at 20x.
              let NoL = max(dot(N, -dir), 0.05);
              let worldBias = (light.shadowBias[0] * lengthScale) / NoL;
              let compareZ = (len - worldBias) / shadowFarDecode;

              // Tangent basis around 'dir' for projecting Poisson disk
              // offsets onto the tangent plane. 'up' picked to be
              // non-parallel to dir to avoid cross() collapsing to zero.
              let upAxis = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 1.0, 0.0), abs(dir.y) < 0.9);
              let tRight = normalize(cross(upAxis, dir));
              let tUp = cross(dir, tRight);
              // One texel of this light's faces as an angle (a face spans
              // 90 degrees): filters widen with lower resolution maps.
              let faceTexels = light.shadowTileScale.x / max(light.shadowAtlasTexel.x, 1e-6);
              let texelAngle = 1.5708 / max(faceTexels, 1.0);

              #if USE_HARD_SHADOW
                shadow = 1.0 - pointShadowTap(light, dir, compareZ);
              #else
                #if USE_SOFT_SHADOW
                  // PCSS — blocker search in angular space, penumbra
                  // estimated from (refDepth - avgBlocker) / avgBlocker.
                  // Per-light softness overrides the global knob when > 0.
                  // Units: multiplier on a 4-texel base angle (4/512 rad).
                  let pcssSoftBase = select(max(globalUniform.shadowSoft, 1.0), light.softness, light.softness > 0.0);
                  let pcssLightSize = pcssSoftBase * (4.0 / 512.0);
                  var avgBlocker = 0.0;
                  var numBlockers = 0.0;
                  for (var j = 0; j < 16; j++) {
                      let p = POISSON_DISK_16[j];
                      let searchDir = normalize(dir + (tRight * p.x + tUp * p.y) * pcssLightSize);
                      let sampleDepth = pointShadowDepth(light, searchDir);
                      if (sampleDepth < compareZ) {
                          avgBlocker += sampleDepth;
                          numBlockers += 1.0;
                      }
                  }
                  if (numBlockers < 0.5) {
                      shadow = 0.0;
                  } else {
                      let avgBlockerDepth = avgBlocker / numBlockers;
                      let penumbra = max(compareZ - avgBlockerDepth, 0.0) / max(avgBlockerDepth, 1e-5);
                      let filterRadius = max(min(penumbra * pcssLightSize, pcssLightSize), texelAngle);
                      shadow = 0.0;
                      for (var j = 0; j < 16; j++) {
                          let p = POISSON_DISK_16[j];
                          let offsetDir = normalize(dir + (tRight * p.x + tUp * p.y) * filterRadius);
                          shadow += 1.0 - pointShadowTap(light, offsetDir, compareZ);
                      }
                      shadow = shadow * (1.0 / 16.0);
                  }
                #else
                  // USE_PCF_SHADOW (default). Tangent-plane 16-Poisson about a
                  // texel and a quarter across, scaled by
                  // globalUniform.pcfKernelScale like the directional PCF.
                  let pcfRadius = texelAngle * 1.25 * max(globalUniform.pcfKernelScale, 0.01);
                  shadow = 0.0;
                  for (var j = 0; j < 16; j++) {
                      let p = POISSON_DISK_16[j];
                      let offsetDir = normalize(dir + (tRight * p.x + tUp * p.y) * pcfRadius);
                      shadow += 1.0 - pointShadowTap(light, offsetDir, compareZ);
                  }
                  shadow = shadow * (1.0 / 16.0);
                #endif
              #endif

              // Smooth fade across the last 5% of the shadow's depth range so
              // fragments past the light's range don't hard-edge into "lit".
              // Mirrors the directional frustum-edge fade.
              let edgeFade = smoothstep(0.95, 1.0, len / shadowFarDecode);
              shadow = shadow * (1.0 - edgeFade);

              pointShadows[i32(light.castShadow)] = 1.0 - shadow;
          #endif
      }
    }
`

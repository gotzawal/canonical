/**
 * Volumetric clouds (CloudPost), two compute passes:
 *
 * - `CloudMarch_cs`: at a quarter of the resolution each way, each pixel
 *   marches its view ray through a cloud layer on a shell around the Earth
 *   (from the scene's depth: terrain hides what is behind it), offset each
 *   frame within its 4x4 block of the screen. Density is a weather pattern
 *   (coverage) times a height profile (stratus to cumulus), carved by a
 *   tiling noise volume (32^3, kept as slices in a 2D texture) and eroded
 *   at its edges; light is the sun's (Beer, powder, two-lobe phase, two
 *   octaves of multiple scattering) plus the sky's, and far clouds fade
 *   into the sky behind them. Out: (in-scattered light, transmittance).
 * - `CloudComposite_cs`: at full resolution, blends that with the history
 *   (at half resolution, reprojected by the camera's last view), writes
 *   the history, puts the clouds over the scene, and darkens the ground
 *   under them by their shadow.
 *
 * @internal
 */
const CLOUD_COMMON = /* wgsl */ `
    struct CloudSettings {
        prevViewProj: mat4x4<f32>,
        // bottom (m), top (m), coverage (0..1), density
        layer: vec4<f32>,
        // type (0 stratus .. 1 cumulus), detail, evolution (m/s), time (s)
        shape: vec4<f32>,
        // wind offset x, z (m), haze, shadow strength
        wind: vec4<f32>,
        // steps, frame, jitter x, jitter y (quarter pixels)
        march: vec4<f32>,
    };

    const PI: f32 = 3.14159265;
    const EARTH: f32 = 6360000.0;
    const SLICE: f32 = 32.0;
    const CELL: f32 = 34.0;
    // The atlas is 320 wide (rows of whole 256 bytes for the upload): 8 slices and unused columns.
    const ATLAS: vec2<f32> = vec2<f32>(320.0, 136.0);

    // One slice of the noise volume (with its wrapped border), bilinear.
    fn noiseSlice(s: i32, xy: vec2<f32>) -> vec2<f32> {
        let cell = vec2<f32>(f32(s % 8), f32(s / 8)) * CELL;
        let uv = (cell + 1.0 + xy) / ATLAS;
        return textureSampleLevel(noiseTex, noiseTexSampler, uv, 0.0).rg;
    }

    // The tiling noise volume at p (one tile per unit): base shape (x) and erosion (y).
    fn noise3(p: vec3<f32>) -> vec2<f32> {
        let q = fract(p) * SLICE;
        let z = q.z - 0.5;
        let z0 = floor(z);
        let s0 = (i32(z0) + 32) % 32;
        let s1 = (s0 + 1) % 32;
        return mix(noiseSlice(s0, q.xy), noiseSlice(s1, q.xy), z - z0);
    }

    fn remap(v: f32, a: f32, b: f32) -> f32 {
        return clamp((v - a) / max(b - a, 1e-4), 0.0, 1.0);
    }

    // Height of p over the ground, on the curved Earth under the camera.
    fn altitude(p: vec3<f32>) -> f32 {
        let cam = globalUniform.CameraPos.xyz;
        let d = p.xz - cam.xz;
        return length(vec3<f32>(d.x, p.y + EARTH, d.y)) - EARTH;
    }

    // Where clouds may be (0..1): the weather pattern drifting with the wind.
    fn coverageAt(xz: vec2<f32>) -> f32 {
        let w = (xz + cloud.wind.xy) / 9000.0;
        let n = noise3(vec3<f32>(w, 0.37 + cloud.shape.w * cloud.shape.z * 0.00002)).x * 0.65
            + noise3(vec3<f32>(w * 2.7, 0.71)).x * 0.35;
        // Spread over 0..1, then as much of it as the coverage asks for is cloudy.
        let spread = remap(n, 0.2, 0.75);
        let c = cloud.layer.z;
        return smoothstep(1.0 - c - 0.15, 1.0 - c + 0.15, spread) * step(0.001, c);
    }

    // How the layer fills with height (0 bottom .. 1 top): flat stratus to tall cumulus.
    fn profile(h: f32) -> f32 {
        let t = cloud.shape.x;
        let stratus = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.15, 0.35, h));
        let cumulus = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.55, 1.0, h));
        return mix(stratus, cumulus, t);
    }

    // Cloud density at p; without detail for the light's march.
    fn density(p: vec3<f32>, detail: bool) -> f32 {
        let h = (altitude(p) - cloud.layer.x) / max(cloud.layer.y - cloud.layer.x, 1.0);
        if (h <= 0.0 || h >= 1.0) { return 0.0; }
        let cov = coverageAt(p.xz);
        if (cov <= 0.0) { return 0.0; }
        let drift = vec3<f32>(cloud.wind.x, cloud.shape.w * cloud.shape.z, cloud.wind.y);
        let base = noise3((p + drift) / 3800.0).x;
        // Thin weather leaves only the densest parts of the shape; full weather fills it.
        var d = remap(base * profile(h), 0.62 - 0.72 * cov, 1.0);
        if (detail && d > 0.0) {
            let e = noise3((p + drift * 1.6) / 640.0).y;
            d = remap(d, e * cloud.shape.y * (0.25 + 0.3 * h), 1.0);
        }
        return d * cloud.layer.w;
    }

    // Distances along a ray from the camera to a sphere around the Earth's middle at altitude r (-1 where it misses).
    fn shell(o: vec3<f32>, dir: vec3<f32>, r: f32) -> vec2<f32> {
        let c = vec3<f32>(o.x, -EARTH, o.z);
        let oc = o - c;
        let b = dot(oc, dir);
        let k = dot(oc, oc) - (EARTH + r) * (EARTH + r);
        let disc = b * b - k;
        if (disc < 0.0) { return vec2<f32>(-1.0); }
        let s = sqrt(disc);
        return vec2<f32>(-b - s, -b + s);
    }

    fn hg(c: f32, g: f32) -> f32 {
        let g2 = g * g;
        return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
    }

    // The first directional light that casts shadows (the sun), else the first light.
    fn sunLight() -> LightData {
        if (globalUniform.nDirShadowEnd > globalUniform.nDirShadowStart) {
            let i = u32(globalUniform.nDirShadowStart);
            return lightBuffer[u32(globalUniform.shadowLights[i / 4u][i % 4u])];
        }
        return lightBuffer[0];
    }

    fn sunDir() -> vec3<f32> {
        return normalize(-sunLight().direction);
    }

    // The view ray through a screen position (0..1 from the top left).
    fn viewRay(uv: vec2<f32>) -> vec3<f32> {
        let clip = vec4<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0, 1.0, 1.0);
        var v = globalUniform.projMatInv * clip;
        v = v / v.w;
        return normalize((globalUniform.cameraWorldMatrix * vec4<f32>(v.xyz, 0.0)).xyz);
    }

    // How far the scene is along the ray at a full-resolution pixel (very far for the sky).
    fn sceneDistance(px: vec2<i32>, uv: vec2<f32>) -> f32 {
        let g = getGBuffer(px);
        if (getRoughnessFromGBuffer(g) <= 0.0) { return 1e9; }
        return distance(getWorldPositionFromGBuffer(g, uv), globalUniform.CameraPos.xyz);
    }
`;

export let CloudMarch_cs: string = /* wgsl */ `
    #include "GlobalUniform"
    #include "GBufferStand"
    #include "LightData"

    @group(0) @binding(2) var<uniform> cloud: CloudSettings;
    @group(0) @binding(3) var<storage, read> lightBuffer: array<LightData>;
    @group(0) @binding(4) var noiseTex: texture_2d<f32>;
    @group(0) @binding(5) var noiseTexSampler: sampler;
    @group(0) @binding(6) var prefilterMap: texture_cube<f32>;
    @group(0) @binding(7) var prefilterMapSampler: sampler;
    @group(0) @binding(8) var outTex: texture_storage_2d<rgba16float, write>;

    ${CLOUD_COMMON}

    // How much sunlight reaches p through the cloud toward the sun (optical depth, a few long steps).
    fn toSun(p: vec3<f32>, l: vec3<f32>) -> f32 {
        var od = 0.0;
        var t = 30.0;
        for (var i = 0; i < 5; i++) {
            od += density(p + l * t, false) * t * 0.6;
            t *= 1.9;
        }
        return od;
    }

    @compute @workgroup_size(8, 8, 1)
    fn CsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
        let size = textureDimensions(outTex);
        if (gid.x >= size.x || gid.y >= size.y) { return; }
        let full = vec2<f32>(textureDimensions(gBufferTexture));
        // This frame's pixel within the 4x4 block the quarter pixel covers.
        let px = vec2<f32>(gid.xy) * 4.0 + cloud.march.zw + 0.5;
        let uv = px / full;
        let cam = globalUniform.CameraPos.xyz;
        let dir = viewRay(uv);
        let far = min(sceneDistance(vec2<i32>(px), uv), 60000.0);

        // The part of the ray inside the layer (from the ground up: the camera under it).
        let bottom = shell(cam, dir, cloud.layer.x);
        let top = shell(cam, dir, cloud.layer.y);
        let alt = cam.y;
        var t0 = 0.0;
        var t1 = 0.0;
        if (alt < cloud.layer.x) {
            t0 = max(bottom.y, 0.0);
            t1 = top.y;
        } else if (alt < cloud.layer.y) {
            t0 = 0.0;
            t1 = select(top.y, bottom.x, bottom.x > 0.0);
        } else {
            t0 = max(top.x, 0.0);
            t1 = select(top.y, bottom.x, bottom.x > 0.0);
        }
        t1 = min(t1, far);
        if (top.y < 0.0 || t1 <= t0) {
            textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(0.0, 0.0, 0.0, 1.0));
            return;
        }

        let sun = sunLight();
        let l = sunDir();
        let sunColor = sun.lightColor.rgb * sun.intensity;
        let c = dot(dir, l);
        // Two lobes: forward (silver lining toward the sun) and back.
        let phase = mix(hg(c, 0.75), hg(c, -0.25), 0.3);
        let skyTop = textureSampleLevel(prefilterMap, prefilterMapSampler, vec3<f32>(0.0, 1.0, 0.0), 5.0).rgb * globalUniform.skyExposure;
        let skyLow = textureSampleLevel(prefilterMap, prefilterMapSampler, normalize(vec3<f32>(dir.x, 0.05, dir.z)), 5.0).rgb * globalUniform.skyExposure;

        let steps = max(cloud.march.x, 8.0);
        let len = t1 - t0;
        let dt = len / steps;
        // Interleaved gradient noise: a different start for each pixel and frame.
        let jitter = fract(52.9829189 * fract(dot(px + cloud.march.y * 5.588, vec2<f32>(0.06711056, 0.00583715))));
        let sigma = 0.05;
        var trans = 1.0;
        var light = vec3<f32>(0.0);
        var depthSum = 0.0;
        var weight = 0.0;
        for (var i = 0.0; i < steps; i += 1.0) {
            let t = t0 + (i + jitter) * dt;
            let p = cam + dir * t;
            let d = density(p, true);
            if (d > 0.002) {
                let od = toSun(p, l) * sigma;
                // Beer with a powder darkening of thin edges, and two octaves of light scattered again.
                let powder = 1.0 - exp(-od * 2.0);
                let scattered = phase * exp(-od) + 0.5 * hg(c, 0.3) * exp(-od * 0.25);
                let sunPart = sunColor * scattered * mix(0.6, 1.0, powder);
                let h = (altitude(p) - cloud.layer.x) / max(cloud.layer.y - cloud.layer.x, 1.0);
                let ambient = mix(skyLow * 0.5, skyTop, h) * 0.9;
                let ext = d * sigma;
                let stepT = exp(-ext * dt);
                light += trans * (sunPart + ambient) * (1.0 - stepT);
                depthSum += t * trans * (1.0 - stepT);
                weight += trans * (1.0 - stepT);
                trans *= stepT;
                if (trans < 0.02) { break; }
            }
        }
        // Far clouds fade into the sky behind them through the air.
        let dist = select(t0, depthSum / max(weight, 1e-4), weight > 0.0);
        let haze = 1.0 - exp(-dist * 1.6e-5 * cloud.wind.z);
        let sky = textureSampleLevel(prefilterMap, prefilterMapSampler, dir, 2.0).rgb * globalUniform.skyExposure;
        light = mix(light, sky * (1.0 - trans), haze);
        textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(light, trans));
    }
`;

export let CloudComposite_cs: string = /* wgsl */ `
    #include "GlobalUniform"
    #include "GBufferStand"
    #include "LightData"

    @group(0) @binding(2) var<uniform> cloud: CloudSettings;
    @group(0) @binding(3) var<storage, read> lightBuffer: array<LightData>;
    @group(0) @binding(4) var noiseTex: texture_2d<f32>;
    @group(0) @binding(5) var noiseTexSampler: sampler;
    @group(0) @binding(6) var inTex: texture_2d<f32>;
    @group(0) @binding(7) var marchTex: texture_2d<f32>;
    @group(0) @binding(8) var historyTex: texture_2d<f32>;
    @group(0) @binding(9) var historyTexSampler: sampler;
    @group(0) @binding(10) var historyOut: texture_storage_2d<rgba16float, write>;
    @group(0) @binding(11) var outTex: texture_storage_2d<rgba16float, write>;

    ${CLOUD_COMMON}

    @compute @workgroup_size(8, 8, 1)
    fn CsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
        let size = textureDimensions(outTex);
        if (gid.x >= size.x || gid.y >= size.y) { return; }
        let px = vec2<i32>(gid.xy);
        let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
        let color = textureLoad(inTex, px, 0);
        let cam = globalUniform.CameraPos.xyz;
        let dir = viewRay(uv);

        // This frame's march at this pixel: the nearest quarter pixel whose sample fell here, else the nearest.
        let qsize = vec2<i32>(textureDimensions(marchTex));
        let q = clamp(px / 4, vec2<i32>(0), qsize - 1);
        let fresh = all((px % 4) == vec2<i32>(cloud.march.zw));
        let now = textureLoad(marchTex, q, 0);

        // The history where this point of the sky was last frame (clouds are far: by direction from the camera).
        let p = cam + dir * 4000.0;
        let prev = cloud.prevViewProj * vec4<f32>(p, 1.0);
        let puv = vec2<f32>(prev.x / prev.w * 0.5 + 0.5, 0.5 - prev.y / prev.w * 0.5);
        var result = now;
        if (prev.w > 0.0 && all(puv >= vec2<f32>(0.0)) && all(puv <= vec2<f32>(1.0)) && cloud.march.y > 0.5) {
            let old = textureSampleLevel(historyTex, historyTexSampler, puv, 0.0);
            result = mix(old, now, select(0.04, 0.35, fresh));
        }
        if (all((px % 2) == vec2<i32>(0))) {
            textureStore(historyOut, px / 2, result);
        }

        var out = color.rgb;
        let far = sceneDistance(px, uv);
        // Not over what is nearer than the layer (a sharp edge, not the quarter resolution's).
        let below = shell(cam, dir, cloud.layer.x);
        let near = select(0.0, max(below.y, 0.0), cam.y < cloud.layer.x && below.y > 0.0);
        if (far > near) {
            out = out * result.a + result.rgb;
        }
        // The ground under clouds: their shadow (where the sun's ray meets the middle of the layer).
        if (far < 1e8 && cloud.wind.w > 0.0) {
            let wp = cam + dir * far;
            let l = sunDir();
            if (l.y > 0.05) {
                // The cloud's own shape a third of the way up the layer, where they are thickest.
                let mid = mix(cloud.layer.x, cloud.layer.y, 0.3);
                let at = wp + l * ((mid - wp.y) / l.y);
                let shade = clamp(density(at, false) * 3.0, 0.0, 1.0) * cloud.wind.w;
                out *= 1.0 - shade * 0.65;
            }
        }
        textureStore(outTex, px, vec4<f32>(out, color.a));
    }
`;

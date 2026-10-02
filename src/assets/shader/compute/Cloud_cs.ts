/**
 * Volumetric clouds (CloudPost), two compute passes:
 *
 * - `CloudMarch_cs`: at a quarter of the resolution each way, each pixel
 *   marches its view ray through a cloud layer on a shell around the Earth
 *   (from the scene's depth: terrain hides what is behind it), offset each
 *   frame within its 4x4 block of the screen. Density is a weather pattern
 *   (where clouds gather and how strongly) shaping each cloud's height
 *   (flat bases; domes that rise higher where the weather is stronger;
 *   tops leaning with the wind), carved by a tiling noise volume and worn
 *   at its edges (wisps below, billows above; see CloudNoise); light is the sun's (Beer, powder, two-lobe phase, two
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
        // reflection cube: first face, steps, face size, cloud face size
        env: vec4<f32>,
        // size (1 as usual), softness (0 crisp .. 1 soft), pattern offset x, z (m)
        look: vec4<f32>,
        // wind direction x, z (unit), how far tops lean (0..1), clumping (0 scattered puffs .. 1 big masses)
        lean: vec4<f32>,
        // stars and the moon's disc (x: how bright, 0 none), how far clouds are drawn (y, meters),
        // the march's block (z: 2 or 4 pixels a side), how fast new marches replace the history (w)
        night: vec4<f32>,
        // how much clouds differ from one another (x: 0 all alike .. 1 hazy veils beside crisp heaps), spare
        vary: vec4<f32>,
    };

    const PI: f32 = 3.14159265;
    const EARTH: f32 = 6360000.0;

    // Meters a pixel spans at the sample being read (set by the march): the noise is read at the
    // level of detail that size calls for, so far clouds do not alias into stripes.
    var<private> footprint: f32 = 0.0;
    // Meters a pixel spans per meter of distance (the march sets it for the screen or the reflection cube).
    var<private> pixelSpread: f32 = 0.0015;

    fn noiseLod(voxel: f32) -> f32 {
        return log2(max(footprint / voxel, 1.0));
    }

    // 0..1 from three integers (a PCG hash).
    fn rand(v: vec3<u32>) -> f32 {
        var h = v.x * 1664525u + v.y * 22695477u + v.z * 2891336453u + 1013904223u;
        h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
        return f32((h >> 22u) ^ h) / 4294967296.0;
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

    // How strongly clouds gather at xz (0 clear sky .. 1 the heart of a cloud), drifting with the wind.
    // Flat sheets (stratus, cirrus) are drawn out along the wind into streaks.
    fn streak(xz: vec2<f32>) -> vec2<f32> {
        let d = cloud.lean.xy;
        let k = 1.0 + 3.0 * smoothstep(0.35, 0.0, cloud.shape.x);
        return xz + d * dot(xz, d) * (1.0 / k - 1.0);
    }

    // (x) how strongly clouds gather at xz, and (y) which kind of cloud is there, 0..1 (a field of
    // patches a cloud or two across, from the same sample: hazy where high, crisp heaps where low).
    fn weather(xz: vec2<f32>) -> vec2<f32> {
        let c = cloud.layer.z;
        if (c <= 0.001) { return vec2<f32>(0.0); }
        // Clumping: many small cells (scattered puffs) to few large ones (big masses).
        let scale = 12000.0 * cloud.look.x * mix(0.3, 1.5, cloud.lean.w);
        let w = streak(xz + cloud.wind.xy + cloud.look.zw) / scale;
        // Slowly changing over time as well as drifting.
        let t = cloud.shape.w * cloud.shape.z / scale * 0.25;
        let s = textureSampleLevel(shapeTex, shapeTexSampler, vec3<f32>(w.x, w.y, t), 0.0);
        let n = s.b;
        // About c of the sky past the threshold; a soft rise into each cloud's heart.
        return vec2<f32>(remap(n, 1.0 - c, min(1.0 - c + 0.35, 1.0)) * step(1.0 - c, n), s.g);
    }

    // How the layer fills with height (0 base .. 1 top) where the weather is w: flat sheets
    // (stratus) to heaps (cumulus) whose tops rise with the weather into domes.
    fn profile(h: f32, w: f32) -> f32 {
        let stratus = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.12, 0.3, h));
        let top = mix(0.3, 1.0, w);
        let cumulus = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(top * 0.7, top, h));
        return mix(stratus, cumulus, cloud.shape.x);
    }

    // Cloud density at p, its edges worn by \`detail\` (0 to 1: none for the light's march, the shadows and far clouds).
    fn density(p: vec3<f32>, detail: f32) -> f32 {
        let alt = altitude(p);
        let h = (alt - cloud.layer.x) / max(cloud.layer.y - cloud.layer.x, 1.0);
        if (h <= 0.0 || h >= 1.0) { return 0.0; }
        // Tops lean ahead with the wind (it blows harder higher up).
        let q = p.xz - cloud.lean.xy * cloud.lean.z * h * h * (cloud.layer.y - cloud.layer.x) * 0.5;
        let wk = weather(q);
        let w = wk.x;
        if (w <= 0.0) { return 0.0; }
        // This cloud's kind: hazy (soft, thin, low, more worn) or a crisp heap (sharp, taller).
        let hazy = smoothstep(0.45, 0.8, wk.y) * cloud.vary.x;
        let crisp = smoothstep(0.4, 0.1, wk.y) * cloud.vary.x;
        let g = profile(h, min(w * (1.0 - 0.6 * hazy + 0.4 * crisp), 1.0));
        if (g <= 0.0) { return 0.0; }
        let size = 3200.0 * cloud.look.x;
        let rise = cloud.shape.w * cloud.shape.z;
        let sq = streak(q + cloud.wind.xy);
        let s = textureSampleLevel(shapeTex, shapeTexSampler, vec3<f32>(sq.x, alt + rise, sq.y) / size, noiseLod(size / 64.0));
        // Shape: Perlin-Worley lumps rounded off by the Worley billows.
        var base = remap(s.r, (1.0 - s.g) * 0.55 - 0.1, 1.0);
        // A full sky closes up: its holes fill as coverage nears 1.
        let c = cloud.layer.z;
        base = mix(base, 1.0, c * c * c * w);
        // The weather decides how much of the shape stays: all at a cloud's heart, its peaks at its edges.
        var d = remap(base * g, 1.0 - w, 1.0);
        if (detail > 0.0 && d > 0.0) {
            // Finer, and warped by the shape noise (curls instead of round dimples).
            let warp = (s.ba - 0.5) * size * 0.06;
            let eq = streak(q + cloud.wind.xy * 1.4) + warp;
            let e = textureSampleLevel(detailTex, detailTexSampler, vec3<f32>(eq.x, alt + rise * 1.5 + warp.x, eq.y) / (size * 0.13), noiseLod(size * 0.13 / 32.0)).a;
            // Wisps at the base, billows (the noise turned inside out) toward the top.
            let worn = mix(e, 1.0 - e, clamp(h * 4.0, 0.0, 1.0));
            d = remap(d, worn * cloud.shape.y * 0.55 * detail * (1.0 + 0.8 * hazy), 1.0);
        }
        // Crisp clouds reach full density right inside their edge; soft ones thicken slowly.
        // Thinner where the weather is weak (a cloud's fringe).
        let soft = mix(mix(cloud.look.y, 1.0, hazy), cloud.look.y * 0.3, crisp);
        return min(d * mix(5.0, 1.2, soft), 1.0) * smoothstep(0.0, 0.35, w) * cloud.layer.w * (1.0 - 0.9 * hazy + 0.5 * crisp);
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

`;

// How far the scene is along the ray at a full-resolution pixel (needs GBufferStand).
const SCENE_DISTANCE = /* wgsl */ `
    fn sceneDistance(px: vec2<i32>, uv: vec2<f32>) -> f32 {
        let g = getGBuffer(px);
        if (getRoughnessFromGBuffer(g) <= 0.0) { return 1e9; }
        return distance(getWorldPositionFromGBuffer(g, uv), globalUniform.CameraPos.xyz);
    }
`;

// The march itself, for the screen and for the reflection cube (needs prefilterMap, lightBuffer).
const CLOUD_MARCH = /* wgsl */ `
    // How much sunlight reaches p through the cloud toward the sun (optical depth, a few long steps).
    // Optical depth toward the sun: five steps growing from 25 m (two for far clouds), then one
    // sample 1.5 km out, so the heart and the far side of a large cloud shade its near side.
    fn toSun(p: vec3<f32>, l: vec3<f32>, far: bool) -> f32 {
        var od = 0.0;
        var t = select(25.0, 120.0, far);
        let grow = select(1.9, 3.6, far);
        for (var i = 0; i < select(5, 2, far); i++) {
            od += density(p + l * t, 0.0) * t * select(0.6, 0.72, far);
            t *= grow;
        }
        od += density(p + l * 1500.0, 0.0) * 700.0;
        return od;
    }

    // The clouds along a ray from cam up to far: (in-scattered light, transmittance).
    fn marchClouds(cam: vec3<f32>, dir: vec3<f32>, far: f32, steps: f32, jitter: f32) -> vec4<f32> {
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
        if (top.y < 0.0 || t1 <= t0 || cloud.layer.z <= 0.001) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }

        let sun = sunLight();
        let l = sunDir();
        let sunColor = sun.lightColor.rgb * sun.intensity;
        let c = dot(dir, l);
        // Two lobes: forward (silver lining toward the sun) and back.
        let phase = mix(hg(c, 0.75), hg(c, -0.25), 0.3);
        // Light scattered many times still leans forward a little: clouds toward the sun glow through.
        let multiPhase = mix(1.0, hg(c, 0.4) * 12.566, 0.3);
        let skyTop = textureSampleLevel(prefilterMap, prefilterMapSampler, vec3<f32>(0.0, 1.0, 0.0), 5.0).rgb * globalUniform.skyExposure;
        let skyLow = textureSampleLevel(prefilterMap, prefilterMapSampler, normalize(vec3<f32>(dir.x, 0.05, dir.z)), 5.0).rgb * globalUniform.skyExposure;

        let n = max(steps, 8.0);
        // Short steps inside a cloud, twice as long through clear air (backing up into a cloud's edge),
        // all growing with distance: a tall layer seen far off is still sampled through its clouds.
        let base = clamp((t1 - t0) / n, 30.0, 180.0);
        let sigma = 0.05;
        var trans = 1.0;
        var light = vec3<f32>(0.0);
        var depthSum = 0.0;
        var weight = 0.0;
        var t = t0 + jitter * base;
        // Clear samples in a row: from the second on, steps are twice as long.
        var clear = 0;
        for (var i = 0.0; i < n * 2.5; i += 1.0) {
            if (t >= t1) { break; }
            let dt = base * (1.0 + (t - t0) / 8000.0);
            let p = cam + dir * t;
            footprint = t * pixelSpread;
            // Levels of detail by distance: worn edges and the full light march near, plainer far.
            let lod = smoothstep(6000.0, 20000.0, t);
            let d = density(p, 1.0 - lod);
            if (d > 0.002 && clear > 1) {
                // Into a cloud on a long step: back to halfway, so its edge is found as finely as inside.
                clear = 0;
                t -= dt;
            } else if (d > 0.002) {
                clear = 0;
                let od = toSun(p, l, lod > 0.5) * sigma;
                // Single scattering (Beer, the two-lobe phase), then light scattered many times inside the
                // cloud, nearly the same every way (what makes sunlit clouds bright white; it fades deep inside),
                // and the powder effect: edges facing away from the sun are darker (fewer paths into them).
                let single = phase * exp(-od);
                let multi = (0.2 * exp(-od * 0.25) + 0.1 * exp(-od * 0.06)) * multiPhase;
                let powder = mix(1.0, 1.0 - exp(-od * 2.0 - d * 0.5), 0.6 * smoothstep(0.3, -0.6, c));
                let sunPart = sunColor * (single + multi) * powder;
                let h = (altitude(p) - cloud.layer.x) / max(cloud.layer.y - cloud.layer.x, 1.0);
                // Light from all around: the sky's, half of its color taken out (clouds are grey, not blue).
                let sky = mix(skyLow * 0.5, skyTop, h) * 0.9;
                // With the sun low its light reaches under the clouds too, warmest at their bases.
                let glow = sunColor * 0.12 * smoothstep(0.35, 0.02, l.y) * step(0.0, l.y) * mix(1.0, 0.4, h);
                // Less of it low inside the cloud (the cloud above shades it): dark bases, bright tops.
                let ambient = (mix(vec3<f32>(dot(sky, vec3<f32>(0.2126, 0.7152, 0.0722))), sky, 0.5) + glow) * mix(0.45, 1.0, h);
                let stepT = exp(-d * sigma * dt);
                light += trans * (sunPart + ambient) * (1.0 - stepT);
                depthSum += t * trans * (1.0 - stepT);
                weight += trans * (1.0 - stepT);
                trans *= stepT;
                if (trans < 0.02) { break; }
                t += dt;
            } else {
                clear += 1;
                t += select(dt, dt * 2.0, clear > 1);
            }
        }
        // Far clouds fade into the sky behind them through the air.
        let dist = select(t0, depthSum / max(weight, 1e-4), weight > 0.0);
        let haze = 1.0 - exp(-dist * 1.6e-5 * cloud.wind.z);
        let sky = textureSampleLevel(prefilterMap, prefilterMapSampler, dir, 2.0).rgb * globalUniform.skyExposure;
        return vec4<f32>(mix(light, sky * (1.0 - trans), haze), trans);
    }
`;

// A cube face's texel (0..1 from the top left) as a direction, as WebGPU samples cubes.
const CUBE_DIR = /* wgsl */ `
    fn cubeDir(face: i32, uv: vec2<f32>) -> vec3<f32> {
        let s = uv.x * 2.0 - 1.0;
        let t = uv.y * 2.0 - 1.0;
        switch (face) {
            case 0: { return normalize(vec3<f32>(1.0, -t, -s)); }
            case 1: { return normalize(vec3<f32>(-1.0, -t, s)); }
            case 2: { return normalize(vec3<f32>(s, 1.0, t)); }
            case 3: { return normalize(vec3<f32>(s, -1.0, -t)); }
            case 4: { return normalize(vec3<f32>(s, -t, 1.0)); }
            default: { return normalize(vec3<f32>(-s, -t, -1.0)); }
        }
    }
`;

export let CloudMarch_cs: string = /* wgsl */ `
    #include "GlobalUniform"
    #include "GBufferStand"
    #include "LightData"

    @group(0) @binding(2) var<uniform> cloud: CloudSettings;
    @group(0) @binding(3) var<storage, read> lightBuffer: array<LightData>;
    @group(0) @binding(4) var shapeTex: texture_3d<f32>;
    @group(0) @binding(5) var shapeTexSampler: sampler;
    @group(0) @binding(20) var detailTex: texture_3d<f32>;
    @group(0) @binding(21) var detailTexSampler: sampler;
    @group(0) @binding(6) var prefilterMap: texture_cube<f32>;
    @group(0) @binding(7) var prefilterMapSampler: sampler;
    @group(0) @binding(8) var outTex: texture_storage_2d<rgba16float, write>;

    ${CLOUD_COMMON}
    ${SCENE_DISTANCE}
    ${CLOUD_MARCH}

    @compute @workgroup_size(8, 8, 1)
    fn CsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
        let size = textureDimensions(outTex);
        if (gid.x >= size.x || gid.y >= size.y) { return; }
        let full = vec2<f32>(textureDimensions(gBufferTexture));
        // This frame's pixel within the 4x4 block the quarter pixel covers.
        let px = vec2<f32>(gid.xy) * cloud.night.z + cloud.march.zw + 0.5;
        let uv = px / full;
        let far = min(sceneDistance(vec2<i32>(px), uv), cloud.night.y);
        // A random start for each ray and frame (gradient noise's regular pattern beats with a cloud's
        // surface into bands; this is noise the history averages away).
        let jitter = rand(vec3<u32>(gid.xy, u32(cloud.march.y)));
        // A pixel's angle, times the block one ray stands for.
        pixelSpread = length(viewRay(uv + vec2<f32>(1.0, 0.0) / full) - viewRay(uv)) * cloud.night.z;
        let out = marchClouds(globalUniform.CameraPos.xyz, viewRay(uv), far, cloud.march.x, jitter);
        textureStore(outTex, vec2<i32>(gid.xy), out);
    }
`;

export let CloudComposite_cs: string = /* wgsl */ `
    #include "GlobalUniform"
    #include "GBufferStand"
    #include "LightData"

    @group(0) @binding(2) var<uniform> cloud: CloudSettings;
    @group(0) @binding(3) var<storage, read> lightBuffer: array<LightData>;
    @group(0) @binding(4) var shapeTex: texture_3d<f32>;
    @group(0) @binding(5) var shapeTexSampler: sampler;
    @group(0) @binding(20) var detailTex: texture_3d<f32>;
    @group(0) @binding(21) var detailTexSampler: sampler;
    @group(0) @binding(6) var inTex: texture_2d<f32>;
    @group(0) @binding(7) var marchTex: texture_2d<f32>;
    @group(0) @binding(12) var marchTexSampler: sampler;
    @group(0) @binding(8) var historyTex: texture_2d<f32>;
    @group(0) @binding(9) var historyTexSampler: sampler;
    @group(0) @binding(10) var historyOut: texture_storage_2d<rgba16float, write>;
    @group(0) @binding(11) var outTex: texture_storage_2d<rgba16float, write>;

    ${CLOUD_COMMON}
    ${SCENE_DISTANCE}

    @compute @workgroup_size(8, 8, 1)
    fn CsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
        let size = textureDimensions(outTex);
        if (gid.x >= size.x || gid.y >= size.y) { return; }
        let px = vec2<i32>(gid.xy);
        let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size);
        let color = textureLoad(inTex, px, 0);
        let cam = globalUniform.CameraPos.xyz;
        let dir = viewRay(uv);

        // This frame's march at this pixel, filtered between the quarter pixels (each marched at its offset in the block).
        let qsize = vec2<f32>(textureDimensions(marchTex));
        let block = i32(cloud.night.z);
        let fresh = all((px % block) == vec2<i32>(cloud.march.zw));
        let quv = ((vec2<f32>(px) - cloud.march.zw) / cloud.night.z + 0.5) / qsize;
        let now = textureSampleLevel(marchTex, marchTexSampler, quv, 0.0);

        // The history where this point of the sky was last frame (clouds are far: by direction from the camera).
        let p = cam + dir * 4000.0;
        let prev = cloud.prevViewProj * vec4<f32>(p, 1.0);
        let puv = vec2<f32>(prev.x / prev.w * 0.5 + 0.5, 0.5 - prev.y / prev.w * 0.5);
        var result = now;
        if (prev.w > 0.0 && all(puv >= vec2<f32>(0.0)) && all(puv <= vec2<f32>(1.0)) && cloud.march.y > 0.5) {
            var old = textureSampleLevel(historyTex, historyTexSampler, puv, 0.0);
            // The history kept within what this frame's march sees around here (less smearing when things move).
            let q0 = clamp(vec2<i32>(floor(quv * qsize - 0.5)), vec2<i32>(0), vec2<i32>(qsize) - 2);
            let a = textureLoad(marchTex, q0, 0);
            let b = textureLoad(marchTex, q0 + vec2<i32>(1, 0), 0);
            let c = textureLoad(marchTex, q0 + vec2<i32>(0, 1), 0);
            let e = textureLoad(marchTex, q0 + vec2<i32>(1, 1), 0);
            let lo = min(min(a, b), min(c, e));
            let hi = max(max(a, b), max(c, e));
            let pad = (hi - lo) * 0.25 + vec4<f32>(0.02);
            old = clamp(old, lo - pad, hi + pad);
            result = mix(old, now, min(select(0.04, 0.35, fresh) * cloud.night.w, 0.7));
        }
        if (all((px % 2) == vec2<i32>(0))) {
            textureStore(historyOut, px / 2, result);
        }

        var out = color.rgb;
        let far = sceneDistance(px, uv);
        // Not over what is nearer than the layer (a sharp edge, not the quarter resolution's).
        let below = shell(cam, dir, cloud.layer.x);
        let near = select(0.0, max(below.y, 0.0), cam.y < cloud.layer.x && below.y > 0.0);
        // At night, stars and the moon's disc on the sky, behind the clouds.
        if (far > 1e8 && cloud.night.x > 0.0 && dir.y > 0.0) {
            let cellDir = dir * 420.0;
            let cell = floor(cellDir);
            let h = fract(sin(dot(cell, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
            let spot = 1.0 - smoothstep(0.08, 0.35, length(cellDir - cell - 0.5));
            let star = step(0.985, h) * spot * pow(h, 40.0) * 3.0;
            let moon = smoothstep(0.99985, 0.9999, dot(dir, sunDir()));
            out += (vec3<f32>(star) * smoothstep(0.0, 0.15, dir.y) + vec3<f32>(0.9, 0.93, 1.0) * moon * 1.5) * cloud.night.x * result.a;
        }
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
                let shade = clamp(density(at, 0.0) * 3.0, 0.0, 1.0) * cloud.wind.w;
                out *= 1.0 - shade * 0.65;
            }
        }
        textureStore(outTex, px, vec4<f32>(out, color.a));
    }
`;

/**
 * Clouds in the reflection cube (CloudPost.reflections): the scene's
 * environment cube becomes the sky with the clouds in it, so water, glossy
 * materials and the light from the sky show them. A face or all six per
 * frame (cloud.env.x the first, the dispatch's z the rest):
 *
 * - `CloudEnvMarch_cs` marches the clouds seen from the camera into a small
 *   cube (cloud.env.w per face), light divided by the sky's exposure.
 * - `CloudEnvDown_cs` averages a level of it into the next, smaller one.
 * - `CloudEnvComposite_cs` writes one level of the environment cube: the sky
 *   at the matching blur, through the clouds at a matching blur.
 *
 * @internal
 */
export let CloudEnvMarch_cs: string = /* wgsl */ `
    #include "GlobalUniform"
    #include "LightData"

    @group(0) @binding(2) var<uniform> cloud: CloudSettings;
    @group(0) @binding(3) var<storage, read> lightBuffer: array<LightData>;
    @group(0) @binding(4) var shapeTex: texture_3d<f32>;
    @group(0) @binding(5) var shapeTexSampler: sampler;
    @group(0) @binding(20) var detailTex: texture_3d<f32>;
    @group(0) @binding(21) var detailTexSampler: sampler;
    @group(0) @binding(6) var prefilterMap: texture_cube<f32>;
    @group(0) @binding(7) var prefilterMapSampler: sampler;
    @group(0) @binding(8) var outTex: texture_storage_2d_array<rgba16float, write>;

    ${CLOUD_COMMON}
    ${CLOUD_MARCH}
    ${CUBE_DIR}

    @compute @workgroup_size(8, 8, 1)
    fn CsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
        let size = textureDimensions(outTex);
        if (gid.x >= size.x || gid.y >= size.y) { return; }
        let face = (i32(cloud.env.x) + i32(gid.z)) % 6;
        let dir = cubeDir(face, (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size));
        // A fixed start for each texel: the cube is not gathered over frames.
        let jitter = fract(52.9829189 * fract(dot(vec2<f32>(gid.xy) + f32(face) * 17.0, vec2<f32>(0.06711056, 0.00583715))));
        pixelSpread = 1.6 / f32(size.x);
        let c = marchClouds(globalUniform.CameraPos.xyz, dir, cloud.night.y, cloud.env.y, jitter);
        textureStore(outTex, vec2<i32>(gid.xy), face, vec4<f32>(c.rgb / max(globalUniform.skyExposure, 1e-4), c.a));
    }
`;

export let CloudEnvDown_cs: string = /* wgsl */ `
    struct CloudSettings {
        prevViewProj: mat4x4<f32>,
        layer: vec4<f32>,
        shape: vec4<f32>,
        wind: vec4<f32>,
        march: vec4<f32>,
        env: vec4<f32>,
    };

    @group(0) @binding(0) var<uniform> cloud: CloudSettings;
    @group(0) @binding(1) var inTex: texture_2d_array<f32>;
    @group(0) @binding(2) var outTex: texture_storage_2d_array<rgba16float, write>;

    @compute @workgroup_size(8, 8, 1)
    fn CsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
        let size = textureDimensions(outTex);
        if (gid.x >= size.x || gid.y >= size.y) { return; }
        let face = (i32(cloud.env.x) + i32(gid.z)) % 6;
        let p = vec2<i32>(gid.xy) * 2;
        let sum = textureLoad(inTex, p, face, 0) + textureLoad(inTex, p + vec2<i32>(1, 0), face, 0)
            + textureLoad(inTex, p + vec2<i32>(0, 1), face, 0) + textureLoad(inTex, p + vec2<i32>(1, 1), face, 0);
        textureStore(outTex, vec2<i32>(gid.xy), face, sum * 0.25);
    }
`;

export let CloudEnvComposite_cs: string = /* wgsl */ `
    struct CloudSettings {
        prevViewProj: mat4x4<f32>,
        layer: vec4<f32>,
        shape: vec4<f32>,
        wind: vec4<f32>,
        march: vec4<f32>,
        env: vec4<f32>,
    };

    @group(0) @binding(2) var<uniform> cloud: CloudSettings;
    @group(0) @binding(3) var prefilterMap: texture_cube<f32>;
    @group(0) @binding(4) var prefilterMapSampler: sampler;
    @group(0) @binding(5) var cloudCube: texture_cube<f32>;
    @group(0) @binding(6) var cloudCubeSampler: sampler;
    @group(0) @binding(7) var outTex: texture_storage_2d_array<rgba16float, write>;

    ${CUBE_DIR}

    @compute @workgroup_size(8, 8, 1)
    fn CsMain(@builtin(global_invocation_id) gid: vec3<u32>) {
        let size = textureDimensions(outTex);
        if (gid.x >= size.x || gid.y >= size.y) { return; }
        let face = (i32(cloud.env.x) + i32(gid.z)) % 6;
        let dir = cubeDir(face, (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(size));
        // This level of the cube (0 the sharpest) and the matching level of the sky's own cube.
        let level = log2(cloud.env.z / f32(size.x));
        let levels = max(log2(cloud.env.z / 16.0), 1.0);
        let skyLevels = f32(textureNumLevels(prefilterMap)) - 1.0;
        let sky = textureSampleLevel(prefilterMap, prefilterMapSampler, dir, level / levels * skyLevels).rgb;
        // The clouds as blurred: as fine as this level's texels, more for the rough levels.
        let cloudLevels = f32(textureNumLevels(cloudCube)) - 1.0;
        let blur = clamp(log2(cloud.env.w / f32(size.x)) + max(level - 2.0, 0.0) * 0.75, 0.0, cloudLevels);
        let c = textureSampleLevel(cloudCube, cloudCubeSampler, dir, blur);
        textureStore(outTex, vec2<i32>(gid.xy), face, vec4<f32>(sky * c.a + c.rgb, 1.0));
    }
`;

// The assistant's scene tools: reading the project, creating, changing and
// deleting objects with their components (fields from core/model.ts), the
// environment, imported models' materials and parts, selection and views.

import { defaultCameraDoc, defaultGeometry, defaultLight, makeCameraNode, makeLightNode, makeMeshNode, makeNode } from '../core/defaults';
import { MATERIAL_PRESETS } from '../core/materialPresets';
import { defaultCharacter, defaultPlayer } from '../core/character';
import { Animation, ANIMATION_MODES, AudioSource, Body, Camera, Character, Environment, GEOMETRY_TYPES, Grass, Instancing, Light, Material, MaterialOverride, Mirror, Player, Rain, Terrain } from '../core/model';
import { layersOf } from './terrainTools';
import { defaults, patch, snakeKeys, toolSchema } from '../core/schema';
import type { GeometryType, LightType, MaterialDoc, NodeDoc, PartOverride, SceneDoc } from '../core/types';
import { assetImageDataUrl } from '../core/images';
import { isLevelObject, stageIndex } from '../core/design';
import { stageDef, type ToolGroup } from '../design/stages';
import { allowedGroups, hex, node, num, params, r3, rv, shader, ToolError, tools, v3, type Json, type ToolEnv } from './toolUtil';

// ------------------------------------------------------------------ schemas

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const TEXTURE_FIELDS = ['map', 'normal_map', 'metal_rough_map', 'ao_map', 'emissive_map'];
const materialSchema = toolSchema(Material, 'Material of a primitive. Settings left out keep their value.');
materialSchema.properties.preset = { type: 'string', enum: MATERIAL_PRESETS.map((p) => p.id), description: 'Start from a preset (keeps color and textures), then apply the other fields.' };
materialSchema.properties.shader = { type: ['string', 'null'], description: 'Material shader id or name; sets type to "shader". null goes back to lit.' };
const objectFields = {
    name: { type: 'string' },
    parent: { type: ['string', 'null'], description: 'Parent object id or name; null for the scene root.' },
    position: vec3,
    rotation: { ...vec3, description: 'Euler degrees.' },
    scale: vec3,
    visible: { type: 'boolean' },
    size: { type: 'array', items: { type: 'number' }, description: 'box, ramp, stairs: [width, height, depth]; plane: [width, length].' },
    radius: { type: 'number', description: 'sphere / torus / capsule radius, cone base radius, cylinder radius (both ends).' },
    radius_top: { type: 'number', description: 'cylinder: top radius, to taper it (0 closes it to a point).' },
    radius_bottom: { type: 'number', description: 'cylinder: bottom radius.' },
    height: { type: 'number', description: 'cylinder / cone height, capsule height (caps included)' },
    steps: { type: 'number', description: 'stairs: number of steps' },
    tube: { type: 'number', description: 'torus tube radius' },
    segments: { type: 'number', description: 'Round shapes: segments around. A cone with 8 or fewer has flat sides (4: a square pyramid).' },
    material: materialSchema,
    light: toolSchema(Light),
    camera: toolSchema(Camera),
    character: {
        ...toolSchema(Character, 'A character: in Play the object walks the level (stands on floors, walls and other characters stop it). The player controls one (player); an NPC is walked by its behavior tree (Move To) or a script (this.character). null removes it.'),
        type: ['object', 'null'],
    },
    player: {
        ...toolSchema(Player, 'The player controls this object\'s character (added when missing): WASD / a joystick walk, Space jumps, a drag turns its camera. null removes it. One player per scene: place it with place_player.'),
        type: ['object', 'null'],
    },
    animation: {
        ...toolSchema(Animation, 'Skeletal animation of an imported model with clips (list_model_parts lists them): the clip it plays, its speed and crossfade, and on a character the clip of each mode (idle, walk, run, jump, fall; empty picks a clip named for the mode). Scripts play clips with this.animator. null removes it.'),
        type: ['object', 'null'],
    },
    body: {
        ...toolSchema(Body, 'A physics body: in Play a dynamic one falls, collides and bounces; kinematic follows its object (scripts move it) and pushes dynamic bodies; fixed stays put. Meshes without a body are fixed, so the level holds what falls on it. Scripts use this.body and onCollisionEnter / onTriggerEnter. null removes it.'),
        type: ['object', 'null'],
    },
    mirror: {
        ...toolSchema(Mirror, 'Makes a mesh a planar mirror: it shows the scene reflected in the plane through its top (a plane\'s face, a box\'s top). With a built-in material it is a mirror tinted by the material color; with a material shader that reads mirrorColor(offset) it is water (write_shader template water). Each mirror draws the scene again: one or two per scene. null removes it.'),
        type: ['object', 'null'],
    },
    grass: {
        ...toolSchema(Grass, 'A field of grass blades (one draw for thousands) around the object, bent by wind gusts. ground (an object id or name: a terrain, floor or a group of them) is what the blades stand on, so the field follows any terrain; blades outside it or on steep slopes are left out. Without ground the field is flat at the object\'s height. size is in meters in the object\'s turned frame; count is the cost (up to 30000). null removes it.'),
        type: ['object', 'null'],
    },
    rain: {
        ...toolSchema(Rain, 'Rain falling through a box around the object (an empty object is best), drawn by one shader with drops at real places: they keep their size with distance, stop at the bottom of the box and lean with the wind. Keep the box in the open air with its bottom on the ground and its top above the walls; it costs by the share of the screen it covers and by spacing (smaller spacing, more drops, more cost). shelter (an object id or name: an awning, a porch roof) stays dry; light (a point or spot light, id or name) tints the drops falling near it. Use it for rain instead of particles. null removes it.'),
        type: ['object', 'null'],
    },
    audio: {
        ...toolSchema(AudioSource, 'A sound source: in Play the object plays an audio asset (clip: id or name; search_library kind audio finds sounds), heard from its place (spatial: louder near it, full volume within near meters, fading out up to far) or everywhere (spatial false: music). loop for ambience and music, autoplay off to start it from a script (this.audio.play()). Scripts play one-off sounds with this.playSound(name). null removes it.'),
        type: ['object', 'null'],
    },
    terrain: {
        ...toolSchema(Terrain, 'A terrain (create_terrain makes one; sculpt_terrain changes its heights and paint): size and height stretch its heightmap, detail is how far its full detail reaches, collide and cast_shadow; layers (a new list of up to four: slot, heights, slopes, height_blend, slope_blend, only_painted) are its surface, the first covering everything and each next one going over those before it where its rules hold. null removes it.'),
        type: ['object', 'null'],
    },
    scatter: { type: 'null', description: 'null removes the object\'s scatter (the scatter tool makes and changes scatters).' },
    instancing: {
        ...toolSchema(Instancing, 'Instanced drawing for placing many copies (trees, rocks, fence posts, crates): the meshes of this object and of every object under it that share a shape and a material (primitives, prefab instances, the same imported model) draw in one draw call per shape and material. Put the copies under one group with instancing ({}); moving them is free, adding or restyling regroups them. Skinned or animated meshes, transparent materials and mirrors draw on their own. null removes it.'),
        type: ['object', 'null'],
    },
    cast_shadow: { type: 'boolean' },
    receive_shadow: { type: 'boolean' },
};
const SHAPES = GEOMETRY_TYPES;
const TYPES = [...SHAPES, 'empty', 'grass', 'sound', 'directional_light', 'point_light', 'spot_light', 'camera'];

/** get_scene stays below this many characters (the agent cuts longer tool results at 30 000). */
const SCENE_RESULT_CHARS = 28_000;

export const sceneTools = tools({
    get_scene: {
        groups: ['read'],
        description: 'Summary of the project: objects (ids, types, transforms, materials, scripts), assets, scripts, shaders, render graph settings, selection and play state.',
        run({ ed, store, doc }) {
            const d = doc();
            // Parts of prefab instances follow their prefab: only the instances are listed.
            const listed = d.nodes.filter((n) => !n.prefabChild);
            const data: Json = {
                name: d.name,
                selection: store.selection,
                play_state: ed.player.state,
                environment: snakeKeys({
                    sky: d.environment.sky,
                    ...(d.environment.sky === 'color'
                        ? { skyColor: d.environment.skyColor }
                        : { sunX: d.environment.sunX, sunY: d.environment.sunY, atmosphere: d.environment.atmosphere }),
                    exposure: d.environment.exposure,
                    quality: d.environment.quality,
                    bloom: d.environment.bloom,
                    ao: d.environment.ao,
                    ssr: d.environment.ssr,
                    fog: d.environment.fog,
                    volumetricFog: d.environment.volumetricFog,
                    godRays: d.environment.godRays,
                    shadow: d.environment.shadow,
                    fxaa: d.environment.fxaa,
                    gi: d.environment.gi,
                }) as Json,
                prefabs: d.prefabs.map((p) => ({ id: p.id, name: p.name, instances: d.nodes.filter((n) => n.prefab === p.id).length, parts: p.nodes.length, ...(p.useModel ? { model: true } : {}) })),
                assets: d.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
                scripts: d.scripts.map((s) => {
                    const c = ed.compiler.get(s.id);
                    if (c?.paused) return { id: s.id, name: s.name, paused: true };
                    return { id: s.id, name: s.name, ok: !c?.error, ...(c?.error ? { error: `line ${c.error.line}: ${c.error.message}` } : {}) };
                }),
                shaders: d.shaders.map((s) => ({ id: s.id, name: s.name, kind: s.kind, lighting: s.kind === 'material' ? s.lighting : undefined, state: ed.shaders.status(s.id).state })),
                render_graph: { disabled_passes: d.renderGraph.disabled, post_effects: d.renderGraph.posts.map((p) => ({ id: p.id, shader: p.shader, enabled: p.enabled })) },
            };
            // Objects come last and fit what a tool result may hold (longer
            // results are cut): full entries first, then only id and name.
            let room = SCENE_RESULT_CHARS - JSON.stringify(data).length;
            const objects: Json[] = [];
            const more: Json[] = [];
            for (const n of listed) {
                const full = more.length ? null : nodeSummary(d, n);
                const entry = full && JSON.stringify(full).length + 1 <= room - 4000 ? full : { id: n.id, name: n.name };
                const size = JSON.stringify(entry).length + 1;
                if (size > room) break;
                room -= size;
                (entry === full ? objects : more).push(entry);
            }
            data.objects = objects;
            if (more.length) data.more_objects = more;
            const left = listed.length - objects.length - more.length;
            if (more.length || left) data.note = `${more.length ? `${more.length} objects are listed by id and name only (get_object gives the details)` : ''}${more.length && left ? '; ' : ''}${left ? `${left} more objects are not listed` : ''}.`;
            return { summary: `${d.nodes.length} objects`, data };
        },
    },
    get_object: {
        groups: ['read'],
        description: 'Full details of one object, including its world position and bounding box.',
        params: { id: { type: 'string', description: 'Object id or name.' } },
        required: ['id'],
        run({ args, ed, doc }) {
            const n = node(doc(), args.id);
            const box = ed.picker.bounds(n.id);
            const m = ed.picker.worldMatrix(n.id);
            const out: Json = { ...nodeSummary(doc(), n), raw: n };
            if (m) out.world_position = rv([m[12], m[13], m[14]]);
            if (box) out.bounds = { min: rv(box.min), max: rv(box.max), size: rv([box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]]) };
            const children = doc().nodes.filter((c) => c.parent === n.id).map((c) => c.id);
            if (children.length) out.children = children;
            const drawn = ed.sync.instancingOf(n.id);
            if (drawn) out.instancing = { meshes: drawn.meshes, draw_calls: drawn.draws };
            return { data: out, summary: n.name };
        },
    },
    create_objects: {
        groups: ['objects', 'lights', 'effects'],
        description: 'Create primitives, lights, cameras or empty groups. Returns their ids.',
        params: {
            objects: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: TYPES }, ...objectFields }, required: ['type'] } },
        },
        required: ['objects'],
        run({ env, args, store, doc }) {
            const specs: Json[] = Array.isArray(args.objects) ? args.objects : [];
            if (!specs.length) throw new ToolError('objects is empty.');
            const policy = new StagePolicy(env);
            for (const spec of specs) {
                const err = policy.create(String(spec.type), spec) || (spec.material ? policy.update({ name: spec.name ?? spec.type } as NodeDoc, { material: spec.material }) : '');
                if (err) throw new ToolError(err);
            }
            const created: NodeDoc[] = [];
            const d = JSON.parse(JSON.stringify(doc())) as SceneDoc;
            for (const spec of specs) {
                const n = makeTyped(String(spec.type));
                if (!n.camera && spec.camera) throw new ToolError('camera settings need type "camera".');
                applyFields(env, d, n, spec, created);
                n.name = uniqueIn(d, created, spec.name ? n.name : n.name, n.parent);
                created.push(n);
            }
            store.commit('AI: Create Objects', (dd) => {
                dd.nodes.push(...created);
                // Only one camera is used by Play: a new camera becomes main when
                // asked to, or when there is no main camera yet.
                for (const c of created.filter((n) => n.camera)) {
                    const spec = specs[created.indexOf(c)];
                    const others = dd.nodes.filter((n) => n.camera && n !== c);
                    const wantMain = spec.camera?.main === true || !others.some((n) => n.camera!.main);
                    c.camera!.main = spec.camera?.main === false ? false : wantMain;
                    if (c.camera!.main) for (const o of others) o.camera!.main = false;
                }
            });
            return { data: { created: created.map((n) => ({ id: n.id, name: n.name })), ...(policy.warnings.size ? { note: [...policy.warnings].join(' ') } : {}) }, summary: created.map((n) => n.name).join(', ') };
        },
    },
    update_objects: {
        groups: ['objects', 'lights', 'materials', 'effects'],
        description: 'Change objects: name, parent, transform, visibility, material, primitive size, light or camera settings.',
        params: {
            updates: {
                type: 'array',
                items: { type: 'object', properties: { id: { type: 'string' }, shape: { type: 'string', enum: SHAPES }, ...objectFields }, required: ['id'] },
            },
        },
        required: ['updates'],
        run({ env, args, store, doc }) {
            const updates: Json[] = Array.isArray(args.updates) ? args.updates : [];
            if (!updates.length) throw new ToolError('updates is empty.');
            const policy = new StagePolicy(env);
            for (const u of updates) {
                const err = policy.update(node(doc(), u.id), u);
                if (err) throw new ToolError(err);
            }
            // Validate against a copy first so a bad entry changes nothing.
            const draft = JSON.parse(JSON.stringify(doc())) as SceneDoc;
            for (const u of updates) applyFields(env, draft, node(draft, u.id), u, []);
            store.commit('AI: Edit Objects', (d) => {
                d.nodes = draft.nodes;
            });
            return { data: { updated: updates.length, ...(policy.warnings.size ? { note: [...policy.warnings].join(' ') } : {}) }, summary: `${updates.length} object(s)` };
        },
    },
    delete_objects: {
        groups: ['objects', 'lights', 'effects'],
        description: 'Delete objects and their children.',
        params: { ids: { type: 'array', items: { type: 'string' } } },
        required: ['ids'],
        run({ env, args, store, doc }) {
            const ids: string[] = (Array.isArray(args.ids) ? args.ids : []).map((r: unknown) => node(doc(), r).id);
            const policy = new StagePolicy(env);
            for (const id of ids) {
                const err = policy.remove(store.node(id)!);
                if (err) throw new ToolError(err);
            }
            const all = new Set<string>();
            for (const id of ids) {
                all.add(id);
                for (const c of store.descendants(id)) all.add(c.id);
            }
            store.commit('AI: Delete Objects', (d) => {
                d.nodes = d.nodes.filter((n) => !all.has(n.id));
            });
            store.select(store.selection.filter((id) => !all.has(id)));
            return { data: { deleted: all.size, ...(policy.warnings.size ? { note: [...policy.warnings].join(' ') } : {}) }, summary: `${all.size} object(s)` };
        },
    },
    set_environment: {
        groups: ['environment'],
        description: 'Change sky, exposure, shadows, fog and post processing settings. sky: atmospheric (fast, the default), physical (physically based: deeper sunsets and dusk, optional clouds; slower to change) or color; sun_x/sun_y place the sky\'s sun (keep it where the sun light comes from: apply_key_light does), atmosphere sets the sun disc (sun_size, sun_brightness, show_sun), the viewer\'s altitude and the physical sky\'s clouds. shadow.softness blurs every shadow\'s edges; what each shadow map covers, its size and redraws are the light\'s own (light.shadow in update_objects). ssr adds screen space reflections to smooth surfaces (polished floors, wet streets, metal; only what is on screen). fog.mode: linear (clear at near, full at far), exponential (density per meter past near) or height (thick low down, thinning up by height_falloff per meter: valleys, mist). god_rays needs a directional light that casts shadows; volumetric_fog is sunlit haze without shafts; ao grounds objects in their surroundings. quality is the graphics tier of built games (auto picks per device). Budgets of the costly effects (lower them when review_performance finds the frame over budget): bloom.levels and bloom.blur (blur samples grow with its square), fxaa_span, ssr.resolution and ssr.reach, gi.probes_per_frame and gi.update_every.',
        params: environmentFields(),
        run({ args, ed, store, doc }) {
            const { scene_name: name, ...rest } = args;
            const { fit_to_scene: fit, ...gi } = (rest.gi ?? {}) as Json;
            const environment = patch(Environment, doc().environment, { ...rest, ...(rest.gi ? { gi } : {}) }, 'environment', hex);
            store.commit('AI: Environment', (d) => {
                if (name !== undefined) d.name = String(name).trim() || d.name;
                d.environment = environment;
            }, { env: true });
            if (fit) ed.fitGIToScene();
            const g = doc().environment.gi;
            return { data: { ok: true, gi: g.enable ? { counts: g.counts, spacing: g.spacing, center: g.center, error: ed.runtime.gi.error || undefined } : undefined } };
        },
    },
    list_model_parts: {
        groups: ['read'],
        description: 'Material slots, mesh parts and animation clips of an imported model object, with their current values and overrides.',
        params: { id: { type: 'string' } },
        required: ['id'],
        run({ args, ed, doc }) {
            const n = node(doc(), args.id);
            if (!n.model) throw new ToolError(`"${n.name}" is not an imported model.`);
            const info = ed.sync.modelInfo(n.id);
            if (!info) return { data: { status: ed.sync.modelState(n.id)?.status ?? 'loading', note: 'The model has not finished loading; try again shortly.' } };
            const mats = n.model.materials ?? {};
            const parts = n.model.parts ?? {};
            return {
                summary: `${info.slots.length} materials, ${info.parts.length} meshes`,
                data: {
                    slots: info.slots.map((s) => ({
                        key: s.key,
                        meshes: s.parts.length,
                        file: {
                            color: s.base.color, opacity: r3(s.base.opacity), metallic: r3(s.base.metallic), roughness: r3(s.base.roughness),
                            emissive: s.base.emissive, emissive_intensity: r3(s.base.emissiveIntensity), double_side: s.base.doubleSide, has_texture: s.base.hasMap,
                            alpha: s.base.alpha.toLowerCase(), pbr: s.base.pbr,
                            ...(s.base.transmission ? { transmission: r3(s.base.transmission) } : {}),
                            ...(s.base.clearcoat ? { clearcoat: r3(s.base.clearcoat) } : {}),
                        },
                        ...(mats[s.key] ? { override: mats[s.key] } : {}),
                    })),
                    parts: info.parts.slice(0, 300).map((p) => ({ path: p.path, name: p.name, slot: p.slot, triangles: p.triangles, ...(parts[p.path] ? { override: parts[p.path] } : {}) })),
                    ...(info.parts.length > 300 ? { truncated: info.parts.length - 300 } : {}),
                    ...(info.clips.length ? { clips: info.clips } : {}),
                },
            };
        },
    },
    set_model_material: {
        groups: ['materials'],
        description: 'Override a material slot of imported model objects. Missing fields keep their value; reset clears the slot. Each slot can get its own shading: the file\'s PBR material, unlit, lambert, or a custom material shader.',
        params: {
            ids: { type: 'array', items: { type: 'string' } },
            slot: { type: 'string' },
            reset: { type: 'boolean' },
            ...toolSchema(MaterialOverride).properties,
            map: { type: ['string', 'null'], description: 'Texture asset id, null for none, "file" for the model\'s own.' },
            alpha_mode: { type: 'string', enum: ['auto', 'opaque', 'blend', 'mask', 'additive', 'multiply'], description: 'auto keeps the file\'s mode.' },
            shader: { type: ['string', 'null'], description: 'Material shader id or name to replace the material; null removes it. Texture properties named normalMap, maskMap, emissiveMap or aoMap get the model\'s own maps unless params sets them.' },
        },
        required: ['ids', 'slot'],
        run({ args, ed, doc }) {
            const ids = modelIds(doc(), args.ids);
            const slot = String(args.slot ?? '');
            const info = ed.sync.modelInfo(ids[0]);
            if (info && !info.slot(slot)) throw new ToolError(`No material slot "${slot}". Slots: ${info.slots.map((s) => s.key).join(', ')}`);
            if (args.reset) {
                ed.setModelMaterial(ids, slot, null, 'AI: Reset Model Material');
                return { data: { ok: true } };
            }
            const { ids: _ids, slot: _slot, reset: _reset, shading, alpha_mode: alphaMode, map, shader: shaderRef, params: values, ...fields } = args;
            const change: Partial<MaterialOverride> = patch(MaterialOverride, {}, fields, 'material', hex);
            // "model", "auto" and "file" keep the file's own shading, alpha mode and texture.
            if (shading !== undefined) change.shading = shading === 'model' ? undefined : patch(MaterialOverride, {}, { shading }, 'material').shading;
            if (alphaMode !== undefined) change.alphaMode = alphaMode === 'auto' ? undefined : patch(MaterialOverride, {}, { alpha_mode: alphaMode }, 'material').alphaMode;
            if (map !== undefined) change.map = map === 'file' ? undefined : textureId(doc(), map, 'map');
            if (shaderRef !== undefined) {
                if (shaderRef === null) change.shader = undefined;
                else {
                    const s = shader(doc(), shaderRef);
                    if (s.kind !== 'material') throw new ToolError(`"${s.name}" is a post shader.`);
                    change.shader = s.id;
                }
            }
            if (values !== undefined) {
                const cur = doc().nodes.find((n) => n.id === ids[0])?.model?.materials?.[slot]?.params ?? {};
                change.params = { ...cur, ...params(values) };
            }
            ed.setModelMaterial(ids, slot, change, 'AI: Model Material');
            return { data: { ok: true }, summary: slot };
        },
    },
    set_model_part: {
        groups: ['objects'],
        description: 'Override a mesh part of imported model objects (visibility, shadows, material slot, local transform). reset clears the part.',
        params: {
            ids: { type: 'array', items: { type: 'string' } },
            path: { type: 'string' },
            reset: { type: 'boolean' },
            visible: { type: 'boolean' },
            cast_shadow: { type: 'boolean' },
            receive_shadow: { type: 'boolean' },
            material_slot: { type: 'string' },
            position: vec3,
            rotation: vec3,
            scale: vec3,
        },
        required: ['ids', 'path'],
        run({ args, ed, doc }) {
            const ids = modelIds(doc(), args.ids);
            const path = String(args.path ?? '');
            const info = ed.sync.modelInfo(ids[0]);
            if (info && !info.part(path)) throw new ToolError(`No mesh part "${path}". Call list_model_parts.`);
            if (args.reset) {
                ed.setModelPart(ids, path, null, 'AI: Reset Mesh');
                return { data: { ok: true } };
            }
            const patch: Partial<PartOverride> = {};
            if (args.visible !== undefined) patch.visible = args.visible ? undefined : false;
            if (args.cast_shadow !== undefined) patch.castShadow = !!args.cast_shadow;
            if (args.receive_shadow !== undefined) patch.receiveShadow = !!args.receive_shadow;
            if (args.material_slot !== undefined) {
                if (info && !info.slot(args.material_slot)) throw new ToolError(`No material slot "${args.material_slot}".`);
                patch.material = args.material_slot;
            }
            if (args.position !== undefined) patch.position = v3(args.position, 'position');
            if (args.rotation !== undefined) patch.rotation = v3(args.rotation, 'rotation');
            if (args.scale !== undefined) patch.scale = v3(args.scale, 'scale');
            ed.setModelPart(ids, path, patch, 'AI: Mesh Part');
            return { data: { ok: true }, summary: path };
        },
    },
    add_model: {
        groups: ['objects'],
        description: 'Add another instance of an imported model asset to the scene.',
        params: { asset: { type: 'string' }, name: { type: 'string' }, position: vec3 },
        required: ['asset'],
        run({ args, ed, doc }) {
            const asset = doc().assets.find((a) => (a.id === args.asset || a.name === args.asset) && a.kind === 'model');
            if (!asset) throw new ToolError(`No model asset "${args.asset}".`);
            const before = new Set(doc().nodes.map((n) => n.id));
            ed.addModel(asset.id, args.position !== undefined ? v3(args.position, 'position') : undefined);
            const created = doc().nodes.find((n) => !before.has(n.id));
            if (created && args.name) ed.rename(created.id, String(args.name));
            return { data: { id: created?.id }, summary: asset.name };
        },
    },
    select_objects: {
        groups: ['read'],
        description: 'Select objects in the editor and frame them in the view.',
        params: { ids: { type: 'array', items: { type: 'string' } } },
        required: ['ids'],
        run({ args, ed, store, doc }) {
            const ids = (Array.isArray(args.ids) ? args.ids : []).map((r: unknown) => node(doc(), r).id);
            store.select(ids);
            if (ids.length) ed.viewport.frameNodes(ids);
            return { data: { ok: true } };
        },
    },
    view_images: {
        groups: ['read'],
        description: 'Look at images of the project again: concept images, paintovers, captures, swatches or images the user attached, by asset id. They are shown in the next message (vision models only).',
        params: {
            assets: { type: 'array', items: { type: 'string' }, description: 'Asset ids (at most 6).' },
        },
        required: ['assets'],
        async run({ env, args, doc }) {
            const refs: unknown[] = Array.isArray(args.assets) ? args.assets.slice(0, 6) : [];
            if (!refs.length) throw new ToolError('assets is empty.');
            const images: string[] = [];
            const shown: string[] = [];
            const missing: string[] = [];
            for (const ref of refs) {
                const meta = doc().assets.find((a) => a.id === ref && (a.kind === 'image' || a.kind === 'texture'));
                const url = meta ? await assetImageDataUrl(meta.id, env.imageSize()).catch(() => null) : null;
                if (url && meta) {
                    images.push(url);
                    shown.push(`${meta.name} (${meta.id})`);
                } else missing.push(String(ref));
            }
            if (!images.length) throw new ToolError(`No images found for ${missing.join(', ')}.`);
            return {
                data: { shown, ...(missing.length ? { missing } : {}), note: 'The images are attached in the next message, in this order.' },
                images,
                summary: `${images.length} image${images.length === 1 ? '' : 's'}`,
            };
        },
    },
    capture_viewport: {
        groups: ['read'],
        needs: 'screenshots',
        description: 'Take a picture of the viewport as it is now (the editor view, or the game camera while playing).',
        async run({ env, ed }) {
            const image = await ed.runtime.capture(env.imageSize());
            return { data: { ok: true, note: 'The screenshot is attached in the next message.' }, image, summary: 'screenshot' };
        },
    },
});

/** set_environment's arguments: the environment's fields, the scene name and fitting GI to the scene. */
function environmentFields(): Json {
    const props = toolSchema(Environment).properties;
    props.gi.description = 'Dynamic diffuse global illumination (DDGI): a probe grid bounces light between surfaces. Surfaces more than one spacing outside the grid get no indirect light. fit_to_scene sizes the grid to the meshes.';
    props.gi.properties.fit_to_scene = { type: 'boolean' };
    return { scene_name: { type: 'string' }, ...props };
}

// ---------------------------------------------------------------- helpers

function nodeType(n: NodeDoc): string {
    if (n.light) return `${n.light.type}_light`;
    if (n.camera) return 'camera';
    if (n.model) return 'model';
    if (n.mesh) return n.mesh.geometry.type;
    if (n.particles) return 'particles';
    if (n.grass) return 'grass';
    if (n.rain && !n.mesh && !n.model) return 'rain';
    if (n.terrain) return 'terrain';
    if (n.scatter) return 'scatter';
    if (n.audio) return 'sound';
    return 'empty';
}

function materialSummary(m: MaterialDoc): Json {
    const out: Json = { type: m.type, color: m.color };
    if (m.opacity < 1) out.opacity = r3(m.opacity);
    if (m.alphaMode && m.alphaMode !== 'auto') out.alpha_mode = m.alphaMode;
    if (m.type === 'lit' || m.type === 'shader') {
        out.metallic = r3(m.metallic);
        out.roughness = r3(m.roughness);
    }
    for (const [field, key] of [['normalMap', 'normal_map'], ['metalRoughMap', 'metal_rough_map'], ['aoMap', 'ao_map'], ['emissiveMap', 'emissive_map']] as const) {
        if (m[field]) out[key] = m[field];
    }
    if (m.clearcoat) out.clearcoat = r3(m.clearcoat);
    if (m.transmission) {
        out.transmission = r3(m.transmission);
        out.ior = r3(m.ior ?? 1.5);
    }
    if (m.tiling && (m.tiling[0] !== 1 || m.tiling[1] !== 1)) out.tiling = m.tiling;
    if (m.emissive !== '#000000' && m.emissiveIntensity > 0) {
        out.emissive = m.emissive;
        out.emissive_intensity = r3(m.emissiveIntensity);
    }
    if (m.map) out.map = m.map;
    if (m.type === 'shader') {
        out.shader = m.shader;
        if (m.params && Object.keys(m.params).length) out.params = m.params;
    }
    return out;
}

function nodeSummary(doc: SceneDoc, n: NodeDoc): Json {
    const out: Json = { id: n.id, name: n.name, type: n.prefab ? 'prefab_instance' : nodeType(n) };
    if (n.prefab) out.prefab = doc.prefabs.find((p) => p.id === n.prefab)?.name ?? n.prefab;
    if (n.prefabChild) out.prefab_part = true;
    if (n.parent) out.parent = n.parent;
    out.position = rv(n.position);
    if (n.rotation.some((v) => v !== 0)) out.rotation = rv(n.rotation);
    if (n.scale.some((v) => v !== 1)) out.scale = rv(n.scale);
    if (!n.visible) out.visible = false;
    if (n.mesh) {
        out.material = materialSummary(n.mesh.material);
        const g: Json = { ...n.mesh.geometry };
        delete g.type;
        out.geometry = g;
    }
    if (n.light) {
        const sh = n.light.shadow;
        const shadow = n.light.castShadow && sh ? (n.light.type === 'directional' ? { resolution: sh.resolution, update: sh.update, coverage: sh.coverage, range: sh.range, ...(sh.coverage === 'cascades' ? { cascades: sh.cascades } : {}) } : { resolution: sh.resolution, update: sh.update }) : undefined;
        out.light = { color: n.light.color, intensity: n.light.intensity, cast_shadow: n.light.castShadow, ...(shadow ? { shadow } : {}), ...(n.light.type !== 'directional' ? { range: n.light.range } : {}), ...(n.light.type === 'spot' ? { outer_angle: n.light.outerAngle } : {}) };
    }
    if (n.camera) out.camera = { ...n.camera };
    if (n.character) {
        const c = n.character;
        out.character = { speed: c.speed, run_speed: c.runSpeed, jump: c.jump, height: c.height, radius: c.radius, eye_height: c.eyeHeight, step_height: c.stepHeight, ...(c.collide ? {} : { collide: false }) };
    }
    if (n.player) {
        const p = n.player;
        out.player = { view: p.view, ...(p.view === 'third' ? { distance: p.distance } : {}) };
    }
    if (n.animation) {
        const a = n.animation;
        out.animation = { clip: a.clip || 'first', ...(a.speed !== 1 ? { speed: a.speed } : {}), ...Object.fromEntries(ANIMATION_MODES.filter((m) => a[m]).map((m) => [m, a[m]])) };
    }
    if (n.body) {
        const b = n.body;
        out.body = { type: b.type, ...(b.shape !== 'auto' ? { shape: b.shape } : {}), ...(b.type === 'dynamic' ? { mass: b.mass } : {}), ...(b.sensor ? { sensor: true } : {}) };
    }
    if (n.particles) {
        const p = n.particles;
        out.particles = { preset: p.preset, rate: p.rate, life: p.life, size: p.size, shape: p.shape, blend: p.blend, colors: [p.colorStart, p.colorEnd], alive_at_most: Math.min(p.max, Math.ceil(p.rate * p.life[1])) };
    }
    if (n.mirror) out.mirror = { resolution: n.mirror.resolution };
    if (n.grass) {
        const g = n.grass;
        out.grass = { count: g.count, size: g.size, ground: g.ground, height: g.height, colors: [g.bottomColor, g.topColor], wind: g.wind };
    }
    if (n.rain) {
        const r = n.rain;
        out.rain = { size: r.size, amount: r.amount, spacing: r.spacing, speed: r.speed, wind: r.wind, ...(r.shelter ? { shelter: r.shelter } : {}), ...(r.light ? { light: r.light } : {}) };
    }
    if (n.terrain) {
        const t = n.terrain;
        out.terrain = {
            size: t.size,
            height: t.height,
            layers: t.layers.map((l) => ({ slot: doc.design.materials.find((s) => s.id === l.slot)?.name ?? l.slot, heights: l.height, slopes: l.slope, ...(l.onlyPainted ? { only_painted: true } : {}) })),
            ...(t.splatmap ? { painted: true } : {}),
            ...(t.collide ? {} : { collide: false }),
        };
    }
    if (n.scatter) {
        const s = n.scatter;
        out.scatter = {
            sources: s.sources.map((x) => ({ model: doc.assets.find((a) => a.id === x.model)?.name ?? x.model, weight: x.weight, solid: x.solid })),
            count: s.count,
            size: s.size,
            spacing: s.spacing,
            ground: s.ground,
            ...(s.avoid.length ? { avoid: s.avoid } : {}),
            ...(s.distance ? { distance: s.distance } : {}),
        };
    }
    if (n.instancing) out.instancing = true;
    if (n.audio) {
        const a = n.audio;
        out.audio = { clip: doc.assets.find((x) => x.id === a.clip)?.name ?? null, volume: a.volume, loop: a.loop, autoplay: a.autoplay, spatial: a.spatial, ...(a.spatial ? { near: a.near, far: a.far } : {}), ...(a.pitch !== 1 ? { pitch: a.pitch } : {}) };
    }
    if (n.model) {
        out.model = { asset: n.model.asset, asset_name: doc.assets.find((a) => a.id === n.model!.asset)?.name };
        const o = Object.keys(n.model.materials ?? {}).length + Object.keys(n.model.parts ?? {}).length;
        if (o) out.model.overrides = o;
    }
    if (n.scripts?.length) {
        out.scripts = n.scripts.map((r) => ({
            script: doc.scripts.find((s) => s.id === r.script)?.name ?? r.script,
            ...(r.enabled ? {} : { enabled: false }),
            ...(Object.keys(r.props).length ? { props: r.props } : {}),
        }));
    }
    return out;
}

function resolveParent(doc: SceneDoc, ref: unknown, batch: NodeDoc[], what = 'parent'): string | null {
    if (ref === null || ref === undefined || ref === '') return null;
    if (typeof ref !== 'string') throw new ToolError(`${what} must be an object id or name.`);
    const found = batch.find((n) => n.id === ref || n.name === ref) ?? doc.nodes.find((n) => n.id === ref) ?? doc.nodes.find((n) => n.name === ref);
    if (!found) throw new ToolError(`${what}: "${ref}" does not exist.`);
    return found.id;
}

/** Applies the shared object fields (create and update) to a node. */
function applyFields(env: ToolEnv, doc: SceneDoc, n: NodeDoc, spec: Json, batch: NodeDoc[]) {
    if (spec.name !== undefined) n.name = String(spec.name).trim() || n.name;
    if (spec.parent !== undefined) {
        const p = resolveParent(doc, spec.parent, batch);
        if (p === n.id) throw new ToolError('An object cannot be its own parent.');
        // Nor go under one of its own descendants: the hierarchy would loop.
        const lookup = (id: string) => batch.find((b) => b.id === id) ?? doc.nodes.find((x) => x.id === id);
        for (let cur = p, steps = 0; cur && steps <= doc.nodes.length + batch.length; cur = lookup(cur)?.parent ?? null, steps++) {
            if (cur === n.id) throw new ToolError(`"${n.name}" cannot go under "${lookup(p!)?.name ?? p}", which is inside it.`);
        }
        n.parent = p;
    }
    if (spec.position !== undefined) n.position = v3(spec.position, 'position');
    if (spec.rotation !== undefined) n.rotation = v3(spec.rotation, 'rotation');
    if (spec.scale !== undefined) n.scale = v3(spec.scale, 'scale');
    if (spec.visible !== undefined) n.visible = !!spec.visible;
    if (n.mesh) {
        if (spec.shape !== undefined && spec.shape !== n.mesh.geometry.type) {
            if (!SHAPES.includes(spec.shape)) throw new ToolError(`Unknown shape "${spec.shape}".`);
            n.mesh.geometry = defaultGeometry(spec.shape as GeometryType);
        }
        const g = n.mesh.geometry as any;
        if (spec.size !== undefined) {
            const s = Array.isArray(spec.size) ? spec.size.map((x: unknown) => num(x, 'size')) : [num(spec.size, 'size')];
            if (g.type === 'box' || g.type === 'ramp' || g.type === 'stairs') [g.width, g.height, g.depth] = [s[0], s[1] ?? s[0], s[2] ?? s[0]];
            else if (g.type === 'plane') [g.width, g.height] = [s[0], s[1] ?? s[0]];
            else if (g.type === 'sphere') g.radius = s[0] / 2;
        }
        if (spec.radius !== undefined) {
            const r = num(spec.radius, 'radius');
            if (g.type === 'cylinder') g.radiusTop = g.radiusBottom = r;
            else if ('radius' in g) g.radius = r;
        }
        if (spec.radius_top !== undefined && g.type === 'cylinder') g.radiusTop = Math.max(0, num(spec.radius_top, 'radius_top'));
        if (spec.radius_bottom !== undefined && g.type === 'cylinder') g.radiusBottom = Math.max(0, num(spec.radius_bottom, 'radius_bottom'));
        if (spec.height !== undefined && 'height' in g) g.height = num(spec.height, 'height');
        if (spec.tube !== undefined && g.type === 'torus') g.tube = num(spec.tube, 'tube');
        if (spec.steps !== undefined && g.type === 'stairs') g.steps = Math.max(1, Math.round(num(spec.steps, 'steps')));
        if (spec.segments !== undefined && 'segments' in g) g.segments = Math.round(num(spec.segments, 'segments'));
        if (spec.cast_shadow !== undefined) n.mesh.castShadow = !!spec.cast_shadow;
        if (spec.receive_shadow !== undefined) n.mesh.receiveShadow = !!spec.receive_shadow;
        if (spec.material) n.mesh.material = applyMaterial(doc, n.mesh.material, spec.material);
    } else if (spec.material) {
        throw new ToolError(`"${n.name}" has no mesh. Use set_model_material for imported models.`);
    }
    if (spec.light) {
        if (!n.light) throw new ToolError(`"${n.name}" is not a light.`);
        const type = spec.light.type as LightType | undefined;
        // Another type starts from that type's defaults, in the same color.
        const base = type !== undefined && type !== n.light.type && Light.shape.type.safeParse(type).success ? { ...defaultLight(type), color: n.light.color } : n.light;
        n.light = patch(Light, base, spec.light, 'light', hex);
    }
    if (spec.character === null) {
        delete n.character;
        delete n.player;
    } else if (spec.character || spec.player) {
        if (n.light || n.camera || n.particles || n.body) throw new ToolError(`"${n.name}" cannot be a character (lights, cameras, particles and physics bodies cannot).`);
        n.character = patch(Character, n.character ?? defaultCharacter(doc.design.specs), spec.character ?? {}, 'character');
    }
    if (spec.player === null) delete n.player;
    else if (spec.player) {
        const other = doc.nodes.find((o) => o.player && o.id !== n.id) ?? batch.find((o) => o.player && o !== n);
        if (other) throw new ToolError(`"${other.name}" is the player already: one player per scene. Move it with place_player.`);
        if (!n.character) throw new ToolError('The player controls a character: give the object one (character) too.');
        n.player = patch(Player, n.player ?? defaultPlayer(), spec.player, 'player');
    }
    if (spec.animation === null) delete n.animation;
    else if (spec.animation) {
        if (!n.model) throw new ToolError(`"${n.name}" is not an imported model: only models have animation clips.`);
        n.animation = patch(Animation, n.animation ?? defaults(Animation), spec.animation, 'animation');
    }
    if (spec.body === null) delete n.body;
    else if (spec.body) {
        if (n.light || n.camera || n.particles || n.character) throw new ToolError(`"${n.name}" cannot have a physics body (lights, cameras, particles and characters cannot).`);
        n.body = patch(Body, n.body ?? defaults(Body), spec.body, 'body');
    }
    if (spec.camera) {
        if (!n.camera) throw new ToolError(`"${n.name}" is not a camera.`);
        n.camera = patch(Camera, n.camera, spec.camera, 'camera');
        if (spec.camera.main) for (const o of doc.nodes) if (o !== n && o.camera) o.camera.main = false;
    }
    if (spec.mirror === null) delete n.mirror;
    else if (spec.mirror) {
        if (!n.mesh) throw new ToolError(`"${n.name}" has no mesh: a mirror is a mesh (a plane, a box) whose top reflects.`);
        n.mirror = patch(Mirror, n.mirror ?? defaults(Mirror), spec.mirror, 'mirror');
    }
    if (spec.grass === null) delete n.grass;
    else if (spec.grass) {
        const { ground, texture, wind_map: windMap, ...fields } = spec.grass as Json;
        const g = patch(Grass, n.grass ?? defaults(Grass), fields, 'grass', hex);
        if (ground !== undefined) {
            g.ground = resolveParent(doc, ground, batch, 'grass.ground');
            if (g.ground === n.id && !n.mesh && !n.model && !n.terrain) throw new ToolError('grass.ground: the object itself has no mesh to stand on.');
        }
        if (texture !== undefined) g.texture = textureId(doc, texture, 'grass.texture');
        if (windMap !== undefined) g.windMap = textureId(doc, windMap, 'grass.wind_map');
        n.grass = g;
    }
    if (spec.rain === null) delete n.rain;
    else if (spec.rain) {
        const { shelter, light, ...fields } = spec.rain as Json;
        const r = patch(Rain, n.rain ?? defaults(Rain), fields, 'rain', hex);
        if (shelter !== undefined) r.shelter = resolveParent(doc, shelter, batch, 'rain.shelter');
        if (light !== undefined) {
            r.light = resolveParent(doc, light, batch, 'rain.light');
            const target = r.light ? batch.find((x) => x.id === r.light) ?? doc.nodes.find((x) => x.id === r.light) : null;
            if (r.light && target && !target.light) throw new ToolError(`rain.light: "${target.name}" is not a light.`);
        }
        n.rain = r;
    }
    if (spec.terrain === null) delete n.terrain;
    else if (spec.terrain) {
        if (!n.terrain) throw new ToolError('terrain: create_terrain makes terrains.');
        const { layers, ...fields } = spec.terrain as Json;
        const t = patch(Terrain, n.terrain, fields, 'terrain', hex);
        if (layers !== undefined) t.layers = layersOf(env, layers);
        n.terrain = t;
    }
    if (spec.scatter === null) delete n.scatter;
    else if (spec.scatter !== undefined) throw new ToolError('scatter: the scatter tool makes and changes scatters (null removes one).');
    if (spec.instancing === null) delete n.instancing;
    else if (spec.instancing) n.instancing = defaults(Instancing);
    if (spec.audio === null) delete n.audio;
    else if (spec.audio) {
        const { clip, ...fields } = spec.audio as Json;
        const a = patch(AudioSource, n.audio ?? defaults(AudioSource), fields, 'audio');
        if (clip !== undefined) a.clip = soundId(doc, clip, 'audio.clip');
        n.audio = a;
    }
}

/** A sound asset by id or name (with or without its extension). */
function soundId(doc: SceneDoc, v: unknown, what: string): string | null {
    if (v === null || v === '') return null;
    const sounds = doc.assets.filter((a) => a.kind === 'audio');
    const want = String(v).toLowerCase();
    const found = sounds.find((a) => a.id === v) ?? sounds.find((a) => a.name.toLowerCase() === want || a.name.replace(/\.[a-z0-9]+$/i, '').toLowerCase() === want);
    if (!found) throw new ToolError(`${what}: no sound "${v}" in the project${sounds.length ? ` (sounds: ${sounds.map((a) => a.name).join(', ')})` : ''}. Add one with search_library / add_from_library or import_url.`);
    return found.id;
}

function textureId(doc: SceneDoc, v: unknown, what: string): string | null {
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !doc.assets.some((a) => a.id === v && a.kind === 'texture')) throw new ToolError(`${what}: no texture asset "${v}".`);
    return v;
}

/** A primitive's material with the tool's changes: a preset first, the shader by id or name, textures that exist. */
function applyMaterial(doc: SceneDoc, m: MaterialDoc, p: Json): MaterialDoc {
    const { preset, shader: shaderRef, ...fields } = p;
    let base = m;
    if (preset !== undefined) {
        const found = MATERIAL_PRESETS.find((x) => x.id === preset);
        if (!found) throw new ToolError(`Unknown preset "${preset}". Use one of ${MATERIAL_PRESETS.map((x) => x.id).join(', ')}.`);
        base = { ...m };
        found.apply(base);
    }
    for (const k of TEXTURE_FIELDS) if (fields[k] !== undefined) textureId(doc, fields[k], k);
    if (fields.params !== undefined) fields.params = params(fields.params);
    const out = patch(Material, base, fields, 'material', hex);
    if (shaderRef === null) {
        out.type = 'lit';
        out.shader = null;
    } else if (shaderRef !== undefined) {
        const s = shader(doc, shaderRef);
        if (s.kind !== 'material') throw new ToolError(`"${s.name}" is a post shader; use add_post_effect.`);
        out.type = 'shader';
        out.shader = s.id;
    }
    if (out.type === 'shader' && !out.shader) throw new ToolError('Material type "shader" needs a shader.');
    return out;
}

function makeTyped(type: string): NodeDoc {
    switch (type) {
        case 'box':
        case 'sphere':
        case 'plane':
        case 'cylinder':
        case 'cone':
        case 'torus':
        case 'ramp':
        case 'stairs':
        case 'capsule':
            return makeMeshNode(type);
        case 'empty':
            return makeNode('Empty');
        case 'grass': {
            const n = makeNode('Grass');
            n.grass = defaults(Grass);
            return n;
        }
        case 'sound': {
            const n = makeNode('Sound');
            n.audio = defaults(AudioSource);
            return n;
        }
        case 'directional_light':
            return makeLightNode('directional');
        case 'point_light':
            return makeLightNode('point');
        case 'spot_light':
            return makeLightNode('spot');
        case 'camera': {
            const c = makeCameraNode();
            c.camera = defaultCameraDoc();
            return c;
        }
    }
    throw new ToolError(`Unknown object type "${type}". Use one of ${TYPES.join(', ')}.`);
}

// ------------------------------------------------------------------ policy

const PLACEMENT_FIELDS = ['position', 'rotation', 'scale', 'parent', 'shape', 'size', 'radius', 'radius_top', 'radius_bottom', 'height', 'tube', 'segments', 'steps', 'visible'];

/**
 * What the current stage lets the assistant change when the AI settings
 * limit its tools by stage (lights in the lighting stage, materials in the
 * materials stage); otherwise everything. Returns an error message, or ''
 * when allowed. Changes that reach back into a finished step are allowed
 * and get a note: that step is marked for a recheck (see layoutChanged).
 */
class StagePolicy {
    readonly allowed: Set<ToolGroup>;
    readonly stage: string;
    /** The Level stage is done: a change of the level marks the Layout step for a recheck. */
    private levelDone: boolean;
    warnings = new Set<string>();

    constructor(env: ToolEnv) {
        this.allowed = allowedGroups(env);
        const design = env.editor.pipeline.design;
        this.stage = stageDef(design.stage).title;
        this.levelDone = stageIndex(design.stage) > stageIndex('level');
    }

    private any(...groups: ToolGroup[]): boolean {
        return groups.some((g) => this.allowed.has(g));
    }

    /** The level changes: after the Level stage that is noted, not refused. */
    private layout(n: { light?: unknown; camera?: unknown; particles?: unknown; player?: unknown }) {
        if (this.levelDone && isLevelObject(n as NodeDoc)) {
            this.warnings.add('This changes the level after the Level stage was done: the Layout step is marked for a recheck until check_level passes. Run it before you finish if the change could open gaps or block the route.');
        }
    }

    /** The stage's tools allow moving or deleting `n`. */
    private placement(n: NodeDoc, verb: string): string {
        const mover = !!n.light || !!n.camera || !!n.particles || !!n.player;
        if (!(mover ? this.any('lights', 'objects', 'shots', 'effects') : this.allowed.has('objects'))) return `"${n.name}" cannot be ${verb} while the AI settings limit your tools to the ${this.stage} stage.`;
        this.layout(n);
        return '';
    }

    create(type: string, spec: Json = {}): string {
        if (type.endsWith('_light')) return this.any('lights', 'objects') ? '' : `Lights cannot be added while the AI settings limit your tools to the ${this.stage} stage.`;
        // Grass, water and mirrors dress the level in the Materials stage.
        if (type === 'grass') return this.any('objects', 'materials', 'effects') ? '' : `Grass cannot be added while the AI settings limit your tools to the ${this.stage} stage.`;
        if (type === 'sound') return this.any('objects', 'audio') ? '' : `Sounds cannot be added while the AI settings limit your tools to the ${this.stage} stage.`;
        if (spec.mirror && this.any('materials')) return '';
        if (spec.audio && type === 'empty' && this.any('audio')) return '';
        if (type === 'camera') return this.any('objects', 'lights', 'shots') ? '' : `Cameras cannot be added while the AI settings limit your tools to the ${this.stage} stage.`;
        if (!this.allowed.has('objects')) return `Objects cannot be placed while the AI settings limit your tools to the ${this.stage} stage.`;
        this.layout({});
        return '';
    }

    update(n: NodeDoc, spec: Json): string {
        if (n.prefabChild) return `"${n.name}" is part of a prefab instance and follows its prefab; change the instance (its root) instead.`;
        if (PLACEMENT_FIELDS.some((f) => spec[f] !== undefined)) {
            const err = this.placement(n, 'moved');
            if (err) return err;
        }
        const limited = `while the AI settings limit your tools to the ${this.stage} stage`;
        if (spec.material !== undefined && !this.any('materials', 'objects')) return `Materials cannot be changed ${limited}.`;
        if (spec.light !== undefined && !this.any('lights', 'objects')) return `Lights cannot be changed ${limited}.`;
        if (spec.camera !== undefined && !this.any('objects', 'lights', 'shots')) return `Cameras cannot be changed ${limited}.`;
        if (['player', 'character', 'body', 'animation'].some((k) => spec[k] !== undefined) && !this.any('objects', 'code', 'play')) return `Characters, the player, physics bodies and animation cannot be changed ${limited}.`;
        if ((spec.mirror !== undefined || spec.grass !== undefined) && !this.any('objects', 'materials', 'effects')) return `Mirrors and grass cannot be changed ${limited}.`;
        if ((spec.terrain !== undefined || spec.scatter !== undefined) && !this.any('objects', 'materials')) return `Terrains and scatters cannot be changed ${limited}.`;
        if (spec.instancing !== undefined && !this.allowed.has('objects')) return `Instancing cannot be changed ${limited}.`;
        if (spec.audio !== undefined && !this.any('objects', 'audio')) return `Sounds cannot be changed ${limited}.`;
        if (this.stage === 'Level' && spec.material) {
            const m = spec.material as Json;
            if (m.color !== undefined || m.texture !== undefined || m.shader !== undefined || m.preset !== undefined || m.emissive !== undefined) {
                this.warnings.add('The Level stage is greybox: keep the gray material and name surfaces with set_material_slot / assign_material_slot; colors and textures come in the Materials stage (unless the user asked for them now).');
            }
        }
        return '';
    }

    remove(n: NodeDoc): string {
        return this.placement(n, 'deleted');
    }
}

function modelIds(doc: SceneDoc, refs: unknown): string[] {
    const list = Array.isArray(refs) ? refs : typeof refs === 'string' ? [refs] : [];
    const ids = list.map((r) => node(doc, r)).filter((n) => {
        if (!n.model) throw new ToolError(`"${n.name}" is not an imported model.`);
        return true;
    }).map((n) => n.id);
    if (!ids.length) throw new ToolError('ids is empty.');
    return ids;
}

function uniqueIn(doc: SceneDoc, batch: NodeDoc[], base: string, parent: string | null): string {
    const stem = base.replace(/\s\(\d+\)$/, '');
    const names = new Set([...doc.nodes, ...batch].filter((n) => n.parent === parent).map((n) => n.name));
    if (!names.has(stem)) return stem;
    let i = 1;
    while (names.has(`${stem} (${i})`)) i++;
    return `${stem} (${i})`;
}

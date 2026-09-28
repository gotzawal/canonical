import type { Editor } from '../editor';
import {
    defaultCameraDoc, defaultGeometry, defaultLight, makeCameraNode, makeLightNode, makeMeshNode, makeNode,
} from '../core/defaults';
import { MATERIAL_PRESETS } from '../core/materialPresets';
import { defaultCharacter, defaultPlayer } from '../core/character';
import { Camera, Character, Environment, GEOMETRY_TYPES, Light, Material, MaterialOverride, Player } from '../core/model';
import { patch, toolSchema } from '../core/schema';
import type { GeometryType, LightType, MaterialDoc, NodeDoc, ParamValue, PartOverride, SceneDoc } from '../core/types';
import { assetImageDataUrl } from '../core/images';
import { recentLogs } from '../ui/statusbar';
import { ALL_TOOL_GROUPS, stageDef, type ToolGroup } from '../design/stages';
import { def, hex, node, num, params, r3, rv, script, shader, ToolError, v3, type Json } from './toolUtil';
import { designToolDefs, runDesignTool } from './designTools';
import { greyboxToolDefs, runGreyboxTool } from './greyboxTools';
import { imageToolDefs, PAID_IMAGE_TOOLS, runImageTool } from './imageTools';
import { materialToolDefs, PAID_MATERIAL_TOOLS, runMaterialTool } from './materialTools';
import { effectToolDefs, runEffectTool } from './effectTools';
import { behaviorToolDefs, runBehaviorTool } from './behaviorTools';
import { levelToolDefs, runLevelTool } from './levelTools';
import type { ToolDef } from './openrouter';

export interface ToolResult {
    /** JSON-able result sent back to the model. */
    data: unknown;
    /** A data: URL image to show the model (vision models only). */
    image?: string;
    /** More images to show the model. */
    images?: string[];
    /** Short line for the chat log. */
    summary?: string;
    /** Buttons for the user to answer with in the chat (the assistant waits for the answer). */
    choice?: ToolChoice;
}

/** A question with buttons shown in the chat; a button sends its label as the user's answer. */
export interface ToolChoice {
    /** What picking an option also sets: 'detail' sets the plan's detail level to the option's value. */
    kind: 'detail';
    question: string;
    options: { value: string; label: string }[];
}

export interface ToolEnv {
    editor: Editor;
    allowPlay(): boolean;
    screenshots(): boolean;
    /** The pipeline stage limits the tools. */
    stageTools(): boolean;
    /** Tools may spend credits on images. */
    allowImages(): boolean;
    /** Aborts long tools (image generation) when the request is stopped. */
    signal?: AbortSignal;
}


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
    cast_shadow: { type: 'boolean' },
    receive_shadow: { type: 'boolean' },
};
const SHAPES = GEOMETRY_TYPES;
const TYPES = [...SHAPES, 'empty', 'directional_light', 'point_light', 'spot_light', 'camera'];

/** get_scene stays below this many characters (the agent cuts longer tool results at 30 000). */
const SCENE_RESULT_CHARS = 28_000;

/** Tools that only read or look: every stage has them. */
const READ_TOOLS = ['get_scene', 'get_object', 'list_model_parts', 'read_script', 'read_shader', 'get_render_graph', 'get_console', 'capture_viewport', 'view_images', 'select_objects', 'read_design', 'get_behavior_outline', 'validate_behavior', 'get_decision_log', 'check_level'];

/**
 * Tool groups: a tool is offered when the current pipeline stage allows one
 * of its groups (see design/stages.ts). A tool missing here is never
 * offered, so a new one cannot slip past the stages.
 */
const TOOL_GROUPS: Record<string, ToolGroup[]> = {
    ...Object.fromEntries(READ_TOOLS.map((t) => [t, ['read']])),
    create_objects: ['objects', 'lights', 'effects'],
    update_objects: ['objects', 'lights', 'materials', 'effects'],
    delete_objects: ['objects', 'lights', 'effects'],
    set_environment: ['environment'],
    set_model_material: ['materials'],
    set_model_part: ['objects'],
    add_model: ['objects'],
    write_script: ['code'],
    attach_script: ['code'],
    detach_script: ['code'],
    set_script_props: ['code'],
    delete_script: ['code'],
    write_shader: ['code', 'materials', 'effects'],
    assign_shader: ['code', 'materials'],
    delete_shader: ['code'],
    set_render_pass: ['code', 'effects'],
    add_post_effect: ['effects', 'code'],
    update_post_effect: ['effects', 'code'],
    remove_post_effect: ['effects', 'code'],
    run_play_test: ['play', 'code'],
    play: ['play', 'code'],
    stop: ['play', 'code'],
    create_shot: ['shots'],
    update_shot: ['shots'],
    delete_shot: ['shots'],
    capture_shot: ['shots', 'capture', 'compare'],
    compare_shot: ['compare'],
    apply_key_light: ['lights'],
    capture_player_view: ['capture'],
    check_sightline: ['capture'],
    create_prefab: ['prefabs'],
    place_prefab: ['prefabs'],
    build_rooms: ['objects'],
    place_player: ['objects', 'play', 'code'],
    generate_paintover: ['images'],
    choose_paintover: ['images', 'shots'],
    image_model_info: ['images'],
    set_material_slot: ['materials', 'design'],
    assign_material_slot: ['materials', 'objects'],
    search_swatches: ['materials'],
    use_swatch: ['materials'],
    generate_swatch: ['images'],
    add_particles: ['effects'],
    update_particles: ['effects'],
    add_vignette: ['effects'],
    add_color_grade: ['effects'],
    apply_behavior_ops: ['code'],
    update_design: ['design'],
    ask_user: ['design'],
    update_checklist: ['design'],
    propose_stage_complete: ['design'],
    set_detail_level: ['design'],
    ask_detail_level: ['design'],
    mark_shot_matching: ['compare'],
    generate_concept: ['concepts'],
};

/** Groups the assistant may use now: the stage's, or all of them when the stage does not limit tools. */
export function allowedGroups(env: ToolEnv): Set<ToolGroup> {
    if (!env.stageTools()) return new Set(ALL_TOOL_GROUPS);
    const design = env.editor.pipeline.design;
    // Working without a brief: the pipeline has not started, so the Brief stage limits nothing.
    if (design.stage === 'brief' && design.brief.skipped) return new Set(ALL_TOOL_GROUPS);
    return new Set(stageDef(design.stage).tools);
}

function toolAllowed(name: string, allowed: Set<ToolGroup>): boolean {
    return !!TOOL_GROUPS[name]?.some((g) => allowed.has(g));
}

/** Tools that depend on the detail level: questions only when the user wants to refine, own judgments only when they want the assistant to decide. */
const DETAILED_ONLY = new Set(['ask_user']);
const QUICK_ONLY = new Set(['mark_shot_matching']);

export function toolDefs(env: ToolEnv): ToolDef[] {
    const allowed = allowedGroups(env);
    const quick = env.editor.store.doc.design.detail === 'quick';
    return allToolDefs(env).filter((d) => toolAllowed(d.function.name, allowed) && !(quick ? DETAILED_ONLY : QUICK_ONLY).has(d.function.name));
}

function allToolDefs(env: ToolEnv): ToolDef[] {
    const defs: ToolDef[] = [
        def('get_scene', 'Summary of the project: objects (ids, types, transforms, materials, scripts), assets, scripts, shaders, render graph settings, selection and play state.'),
        def('get_object', 'Full details of one object, including its world position and bounding box.', { id: { type: 'string', description: 'Object id or name.' } }, ['id']),
        def('create_objects', 'Create primitives, lights, cameras or empty groups. Returns their ids.', {
            objects: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: TYPES }, ...objectFields }, required: ['type'] } },
        }, ['objects']),
        def('update_objects', 'Change objects: name, parent, transform, visibility, material, primitive size, light or camera settings.', {
            updates: {
                type: 'array',
                items: { type: 'object', properties: { id: { type: 'string' }, shape: { type: 'string', enum: SHAPES }, ...objectFields }, required: ['id'] },
            },
        }, ['updates']),
        def('delete_objects', 'Delete objects and their children.', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
        def('set_environment', 'Change sky, exposure and post processing settings.', environmentFields()),
        def('list_model_parts', 'Material slots and mesh parts of an imported model object, with their current values and overrides.', { id: { type: 'string' } }, ['id']),
        def('set_model_material', 'Override a material slot of imported model objects. Missing fields keep their value; reset clears the slot. Each slot can get its own shading: the file\'s PBR material, unlit, lambert, or a custom material shader.', {
            ids: { type: 'array', items: { type: 'string' } },
            slot: { type: 'string' },
            reset: { type: 'boolean' },
            ...toolSchema(MaterialOverride).properties,
            map: { type: ['string', 'null'], description: 'Texture asset id, null for none, "file" for the model\'s own.' },
            alpha_mode: { type: 'string', enum: ['auto', 'opaque', 'blend', 'mask', 'additive', 'multiply'], description: 'auto keeps the file\'s mode.' },
            shader: { type: ['string', 'null'], description: 'Material shader id or name to replace the material; null removes it. Texture properties named normalMap, maskMap, emissiveMap or aoMap get the model\'s own maps unless params sets them.' },
        }, ['ids', 'slot']),
        def('set_model_part', 'Override a mesh part of imported model objects (visibility, shadows, material slot, local transform). reset clears the part.', {
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
        }, ['ids', 'path']),
        def('add_model', 'Add another instance of an imported model asset to the scene.', { asset: { type: 'string' }, name: { type: 'string' }, position: vec3 }, ['asset']),
        def('write_script', 'Create a script, or replace the code of an existing one (pass id, or an existing name). Optionally attach it to objects. Returns the compile result, fields and methods.', {
            name: { type: 'string', description: 'File name, e.g. "Orbit.js".' },
            code: { type: 'string' },
            id: { type: 'string' },
            attach_to: { type: 'array', items: { type: 'string' }, description: 'Object ids or names.' },
            props: { type: 'object', description: 'Field values for the attached objects.' },
        }, ['name', 'code']),
        def('read_script', 'Code, compile status and runtime errors of a script.', { script: { type: 'string', description: 'Script id or name.' } }, ['script']),
        def('attach_script', 'Attach a script to objects, with optional field values.', {
            script: { type: 'string' },
            object_ids: { type: 'array', items: { type: 'string' } },
            props: { type: 'object' },
        }, ['script', 'object_ids']),
        def('detach_script', 'Remove a script from an object.', { object_id: { type: 'string' }, script: { type: 'string' } }, ['object_id', 'script']),
        def('set_script_props', 'Set field values of a script attached to an object.', { object_id: { type: 'string' }, script: { type: 'string' }, props: { type: 'object' } }, ['object_id', 'script', 'props']),
        def('delete_script', 'Delete a script asset (it is removed from every object).', { script: { type: 'string' } }, ['script']),
        def('write_shader', 'Create a WGSL shader, or replace an existing one (pass id, or an existing name). Waits for the GPU compiler and returns errors with line numbers and the declared properties.', {
            name: { type: 'string', description: 'File name, e.g. "Hologram.wgsl".' },
            kind: { type: 'string', enum: ['material', 'post'] },
            lighting: { type: 'string', enum: ['lit', 'unlit'], description: 'Material shaders only.' },
            code: { type: 'string' },
            id: { type: 'string' },
        }, ['name', 'kind', 'code']),
        def('read_shader', 'Code and compile status of a shader.', { shader: { type: 'string' } }, ['shader']),
        def('assign_shader', 'Render primitive objects with a material shader (null goes back to the lit material).', {
            shader: { type: ['string', 'null'] },
            object_ids: { type: 'array', items: { type: 'string' } },
            params: { type: 'object' },
        }, ['shader', 'object_ids']),
        def('delete_shader', 'Delete a shader asset.', { shader: { type: 'string' } }, ['shader']),
        def('get_render_graph', 'Render passes in execution order with the resources they read and write, and the post effect chain.'),
        def('set_render_pass', 'Switch a render pass off or on. Refused with a reason when the graph could not run.', { name: { type: 'string' }, enabled: { type: 'boolean' } }, ['name', 'enabled']),
        def('add_post_effect', 'Add a post shader to the post chain.', { shader: { type: 'string' }, params: { type: 'object' }, enabled: { type: 'boolean' } }, ['shader']),
        def('update_post_effect', 'Change a custom post effect: enabled, params, or move it (negative = earlier).', {
            id: { type: 'string' },
            enabled: { type: 'boolean' },
            params: { type: 'object' },
            move: { type: 'number' },
        }, ['id']),
        def('remove_post_effect', 'Remove a custom post effect from the chain.', { id: { type: 'string' } }, ['id']),
        def('get_console', 'Recent editor console messages (errors, warnings, script logs).', { limit: { type: 'number' }, errors_only: { type: 'boolean' } }),
        def('select_objects', 'Select objects in the editor and frame them in the view.', { ids: { type: 'array', items: { type: 'string' } } }, ['ids']),
        def('view_images', 'Look at images of the project again: concept images, paintovers, captures, swatches or images the user attached, by asset id. They are shown in the next message (vision models only).', {
            assets: { type: 'array', items: { type: 'string' }, description: 'Asset ids (at most 6).' },
        }, ['assets']),
    ];
    if (env.allowPlay()) {
        defs.push(
            def('run_play_test', 'Run the scene in Play mode for a few seconds, then stop and restore it. Returns script logs and errors. Use it to test scripts.', {
                seconds: { type: 'number', description: '0.5 to 20, default 3.' },
            }),
            def('play', 'Start Play mode and leave it running for the user.'),
            def('stop', 'Stop Play mode (restores the scene).'),
        );
    }
    if (env.screenshots()) {
        defs.push(def('capture_viewport', 'Take a picture of the viewport as it is now (the editor view, or the game camera while playing).'));
    }
    defs.push(...designToolDefs());
    if (env.screenshots()) defs.push(...greyboxToolDefs());
    else defs.push(...greyboxToolDefs().filter((d) => !/^capture|^check_sightline/.test(d.function.name)));
    defs.push(...imageToolDefs().filter((d) => env.allowImages() || !PAID_IMAGE_TOOLS.has(d.function.name)));
    defs.push(...materialToolDefs().filter((d) => env.allowImages() || !PAID_MATERIAL_TOOLS.has(d.function.name)));
    defs.push(...effectToolDefs());
    defs.push(...behaviorToolDefs());
    defs.push(...levelToolDefs());
    return defs;
}

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
    if (n.light) out.light = { color: n.light.color, intensity: n.light.intensity, cast_shadow: n.light.castShadow, ...(n.light.type !== 'directional' ? { range: n.light.range } : {}), ...(n.light.type === 'spot' ? { outer_angle: n.light.outerAngle } : {}) };
    if (n.camera) out.camera = { ...n.camera };
    if (n.character) {
        const c = n.character;
        out.character = { speed: c.speed, run_speed: c.runSpeed, jump: c.jump, height: c.height, radius: c.radius, eye_height: c.eyeHeight, step_height: c.stepHeight, ...(c.collide ? {} : { collide: false }) };
    }
    if (n.player) {
        const p = n.player;
        out.player = { view: p.view, ...(p.view === 'third' ? { distance: p.distance } : {}) };
    }
    if (n.particles) {
        const p = n.particles;
        out.particles = { preset: p.preset, rate: p.rate, life: p.life, size: p.size, shape: p.shape, blend: p.blend, colors: [p.colorStart, p.colorEnd], alive_at_most: Math.min(p.max, Math.ceil(p.rate * p.life[1])) };
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

function resolveParent(doc: SceneDoc, ref: unknown, batch: NodeDoc[]): string | null {
    if (ref === null || ref === undefined || ref === '') return null;
    if (typeof ref !== 'string') throw new ToolError('parent must be an object id or name.');
    const found = batch.find((n) => n.id === ref || n.name === ref) ?? doc.nodes.find((n) => n.id === ref) ?? doc.nodes.find((n) => n.name === ref);
    if (!found) throw new ToolError(`Parent "${ref}" does not exist.`);
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
        if (n.light || n.camera || n.particles) throw new ToolError(`"${n.name}" cannot be a character (lights, cameras and particles cannot).`);
        n.character = patch(Character, n.character ?? defaultCharacter(doc.design.specs), spec.character ?? {}, 'character');
    }
    if (spec.player === null) delete n.player;
    else if (spec.player) {
        const other = doc.nodes.find((o) => o.player && o.id !== n.id) ?? batch.find((o) => o.player && o !== n);
        if (other) throw new ToolError(`"${other.name}" is the player already: one player per scene. Move it with place_player.`);
        if (!n.character) throw new ToolError('The player controls a character: give the object one (character) too.');
        n.player = patch(Player, n.player ?? defaultPlayer(), spec.player, 'player');
    }
    if (spec.camera) {
        if (!n.camera) throw new ToolError(`"${n.name}" is not a camera.`);
        n.camera = patch(Camera, n.camera, spec.camera, 'camera');
        if (spec.camera.main) for (const o of doc.nodes) if (o !== n && o.camera) o.camera.main = false;
    }
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

const PAUSED_TOOL_ERROR =
    'Scripts in this scene are paused because it was opened from a file. Only the user can enable them (the "Enable Scripts" button above the viewport); ask them to review the scripts and enable them.';

function compiledInfo(env: ToolEnv, id: string): Json {
    const c = env.editor.compiler.get(id);
    if (!c) return { ok: false, error: 'missing' };
    if (c.paused) return { ok: false, paused: true, error: PAUSED_TOOL_ERROR };
    const out: Json = { ok: !c.error };
    if (c.error) out.error = { line: c.error.line, column: c.error.column, message: c.error.message };
    if (c.fieldError) out.field_error = c.fieldError;
    out.class = c.className;
    out.fields = c.fields.map((f) => ({ name: f.name, type: f.type, default: f.default }));
    out.methods = c.methods;
    return out;
}

async function shaderInfo(env: ToolEnv, id: string): Promise<Json> {
    await env.editor.shaders.whenIdle();
    const st = env.editor.shaders.status(id);
    return {
        ok: st.state === 'ok',
        state: st.state,
        errors: st.messages.filter((m) => m.severity === 'error').map((m) => ({ line: m.line, column: m.column, message: m.message })),
        warnings: st.messages.filter((m) => m.severity === 'warning').map((m) => ({ line: m.line, message: m.message })),
        properties: env.editor.shaders.props(id).map((p) => ({ name: p.name, type: p.type, default: p.default, ...(p.min !== undefined ? { min: p.min, max: p.max } : {}) })),
        in_use: st.state !== 'ok' && env.editor.shaders.isValid(id) ? 'the previous valid version is still rendering' : undefined,
    };
}

// ------------------------------------------------------------------ policy

const PLACEMENT_FIELDS = ['position', 'rotation', 'scale', 'parent', 'shape', 'size', 'radius', 'radius_top', 'radius_bottom', 'height', 'tube', 'segments', 'steps', 'visible'];

/**
 * What the current stage lets the assistant change: lights in the lighting
 * stage, materials in the materials stage, placement only while it is not
 * locked. Returns an error message, or '' when allowed.
 */
class StagePolicy {
    readonly allowed: Set<ToolGroup>;
    readonly stage: string;
    private pipeline: ToolEnv['editor']['pipeline'];
    warnings = new Set<string>();

    constructor(env: ToolEnv) {
        this.allowed = allowedGroups(env);
        this.pipeline = env.editor.pipeline;
        this.stage = stageDef(this.pipeline.design.stage).title;
    }

    private any(...groups: ToolGroup[]): boolean {
        return groups.some((g) => this.allowed.has(g));
    }

    /** The stage's tools allow moving or deleting `n`, and the placement lock does (Pipeline.placementBlock). */
    private placement(n: NodeDoc, verb: string): string {
        const mover = !!n.light || !!n.camera || !!n.particles || !!n.player;
        if (!(mover ? this.any('lights', 'objects', 'shots', 'effects') : this.allowed.has('objects'))) return `"${n.name}" cannot be ${verb} in the ${this.stage} stage.`;
        const why = this.pipeline.placementBlock([n.id]);
        return why ? `"${n.name}": ${why}` : '';
    }

    create(type: string): string {
        if (type.endsWith('_light')) return this.any('lights', 'objects') ? '' : `Lights cannot be added in the ${this.stage} stage.`;
        if (type === 'camera') return this.any('objects', 'lights', 'shots') ? '' : `Cameras cannot be added in the ${this.stage} stage.`;
        if (!this.allowed.has('objects')) return `Objects cannot be placed or changed in the ${this.stage} stage.`;
        return this.pipeline.placementLocked ? `Placement is locked in the ${this.stage} stage: new objects would change the level. It can be unlocked in the pipeline bar.` : '';
    }

    update(n: NodeDoc, spec: Json): string {
        if (n.prefabChild) return `"${n.name}" is part of a prefab instance and follows its prefab; change the instance (its root) instead.`;
        if (PLACEMENT_FIELDS.some((f) => spec[f] !== undefined)) {
            const err = this.placement(n, 'moved');
            if (err) return err;
        }
        if (spec.material !== undefined && !this.any('materials', 'objects')) return `Materials cannot be changed in the ${this.stage} stage.`;
        if (spec.light !== undefined && !this.any('lights', 'objects')) return `Lights cannot be changed in the ${this.stage} stage.`;
        if (spec.camera !== undefined && !this.any('objects', 'lights', 'shots')) return `Cameras cannot be changed in the ${this.stage} stage.`;
        if ((spec.player !== undefined || spec.character !== undefined) && !this.any('objects', 'code', 'play')) return `Characters and the player cannot be changed in the ${this.stage} stage.`;
        if (this.stage === 'Level' && spec.material) {
            const m = spec.material as Json;
            if (m.color !== undefined || m.texture !== undefined || m.shader !== undefined || m.preset !== undefined || m.emissive !== undefined) {
                this.warnings.add('The Level stage is greybox: keep the gray material and name surfaces with set_material_slot / assign_material_slot; colors and textures come in the Materials stage.');
            }
        }
        return '';
    }

    remove(n: NodeDoc): string {
        return this.placement(n, 'deleted');
    }
}

// ------------------------------------------------------------------ runner

/** Runs one tool call against the editor. */
export async function runTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult> {
    const ed = env.editor;
    const store = ed.store;
    const doc = () => store.doc;
    try {
        const allowed = allowedGroups(env);
        if (!toolAllowed(name, allowed)) {
            const stage = stageDef(ed.pipeline.design.stage);
            throw new ToolError(`${name} is not available in the ${stage.title} stage. Ask the user to reopen the right stage, or to let the assistant use every tool in the AI settings.`);
        }
        const quick = ed.store.doc.design.detail === 'quick';
        if (quick && DETAILED_ONLY.has(name)) throw new ToolError('The user wants you to decide the details yourself: decide, write your choice into the plan and go on.');
        if (!quick && QUICK_ONLY.has(name)) throw new ToolError('Only the user judges this, unless they let you decide the details (detail level quick).');
        const design =
            (await runDesignTool(env, name, args)) ??
            (await runGreyboxTool(env, name, args)) ??
            (await runImageTool(env, name, args)) ??
            (await runMaterialTool(env, name, args)) ??
            (await runEffectTool(env, name, args)) ??
            (await runBehaviorTool(env, name, args)) ??
            (await runLevelTool(env, name, args));
        if (design) return design;
        switch (name) {
            case 'get_scene': {
                const d = doc();
                // Parts of prefab instances follow their prefab: only the instances are listed.
                const listed = d.nodes.filter((n) => !n.prefabChild);
                const data: Json = {
                    name: d.name,
                    selection: store.selection,
                    play_state: ed.player.state,
                    environment: {
                        sky: d.environment.sky,
                        ...(d.environment.sky === 'color' ? { sky_color: d.environment.skyColor } : { sun_x: d.environment.sunX, sun_y: d.environment.sunY }),
                        exposure: d.environment.exposure,
                        bloom: d.environment.bloom,
                        ao: d.environment.ao,
                        fog: d.environment.fog,
                        fxaa: d.environment.fxaa,
                        gi: d.environment.gi,
                    },
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
            }
            case 'get_object': {
                const n = node(doc(), args.id);
                const box = ed.picker.bounds(n.id);
                const m = ed.picker.worldMatrix(n.id);
                const out: Json = { ...nodeSummary(doc(), n), raw: n };
                if (m) out.world_position = rv([m[12], m[13], m[14]]);
                if (box) out.bounds = { min: rv(box.min), max: rv(box.max), size: rv([box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]]) };
                const children = doc().nodes.filter((c) => c.parent === n.id).map((c) => c.id);
                if (children.length) out.children = children;
                return { data: out, summary: n.name };
            }
            case 'create_objects': {
                const specs: Json[] = Array.isArray(args.objects) ? args.objects : [];
                if (!specs.length) throw new ToolError('objects is empty.');
                const policy = new StagePolicy(env);
                for (const spec of specs) {
                    const err = policy.create(String(spec.type)) || (spec.material ? policy.update({ name: spec.name ?? spec.type } as NodeDoc, { material: spec.material }) : '');
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
            }
            case 'update_objects': {
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
            }
            case 'delete_objects': {
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
                return { data: { deleted: all.size }, summary: `${all.size} object(s)` };
            }
            case 'set_environment': {
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
            }
            case 'list_model_parts': {
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
                    },
                };
            }
            case 'set_model_material': {
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
            }
            case 'set_model_part': {
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
            }
            case 'add_model': {
                const asset = doc().assets.find((a) => (a.id === args.asset || a.name === args.asset) && a.kind === 'model');
                if (!asset) throw new ToolError(`No model asset "${args.asset}".`);
                const before = new Set(doc().nodes.map((n) => n.id));
                ed.addModel(asset.id, args.position !== undefined ? v3(args.position, 'position') : undefined);
                const created = doc().nodes.find((n) => !before.has(n.id));
                if (created && args.name) ed.rename(created.id, String(args.name));
                return { data: { id: created?.id }, summary: asset.name };
            }
            case 'write_script': {
                const code = String(args.code ?? '');
                if (!code.trim()) throw new ToolError('code is empty.');
                const name = String(args.name ?? 'Script.js');
                const existing = args.id ? script(doc(), args.id) : doc().scripts.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.name.toLowerCase() === (name + '.js').toLowerCase());
                let id: string;
                if (existing) {
                    id = existing.id;
                    ed.updateScript(id, code);
                    if (args.id && name && name !== existing.name) ed.renameScript(id, name);
                } else {
                    id = ed.createScript({ name, code, open: false }).id;
                }
                if (Array.isArray(args.attach_to) && args.attach_to.length) {
                    const targets = args.attach_to.map((r: unknown) => node(doc(), r).id);
                    const fresh = targets.filter((t: string) => !store.node(t)?.scripts?.some((r) => r.script === id));
                    if (fresh.length) ed.attachScript(fresh, id, params(args.props));
                    else if (args.props) setScriptProps(env, targets, id, params(args.props));
                }
                const info = compiledInfo(env, id);
                return { data: { id, name: doc().scripts.find((s) => s.id === id)?.name, ...info }, summary: `${name}${info.ok ? '' : ' (errors)'}` };
            }
            case 'read_script': {
                const s = script(doc(), args.script);
                const issues = ed.player.issues.filter((i) => i.script === s.id).map((i) => ({ method: i.method, line: i.line, message: i.message, object: i.node }));
                return { data: { id: s.id, name: s.name, code: s.code, ...compiledInfo(env, s.id), ...(issues.length ? { runtime_errors: issues } : {}) }, summary: s.name };
            }
            case 'attach_script': {
                const s = script(doc(), args.script);
                const targets = (Array.isArray(args.object_ids) ? args.object_ids : []).map((r: unknown) => node(doc(), r).id);
                if (!targets.length) throw new ToolError('object_ids is empty.');
                ed.attachScript(targets, s.id, params(args.props));
                return { data: { ok: true, ...compiledInfo(env, s.id) }, summary: s.name };
            }
            case 'detach_script': {
                const n = node(doc(), args.object_id);
                const s = script(doc(), args.script);
                const i = n.scripts?.findIndex((r) => r.script === s.id) ?? -1;
                if (i < 0) throw new ToolError(`"${n.name}" does not have ${s.name}.`);
                ed.detachScript(n.id, i);
                return { data: { ok: true } };
            }
            case 'set_script_props': {
                const n = node(doc(), args.object_id);
                const s = script(doc(), args.script);
                if (!n.scripts?.some((r) => r.script === s.id)) throw new ToolError(`"${n.name}" does not have ${s.name}; attach it first.`);
                setScriptProps(env, [n.id], s.id, params(args.props));
                return { data: { ok: true } };
            }
            case 'delete_script': {
                const s = script(doc(), args.script);
                await ed.deleteScript(s.id, false);
                return { data: { ok: true }, summary: s.name };
            }
            case 'write_shader': {
                const code = String(args.code ?? '');
                if (!code.trim()) throw new ToolError('code is empty.');
                const name = String(args.name ?? 'Shader.wgsl');
                const existing = args.id ? shader(doc(), args.id) : doc().shaders.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.name.toLowerCase() === (name + '.wgsl').toLowerCase());
                // A rewrite keeps the kind and lighting the call leaves out.
                const kind = args.kind === 'post' || args.kind === 'material' ? args.kind : existing?.kind ?? 'material';
                const lighting = args.lighting === 'unlit' || args.lighting === 'lit' ? args.lighting : existing?.lighting ?? 'lit';
                let id: string;
                if (existing) {
                    id = existing.id;
                    ed.updateShader(id, { code, kind, lighting });
                } else {
                    id = ed.createShader({ name, code, kind, lighting, open: false }).id;
                }
                const info = await shaderInfo(env, id);
                return { data: { id, name: doc().shaders.find((s) => s.id === id)?.name, kind, ...(kind === 'material' ? { lighting } : {}), ...info }, summary: `${name}${info.ok ? '' : ' (errors)'}` };
            }
            case 'read_shader': {
                const s = shader(doc(), args.shader);
                return { data: { id: s.id, name: s.name, kind: s.kind, lighting: s.lighting, code: s.code, ...(await shaderInfo(env, s.id)) }, summary: s.name };
            }
            case 'assign_shader': {
                const targets: string[] = (Array.isArray(args.object_ids) ? args.object_ids : []).map((r: unknown) => node(doc(), r).id);
                const meshes = targets.filter((id) => store.node(id)?.mesh);
                if (!meshes.length) throw new ToolError('None of these objects is a primitive with a material. For imported models use set_model_material with shader.');
                if (args.shader === null) {
                    ed.assignShader(meshes, null);
                    return { data: { ok: true } };
                }
                const s = shader(doc(), args.shader);
                if (s.kind !== 'material') throw new ToolError(`"${s.name}" is a post shader; use add_post_effect.`);
                ed.assignShader(meshes, s.id);
                if (args.params) {
                    const p = params(args.params);
                    store.commit('AI: Shader Params', (d) => {
                        for (const n of d.nodes) if (meshes.includes(n.id) && n.mesh) n.mesh.material.params = { ...(n.mesh.material.params ?? {}), ...p };
                    }, { nodes: meshes });
                }
                return { data: { ok: true, objects: meshes.length, ...(await shaderInfo(env, s.id)) }, summary: s.name };
            }
            case 'delete_shader': {
                const s = shader(doc(), args.shader);
                await ed.deleteShader(s.id, false);
                return { data: { ok: true }, summary: s.name };
            }
            case 'get_render_graph': {
                const info = ed.graph.info();
                return {
                    summary: `${info.passes.length} passes`,
                    data: {
                        passes: info.passes
                            .slice()
                            .sort((a, b) => (a.order < 0 ? 1e6 : a.order) - (b.order < 0 ? 1e6 : b.order))
                            .map((p) => ({ name: p.name, enabled: p.enabled, order: p.order, reads: p.reads, writes: p.writes, ...(p.deps.length ? { after: p.deps } : {}), ...(p.essential ? { required: true } : {}) })),
                        post_chain: ed.graph.chain().map((c) => ({ name: c.name, enabled: c.enabled, ...(c.custom ? { id: c.custom } : {}), ...(c.final ? { final: true } : {}) })),
                        custom_post_effects: doc().renderGraph.posts,
                        error: info.error || undefined,
                    },
                };
            }
            case 'set_render_pass': {
                const err = ed.setPassEnabled(String(args.name), !!args.enabled);
                if (err) throw new ToolError(err);
                return { data: { ok: true }, summary: `${args.name} ${args.enabled ? 'on' : 'off'}` };
            }
            case 'add_post_effect': {
                const s = shader(doc(), args.shader);
                if (s.kind !== 'post') throw new ToolError(`"${s.name}" is a material shader.`);
                const id = ed.addPostEffect(s.id);
                if (!id) throw new ToolError('Could not add the effect.');
                if (args.params || args.enabled === false) ed.updatePostEffect(id, { params: params(args.params), enabled: args.enabled !== false }, 'AI: Post Effect');
                return { data: { id, ...(await shaderInfo(env, s.id)) }, summary: s.name };
            }
            case 'update_post_effect': {
                const p = doc().renderGraph.posts.find((x) => x.id === args.id);
                if (!p) throw new ToolError(`No post effect "${args.id}".`);
                if (args.enabled !== undefined || args.params !== undefined) {
                    ed.updatePostEffect(p.id, { enabled: args.enabled, params: args.params ? params(args.params) : undefined }, 'AI: Post Effect');
                }
                if (args.move) ed.movePostEffect(p.id, Math.sign(num(args.move, 'move')));
                return { data: { ok: true } };
            }
            case 'remove_post_effect': {
                if (!doc().renderGraph.posts.some((x) => x.id === args.id)) throw new ToolError(`No post effect "${args.id}".`);
                ed.removePostEffect(String(args.id));
                return { data: { ok: true } };
            }
            case 'get_console': {
                const limit = Math.min(200, Math.max(1, Number(args.limit) || 40));
                return { data: { messages: recentLogs(limit, args.errors_only ? ['error'] : ['error', 'warn', 'info']) } };
            }
            case 'select_objects': {
                const ids = (Array.isArray(args.ids) ? args.ids : []).map((r: unknown) => node(doc(), r).id);
                store.select(ids);
                if (ids.length) ed.viewport.frameNodes(ids);
                return { data: { ok: true } };
            }
            case 'run_play_test': {
                if (!env.allowPlay()) throw new ToolError('Play tests are turned off in the AI settings.');
                if (!ed.compiler.trusted && ed.store.doc.scripts.length) throw new ToolError(PAUSED_TOOL_ERROR);
                const seconds = Math.min(20, Math.max(0.5, Number(args.seconds) || 3));
                const res = await ed.player.runFor(seconds);
                const log = ed.player.agents.log;
                const agents = ed.store.doc.nodes.filter((n) => n.agent?.enabled).length;
                return {
                    summary: `${seconds}s, ${res.issues.length} error(s)`,
                    data: {
                        seconds,
                        frames: res.frames,
                        errors: res.issues.map((i) => ({ script: i.scriptName, object: i.node, method: i.method, line: i.line, message: i.message, at: r3(i.time) })),
                        logs: res.logs.slice(-60).map((l) => `${r3(l.time)}s ${l.level}: ${l.text}`),
                        ...(agents ? { behavior: { agents, decisions: log.entries.length, outcomes: log.outcomes(), note: 'get_decision_log shows the decisions.' } } : {}),
                        note: res.frames < 2 ? 'Very few frames ran; the tab may be in the background.' : undefined,
                    },
                };
            }
            case 'play': {
                if (!env.allowPlay()) throw new ToolError('Play is turned off in the AI settings.');
                if (!ed.compiler.trusted && ed.store.doc.scripts.length) throw new ToolError(PAUSED_TOOL_ERROR);
                ed.play();
                return { data: { state: ed.player.state } };
            }
            case 'stop': {
                ed.stopPlay();
                return { data: { state: ed.player.state } };
            }
            case 'view_images': {
                const refs: unknown[] = Array.isArray(args.assets) ? args.assets.slice(0, 6) : [];
                if (!refs.length) throw new ToolError('assets is empty.');
                const images: string[] = [];
                const shown: string[] = [];
                const missing: string[] = [];
                for (const ref of refs) {
                    const meta = doc().assets.find((a) => a.id === ref && (a.kind === 'image' || a.kind === 'texture'));
                    const url = meta ? await assetImageDataUrl(meta.id, 1024).catch(() => null) : null;
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
            }
            case 'capture_viewport': {
                const image = await ed.runtime.capture(768);
                return { data: { ok: true, note: 'The screenshot is attached in the next message.' }, image, summary: 'screenshot' };
            }
        }
        throw new ToolError(`Unknown tool "${name}".`);
    } catch (e: any) {
        // A stopped request stops here; the agent reports it.
        if (e?.name === 'AbortError') throw e;
        const message = e instanceof ToolError ? e.message : `${e?.name || 'Error'}: ${e?.message || e}`;
        if (!(e instanceof ToolError)) console.error('[ai] tool failed', name, e);
        return { data: { error: message }, summary: 'error' };
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

function setScriptProps(env: ToolEnv, ids: string[], scriptId: string, props: Record<string, ParamValue>) {
    env.editor.store.commit('AI: Script Fields', (d) => {
        for (const n of d.nodes) {
            if (!ids.includes(n.id)) continue;
            for (const r of n.scripts ?? []) if (r.script === scriptId) r.props = { ...r.props, ...props };
        }
    }, { nodes: ids });
}

function uniqueIn(doc: SceneDoc, batch: NodeDoc[], base: string, parent: string | null): string {
    const stem = base.replace(/\s\(\d+\)$/, '');
    const names = new Set([...doc.nodes, ...batch].filter((n) => n.parent === parent).map((n) => n.name));
    if (!names.has(stem)) return stem;
    let i = 1;
    while (names.has(`${stem} (${i})`)) i++;
    return `${stem} (${i})`;
}

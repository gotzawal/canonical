// The assistant's greybox tools: shots (camera bookmarks framed like the
// concepts), player eye-height views and sight line checks, and prefabs.

import { add, DEG, len, normalize, sub } from '../core/math';
import type { CameraState, SceneDoc, ShotDoc, Vec3 } from '../core/types';
import { blobToDataUrl } from '../core/images';
import { assetImageDataUrl } from '../core/images';
import type { ToolDef } from './openrouter';
import type { ToolEnv, ToolResult } from './tools';
import { node, num, optStr, r3, rv, str, ToolError, v3, type Json } from './toolUtil';

function def(name: string, description: string, properties: Json = {}, required: string[] = []): ToolDef {
    return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const place = { type: ['array', 'string'], description: '[x, y, z], or the name / id of an object or route point.' };

export function greyboxToolDefs(): ToolDef[] {
    return [
        def('create_shot', 'Add a shot: a camera bookmark framed like a concept image (same aspect ratio), used for every comparison later. Place it with position and look_at, or take the current view.', {
            name: { type: 'string' },
            concept: { type: 'string', description: 'Concept image asset id this shot matches.' },
            area: { type: 'string', description: 'Area id or name.' },
            position: vec3,
            look_at: vec3,
            fov: { type: 'number', description: 'Vertical field of view of the frame in degrees (default 50).' },
            aspect: { type: 'number', description: 'Width / height; defaults to the concept image, else 16/9.' },
        }),
        def('update_shot', 'Change a shot: name, area, concept, camera (position, look_at, fov) or final approval.', {
            shot: { type: 'string', description: 'Shot id or name.' },
            name: { type: 'string' },
            area: { type: ['string', 'null'] },
            concept: { type: ['string', 'null'] },
            position: vec3,
            look_at: vec3,
            fov: { type: 'number' },
        }, ['shot']),
        def('delete_shot', 'Delete a shot.', { shot: { type: 'string' } }, ['shot']),
        def('capture_shot', 'Render a shot and look at it next to its target paintover and concept image (vision models). Adds the capture to the shot history.', {
            shot: { type: 'string' },
            compare: { type: 'string', enum: ['both', 'target', 'concept', 'none'], description: 'Images to show next to the capture (default both).' },
        }, ['shot']),
        def('capture_player_view', 'See what the player sees: the camera stands on the ground at `from`, at the brief\'s eye height, and looks at `look_at`.', {
            from: place,
            look_at: place,
            fov: { type: 'number', description: 'Vertical degrees, default 60.' },
        }, ['from', 'look_at']),
        def('check_sightline', 'Check whether a landmark is visible from a point at eye height: rays from the eye to the landmark tell whether and by what it is blocked. With sightline (an id from the plan) the result is recorded. Returns a picture of the view.', {
            from: place,
            to: place,
            sightline: { type: 'string', description: 'Sight line id of the plan to record the result in.' },
        }, ['from', 'to']),
        def('create_prefab', 'Turn objects into a prefab (a reusable group with its materials, pivot at the bottom center) and replace them with one instance. Place more with place_prefab; a model can later replace the prefab in every instance.', {
            objects: { type: 'array', items: { type: 'string' }, description: 'Object ids or names.' },
            name: { type: 'string' },
        }, ['objects', 'name']),
        def('place_prefab', 'Place instances of a prefab. Instances follow the prefab; do not edit their parts.', {
            prefab: { type: 'string', description: 'Prefab id or name.' },
            instances: { type: 'array', items: { type: 'object', properties: { position: vec3, rotation_y: { type: 'number' }, name: { type: 'string' } }, required: ['position'] } },
        }, ['prefab', 'instances']),
    ];
}

/** Orbit camera state for a camera at `pos` looking at `at`. */
function lookCamera(pos: Vec3, at: Vec3, fov: number): CameraState {
    const back = sub(pos, at);
    const distance = Math.max(0.05, len(back));
    const d = normalize(back);
    return { target: [...at] as Vec3, distance, yaw: ((Math.atan2(d[0], d[2]) / DEG) + 360) % 360, pitch: Math.asin(Math.max(-1, Math.min(1, d[1]))) / DEG, fov };
}

function findShot(doc: SceneDoc, ref: unknown): ShotDoc {
    if (typeof ref !== 'string') throw new ToolError('shot must be a shot id or name.');
    const s = doc.design.shots.find((x) => x.id === ref) ?? doc.design.shots.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!s) throw new ToolError(`No shot "${ref}". Shots: ${doc.design.shots.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}.`);
    return s;
}

function areaRef(doc: SceneDoc, ref: unknown): string | null {
    if (ref === undefined || ref === null || ref === '') return null;
    const a = doc.design.areas.find((x) => x.id === ref) ?? doc.design.areas.find((x) => x.name.toLowerCase() === String(ref).toLowerCase());
    if (!a) throw new ToolError(`No area "${ref}".`);
    return a.id;
}

/** A point on the ground from [x, y, z], a route point, an area or an object. */
function resolvePlace(env: ToolEnv, ref: unknown, what: string): { point: Vec3; node?: string } {
    const doc = env.editor.store.doc;
    if (Array.isArray(ref)) return { point: v3(ref, what) };
    if (typeof ref !== 'string' || !ref) throw new ToolError(`${what} must be [x, y, z] or a name.`);
    const rp = doc.design.play.route.find((r) => r.id === ref || r.name.toLowerCase() === ref.toLowerCase());
    if (rp?.position) return { point: [...rp.position] as Vec3 };
    const area = doc.design.areas.find((a) => a.id === ref || a.name.toLowerCase() === ref.toLowerCase());
    if (area?.bounds) return { point: [...area.bounds.center] as Vec3 };
    const n = node(doc, ref);
    const box = env.editor.picker.bounds(n.id);
    if (box) return { point: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2], node: n.id };
    const m = env.editor.picker.worldMatrix(n.id);
    if (!m) throw new ToolError(`"${ref}" has no position.`);
    return { point: [m[12], m[13], m[14]], node: n.id };
}

/** Eye position standing on the ground at the xz of `p`. */
function eyeAt(env: ToolEnv, p: Vec3): Vec3 {
    const ed = env.editor;
    ed.picker.update();
    const top = Math.max(p[1] + 2, 60);
    const hit = ed.picker.raycast([p[0], top, p[2]], [0, -1, 0], top + 60);
    const ground = hit ? hit.point[1] : 0;
    return [p[0], ground + ed.store.doc.design.specs.eyeHeight, p[2]];
}

async function capture(env: ToolEnv, camera: CameraState, aspect: number): Promise<string> {
    const blob = await env.editor.pipeline.captureCamera(camera, aspect, 1024);
    return blobToDataUrl(blob);
}

export async function runGreyboxTool(env: ToolEnv, name: string, args: Json): Promise<ToolResult | null> {
    const ed = env.editor;
    const store = ed.store;
    const doc = () => store.doc;
    const pipeline = ed.pipeline;
    switch (name) {
        case 'create_shot': {
            const concept = optStr(args.concept, 'concept', 64);
            if (concept && !doc().assets.some((a) => a.id === concept && a.kind === 'image')) throw new ToolError(`"${concept}" is not an image asset.`);
            const shot = pipeline.createShot({ name: optStr(args.name, 'name', 200), concept: concept ?? null, area: areaRef(doc(), args.area), aspect: args.aspect !== undefined ? Math.max(0.2, Math.min(5, num(args.aspect, 'aspect'))) : undefined });
            if (args.position !== undefined || args.look_at !== undefined) {
                if (args.position === undefined || args.look_at === undefined) throw new ToolError('Give both position and look_at, or neither.');
                const cam = lookCamera(v3(args.position, 'position'), v3(args.look_at, 'look_at'), args.fov !== undefined ? num(args.fov, 'fov') : 50);
                store.commit('AI: Shot Camera', (d) => {
                    const s = d.design.shots.find((x) => x.id === shot.id);
                    if (s) s.camera = cam;
                }, { design: true });
            } else if (args.fov !== undefined) {
                store.commit('AI: Shot Camera', (d) => {
                    const s = d.design.shots.find((x) => x.id === shot.id);
                    if (s) s.camera = { ...s.camera, fov: num(args.fov, 'fov') };
                }, { design: true });
            }
            return { data: { id: shot.id, name: shot.name, aspect: r3(shot.aspect) }, summary: shot.name };
        }
        case 'update_shot': {
            const shot = findShot(doc(), args.shot);
            const patch: Partial<ShotDoc> = {};
            if (args.name !== undefined) patch.name = str(args.name, 'name', 200).trim() || shot.name;
            if (args.area !== undefined) patch.area = areaRef(doc(), args.area);
            if (args.concept !== undefined) patch.concept = args.concept === null ? null : str(args.concept, 'concept', 64);
            let camera: CameraState | null = null;
            if (args.position !== undefined || args.look_at !== undefined) {
                const pos = args.position !== undefined ? v3(args.position, 'position') : add(shot.camera.target, orbitOffset(shot.camera));
                const at = args.look_at !== undefined ? v3(args.look_at, 'look_at') : shot.camera.target;
                camera = lookCamera(pos, at, args.fov !== undefined ? num(args.fov, 'fov') : shot.camera.fov);
            } else if (args.fov !== undefined) camera = { ...shot.camera, fov: num(args.fov, 'fov') };
            store.commit('AI: Edit Shot', (d) => {
                const s = d.design.shots.find((x) => x.id === shot.id);
                if (!s) return;
                Object.assign(s, patch);
                if (camera) s.camera = camera;
            }, { design: true });
            return { data: { ok: true }, summary: shot.name };
        }
        case 'delete_shot': {
            const shot = findShot(doc(), args.shot);
            pipeline.deleteShot(shot.id);
            return { data: { ok: true }, summary: shot.name };
        }
        case 'capture_shot': {
            const shot = findShot(doc(), args.shot);
            const meta = await pipeline.captureShotAsset(shot.id, 'ai');
            const images: string[] = [];
            const labels: string[] = [];
            const url = await assetImageDataUrl(meta.id, 1024);
            if (url) {
                images.push(url);
                labels.push('capture (the scene now)');
            }
            const compare = typeof args.compare === 'string' ? args.compare : 'both';
            const s = pipeline.shot(shot.id)!;
            if ((compare === 'both' || compare === 'target') && s.target) {
                const t = await assetImageDataUrl(s.target, 1024);
                if (t) {
                    images.push(t);
                    labels.push('target paintover');
                }
            }
            if ((compare === 'both' || compare === 'concept') && s.concept) {
                const c = await assetImageDataUrl(s.concept, 1024);
                if (c) {
                    images.push(c);
                    labels.push('original concept');
                }
            }
            return { data: { ok: true, capture: meta.id, images_in_order: labels, note: 'The images are attached in the next message.' }, images, summary: shot.name };
        }
        case 'capture_player_view': {
            const from = resolvePlace(env, args.from, 'from');
            const at = resolvePlace(env, args.look_at, 'look_at');
            const eye = eyeAt(env, from.point);
            const cam = lookCamera(eye, at.point, args.fov !== undefined ? Math.min(120, Math.max(10, num(args.fov, 'fov'))) : 60);
            const image = await capture(env, cam, 16 / 9);
            return { data: { eye: rv(eye), looking_at: rv(at.point), note: 'The picture is attached in the next message.' }, image, summary: `from ${rv(eye).join(', ')}` };
        }
        case 'check_sightline': {
            const from = resolvePlace(env, args.from, 'from');
            const to = resolvePlace(env, args.to, 'to');
            const eye = eyeAt(env, from.point);
            ed.picker.update();
            // Sample the landmark: its center and the middle of its top.
            const samples: Vec3[] = [to.point];
            if (to.node) {
                const box = ed.picker.bounds(to.node);
                if (box) samples.push([(box.min[0] + box.max[0]) / 2, box.max[1] - 0.05, (box.min[2] + box.max[2]) / 2]);
            }
            const inTarget = (id: string) => !!to.node && (id === to.node || store.isAncestor(to.node, id));
            let visible = 0;
            const blockers = new Set<string>();
            for (const p of samples) {
                const dir = sub(p, eye);
                const dist = len(dir);
                const hit = ed.picker.raycast(eye, dir, Math.max(0, dist - 0.05));
                if (!hit || inTarget(hit.id)) visible++;
                else blockers.add(store.node(hit.id)?.name ?? hit.id);
            }
            const clear = visible > 0;
            if (typeof args.sightline === 'string') {
                const id = args.sightline;
                if (!doc().design.play.sightlines.some((s) => s.id === id)) throw new ToolError(`No sight line "${id}" in the plan.`);
                store.commit('AI: Sight Line', (d) => {
                    const sl = d.design.play.sightlines.find((s) => s.id === id);
                    if (sl) sl.ok = clear;
                }, { design: true });
            }
            const image = await capture(env, lookCamera(eye, to.point, 60), 16 / 9).catch(() => undefined);
            return {
                data: { clear, samples_visible: `${visible}/${samples.length}`, ...(blockers.size ? { blocked_by: [...blockers] } : {}), eye: rv(eye), distance: r3(len(sub(to.point, eye))) },
                image,
                summary: clear ? 'clear' : `blocked by ${[...blockers].join(', ')}`,
            };
        }
        case 'create_prefab': {
            const ids = (Array.isArray(args.objects) ? args.objects : []).map((r: unknown) => node(doc(), r).id);
            if (!ids.length) throw new ToolError('objects is empty.');
            const res = ed.createPrefab(str(args.name, 'name', 200), ids);
            if (!res) throw new ToolError('Could not make a prefab from these objects (nested prefabs, locked placement or no meshes).');
            return { data: { prefab: res.prefab.id, name: res.prefab.name, instance: res.instance }, summary: res.prefab.name };
        }
        case 'place_prefab': {
            const prefab = ed.prefab(typeof args.prefab === 'string' ? args.prefab : '');
            if (!prefab) throw new ToolError(`No prefab "${args.prefab}". Prefabs: ${doc().prefabs.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}.`);
            const list: Json[] = Array.isArray(args.instances) ? args.instances : [];
            if (!list.length) throw new ToolError('instances is empty.');
            const placed: { id: string; name: string }[] = [];
            store.begin('AI: Place Prefab');
            try {
                for (const inst of list) {
                    const id = ed.placePrefab(prefab.id, v3(inst.position, 'position'), inst.rotation_y !== undefined ? num(inst.rotation_y, 'rotation_y') : 0, false);
                    if (!id) throw new ToolError('Placement is locked in this stage.');
                    if (inst.name) ed.rename(id, String(inst.name));
                    placed.push({ id, name: store.node(id)?.name ?? '' });
                }
            } finally {
                store.end();
            }
            return { data: { placed }, summary: `${placed.length} x ${prefab.name}` };
        }
    }
    return null;
}

/** Offset from the orbit target to the camera. */
function orbitOffset(c: CameraState): Vec3 {
    const y = c.yaw * DEG, p = c.pitch * DEG;
    return [Math.cos(p) * Math.sin(y) * c.distance, Math.sin(p) * c.distance, Math.cos(p) * Math.cos(y) * c.distance];
}

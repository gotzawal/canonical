// The assistant's terrain tools: make a terrain of a shape, sculpt and paint
// it along strokes, and scatter copies of models or trees grown from rules
// over it (trees, rocks, grass tufts), which can also be turned into
// objects of their own.

import { defaultTree } from '../core/defaults';
import { Scatter, SCATTER_SOLIDS, ScatterSource, TerrainLayer, Tree } from '../core/model';
import { defaults, patch, snakeKeys, toolSchema } from '../core/schema';
import { SCULPT_OPS, TERRAIN_SHAPES, type TerrainShape } from '../core/terrainGen';
import { TREE_SPECIES, type TreeSpecies } from '../core/trees';
import type { ScatterDoc, TerrainLayerDoc, TreeDoc } from '../core/types';
import { layerFromSlot } from '../design/materialSlots';
import { allItems } from './libraryTools';
import { findSlot } from './materialTools';
import { allowedGroups, hex, node, num, r3, rv, str, ToolError, tools, v3, type Json, type ToolEnv } from './toolUtil';

const pair = (description: string) => ({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description });
const ref = (description: string) => ({ type: 'string', description });

function pairOf(v: unknown, what: string): [number, number] {
    if (!Array.isArray(v) || v.length !== 2) throw new ToolError(`${what} must be two numbers.`);
    return [num(v[0], what), num(v[1], what)];
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
    if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new ToolError(`${what} must be one of ${list.join(', ')}.`);
    return v as T;
}

/** A terrain's place, extent, lowest and highest ground and layers, as the tools report it. */
function terrainSummary(env: ToolEnv, id: string): Json {
    const ed = env.editor;
    const n = ed.store.node(id);
    const view = ed.sync.terrainView(id);
    if (!n?.terrain || !view) return { object: id };
    const f = view.frame;
    let lo = Infinity, hi = -Infinity;
    for (const v of view.map.data) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    return {
        object: id,
        name: n.name,
        position: rv([f.x, f.y, f.z]),
        size: rv([f.sizeX, f.sizeZ]),
        height: r3(f.height),
        ground: { lowest: r3(f.y + lo * f.height), highest: r3(f.y + hi * f.height) },
        samples: [view.map.width, view.map.height],
        meters_per_sample: r3(f.sizeX / (view.map.width - 1)),
        layers: n.terrain.layers.map((l, i) => ({ layer: i, slot: l.slot, heights: l.height, slopes: l.slope, only_painted: l.onlyPainted })),
    };
}

/** Terrain layers from the tool's list: a material slot each (its swatch, tile and color), placed by height and slope. */
export function layersOf(env: ToolEnv, list: unknown): TerrainLayerDoc[] {
    if (!Array.isArray(list)) throw new ToolError('layers must be a list.');
    if (list.length > 4) throw new ToolError('A terrain has at most four layers.');
    return list.map((l, i) => {
        if (!l || typeof l !== 'object') throw new ToolError(`layers[${i}] must be an object.`);
        const { slot, ...fields } = l as Json;
        let layer = defaults(TerrainLayer);
        if (slot !== undefined && slot !== null) layerFromSlot(layer, findSlot(env, slot));
        layer = patch(TerrainLayer, layer, fields, `layers[${i}]`, hex);
        return layer;
    });
}

/** Points of a stroke: [x, z] pairs in world meters. */
function strokePoints(v: unknown): [number, number][] {
    if (!Array.isArray(v) || !v.length) throw new ToolError('points must be a list of [x, z] world positions.');
    if (v.length > 400) throw new ToolError('At most 400 points a stroke.');
    return v.map((p, i) => pairOf(p, `points[${i}]`));
}

/** More points along a line, `step` meters apart at most (a path follows the ground between them). */
function densify(points: [number, number][], step: number): [number, number][] {
    const out: [number, number][] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const [ax, az] = points[i - 1];
        const [bx, bz] = points[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
        for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
    }
    return out;
}

/**
 * A model asset for a scatter source: an asset of the project (id or name),
 * or a Library item, which is copied in (without placing it) the first time.
 */
async function sourceModel(env: ToolEnv, v: unknown, what: string): Promise<string> {
    const ref = str(v, what, 200).trim();
    const doc = env.editor.store.doc;
    const own = doc.assets.find((a) => a.kind === 'model' && (a.id === ref || a.name === ref || a.name.replace(/\.(glb|gltf)$/i, '') === ref));
    if (own) return own.id;
    const { items } = await allItems(env);
    const item = items.find((it) => it.id === ref && it.kind === 'model');
    if (!item) throw new ToolError(`${what}: no model asset or Library model "${ref}" (search_library finds models).`);
    const res = await env.editor.addFromLibrary(item, { place: false, frame: false, signal: env.signal }).catch((e) => {
        if (e?.name === 'AbortError') throw e;
        throw new ToolError(e?.message || String(e));
    });
    return res.asset.id;
}

/** A tree's species, seed and height, and its other fields that differ from a new tree's. */
export function treeSummary(t: TreeDoc): Json {
    const d = defaults(Tree) as Record<string, unknown>;
    const changed = Object.fromEntries(Object.entries(t).filter(([k, v]) => k !== 'species' && k !== 'seed' && k !== 'height' && v !== d[k]));
    return { species: t.species, seed: t.seed, height: t.height, ...(snakeKeys(changed) as Json) };
}

/**
 * A tree component from a tool's tree fields over the current one (only the
 * fields given change, as in the inspector); a new tree starts as a new one
 * of its species (an oak by default), at the species' usual height.
 */
export function treeFrom(current: TreeDoc | undefined, fields: Json, what: string): TreeDoc {
    const species = fields.species;
    if (species !== undefined && !TREE_SPECIES.includes(species)) throw new ToolError(`${what}.species: one of ${TREE_SPECIES.join(', ')}.`);
    return patch(Tree, current ?? defaultTree((species ?? 'oak') as TreeSpecies), fields, what, hex);
}

/** A scatter's copies and solids as the tools report them, once they are placed. */
async function scatterSummary(env: ToolEnv, id: string): Promise<Json> {
    const ed = env.editor;
    await ed.sync.whenLoaded();
    const n = ed.store.node(id);
    const doc = n?.scatter;
    if (!n || !doc) return { object: id };
    const placements = ed.sync.scatterPlacements(id);
    const bySource = doc.sources.map((s, i) => {
        const copies = placements.filter((p) => p.source === i).length;
        if (s.tree) return { tree: s.tree.species, copies };
        const model = s.model ? ed.sync.scatterModelOf(s.model) : null;
        return { model: s.model, copies, ...(model && model.pieces.length > 1 ? { pieces: model.pieces.length } : {}), ...(s.model && !model ? { note: 'model not loaded' } : {}) };
    });
    const solids = ed.sync.scatterSolids().find((x) => x.id === id)?.solids.length ?? 0;
    const bounds = ed.sync.scatterView(id)?.bounds();
    return {
        object: id,
        name: n.name,
        copies: placements.length,
        asked: doc.count,
        sources: bySource,
        solid_copies: solids,
        ...(bounds ? { bounds: { min: rv(bounds.min), max: rv(bounds.max) } } : {}),
        ...(placements.length < doc.count
            ? { note: 'Fewer copies than asked: the area, ground, heights, slopes, spacing or objects to avoid leave no more room (lower the spacing, widen the ranges or the area).' }
            : {}),
    };
}

export const terrainTools = tools({
    create_terrain: {
        groups: ['objects'],
        description:
            'Make a terrain: ground from a 16-bit heightmap made in a shape, drawn in chunks that get coarser far from the camera (cheap over hundreds of meters). island: land rising out of the water, its coast at water_level (default 0), with sea floor around it; hills; mountains; plains; flat. Characters and bodies stand on it in Play, grass and scatters stand on it, the navigation mesh covers it and a Water material over it is shallow along its shore. Its surface blends up to four layers from material slots by height and slope (layers here, or update_objects terrain.layers later; the first covers everything, each next one goes over those before it where its rules hold). Shape it further with sculpt_terrain. Returns its lowest and highest ground.',
        params: {
            shape: { type: 'string', enum: TERRAIN_SHAPES },
            size: pair('[x, z] meters it spans, centered on its position (island and hills 200, mountains 400, plains 200, flat 100 by default).'),
            height: { type: 'number', description: 'Meters from its lowest to its highest possible ground (island 40, hills 20, mountains 120, plains 4, flat 10).' },
            seed: { type: 'number', description: 'Another seed makes another terrain of the shape.' },
            roughness: { type: 'number', description: '0 smooth to 1 rugged (default 0.5).' },
            erosion: { type: 'number', description: 'How much water has worn it, 0 to 1: gullies down slopes, ridges, fans at their feet (default by shape: island 0.5, mountains 0.7).' },
            resolution: { type: 'number', enum: [257, 513, 1025], description: 'Samples a side (default 513; 1025 for large or detailed ground, 4 times the memory).' },
            water_level: { type: 'number', description: 'island: the water\'s height, where its coast lies (default 0).' },
            position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Its middle (an island sits so its coast is at water_level).' },
            name: { type: 'string' },
            layers: {
                type: 'array',
                maxItems: 4,
                items: {
                    type: 'object',
                    properties: {
                        slot: ref('Material slot id or name: the layer shows its swatch at its tile size.'),
                        height: pair('World heights [lowest, highest] where it shows (a beach: [-5, 1.5]).'),
                        slope: pair('Slopes [least, steepest] in degrees where it shows (rock on cliffs: [35, 90]).'),
                        height_blend: { type: 'number' },
                        slope_blend: { type: 'number' },
                        only_painted: { type: 'boolean', description: 'Only where sculpt_terrain paints it (paths, fields).' },
                    },
                },
                description: 'Up to four surface layers; the first covers everything (grass), the next ones go over it by their rules (beach sand low, rock on slopes, snow high).',
            },
        },
        required: ['shape'],
        async run({ env, args, ed }) {
            const shape = oneOf(args.shape, TERRAIN_SHAPES, 'shape') as TerrainShape;
            const layers = args.layers !== undefined ? layersOf(env, args.layers) : null;
            const id = await ed.createTerrain({
                shape,
                size: args.size !== undefined ? pairOf(args.size, 'size') : undefined,
                height: args.height !== undefined ? Math.max(0.1, num(args.height, 'height')) : undefined,
                seed: args.seed !== undefined ? Math.round(num(args.seed, 'seed')) : undefined,
                roughness: args.roughness !== undefined ? num(args.roughness, 'roughness') : undefined,
                erosion: args.erosion !== undefined ? num(args.erosion, 'erosion') : undefined,
                resolution: args.resolution !== undefined ? num(args.resolution, 'resolution') : undefined,
                waterLevel: args.water_level !== undefined ? num(args.water_level, 'water_level') : undefined,
                at: args.position !== undefined ? v3(args.position, 'position') : undefined,
                name: args.name !== undefined ? str(args.name, 'name', 100) : undefined,
            });
            if (layers) {
                ed.store.commit('Terrain Layers', (d) => {
                    const n = d.nodes.find((x) => x.id === id);
                    if (n?.terrain) n.terrain.layers = layers;
                });
            }
            await ed.sync.whenLoaded();
            return { data: terrainSummary(env, id), summary: `${shape} terrain` };
        },
    },
    sculpt_terrain: {
        groups: ['objects', 'materials'],
        description:
            'Shape or paint a terrain along a stroke (world [x, z] points; one point is a single dab), as one undo step. raise / lower: move the ground up or down by amount meters where the stroke is full (fading to its radius). flatten: pull it to the world height target (default the ground under the first point): a building site, a plateau. smooth: even out bumps. path: level the ground across the stroke along its own height (a walkable road or trail that keeps the slope it follows). paint: paint surface layer `layer` (a painted layer takes over from the others; layers with only_painted show only where painted). The ground stays within the terrain\'s height range. Sculpting belongs to the Level stage, painting to the Materials stage.',
        params: {
            object: ref('The terrain (id or name).'),
            op: { type: 'string', enum: [...SCULPT_OPS, 'paint'] },
            points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'World [x, z] points along the stroke.' },
            radius: { type: 'number', description: 'Meters from the stroke where it fades out (default 6).' },
            strength: { type: 'number', description: '0 to 1: how much of the change it makes where full (default 1 for flatten and path, 0.6 for the others).' },
            amount: { type: 'number', description: 'raise / lower: meters at full strength (default 2).' },
            target: { type: 'number', description: 'flatten: the world height to level to.' },
            layer: { type: 'number', description: 'paint: the layer (0 to 3) to paint.' },
        },
        required: ['object', 'op', 'points'],
        async run({ env, args, ed, doc }) {
            const n = node(doc(), args.object);
            if (!n.terrain) throw new ToolError(`${n.name} is no terrain.`);
            const op = oneOf(args.op, [...SCULPT_OPS, 'paint'] as const, 'op');
            const allowed = allowedGroups(env);
            if (op === 'paint' ? !allowed.has('materials') : !allowed.has('objects')) {
                throw new ToolError(op === 'paint' ? 'Painting belongs to the Materials stage.' : 'Sculpting belongs to the Level stage.');
            }
            const radius = Math.max(0.2, args.radius !== undefined ? num(args.radius, 'radius') : 6);
            const strength = Math.min(1, Math.max(0, args.strength !== undefined ? num(args.strength, 'strength') : op === 'flatten' || op === 'path' ? 1 : 0.6));
            let points = strokePoints(args.points);
            if (op === 'path') points = densify(points, radius / 2);
            const stroke = ed.terrainStroke(n.id);
            if (op === 'paint') {
                const layer = Math.round(num(args.layer, 'layer'));
                if (layer < 0 || layer >= Math.max(1, n.terrain.layers.length)) throw new ToolError(`layer must be one of the terrain's layers (0 to ${Math.max(0, n.terrain.layers.length - 1)}).`);
                const meta = n.terrain.splatmap ? doc().assets.find((a) => a.id === n.terrain!.splatmap) : undefined;
                // Loaded here: the tool list is read where the engine is not (tests).
                const { paintOf } = await import('../engine/terrain');
                const current = meta ? await paintOf(meta) : null;
                if (!(await stroke.paintLayer(layer, { points, radius, strength }, current))) throw new ToolError('The terrain is not shown yet.');
            } else {
                const ok = stroke.sculpt(op, { points, radius, strength }, {
                    amount: op === 'raise' || op === 'lower' ? (args.amount !== undefined ? Math.abs(num(args.amount, 'amount')) : 2) : undefined,
                    target: args.target !== undefined ? num(args.target, 'target') : undefined,
                });
                if (!ok) {
                    stroke.cancel();
                    throw new ToolError('The terrain is not shown yet.');
                }
            }
            await stroke.end(op === 'paint' ? `Paint ${n.name}` : `Sculpt ${n.name}`);
            await ed.sync.whenLoaded();
            return { data: terrainSummary(env, n.id), summary: `${op} on ${n.name}` };
        },
    },
    scatter: {
        groups: ['objects', 'materials'],
        description:
            'Spread copies of models or of trees grown from rules over an area by rules, drawn instanced (thousands cost little): trees and rocks in the Level stage, grass tufts, flowers and pebbles in the Materials stage. A source is a model or a tree (tree: species oak, birch or spruce, its height, seed and look; no model needed): each tree source grows a few variants of its tree with three levels of detail, swaying in the weather\'s wind, so woods and forests of a thousand trees are cheap (forest: oak, birch and spruce sources, spacing 4 to 6, clusters 0.3 with cluster_size 40, slope [0, 35], solid trunk, above the water). Only the rules are kept; the copies are placed again from them and the seed whenever the rules, the ground or what to avoid change. Copies stand on ground (a terrain or meshes) where its world height and slope are within range, keep spacing apart and stay out of the boxes of the objects to avoid (plus margin). A model that is a set of pieces side by side (a rock set, grass clumps) gives each copy one piece. Natural rocks: clusters with a cluster size, layer to follow a terrain layer, tilt, align about 0.7 and bury so they sit in the ground. Solid sources (trunk for trees, box for rocks) stop characters and bodies and are holes in the navigation mesh. Give object to change a scatter (only the fields given change); bake: true turns its copies into objects of their own (to edit one by one); remove: true deletes it. Returns the copies placed per source.',
        params: {
            object: ref('An existing scatter to change (id or name); leave out to make one.'),
            name: { type: 'string' },
            position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'New scatters: the middle of the area.' },
            sources: {
                type: 'array',
                maxItems: 8,
                items: {
                    type: 'object',
                    properties: {
                        model: ref('A model asset (id or name) or a Library model id (copied in).'),
                        tree: { ...toolSchema(Tree), description: 'A tree grown from rules in place of a model: species, height (a species\' usual height when a new tree leaves it out: oak 14, birch 15, spruce 18), seed and how it grows and looks. A copy\'s height is the tree\'s height times its scale; cast_shadow and solid are the scatter\'s and the source\'s.' },
                        weight: { type: 'number', description: 'How often it is picked, relative to the others (default 1).' },
                        scale: pair('Scale [smallest, largest] each copy picks from (default [0.8, 1.2]).'),
                        solid: { type: 'string', enum: SCATTER_SOLIDS, description: 'Default none for models, trunk for trees.' },
                    },
                },
            },
            size: pair('Area [x, z] in meters, centered on the object.'),
            count: { type: 'number', description: 'Copies to place (up to 20000; fewer where the rules leave no room).' },
            seed: { type: 'number' },
            spacing: { type: 'number', description: 'Least meters between copies (trees 3 to 6, rocks 1 to 3, grass tufts 0.3 to 0.8).' },
            ground: ref('What the copies stand on (a terrain or meshes, id or name); leave out to place them flat at the object\'s height.'),
            height: pair('World heights [lowest, highest] where copies may stand (keep trees above the beach).'),
            slope: pair('Slopes [least, steepest] in degrees where copies may stand (trees [0, 30], rocks [0, 60]).'),
            avoid: { type: 'array', items: { type: 'string' }, description: 'Objects (ids or names) whose ground area stays clear: buildings, roads, the play area.' },
            margin: { type: 'number', description: 'Meters kept clear around the objects to avoid (default 1).' },
            align: { type: 'number', description: '0 upright (trees) to 1 leaning with the ground (rocks, tufts).' },
            sink: { type: 'number', description: 'Meters the copies sink into the ground (rock bottoms, roots).' },
            bury: { type: 'number', description: '0 to 1: on slopes, how much of the gap under a copy\'s downhill side it sinks further (default 0.5), so rocks sit in a hillside.' },
            tilt: { type: 'number', description: 'Degrees of random tilt per copy on top of its lean (rocks 10 to 30; 0 for trees).' },
            clusters: { type: 'number', description: '0 to 1: how much copies gather in groups with bare ground between, the largest in the middle (rocks 0.6 to 0.9, shrubs 0.4); 0 spreads them evenly.' },
            cluster_size: { type: 'number', description: 'Meters across a group (default 15; boulder fields 20 to 40, pebbles 3 to 8).' },
            layer: { type: 'number', description: '1 to 4: stand only where that layer of the ground terrain shows, as much as it shows (pebbles on the gravel layer, rocks on the rock layer); 0 anywhere.' },
            distance: { type: 'number', description: 'Draw distance in meters; 0 draws at any distance (grass tufts 40 to 80).' },
            cast_shadow: { type: 'boolean' },
            bake: { type: 'boolean', description: 'Turn the copies into objects under an instanced group; the scatter goes. Tree copies become tree objects, each drawn on its own (keep forests as scatters).' },
            remove: { type: 'boolean' },
        },
        async run({ env, args, ed, doc }) {
            const existing = args.object !== undefined ? node(doc(), args.object) : null;
            if (existing && !existing.scatter) throw new ToolError(`${existing.name} has no scatter.`);
            if (existing && args.remove) {
                ed.store.commit('Remove Scatter', (d) => {
                    const n = d.nodes.find((x) => x.id === existing.id);
                    if (n) delete n.scatter;
                });
                return { data: { object: existing.id, removed: true }, summary: `scatter off ${existing.name}` };
            }
            if (existing && args.bake) {
                await ed.sync.whenLoaded();
                const group = ed.bakeScatter(existing.id);
                if (!group) throw new ToolError('The scatter has no copies to turn into objects (or its models are not loaded).');
                return { data: { group, objects: ed.store.children(group).length }, summary: `baked ${existing.name}` };
            }
            const { sources, ground, avoid, cast_shadow: castShadow, object: _o, name, position, bake: _b, remove: _r, ...fields } = args;
            let scatter: ScatterDoc = patch(Scatter, existing?.scatter ?? defaults(Scatter), fields, 'scatter', hex);
            if (castShadow !== undefined) scatter.castShadow = !!castShadow;
            if (sources !== undefined) {
                if (!Array.isArray(sources) || !sources.length) throw new ToolError('sources must list at least one model or tree.');
                if (sources.length > 8) throw new ToolError('At most eight sources.');
                const list = [];
                for (const [i, s] of sources.entries()) {
                    const { model, tree, ...rest } = (s ?? {}) as Json;
                    const what = `sources[${i}]`;
                    const { tree: was, ...before } = scatter.sources[i] ?? defaults(ScatterSource);
                    if (tree !== undefined && tree !== null) {
                        if (model !== undefined && model !== null) throw new ToolError(`${what}: a model or a tree, not both.`);
                        // A tree is solid at its trunk unless the source says otherwise.
                        const fresh = !was && rest.solid === undefined;
                        list.push({ ...patch(ScatterSource, before, rest, what, hex), model: null, tree: treeFrom(was, tree as Json, `${what}.tree`), ...(fresh ? { solid: 'trunk' as const } : {}) });
                    } else {
                        if (model === undefined || model === null) throw new ToolError(`${what} needs a model or a tree.`);
                        list.push({ ...patch(ScatterSource, before, rest, what, hex), model: await sourceModel(env, model, `${what}.model`) });
                    }
                }
                scatter = { ...scatter, sources: list };
            } else if (!existing) {
                throw new ToolError('A new scatter needs sources.');
            }
            if (ground !== undefined) scatter.ground = ground === null ? null : node(doc(), ground).id;
            if (avoid !== undefined) {
                if (!Array.isArray(avoid)) throw new ToolError('avoid must be a list of objects.');
                scatter.avoid = avoid.map((a) => node(doc(), a).id);
            }
            let id = existing?.id ?? '';
            if (existing) {
                ed.store.commit('Scatter', (d) => {
                    const n = d.nodes.find((x) => x.id === existing.id);
                    if (!n) return;
                    n.scatter = scatter;
                    if (name !== undefined) n.name = str(name, 'name', 100);
                });
            } else {
                id = ed.createScatter(scatter, { name: name !== undefined ? str(name, 'name', 100) : undefined, at: position !== undefined ? v3(position, 'position') : [0, 0, 0] });
            }
            return { data: await scatterSummary(env, id), summary: existing ? `scatter ${existing.name}` : 'new scatter' };
        },
    },
});

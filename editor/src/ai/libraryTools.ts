// The assistant's Library tools: search the asset catalogs (core/library.ts,
// CC0 packs mirrored into the repository and catalogs the user added), copy
// an item into the project (a material onto a material slot, an HDRI onto
// the sky), or download a file from a link. Files are copied in, so the
// scene keeps them when a link goes away.

import { contactSheet } from '../core/images';
import { catalogList, kindOfUrl, loadCatalog, searchLibrary, urlFileName, type LibraryItem, type LibraryKind } from '../core/library';
import type { ToolGroup } from '../design/stages';
import { findSlot, slotSummary } from './materialTools';
import { allowedGroups, num, optStr, str, ToolError, tools, v3, type ToolEnv } from './toolUtil';

const KINDS: LibraryKind[] = ['model', 'material', 'hdri', 'audio', 'texture'];

/** The stage work each kind goes in with. */
const KIND_GROUP: Record<string, ToolGroup> = { model: 'objects', audio: 'audio', material: 'materials', texture: 'materials', hdri: 'environment' };
const KIND_WORDS: Record<string, string> = { model: 'Models', audio: 'Sounds', material: 'Materials', texture: 'Images', hdri: 'Skies' };

/** Every item of the catalogs the editor reads, and the catalogs it could not read. */
export async function allItems(env: ToolEnv): Promise<{ items: LibraryItem[]; errors: string[] }> {
    const urls = catalogList(env.editor.store.prefs.libraryCatalogs);
    const results = await Promise.allSettled(urls.map((u) => loadCatalog(u)));
    const items: LibraryItem[] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') items.push(...r.value.items);
        else errors.push(`${urls[i]}: ${r.reason?.message || r.reason}`);
    });
    return { items, errors };
}

/** An item goes in with the stage that uses it (when the AI settings limit tools by stage). */
function checkStage(env: ToolEnv, kind: string) {
    if (!allowedGroups(env).has(KIND_GROUP[kind] ?? 'materials')) throw new ToolError(`${KIND_WORDS[kind] ?? 'Images'} cannot be added while the AI settings limit your tools to this stage.`);
}

function brief(item: LibraryItem, n: number) {
    return {
        n,
        id: item.id,
        name: item.name,
        kind: item.kind,
        tags: item.tags,
        ...(item.extent ? { size_m: item.extent } : {}),
        ...(item.tris ? { tris: item.tris } : {}),
        ...(item.animations?.length ? { clips: item.animations } : {}),
        ...(item.seconds ? { seconds: item.seconds } : {}),
        ...(item.pixels ? { pixels: item.pixels } : {}),
        ...(item.tile ? { tile_m: item.tile } : {}),
        ...(item.maps ? { maps: ['color', ...(item.maps.normal ? ['normal'] : []), ...(item.maps.arm ? ['arm'] : []), ...(item.maps.height ? ['height'] : [])] } : {}),
        kb: Math.round(item.bytes / 1024),
        pack: item.sourceInfo?.name,
        ...(item.author ? { author: item.author } : {}),
        license: item.sourceInfo?.license,
    };
}

export const libraryTools = tools({
    search_library: {
        groups: ['objects', 'materials', 'audio', 'environment'],
        description:
            'Search the asset Library: open-source (CC0) files that can be copied into the project. Models: realistic scanned props, furniture, rocks and plants. Materials: realistic scanned surfaces (brick, plaster, wood, concrete, ground, rock) with color, normal and ARM maps and their real tile size, for material slots. Skies (kind hdri): HDRI photos of real skies that light the scene. Catalogs the user added may also hold sounds and images. Words match names, tags and pack names. Model sizes are as authored (real-world meters for the scans): scale them to the design specs if needed. A contact sheet of the results with a picture is attached, numbered like the list. Check here before building a prop from primitives or generating a swatch.',
        params: {
            query: { type: 'string', description: 'Words, e.g. "rock", "fern", "chair", "brick wall", "sunset sky".' },
            kind: { type: 'string', enum: KINDS },
            limit: { type: 'integer', minimum: 1, maximum: 24 },
        },
        async run({ env, args }) {
            const query = optStr(args.query, 'query', 200) ?? '';
            const kind = args.kind === undefined ? null : (KINDS.find((k) => k === args.kind) ?? null);
            if (args.kind !== undefined && !kind) throw new ToolError(`kind must be one of ${KINDS.join(', ')}.`);
            const limit = args.limit !== undefined ? Math.max(1, Math.min(24, Math.round(num(args.limit, 'limit')))) : 12;
            const { items, errors } = await allItems(env);
            const found = searchLibrary(items, query, kind).slice(0, limit);
            const results = found.map((it, i) => brief(it, i + 1));
            const pics = found.filter((it) => it.thumbUrl);
            let images: string[] = [];
            if (pics.length && env.screenshots()) {
                const blobs = await Promise.all(pics.map((it) => fetch(it.thumbUrl!).then((r) => r.blob()).catch(() => new Blob())));
                images = [await contactSheet(blobs, 160, 6)];
            }
            return {
                data: {
                    query,
                    results,
                    ...(pics.length && pics.length < found.length ? { note: 'The contact sheet numbers only the results with a picture, in list order.' } : {}),
                    ...(results.length ? {} : { note: `Nothing matches${items.length ? '' : ' (no catalog could be read)'}. Try other words or another kind.` }),
                    ...(errors.length ? { unreadable_catalogs: errors } : {}),
                },
                images,
                summary: `${results.length} found`,
            };
        },
    },
    add_from_library: {
        groups: ['objects', 'materials', 'audio', 'environment'],
        description:
            'Copy a Library item into the project. A model is placed too (at position, else where new objects go) and the new object id is returned: scale it with update_object (sizes are as authored). A material becomes a swatch and, given a slot, goes on that material slot like use_swatch (its maps, real tile size, textures sized for the surface and compressed). A sky (hdri) becomes the sky, lighting the scene; sky false only adds the file. A sound or image becomes an asset for Audio components, scripts or materials. An item the project has already is not downloaded again.',
        params: {
            item: { type: 'string', description: 'Item id from search_library, e.g. "polyhaven/rock-moss-set-01".' },
            position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            name: { type: 'string', description: 'Name of the placed object.' },
            place: { type: 'boolean', description: 'false adds a model\'s file without placing it.' },
            slot: { type: 'string', description: 'Materials: the material slot (id or name) to put it on.' },
            sky: { type: 'boolean', description: 'Skies: false adds the file without showing it on the sky.' },
        },
        required: ['item'],
        async run({ env, args, ed }) {
            const id = str(args.item, 'item', 200).trim();
            const { items } = await allItems(env);
            const item = items.find((it) => it.id === id) ?? items.find((it) => it.name.toLowerCase() === id.toLowerCase());
            if (!item) throw new ToolError(`No Library item "${id}". Use an id from search_library.`);
            checkStage(env, item.kind);
            const failed = (e: any) => {
                if (e?.name === 'AbortError') throw e;
                throw new ToolError(e?.message || String(e));
            };
            if (item.kind === 'material') {
                const slot = args.slot !== undefined ? findSlot(env, args.slot) : undefined;
                const res = await ed.addLibraryMaterial(item, slot?.id, env.signal).catch(failed);
                return {
                    data: {
                        swatch: res.swatch.id,
                        added_to_swatches: res.added,
                        ...(res.slot ? { slot: slotSummary(env, res.slot) } : { note: 'In the swatch library now; use_swatch (or slot here) puts it on a material slot.' }),
                    },
                    summary: res.slot ? `${item.name} on ${res.slot.name}` : item.name,
                };
            }
            const res = await ed
                .addFromLibrary(item, { at: args.position !== undefined ? v3(args.position, 'position') : undefined, place: args.place !== false, frame: false, signal: env.signal, sky: args.sky !== false })
                .catch(failed);
            if (res.node && args.name) ed.rename(res.node, String(args.name));
            const sky = item.kind === 'hdri' && args.sky !== false;
            return {
                data: {
                    asset: res.asset.id,
                    asset_name: res.asset.name,
                    kind: res.asset.kind,
                    ...(res.node ? { object: res.node } : {}),
                    reused: res.reused,
                    ...(item.extent ? { size_m: item.extent } : {}),
                    ...(sky ? { note: 'The sky shows it and it lights the scene. Turn the sun (the key directional light) to match where the sun is in the photo, and set its color and intensity to match.' } : {}),
                },
                summary: item.name,
            };
        },
    },
    import_url: {
        groups: ['objects', 'materials', 'audio'],
        description:
            'Download a model (.glb, or .gltf with its files), image or sound from a link into the project (a model is placed). The file is copied in, so the scene keeps it when the link goes away. Only use links the user gave or files whose license allows it; the site must let other sites read its files (GitHub raw links do).',
        params: {
            url: { type: 'string' },
            position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            name: { type: 'string', description: 'Name of the placed object.' },
        },
        required: ['url'],
        async run({ env, args, ed }) {
            const url = str(args.url, 'url', 2000).trim();
            const kind = kindOfUrl(urlFileName(url));
            if (kind) checkStage(env, kind);
            const res = await ed.importUrl(url, { at: args.position !== undefined ? v3(args.position, 'position') : undefined, frame: false, signal: env.signal }).catch((e) => {
                if (e?.name === 'AbortError') throw e;
                throw new ToolError(e?.message || String(e));
            });
            if (!kind) checkStage(env, res.asset.kind);
            if (res.node && args.name) ed.rename(res.node, String(args.name));
            return { data: { asset: res.asset.id, asset_name: res.asset.name, kind: res.asset.kind, ...(res.node ? { object: res.node } : {}), reused: res.reused }, summary: res.asset.name };
        },
    },
});

// Poly Haven (https://polyhaven.com): realistic CC0 HDRIs, PBR materials and
// models, through its public API (https://api.polyhaven.com, its terms:
// requests name this software in the User-Agent). Used by
// mirror-library.mjs for sources of type "polyhaven": each rule picks the
// most downloaded assets of a type and categories (or the ids it was pinned
// to), downloads them at one resolution and packs them for the editor:
//
//   hdri      the .hdr file, for the sky and the scene's lighting
//   material  color, normal (OpenGL) and ARM (occlusion, roughness,
//             metallic) maps as JPEG, with the real size of a tile
//   model     a self-contained GLB (JPEG textures, meshopt geometry)
//
// with Poly Haven's thumbnail of each.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const HEADERS = { 'User-Agent': 'Morglay-library-mirror/1 (+https://github.com/gotzawal/morglay)' };

async function fetchOk(url) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            if (res.ok) return res;
            last = new Error(`${url}: ${res.status} ${res.statusText}`);
            if (res.status < 500 && res.status !== 429) break;
        } catch (e) {
            last = e;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw last;
}

const getJson = async (url) => (await fetchOk(url)).json();
const getBytes = async (url) => Buffer.from(await (await fetchOk(url)).arrayBuffer());

const slugOf = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The asset's authors, "A and B". */
const authorsOf = (info) => {
    const names = Object.keys(info.authors ?? {});
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'Poly Haven';
};

/** A file of a map at a resolution, in the first format there is. */
function fileOf(files, map, res, formats = ['jpg', 'png']) {
    const byRes = files?.[map]?.[res];
    for (const f of formats) if (byRes?.[f]?.url) return byRes[f];
    return null;
}

/** Width and height of a Radiance .hdr file, from its resolution line ("-Y 512 +X 1024"). */
function hdrSize(bytes) {
    const head = bytes.toString('latin1', 0, Math.min(bytes.length, 4096));
    const m = head.match(/\n[-+]Y (\d+) [-+]X (\d+)\n/);
    return m ? [Number(m[2]), Number(m[1])] : undefined;
}

/** Poly Haven's picture of an asset as a PNG of this size. */
async function thumbnail(info, out, width, height) {
    if (!info.thumbnail_url) return false;
    const url = new URL(info.thumbnail_url);
    url.searchParams.set('width', String(width * 2));
    url.searchParams.set('height', String(height * 2));
    const png = await sharp(await getBytes(url.href)).resize(width, height, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, png);
    return true;
}

/** A texture captured from the air (a drone scan): tens of meters a tile, not for the ground underfoot. */
const aerial = (id, a) => !!a.attributes?.aerial || /^aerial[_-]/i.test(id) || (a.tags ?? []).includes('aerial');

/**
 * The ids a rule picks: of its type and every one of its categories, most
 * downloaded first; aerial textures only when the rule asks (aerial: true).
 */
function candidates(list, rule, taken) {
    const cats = rule.categories ?? [];
    const exclude = new Set(rule.exclude ?? []);
    return Object.entries(list)
        .filter(([id, a]) => !taken.has(id) && !exclude.has(id) && cats.every((c) => (a.categories ?? []).includes(c)) && (rule.aerial || !aerial(id, a)))
        .sort((a, b) => (b[1].download_count ?? 0) - (a[1].download_count ?? 0))
        .map(([id]) => id);
}

/**
 * Mirrors a Poly Haven source into `out/<src.id>`. Returns the catalog
 * items; the rules get the ids they were given (`ids`), so the next run
 * mirrors the same ones (unless `latest`).
 */
export async function mirrorPolyHaven({ src, out, latest, io, modelInfo }) {
    const api = src.api ?? 'https://api.polyhaven.com';
    const res = src.resolution ?? '1k';
    const lists = {};
    const listOf = async (type) => (lists[type] ??= await getJson(`${api}/assets?t=${type}`));
    const target = join(out, src.id);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const items = [];
    const taken = new Set();
    for (const rule of src.items) {
        const type = { hdri: 'hdris', material: 'textures', model: 'models' }[rule.kind];
        if (!type) {
            console.warn(`  unknown kind ${rule.kind}`);
            continue;
        }
        const list = await listOf(type);
        const pinned = !latest && Array.isArray(rule.ids) && rule.ids.length > 0;
        const ids = pinned ? rule.ids : candidates(list, rule, taken);
        const want = pinned ? rule.ids.length : rule.count ?? 1;
        if (!ids.length) console.warn(`  nothing matches ${type} ${JSON.stringify(rule.categories ?? [])}`);
        const kept = [];
        for (const id of ids) {
            if (kept.length >= want) break;
            if (taken.has(id)) continue;
            const info = list[id];
            if (!info) {
                console.warn(`  ${id}: not in the ${type} list`);
                continue;
            }
            try {
                const files = await getJson(`${api}/files/${id}`);
                const make = { hdri: hdriItem, material: materialItem, model: modelItem }[rule.kind];
                const item = await make({ id, info, files, res, src, rule, target, io, modelInfo });
                if (!item) continue;
                items.push(item);
                kept.push(id);
                taken.add(id);
                console.log(`  ${rule.kind} ${id}: ${(item.bytes / 1024).toFixed(0)} KiB`);
            } catch (e) {
                console.warn(`  ${id}: ${e?.message ?? e}`);
            }
        }
        if (kept.length < want) console.warn(`  ${rule.kind} ${JSON.stringify(rule.categories ?? rule.ids)}: ${kept.length} of ${want}`);
        rule.ids = kept;
    }
    return items;
}

function baseItem({ id, info, src, rule }, kind, file, bytes, extra) {
    const slug = slugOf(id);
    return {
        id: `${src.id}/${slug}`,
        name: info.name ?? id,
        kind,
        file,
        bytes,
        source: src.id,
        tags: [...new Set([...(rule.tags ?? []), ...(info.tags ?? []).slice(0, 8)])],
        author: authorsOf(info),
        origin: `https://polyhaven.com/a/${id}`,
        ...extra,
    };
}

async function hdriItem(ctx) {
    const { id, info, files, res, src, target } = ctx;
    const f = files.hdri?.[res]?.hdr;
    if (!f?.url) throw new Error(`no ${res} .hdr`);
    const slug = slugOf(id);
    const bytes = await getBytes(f.url);
    const file = `${src.id}/${slug}.hdr`;
    writeFileSync(join(target, `${slug}.hdr`), bytes);
    const thumb = `${src.id}/thumbs/${slug}.png`;
    const has = await thumbnail(info, join(target, 'thumbs', `${slug}.png`), 160, 80).catch(() => false);
    return baseItem(ctx, 'hdri', file, bytes.length, { pixels: hdrSize(bytes), ...(has ? { thumb } : {}) });
}

/** Occlusion, roughness and metallic in one image's red, green and blue, from the separate maps. */
async function packArm(ao, rough, metal, size) {
    const channel = async (buf, fill) =>
        buf ? sharp(buf).resize(size, size, { fit: 'fill' }).greyscale().raw().toBuffer() : Buffer.alloc(size * size, fill);
    const [r, g, b] = await Promise.all([channel(ao, 255), channel(rough, 200), channel(metal, 0)]);
    const rgb = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size; i++) {
        rgb[i * 3] = r[i];
        rgb[i * 3 + 1] = g[i];
        rgb[i * 3 + 2] = b[i];
    }
    return sharp(rgb, { raw: { width: size, height: size, channels: 3 } });
}

async function materialItem(ctx) {
    const { id, info, files, res, src, target } = ctx;
    const slug = slugOf(id);
    const colorFile = fileOf(files, 'Diffuse', res) ?? fileOf(files, 'diff', res);
    const normalFile = fileOf(files, 'nor_gl', res);
    if (!colorFile) throw new Error(`no ${res} color map`);
    const dir = join(target, slug);
    mkdirSync(dir, { recursive: true });
    const color = sharp(await getBytes(colorFile.url)).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true });
    const colorJpg = await color.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const meta = await sharp(colorJpg).metadata();
    const size = meta.width ?? 1024;
    writeFileSync(join(dir, 'color.jpg'), colorJpg);
    let bytes = colorJpg.length;
    const maps = {};
    if (normalFile) {
        const jpg = await sharp(await getBytes(normalFile.url)).resize(size, size, { fit: 'fill' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
        writeFileSync(join(dir, 'normal.jpg'), jpg);
        bytes += jpg.length;
        maps.normal = `${src.id}/${slug}/normal.jpg`;
    }
    const armFile = fileOf(files, 'arm', res);
    let arm = null;
    if (armFile) arm = sharp(await getBytes(armFile.url)).resize(size, size, { fit: 'fill' });
    else {
        const get = async (map) => {
            const f = fileOf(files, map, res);
            return f ? getBytes(f.url) : null;
        };
        const [ao, rough, metal] = await Promise.all([get('AO'), get('Rough'), get('Metal')]);
        if (ao || rough || metal) arm = await packArm(ao, rough, metal, size);
    }
    if (arm) {
        const jpg = await arm.removeAlpha().jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        writeFileSync(join(dir, 'arm.jpg'), jpg);
        bytes += jpg.length;
        maps.arm = `${src.id}/${slug}/arm.jpg`;
    }
    // The size of one tile in the world, meters (the dimensions are millimeters).
    const tile = Array.isArray(info.dimensions) && info.dimensions[0] > 0 ? Math.round(info.dimensions[0]) / 1000 : 2;
    const thumb = `${src.id}/thumbs/${slug}.png`;
    const has = await thumbnail(info, join(target, 'thumbs', `${slug}.png`), 160, 160).catch(() => false);
    return baseItem(ctx, 'material', `${src.id}/${slug}/color.jpg`, bytes, { maps, tile, pixels: [size, size], ...(has ? { thumb } : {}) });
}

async function modelItem(ctx) {
    const { id, info, files, res, src, rule, target, io, modelInfo } = ctx;
    const g = files.gltf?.[res]?.gltf;
    if (!g?.url) throw new Error(`no ${res} glTF`);
    const slug = slugOf(id);
    const tmp = mkdtempSync(join(tmpdir(), 'polyhaven-'));
    try {
        const main = join(tmp, `${slug}.gltf`);
        writeFileSync(main, await getBytes(g.url));
        for (const [path, f] of Object.entries(g.include ?? {})) {
            const file = join(tmp, path);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, await getBytes(f.url));
        }
        const doc = await io.read(main);
        const info2 = modelInfo(doc);
        const maxTris = rule.maxTris ?? 60000;
        if (info2.tris > maxTris) throw new Error(`${info2.tris} triangles, more than ${maxTris}`);
        await MeshoptEncoder.ready;
        await doc.transform(
            dedup(),
            prune(),
            // At most 1024, each in its own format (a PNG keeps its alpha).
            textureCompress({ encoder: sharp, resize: [1024, 1024], quality: 85 }),
            meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
        );
        const glb = await io.writeBinary(doc);
        const file = `${src.id}/${slug}.glb`;
        writeFileSync(join(target, `${slug}.glb`), glb);
        const thumb = `${src.id}/thumbs/${slug}.png`;
        const has = await thumbnail(info, join(target, 'thumbs', `${slug}.png`), 160, 160).catch(() => false);
        return baseItem(ctx, 'model', file, glb.length, { tris: info2.tris, extent: info2.extent, ...(info2.animations.length ? { animations: info2.animations } : {}), ...(has ? { thumb } : {}) });
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

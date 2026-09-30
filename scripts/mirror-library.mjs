#!/usr/bin/env node
// Mirrors the open-source asset packs of scripts/library/sources.json into
// editor/library, which the editor serves next to itself (library/ in its
// build): a project copies a file in only when it is picked (the Library of
// the Assets panel, or the assistant). Upstream links can move or vanish;
// the mirror cannot.
//
//   node scripts/mirror-library.mjs              every source, at its pinned ref
//   node scripts/mirror-library.mjs kenney-city  only that source
//   node scripts/mirror-library.mjs --latest     move every source to its newest commit
//
// Models are packed into self-contained GLBs (their external textures and
// buffers embedded) with a thumbnail each, and their extent, triangles and
// animation clips in the catalog; sounds and images are copied as they are.
// Sources of type "polyhaven" come from Poly Haven's API instead of a git
// repository (library/polyhaven.mjs): realistic HDRIs, PBR materials and
// models, pinned by their ids. The GitHub workflow library-mirror.yml runs
// this script when the list changes and commits what it mirrored.
// Writes library/catalog.json, which the editor reads, and
// library/LICENSES.md.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { mirrorPolyHaven } from './library/polyhaven.mjs';
import { renderThumbnail } from './library/thumbnail.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = join(ROOT, 'scripts/library/sources.json');
const OUT = join(ROOT, 'editor/library');
const CACHE = join(tmpdir(), 'morglay-library');

const args = process.argv.slice(2);
const latest = args.includes('--latest');
const only = args.filter((a) => !a.startsWith('--'));

const config = JSON.parse(readFileSync(SOURCES, 'utf8'));
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

/** A shallow checkout of the source at its ref (or its newest commit). */
function checkout(src) {
    const dir = join(CACHE, src.id);
    if (!existsSync(join(dir, '.git'))) {
        mkdirSync(dir, { recursive: true });
        git(dir, 'init', '-q');
        git(dir, 'remote', 'add', 'origin', src.git);
    }
    const ref = latest || !src.ref ? 'HEAD' : src.ref;
    git(dir, 'fetch', '-q', '--depth', '1', 'origin', ref);
    git(dir, 'checkout', '-q', '--force', 'FETCH_HEAD');
    return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

const title = (file) =>
    basename(file, extname(file))
        .split(/[-_ ]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');

const slug = (file) =>
    basename(file, extname(file))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

/** A model's triangles, size in meters (x, y, z) as authored, and animation clips. */
function modelInfo(doc) {
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    let tris = 0;
    const count = (node) => {
        for (const prim of node.getMesh()?.listPrimitives() ?? []) {
            const n = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
            if (prim.getMode() === 4) tris += n / 3;
        }
        node.listChildren().forEach(count);
    };
    scene?.listChildren().forEach(count);
    const { min, max } = scene ? getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
    const extent = max.map((v, i) => Math.round((v - min[i]) * 1000) / 1000);
    const animations = doc.getRoot().listAnimations().map((a) => a.getName()).filter(Boolean);
    return { tris: Math.round(tris), extent, animations };
}

async function packModel(file, out, thumb) {
    const doc = await io.read(file);
    const glb = await io.writeBinary(doc);
    writeFileSync(out, glb);
    const png = renderThumbnail(doc);
    if (png) {
        mkdirSync(dirname(join(OUT, thumb)), { recursive: true });
        writeFileSync(join(OUT, thumb), png);
    }
    const { tris, extent, animations } = modelInfo(doc);
    return { tris, extent, ...(png ? { thumb } : {}), ...(animations.length ? { animations } : {}) };
}

/** Seconds of an Ogg Vorbis or Opus file: the last page's granule position over the rate. */
function oggSeconds(bytes) {
    if (bytes.toString('latin1', 0, 4) !== 'OggS') return undefined;
    const head = 27 + bytes[26];
    const codec = bytes.toString('latin1', head, head + 8);
    let rate = 0;
    let skip = 0;
    if (codec.startsWith('\x01vorbis')) rate = bytes.readUInt32LE(head + 12);
    else if (codec === 'OpusHead') {
        rate = 48000;
        skip = bytes.readUInt16LE(head + 10);
    }
    const last = bytes.lastIndexOf('OggS');
    if (!rate || last < 0) return undefined;
    const granule = Number(bytes.readBigInt64LE(last + 6));
    return Math.round(((granule - skip) / rate) * 100) / 100;
}

function pngSize(bytes) {
    if (bytes.toString('latin1', 1, 4) !== 'PNG') return undefined;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

const previous = existsSync(join(OUT, 'catalog.json')) ? JSON.parse(readFileSync(join(OUT, 'catalog.json'), 'utf8')) : null;
const sources = [];
const items = [];

for (const [index, src] of config.sources.entries()) {
    if (only.length && !only.includes(src.id)) {
        // Keep what an earlier run mirrored of the sources not asked for.
        const kept = previous?.sources.find((s) => s.id === src.id);
        if (kept) {
            sources.push(kept);
            items.push(...previous.items.filter((i) => i.source === src.id));
        }
        continue;
    }
    if (src.type === 'polyhaven') {
        console.log(`${src.id}: ${src.api ?? 'https://api.polyhaven.com'}`);
        const got = await mirrorPolyHaven({ src, out: OUT, latest, io, modelInfo });
        items.push(...got);
        const { items: _rules, api: _api, type: _type, resolution: _res, ...meta } = src;
        sources.push({ ...meta, assets: got.map((i) => ({ id: i.id, author: i.author, origin: i.origin })) });
        console.log(`  ${got.length} assets, ${(got.reduce((s, i) => s + i.bytes, 0) / 1024 / 1024).toFixed(1)} MiB`);
        continue;
    }
    console.log(`${src.id}: ${src.git}`);
    const { dir, commit } = checkout(src);
    const target = join(OUT, src.id);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const seen = new Set();
    for (const rule of src.items) {
        const files = globSync(rule.glob, { cwd: dir }).sort();
        if (!files.length) console.warn(`  nothing matches ${rule.glob}`);
        for (const rel of files) {
            // A model and a sound of the same name (coin.glb, coin.ogg) tell their kind apart.
            let id = slug(rel);
            if (seen.has(id)) id += `-${{ model: 'model', audio: 'sound', texture: 'image' }[rule.kind] ?? rule.kind}`;
            for (let n = 2; seen.has(id); n++) id = id.replace(/(-\d+)?$/, `-${n}`);
            seen.add(id);
            const from = join(dir, rel);
            const ext = rule.kind === 'model' ? '.glb' : extname(rel).toLowerCase();
            const file = `${src.id}/${id}${ext}`;
            const out = join(OUT, file);
            let info = {};
            if (rule.kind === 'model') info = await packModel(from, out, `${src.id}/thumbs/${id}.png`);
            else {
                copyFileSync(from, out);
                const bytes = readFileSync(out);
                if (rule.kind === 'audio') info = { seconds: oggSeconds(bytes) };
                else if (rule.kind === 'texture') info = { pixels: pngSize(bytes) };
            }
            items.push({
                id: `${src.id}/${id}`,
                name: title(rel),
                kind: rule.kind,
                file,
                bytes: statSync(out).size,
                source: src.id,
                tags: rule.tags ?? [],
                ...info,
            });
        }
    }
    const { items: _rules, git: _git, ref: _ref, ...meta } = src;
    sources.push({ ...meta, commit });
    const n = items.filter((i) => i.source === src.id);
    console.log(`  ${n.length} files, ${(n.reduce((s, i) => s + i.bytes, 0) / 1024).toFixed(0)} KiB at ${commit.slice(0, 12)}`);
    // Pin the commit, after the source's links, so the next run reproduces it.
    const { items: rules, ref: _pinned, ...links } = src;
    config.sources[index] = { ...links, ref: commit, items: rules };
}

const order = new Map(config.sources.map((s, i) => [s.id, i]));
sources.sort((a, b) => order.get(a.id) - order.get(b.id));
items.sort((a, b) => order.get(a.source) - order.get(b.source) || a.id.localeCompare(b.id));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'catalog.json'), JSON.stringify({ version: 1, name: 'Morglay library', sources, items }, null, 1) + '\n');

const credits = [
    '# Library credits',
    '',
    'The files under this folder are copies of the open-source asset packs below, mirrored by',
    '`scripts/mirror-library.mjs` from the list in `scripts/library/sources.json`. All of them are',
    'CC0 (public domain dedication): free to use, change and ship, with no attribution required.',
    'The credits are kept all the same.',
    '',
    ...sources.flatMap((s) => [
        s.commit
            ? `- **${s.name}** by ${s.author}, ${s.license}${s.licenseNote ? ` (${s.licenseNote})` : ''}: ${s.url} at \`${s.commit}\``
            : `- **${s.name}** by ${s.author}, ${s.license}${s.licenseNote ? ` (${s.licenseNote})` : ''}: ${s.url}`,
        ...(s.assets ?? []).map((a) => `  - ${a.id} by ${a.author}: ${a.origin}`),
    ]),
    '',
];
writeFileSync(join(OUT, 'LICENSES.md'), credits.join('\n'));

// One line per rule, as the file is written by hand.
const text = JSON.stringify(config, null, 4).replace(/\{\n\s+"(glob|kind)"[^{}]*?\n\s+\}/g, (rule) =>
    rule.replace(/\s*\n\s*/g, ' ').replace(/\[ /g, '[').replace(/ \]/g, ']'),
);
writeFileSync(SOURCES, text + '\n');

const total = items.reduce((s, i) => s + i.bytes, 0);
console.log(`${items.length} files, ${(total / 1024 / 1024).toFixed(2)} MiB in ${dirname(join(OUT, 'catalog.json'))}`);

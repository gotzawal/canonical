import { afterEach, describe, expect, it, vi } from 'vitest';
import { derivedPath } from '../../src/build/build';
import { decodersFor, gltfExtensions } from '../../src/build/modelInfo';
import {
    DEFAULT_MAX_SIZE, deleteDerivedOf, derivedKey, derivedOptions, derivedUsage, ENCODER_VERSION, evictDerived, gcDerived, getDerived, isFresh, putDerived, shipsCopy, storedCopy,
    type DerivedRecord, type DerivedRole,
} from '../../src/core/derived';
import { assetRoles } from '../../src/core/refs';
import type { AssetMeta, TextureRole } from '../../src/core/types';
import type { DeriveIn, DeriveOut } from '../../src/derive/derive.worker';
import { copyBlockBytes, encodedSize, encoderSettings, MAX_SOURCE_TEXELS, modelTextureOptions, slotRole, textureMemory } from '../../src/derive/encode';
import { DeriveQueue, PRIORITY, type WorkerLike } from '../../src/derive/queue';
import { DerivedAssets } from '../../src/derive/derivedAssets';
import { putAsset } from '../../src/core/assets';
import { Store } from '../../src/core/store';
import { newScene } from '../../src/core/defaults';

const meta = (id: string, extra: Partial<AssetMeta> = {}): AssetMeta => ({ id, name: `${id}.png`, kind: 'texture', mime: 'image/png', size: 1000, ...extra });

function record(asset: string, role: DerivedRole, extra: Partial<DerivedRecord> = {}): DerivedRecord {
    return {
        key: derivedKey(asset, role),
        asset,
        role,
        encoder: ENCODER_VERSION,
        src: { size: 1000 },
        opts: derivedOptions(role)!,
        blob: new Blob([new Uint8Array(10)]),
        bytes: 10,
        width: 64,
        height: 64,
        levels: 7,
        alpha: false,
        made: 1,
        used: 1,
        ...extra,
    };
}

describe('compressed copies', () => {
    it('are ETC1S for colors and UASTC for normal and data maps, unless asked otherwise', () => {
        expect(derivedOptions('color')).toEqual({ codec: 'etc1s', maxSize: DEFAULT_MAX_SIZE });
        expect(derivedOptions('normal')).toEqual({ codec: 'uastc', maxSize: DEFAULT_MAX_SIZE });
        expect(derivedOptions('data')?.codec).toBe('uastc');
        expect(derivedOptions('color', { mode: 'high' })?.codec).toBe('uastc');
        expect(derivedOptions('color', { maxSize: 512 })?.maxSize).toBe(512);
        expect(derivedOptions('normal', { mode: 'off' })).toBeNull();
        // A model's codec is that of its color textures.
        expect(derivedOptions('model')).toEqual({ codec: 'etc1s', maxSize: DEFAULT_MAX_SIZE });
        expect(derivedOptions('model', { mode: 'high', maxSize: 1024 })).toEqual({ codec: 'uastc', maxSize: 1024 });
        expect(derivedOptions('model', { mode: 'off' })).toBeNull();
    });

    it('of models ship when they hold KTX2 textures or are smaller than the file', () => {
        const model = meta('m', { name: 'm.glb', kind: 'model', size: 1000 });
        expect(shipsCopy(record('m', 'model', { textures: 2, bytes: 5000 }), model)).toBe(true);
        expect(shipsCopy(record('m', 'model', { textures: 0, bytes: 800 }), model)).toBe(true);
        expect(shipsCopy(record('m', 'model', { textures: 0, bytes: 1000 }), model)).toBe(false);
        // A texture's copy always does (its GPU memory is what it saves).
        expect(shipsCopy(record('t', 'color', { bytes: 5000 }), meta('t'))).toBe(true);
    });

    it('are stale once the file, the options or the encoder change', () => {
        const opts = derivedOptions('color')!;
        const rec = record('a', 'color', { src: { size: 1000, hash: 'abc' } });
        expect(isFresh(rec, meta('a', { hash: 'abc' }), opts)).toBe(true);
        // Without a fingerprint on either side, the size decides.
        expect(isFresh(rec, meta('a'), opts)).toBe(true);
        expect(isFresh(rec, meta('a', { hash: 'def' }), opts)).toBe(false);
        expect(isFresh(rec, meta('a', { size: 999 }), opts)).toBe(false);
        expect(isFresh(rec, meta('a'), { ...opts, maxSize: 1024 })).toBe(false);
        expect(isFresh(rec, meta('a'), { ...opts, codec: 'uastc' })).toBe(false);
        expect(isFresh({ ...rec, encoder: 'old' }, meta('a'), opts)).toBe(false);
        expect(isFresh(null, meta('a'), opts)).toBe(false);
    });

    it('stay in memory where IndexedDB is missing, and go when their files do', async () => {
        // Node has no IndexedDB: the store keeps them for the session.
        expect(await putDerived(record('a', 'color', { bytes: 100, used: 3 }))).toBe(false);
        await putDerived(record('a', 'normal', { bytes: 200, used: 1 }));
        await putDerived(record('b', 'color', { bytes: 300, used: 2 }));
        await putDerived(record('c', 'color', { bytes: 50, used: 4, encoder: 'basisu-old' }));
        expect((await getDerived(derivedKey('a', 'normal')))?.bytes).toBe(200);
        expect(await derivedUsage()).toEqual({ count: 4, bytes: 650 });
        expect(await storedCopy(meta('b'), 'color')).toBeInstanceOf(Blob);
        expect(await storedCopy(meta('b', { compress: { mode: 'off' } }), 'color')).toBeNull();

        // Garbage: assets no longer kept, and copies of another encoder.
        expect(await gcDerived(new Set(['a', 'b', 'c']))).toBe(1);
        // The copies used longest ago go first.
        expect(await evictDerived(250)).toBe(500);
        expect(await getDerived(derivedKey('a', 'normal'))).toBeNull();
        expect(await getDerived(derivedKey('b', 'color'))).toBeNull();
        expect(await getDerived(derivedKey('a', 'color'))).not.toBeNull();
        await deleteDerivedOf(['a']);
        expect(await derivedUsage()).toEqual({ count: 0, bytes: 0 });

        // A model's copy that saves nothing is not one a preview uses.
        const model = meta('m', { name: 'm.glb', kind: 'model', size: 1000 });
        await putDerived(record('m', 'model', { opts: derivedOptions('model')!, textures: 0, bytes: 1200 }));
        expect(await storedCopy(model, 'model')).toBeNull();
        await putDerived(record('m', 'model', { opts: derivedOptions('model')!, textures: 1, bytes: 1200 }));
        expect(await storedCopy(model, 'model')).toBeInstanceOf(Blob);
        await deleteDerivedOf(['m']);
        expect(await derivedUsage()).toEqual({ count: 0, bytes: 0 });
    });
});

describe('texture encoding', () => {
    it('fits the size in the largest side, whole blocks and the encoder limit', () => {
        expect(encodedSize(1024, 1024, 2048)).toEqual({ width: 1024, height: 1024 });
        expect(encodedSize(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024 });
        expect(encodedSize(1000, 750, 512)).toEqual({ width: 512, height: 384 });
        // Not whole 4x4 blocks: to the nearest.
        expect(encodedSize(1023, 767, 4096)).toEqual({ width: 1024, height: 768 });
        expect(encodedSize(18, 18, 2048)).toEqual({ width: 20, height: 20 });
        expect(encodedSize(1, 1, 2048)).toEqual({ width: 4, height: 4 });
        // A 4096 square is over the 12 Mpix the encoder takes.
        const big = encodedSize(4096, 4096, 4096);
        expect(big.width * big.height).toBeLessThanOrEqual(MAX_SOURCE_TEXELS);
        expect(big.width % 4 + big.height % 4).toBe(0);
    });

    it('encodes colors perceptually in sRGB and normal maps with their preset', () => {
        expect(encoderSettings('color', { codec: 'etc1s', maxSize: 2048 })).toMatchObject({ uastc: false, srgb: true, normalMap: false });
        expect(encoderSettings('normal', { codec: 'uastc', maxSize: 2048 })).toMatchObject({ uastc: true, srgb: false, normalMap: true, zstd: true });
        expect(encoderSettings('data', { codec: 'uastc', maxSize: 2048 })).toMatchObject({ uastc: true, srgb: false, normalMap: false });
    });

    it('estimates GPU memory with and without compression', () => {
        expect(textureMemory(2048, 2048)).toBe(22_369_620);
        expect(textureMemory(2048, 2048, 16)).toBe(5_592_432);
        expect(textureMemory(2048, 2048, copyBlockBytes('etc1s', false))).toBe(2_796_216);
        expect(copyBlockBytes('etc1s', true)).toBe(16);
        expect(copyBlockBytes('uastc', false)).toBe(16);
    });

    it('takes the role of a model\'s texture from the material slots using it', () => {
        expect(slotRole([{ name: 'baseColorTexture', color: true }])).toBe('color');
        expect(slotRole([{ name: 'metallicRoughnessTexture', color: false }, { name: 'occlusionTexture', color: false }])).toBe('data');
        // A normal map wherever one uses it as such.
        expect(slotRole([{ name: 'emissiveTexture', color: true }, { name: 'clearcoatNormalTexture', color: false }])).toBe('normal');
        expect(modelTextureOptions('color', { codec: 'etc1s', maxSize: 1024 })).toEqual({ codec: 'etc1s', maxSize: 1024 });
        expect(modelTextureOptions('normal', { codec: 'etc1s', maxSize: 1024 })).toEqual({ codec: 'uastc', maxSize: 1024 });
    });
});

/** A worker that answers when told to; `sent` holds what it got. */
class FakeWorker implements WorkerLike {
    static all: FakeWorker[] = [];
    sent: DeriveIn[] = [];
    terminated = false;
    onmessage: ((e: MessageEvent<DeriveOut>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    constructor() {
        FakeWorker.all.push(this);
    }
    postMessage(msg: DeriveIn) {
        this.sent.push(msg);
    }
    terminate() {
        this.terminated = true;
    }
    /** Answers its latest job. */
    finish(ok = true, extra: Partial<Extract<DeriveOut, { type: 'done' }>> = {}) {
        const job = [...this.sent].reverse().find((m) => m.type !== 'init') as Exclude<DeriveIn, { type: 'init' }>;
        const msg: DeriveOut = ok
            ? { type: 'done', id: job.id, data: new ArrayBuffer(8), width: 4, height: 4, levels: 3, alpha: false, ...extra }
            : { type: 'failed', id: job.id, message: 'bad image' };
        this.onmessage?.({ data: msg } as MessageEvent<DeriveOut>);
    }
    /** The names of the textures and models it was given. */
    get jobs(): string[] {
        return this.sent.filter((m) => m.type !== 'init').map((m) => (m as any).blob.name);
    }
}

const input = (name: string) => ({ blob: Object.assign(new Blob([name]), { name }), role: 'color' as const, opts: { codec: 'etc1s' as const, maxSize: 2048 } });

describe('the encoding queue', () => {
    afterEach(() => {
        FakeWorker.all = [];
        vi.useRealTimers();
    });

    it('runs one job per copy, the most urgent first', async () => {
        const q = new DeriveQueue(() => new FakeWorker(), 'encoder.wasm');
        const a = q.run('a', input('a'));
        const b = q.run('b', input('b'));
        const c = q.run('c', input('c'), PRIORITY.build);
        // The same copy again shares the job.
        const b2 = q.run('b', input('b'), PRIORITY.view);
        expect(q.size).toBe(3);
        const w = FakeWorker.all[0];
        expect(FakeWorker.all).toHaveLength(1);
        expect(w.sent[0]).toEqual({ type: 'init', wasmUrl: 'encoder.wasm' });
        expect(w.jobs).toEqual(['a']);
        w.finish();
        await expect(a).resolves.toMatchObject({ width: 4, levels: 3 });
        // The build's job, then the one the view raised.
        expect(w.jobs).toEqual(['a', 'c']);
        w.finish();
        w.finish(false);
        await expect(c).resolves.toBeTruthy();
        expect(w.jobs).toEqual(['a', 'c', 'b']);
        await expect(b).rejects.toThrow('bad image');
        await expect(b2).rejects.toThrow('bad image');
        expect(q.size).toBe(0);
    });

    it('sends models as model jobs and keeps how many textures they encoded', async () => {
        const q = new DeriveQueue(() => new FakeWorker(), 'encoder.wasm');
        const m = q.run('m|model', { ...input('m'), role: 'model' });
        const w = FakeWorker.all[0];
        expect(w.sent[1]).toMatchObject({ type: 'model', opts: { codec: 'etc1s', maxSize: 2048 } });
        expect(w.sent[1]).not.toHaveProperty('role');
        expect(q.keys()).toEqual(['m|model']);
        w.finish(true, { width: 0, height: 0, levels: 0, textures: 2 });
        await expect(m).resolves.toMatchObject({ textures: 2 });
        q.dispose();
    });

    it('starts nothing while paused and uses more workers when allowed', async () => {
        const q = new DeriveQueue(() => new FakeWorker(), 'encoder.wasm', { workers: 2 });
        q.pause(true);
        void q.run('a', input('a')).catch(() => {});
        void q.run('b', input('b')).catch(() => {});
        expect(FakeWorker.all).toHaveLength(0);
        q.pause(false);
        expect(FakeWorker.all.map((w) => w.jobs)).toEqual([['a'], ['b']]);
        q.dispose();
    });

    it('stops a job nobody waits for, and a worker that crashed', async () => {
        const q = new DeriveQueue(() => new FakeWorker(), 'encoder.wasm');
        const stop = new AbortController();
        const a = q.run('a', input('a'), PRIORITY.background, stop.signal);
        const b = q.run('b', input('b'));
        stop.abort();
        await expect(a).rejects.toThrow('Cancelled');
        // Encoding cannot be interrupted: that worker went, a new one took the next job.
        expect(FakeWorker.all[0].terminated).toBe(true);
        expect(FakeWorker.all[1].jobs).toEqual(['b']);
        FakeWorker.all[1].onerror?.({ message: 'out of memory', preventDefault() {} } as ErrorEvent);
        await expect(b).rejects.toThrow('out of memory');
        expect(q.size).toBe(0);
    });

    it('tells when jobs start encoding, and stops a worker that went idle during Play', async () => {
        vi.useFakeTimers();
        const q = new DeriveQueue(() => new FakeWorker(), 'encoder.wasm', { idleMs: 1000 });
        const changes: boolean[] = [];
        q.on('change', () => changes.push(q.running('a')));
        const a = q.run('a', input('a'));
        // Queued, then encoding.
        expect(changes).toEqual([false, true]);
        q.pause(true);
        FakeWorker.all[0].finish();
        await a;
        vi.advanceTimersByTime(1000);
        expect(FakeWorker.all[0].terminated).toBe(true);
        q.dispose();
    });

    it('stops idle workers, whose memory never shrinks', async () => {
        vi.useFakeTimers();
        const q = new DeriveQueue(() => new FakeWorker(), 'encoder.wasm', { idleMs: 1000 });
        const a = q.run('a', input('a'));
        FakeWorker.all[0].finish();
        await a;
        vi.advanceTimersByTime(999);
        expect(FakeWorker.all[0].terminated).toBe(false);
        vi.advanceTimersByTime(1);
        expect(FakeWorker.all[0].terminated).toBe(true);
        // The next job gets a new worker.
        void q.run('b', input('b')).catch(() => {});
        expect(FakeWorker.all).toHaveLength(2);
        q.dispose();
    });
});

describe('texture roles of a scene', () => {
    it('come from where each texture is used', () => {
        const doc = newScene();
        const tex = (id: string) => doc.assets.push({ id, name: id + '.png', kind: 'texture', mime: 'image/png', size: 1 });
        ['base', 'normal', 'rough', 'fx', 'code'].forEach(tex);
        doc.assets.push({ id: 'model', name: 'm.glb', kind: 'model', mime: 'model/gltf-binary', size: 1 });
        const box = doc.nodes.find((n) => n.mesh)!;
        Object.assign(box.mesh!.material, { map: 'base', normalMap: 'normal', metalRoughMap: 'rough', aoMap: 'rough' });
        box.particles = { texture: 'fx' } as any;
        doc.nodes.push({ ...box, id: 'm', mesh: undefined, particles: undefined, model: { asset: 'model', materials: { Skin: { map: 'base' } } } } as any);
        doc.shaders.push({ id: 'sh', name: 'S', kind: 'material', code: '// uses code', template: 'lit' } as any);
        const roles = assetRoles(doc);
        const of = (id: string) => [...(roles.get(id) ?? [])].sort();
        expect(of('base')).toEqual(['color']);
        expect(of('normal')).toEqual(['normal']);
        expect(of('rough')).toEqual(['data']);
        expect(of('fx')).toEqual(['color']);
        expect(of('model')).toEqual(['model']);
        expect(of('code')).toEqual(['unknown']);
    });
});

describe('game files', () => {
    it('name compressed copies after their texture and role', () => {
        expect(derivedPath(meta('a1', { name: 'Brick Wall.png' }), 'color')).toBe('media/a1-Brick-Wall.color.ktx2');
        expect(derivedPath(meta('a2', { name: 'noext' }), 'normal')).toBe('media/a2-noext.normal.ktx2');
        expect(derivedPath(meta('m1', { name: 'Hero.gltf', kind: 'model' }), 'model')).toBe('media/m1-Hero.game.glb');
    });

    it('bring the decoders a model needs, read from its glTF', async () => {
        const json = JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_texture_basisu'] });
        const text = new TextEncoder().encode(json + ' '.repeat((4 - (json.length % 4)) % 4));
        const header = new DataView(new ArrayBuffer(20));
        header.setUint32(0, 0x46546c67, true);
        header.setUint32(4, 2, true);
        header.setUint32(8, 20 + text.length, true);
        header.setUint32(12, text.length, true);
        header.setUint32(16, 0x4e4f534a, true);
        const glb = new Blob([header.buffer, text]);
        expect(await gltfExtensions(glb)).toEqual(['KHR_draco_mesh_compression', 'KHR_texture_basisu']);
        expect(decodersFor(await gltfExtensions(glb))).toEqual({ ktx2: true, draco: true, meshopt: false });
        expect(decodersFor(await gltfExtensions(new Blob([JSON.stringify({ extensionsRequired: ['EXT_meshopt_compression'] })])))).toEqual({ ktx2: false, draco: false, meshopt: true });
        // Unreadable: every decoder, rather than a game that cannot load it.
        expect(decodersFor(await gltfExtensions(new Blob(['not json'])))).toEqual({ ktx2: true, draco: true, meshopt: true });
    });
});

describe('the copies of a project', () => {
    afterEach(() => {
        FakeWorker.all = [];
    });

    /** A project with one texture, stored in this (Node) session, and its copies made by fake workers. */
    async function project() {
        const doc = newScene();
        const blob = new Blob([new Uint8Array(1000)], { type: 'image/png' });
        const meta = await putAsset(blob, 'Wall.png', 'texture');
        doc.assets.push(meta);
        const store = new Store(doc);
        store.prefs = { ...store.prefs, backgroundCompression: true };
        const derived = new DerivedAssets(store, () => new FakeWorker(), 'encoder.wasm');
        const asset = () => store.doc.assets.find((a) => a.id === meta.id)!;
        const setMax = (maxSize?: number) =>
            store.commit('Compression', (d) => {
                const a = d.assets.find((x) => x.id === meta.id)!;
                if (maxSize) a.compress = { maxSize };
                else delete a.compress;
            }, { design: true });
        return { store, derived, asset, setMax };
    }

    it('make a copy for other options in a job of its own, and keep only the one wanted', async () => {
        const { derived, asset, setMax } = await project();
        const first = derived.ensure(asset(), 'color');
        await vi.waitFor(() => expect(FakeWorker.all[0]?.jobs).toHaveLength(1));
        setMax(512);
        const second = derived.ensure(asset(), 'color');
        await vi.waitFor(() => expect(derived.queue.size).toBe(2));
        const w = FakeWorker.all[0];
        // The 2048 copy is done, but the asset now wants 512: it is not stored or shown.
        w.finish();
        await expect(first).resolves.toBeNull();
        expect(await getDerived(derivedKey(asset().id, 'color'))).toBeNull();
        expect(derived.statusOf(asset(), 'color').state).toMatch(/queued|encoding/);
        await vi.waitFor(() => expect((w.sent.at(-1) as any).opts).toEqual({ codec: 'etc1s', maxSize: 512 }));
        w.finish();
        await expect(second).resolves.toMatchObject({ opts: { maxSize: 512 } });
        expect((await getDerived(derivedKey(asset().id, 'color')))?.opts.maxSize).toBe(512);
        expect(derived.statusOf(asset(), 'color').state).toBe('ready');

        // Back to Auto, then to 512 before its job ends: the 512 copy stays stored and ready.
        setMax();
        const auto = derived.ensure(asset(), 'color');
        await vi.waitFor(() => expect(derived.queue.size).toBe(1));
        setMax(512);
        expect((await derived.check(asset(), 'color')).state).toBe('ready');
        w.finish();
        await expect(auto).resolves.toBeNull();
        expect((await getDerived(derivedKey(asset().id, 'color')))?.opts.maxSize).toBe(512);
        expect(derived.statusOf(asset(), 'color').state).toBe('ready');
        await deleteDerivedOf([asset().id]);
        derived.dispose();
    });

    it('stop the background jobs of an asset that left the project, but not a build\'s', async () => {
        const { store, derived, asset } = await project();
        const meta = asset();
        // The view and a build wait on the same job.
        derived.used(meta, 'color');
        const build = derived.ensure(meta, 'color');
        await vi.waitFor(() => expect(FakeWorker.all[0]?.jobs).toHaveLength(1));
        store.commit('Remove Asset', (d) => (d.assets = []), { design: true });
        expect(derived.queue.size).toBe(1);
        FakeWorker.all[0].finish();
        // Gone meanwhile: nothing is stored.
        await expect(build).resolves.toBeNull();
        expect(await getDerived(derivedKey(meta.id, 'color'))).toBeNull();

        // Only the view's: it stops with the asset.
        store.commit('Restore Asset', (d) => d.assets.push(meta), { design: true });
        derived.used(asset(), 'color');
        await vi.waitFor(() => expect(derived.queue.running(derived.queue.keys()[0] ?? '')).toBe(true));
        const worker = FakeWorker.all.at(-1)!;
        store.commit('Remove Asset', (d) => (d.assets = []), { design: true });
        expect(derived.queue.size).toBe(0);
        expect(worker.terminated).toBe(true);
        derived.dispose();
    });
});

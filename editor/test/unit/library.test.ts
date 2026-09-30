// The asset library's pure parts: search, packing a .gltf with its files
// into one GLB, and finding the sounds scripts name.
import { describe, expect, it } from 'vitest';
import { packGltf } from '../../src/core/gltfPack';
import { searchLibrary, type LibraryItem } from '../../src/core/library';
import { namesSound } from '../../src/core/refs';

const item = (id: string, name: string, kind: LibraryItem['kind'], tags: string[] = []): LibraryItem => ({ id, name, kind, tags, file: `${id}.x`, bytes: 1, source: 'p', url: id, catalog: 'c' });

describe('library', () => {
    it('finds items by every word, whole-word name matches first, and by kind', () => {
        const items = [item('a/road-corner', 'Road Corner', 'model', ['city', 'road']), item('a/crossroad', 'Crossroad', 'model', ['city']), item('a/coin', 'Coin', 'audio')];
        expect(searchLibrary(items, 'road').map((i) => i.id)).toEqual(['a/road-corner', 'a/crossroad']);
        expect(searchLibrary(items, 'road city corner').map((i) => i.id)).toEqual(['a/road-corner']);
        expect(searchLibrary(items, '', 'audio').map((i) => i.id)).toEqual(['a/coin']);
    });

    it('packs a .gltf and the files it names into one GLB', async () => {
        const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
        const gltf = {
            asset: { version: '2.0' },
            buffers: [{ uri: 'mesh.bin', byteLength: 8 }],
            bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: 4 }],
            images: [{ uri: 'tex/color.png' }],
        };
        const files: Record<string, Uint8Array> = { 'mesh.bin': bin, 'tex/color.png': png };
        const glb = new Uint8Array(await (await packGltf(gltf, async (uri) => files[uri].slice().buffer)).arrayBuffer());
        const dv = new DataView(glb.buffer);
        expect(dv.getUint32(0, true)).toBe(0x46546c67);
        expect(dv.getUint32(8, true)).toBe(glb.byteLength);
        const jsonLength = dv.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
        const binStart = 20 + jsonLength + 8;
        expect(json.buffers).toEqual([{ byteLength: 16 }]);
        expect(json.bufferViews[0]).toEqual({ buffer: 0, byteOffset: 4, byteLength: 4 });
        const img = json.images[0];
        expect(img.uri).toBeUndefined();
        expect(img.mimeType).toBe('image/png');
        const view = json.bufferViews[img.bufferView];
        expect([...glb.subarray(binStart + view.byteOffset, binStart + view.byteOffset + view.byteLength)]).toEqual([...png]);
        expect([...glb.subarray(binStart + 4, binStart + 8)]).toEqual([5, 6, 7, 8]);
    });

    it('finds the sounds a script or tree names', () => {
        const a = { id: 'a_1', name: 'Coin.ogg' };
        expect(namesSound("this.playSound('coin')", a)).toBe(true);
        expect(namesSound('{"clip":"Coin.ogg"}', a)).toBe(true);
        expect(namesSound("this.playSound('Coins')", a)).toBe(false);
    });
});

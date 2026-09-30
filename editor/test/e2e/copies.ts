// Helpers shared by the spec files split from derive.spec.ts.
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { png, unzip } from './fixtures';

/**
 * A 4 x 4 m card seen from above, unlit, with a 256-pixel texture of four
 * colored quarters (which shows a flipped or turned copy); resolves with
 * the texture's asset id.
 */
export async function card(page: Page, name = 'Quarters.png'): Promise<string> {
    return page.evaluate(async (name) => {
        const ed = window.__editor;
        ed.store.commit('Card', (d) => {
            d.nodes = d.nodes.filter((n) => n.name === 'Ground');
            const g = d.nodes[0];
            g.mesh!.geometry = { type: 'plane', width: 4, height: 4 };
            g.mesh!.material.type = 'unlit';
            g.mesh!.material.color = '#ffffff';
            d.environment.sky = 'color';
            d.environment.skyColor = '#000000';
        });
        ed.store.select([ed.store.doc.nodes[0].id]);
        ed.store.setCamera({ ...ed.store.camera, target: [0, 0, 0], yaw: 0, pitch: 89, distance: 5 });
        const c = new OffscreenCanvas(256, 256);
        const g = c.getContext('2d')!;
        const quarters = ['#e02020', '#20c020', '#2040e0', '#e0d020'];
        quarters.forEach((color, i) => {
            g.fillStyle = color;
            g.fillRect((i % 2) * 128, Math.floor(i / 2) * 128, 128, 128);
        });
        const blob = await c.convertToBlob({ type: 'image/png' });
        await ed.importFiles([new File([blob], name, { type: 'image/png' })]);
        return ed.store.doc.assets.find((a) => a.name === name)!.id;
    }, name);
}

/** The card's texture as SceneSync shows it: format, and whether the material still binds that same object. */
export function shown(page: Page, asset: string) {
    return page.evaluate(async (asset) => {
        const ed = window.__editor;
        await ed.sync.whenLoaded();
        const tex = (await ed.sync.loadTexture(asset, 'color')) as any;
        const mat = ed.sync.renderersOf(ed.store.doc.nodes[0].id)[0].materials[0] as any;
        return { format: tex.format as string, bound: mat.shader.getTexture('baseMap') === tex, images: ed.runtime.stats!.snapshot().memory.textures.image.bytes as number };
    }, asset);
}

/** The middle of the view (of the editor, or of a game's player) as RGB rows. */
export function view(page: Page, of: 'editor' | 'player' = 'editor'): Promise<{ w: number; h: number; data: number[] }> {
    return page.evaluate(async (of) => {
        const rt = of === 'editor' ? window.__editor.runtime : (window as any).__player.runtime;
        const [w, h] = rt.cssSize;
        const blob = await rt.captureFrame({ type: 'image/png', frames: 3, maxWidth: 160, crop: { x: w / 2 - 120, y: h / 2 - 120, w: 240, h: 240 } });
        const bmp = await createImageBitmap(blob);
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const data: number[] = [];
        for (let i = 0; i < d.length; i += 4) data.push(d[i], d[i + 1], d[i + 2]);
        return { w: bmp.width, h: bmp.height, data };
    }, of);
}

/** RGBA pixels of the card's four quarters (red, green, blue, yellow). */
export function quarterPixels(size: number): Uint8Array {
    const colors = [[224, 32, 32], [32, 192, 32], [32, 64, 224], [224, 208, 32]];
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) data.set([...colors[(x < size / 2 ? 0 : 1) + (y < size / 2 ? 0 : 2)], 255], (y * size + x) * 4);
    }
    return data;
}

/** Builds the scene with the Build & Deploy dialog's download; resolves with the files of the .zip. */
export async function buildZip(page: Page): Promise<Map<string, Uint8Array>> {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+b');
    const dialog = page.locator('.build-dialog');
    await expect(dialog).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 240_000 });
    await dialog.getByRole('button', { name: 'Download .zip' }).click();
    const zip = unzip(readFileSync(await (await download).path()));
    await page.keyboard.press('Escape');
    return zip;
}

/** Plays a built game served as a static site: `check` runs once its player started, and nothing may fail. */
export async function playGame<T>(browser: Browser, zip: Map<string, Uint8Array>, check: (player: Page) => Promise<T>): Promise<T> {
    const context = await browser.newContext();
    try {
        await context.route('https://game.test/**', (route) => {
            const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1)) || 'index.html';
            const body = zip.get(path);
            if (!body) return route.fulfill({ status: 404, body: 'missing' });
            const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', svg: 'image/svg+xml' }[path.split('.').pop()!] ?? 'application/octet-stream';
            return route.fulfill({ status: 200, body: Buffer.from(body), contentType: type });
        });
        const player = await context.newPage();
        const problems: string[] = [];
        player.on('pageerror', (e) => problems.push(e.message));
        player.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
        await player.goto('https://game.test/index.html');
        await player.waitForFunction(() => !!(window as any).__player, null, { polling: 200, timeout: 150_000 });
        const out = await check(player);
        expect(problems).toEqual([]);
        return out;
    } finally {
        await context.close();
    }
}

/** The JSON of a GLB file. */
export function glbJson(bytes: Uint8Array): any {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
}

/** Share of pixels close to each color of the card's quarters (red, green, blue, yellow). */
export function quarters(img: { data: number[] }): number[] {
    const colors = [[224, 32, 32], [32, 192, 32], [32, 64, 224], [224, 208, 32]];
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < img.data.length; i += 3) {
        colors.forEach((c, k) => {
            if (Math.max(Math.abs(img.data[i] - c[0]), Math.abs(img.data[i + 1] - c[1]), Math.abs(img.data[i + 2] - c[2])) < 48) counts[k]++;
        });
    }
    return counts.map((n) => n / (img.data.length / 3));
}

/** Share of pixels of each quarter's hue (red, green, blue, yellow), however lit. */
export function hues(img: { data: number[] }): number[] {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < img.data.length; i += 3) {
        const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if (r > 2 * g && r > 2 * b) counts[0]++;
        else if (g > 2 * r && g > 2 * b) counts[1]++;
        else if (b > 2 * r && b > 1.5 * g) counts[2]++;
        else if (r > 2 * b && g > 2 * b) counts[3]++;
    }
    return counts.map((n) => n / (img.data.length / 3));
}

/** Share of pixels that differ by more than `tolerance` in a channel. */
export function differing(a: { data: number[] }, b: { data: number[] }, tolerance = 40): number {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 3) {
        if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > tolerance) n++;
    }
    return n / (a.data.length / 3);
}

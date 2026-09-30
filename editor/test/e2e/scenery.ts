// Helpers shared by the spec files split from environment.spec.ts.
import { type Page } from '@playwright/test';
import type { EnvironmentDoc } from '../../src/core/types';
import { measure } from './measure';

export type EnvPatch = { [K in keyof EnvironmentDoc]?: EnvironmentDoc[K] extends object ? Partial<EnvironmentDoc[K]> : EnvironmentDoc[K] };

export function setEnv(page: Page, patch: EnvPatch) {
    return page.evaluate((patch) => {
        const store = window.__editor.store;
        store.commit('Environment', (d) => {
            for (const [k, v] of Object.entries(patch)) {
                const cur = (d.environment as any)[k];
                (d.environment as any)[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cur, ...v } : v;
            }
        }, { env: true });
    }, patch as any);
}

/** The post effects in the order they run, with whether each is on. */
export function chain(page: Page): Promise<[string, boolean][]> {
    return page.evaluate(() => {
        const pass = (window.__editor.runtime.view.renderGraph as any).getPass('PostPass');
        return Array.from(pass.postList.entries() as Iterable<[string, any]>).map(([name, post]) => [name, !!post.enable] as [string, boolean]);
    });
}

/** The view as RGB rows, after `frames` frames; `crop` in CSS pixels. */
export function pixels(page: Page, crop?: { x: number; y: number; w: number; h: number }): Promise<{ w: number; h: number; data: number[] }> {
    return page.evaluate(async (crop) => {
        const rt = window.__editor.runtime;
        const blob = await rt.captureFrame({ type: 'image/png', frames: 4, maxWidth: 320, ...(crop ? { crop } : {}) });
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const out: number[] = [];
        for (let i = 0; i < d.length; i += 4) out.push(d[i], d[i + 1], d[i + 2]);
        return { w: bmp.width, h: bmp.height, data: out };
    }, crop);
}

/** Mean RGB of a band of rows (0..1 from the top) of an image. */
export function band(img: { w: number; h: number; data: number[] }, from: number, to: number): [number, number, number] {
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = Math.floor(from * img.h); y < Math.floor(to * img.h); y++) {
        for (let x = 0; x < img.w; x++) {
            for (let k = 0; k < 3; k++) sum[k] += img.data[(y * img.w + x) * 3 + k];
            n++;
        }
    }
    return sum.map((v) => v / Math.max(1, n)) as [number, number, number];
}

export function differing(a: { data: number[] }, b: { data: number[] }): number {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 3) {
        if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 12) n++;
    }
    return n / (a.data.length / 3);
}

/** A large flat gray ground and the camera low over it, looking along it. */
export async function flatGround(page: Page) {
    await page.evaluate(() => {
        const ed = window.__editor;
        ed.store.commit('Ground', (d) => {
            d.nodes = d.nodes.filter((n) => n.name === 'Sun' || n.name === 'Ground');
            const g = d.nodes.find((n) => n.name === 'Ground')!;
            g.mesh!.geometry = { type: 'plane', width: 400, height: 400 };
            g.mesh!.material.color = '#b0b0b0';
            d.environment.sky = 'color';
            d.environment.skyColor = '#b0b0b0';
        });
        ed.store.setCamera({ ...ed.store.camera, target: [0, 1.5, -40], yaw: 180, pitch: 2, distance: 40 });
    });
    await measure(page, 2);
}

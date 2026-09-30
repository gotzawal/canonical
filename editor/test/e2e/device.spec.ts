// A device like many phones: without bgra8unorm-storage, depth-clip-control,
// depth32float-stencil8, indirect-first-instance, rg11b10ufloat-renderable
// and BC texture compression. The engine asks only for what the adapter has,
// so the editor starts and draws there too.
import { expect, test } from '@playwright/test';
import { sharedEditor } from './editor';
import { measure } from './measure';

const HIDDEN = ['bgra8unorm-storage', 'depth-clip-control', 'depth32float-stencil8', 'indirect-first-instance', 'rg11b10ufloat-renderable', 'texture-compression-bc'];

const problems: string[] = [];
const editor = sharedEditor(async (page) => {
    page.on('console', (m) => {
        if (m.type() === 'error') problems.push(m.text());
    });
    await page.addInitScript((hidden) => {
        const proto = (globalThis as any).GPUAdapter?.prototype;
        if (!proto) return;
        const features = Object.getOwnPropertyDescriptor(proto, 'features')!.get!;
        // The adapter lists fewer features, and a device asking for a hidden one fails as it would there.
        Object.defineProperty(proto, 'features', {
            get(this: GPUAdapter) {
                const all = features.call(this) as GPUSupportedFeatures;
                return new Set(Array.from(all).filter((f) => !hidden.includes(f)));
            },
        });
        const request = proto.requestDevice;
        proto.requestDevice = function (desc?: GPUDeviceDescriptor) {
            const asked = Array.from(desc?.requiredFeatures ?? []);
            const missing = asked.filter((f) => hidden.includes(f));
            if (missing.length) return Promise.reject(new TypeError(`Unsupported features: ${missing.join(', ')}`));
            return request.call(this, desc);
        };
    }, HIDDEN);
});

test.beforeEach(async () => {
    await editor.reset();
    problems.length = 0;
});
test.afterEach(() => {
    expect(editor.errors).toEqual([]);
    expect(problems).toEqual([]);
});

test('starts and draws on a device without the optional features', async () => {
    const page = editor.page();
    const m = await measure(page, 3);
    expect(m.draws).toBeGreaterThan(0);
    const device = await page.evaluate(() => {
        const ctx = window.__editor.runtime.engine.context3D;
        return { features: Array.from(ctx.device.features as unknown as Set<string>), support: ctx.compressedTextureSupport };
    });
    for (const f of HIDDEN) expect(device.features).not.toContain(f);
    expect(device.support.bc).toBe(false);
});

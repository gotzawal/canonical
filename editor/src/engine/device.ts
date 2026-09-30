// What a page knows of its device before the engine starts, to pick a
// graphics quality tier (core/quality.ts): the GPU (from an adapter of its
// own; the engine requests another), whether it is a phone or tablet, and
// its memory.

import { isMobileDevice, type DeviceInfo } from '../core/quality';

export async function probeDevice(): Promise<DeviceInfo> {
    const nav = navigator as any;
    let gpu = '';
    let fallback = false;
    let maxTexture: number | undefined;
    try {
        const adapter = await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        if (adapter) {
            const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
            gpu = [info.vendor, info.architecture, info.description, info.device].filter((s: unknown) => typeof s === 'string' && s).join(' ');
            fallback = !!(adapter.isFallbackAdapter ?? info.isFallbackAdapter);
            maxTexture = adapter.limits?.maxTextureDimension2D;
        }
    } catch {
        // The engine reports what is wrong with WebGPU.
    }
    return { gpu, fallback, mobile: isMobileDevice(nav), memory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined, maxTexture, saveData: !!nav.connection?.saveData };
}

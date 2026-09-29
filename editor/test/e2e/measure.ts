// Measuring what a scene costs to draw in the page (engine/gpuStats.ts).

import type { Page } from '@playwright/test';

export interface Measure {
    draws: number;
    peak: number;
    passes: number;
    triangles: number;
    api: number;
    pipelines: number;
    memory: { stable: number; images: number; targets: number; buffers: number };
    cpu: number;
    settled: boolean;
}

/**
 * Waits until the counts stop changing (pipelines are made when first
 * needed, mip levels when a texture is first used), then measures `frames`
 * frames.
 */
export function measure(page: Page, frames = 10): Promise<Measure> {
    return page.evaluate(async (frames) => {
        const rt = window.__editor.runtime;
        const stats = rt.stats!;
        await window.__editor.sync.whenLoaded();
        const frame = () =>
            new Promise<void>((resolve) => {
                const off = rt.onFrame(() => {
                    off();
                    resolve();
                });
            });
        let same = 0;
        let last = '';
        for (let i = 0; i < 600 && same < 5; i++) {
            await frame();
            const s = stats.snapshot(1);
            const key = `${s.frame.draws}|${s.pipelinesCreated}|${s.memory.stable}`;
            same = key === last ? same + 1 : 0;
            last = key;
        }
        for (let i = 0; i < frames; i++) await frame();
        const s = stats.snapshot(frames);
        const b = s.memory.buffers;
        return {
            draws: s.frame.draws,
            peak: s.peak.draws,
            passes: s.frame.renderPasses,
            triangles: s.frame.triangles,
            api: s.frame.pipelines + s.frame.bindGroups,
            pipelines: s.pipelinesCreated,
            memory: {
                stable: s.memory.stable,
                images: s.memory.textures.image.bytes,
                targets: s.memory.textures.target.bytes,
                buffers: b.vertex.bytes + b.index.bytes + b.uniform.bytes + b.storage.bytes + b.other.bytes,
            },
            cpu: s.cpu.median,
            settled: same >= 5,
        };
    }, frames);
}

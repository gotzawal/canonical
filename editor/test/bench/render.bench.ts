// The editor's work on large scenes (a level as the assistant builds it, a
// large outdoor scene), and what counting draw calls at the WebGPU API
// costs (engine/gpuStats.ts wraps every draw). `pnpm run editor:bench`
// fails when a benchmark named "(budget N ms)" takes longer (its 75th
// percentile; see budgets.mjs).

import { bench, describe } from 'vitest';
import { Store } from '../../src/core/store';
import type { SceneDoc } from '../../src/core/types';
import { installGpuStats } from '../../src/engine/gpuStats';
import { aiLevelScene, outdoorScene } from './scene';

const LEVEL = aiLevelScene();
const OUTDOOR = outdoorScene(2000);
const copy = (doc: SceneDoc): SceneDoc => JSON.parse(JSON.stringify(doc));

describe('open the render scenes', () => {
    bench(`level of ${LEVEL.nodes.length} objects (budget 15 ms)`, () => {
        new Store(copy(LEVEL));
    });
    bench(`outdoor scene of ${OUTDOOR.nodes.length} objects (budget 60 ms)`, () => {
        new Store(copy(OUTDOOR));
    });
});

describe('count draw calls at the WebGPU API', () => {
    class Pass {
        setPipeline(_p: unknown) {}
        setBindGroup(_i: number, _g: unknown) {}
        drawIndexed(_count: number, _instances?: number) {}
    }
    const page: any = { GPURenderPassEncoder: class extends Pass {}, GPUDevice: class {} };
    const stats = installGpuStats(page);
    const counted = new page.GPURenderPassEncoder();
    const frame = (pass: Pass) => {
        for (let i = 0; i < 10_000; i++) {
            pass.setBindGroup(1, null);
            pass.drawIndexed(36, 1);
        }
    };
    bench('10,000 draws, counted (budget 3 ms)', () => {
        stats.beginFrame();
        frame(counted);
        stats.endFrame();
    });
});

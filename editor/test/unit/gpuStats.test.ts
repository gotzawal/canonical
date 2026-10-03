import { describe, expect, it } from 'vitest';
import { installGpuStats, textureBytes } from '../../src/engine/gpuStats';

/** WebGPU as classes with nothing behind them, on a page object of their own. */
function fakePage() {
    class GPUBuffer {
        destroyed = 0;
        destroy() {
            this.destroyed++;
        }
    }
    class GPUTexture {
        destroy() {}
    }
    class GPURenderPipeline {}
    class GPURenderBundle {}
    class GPURenderPassEncoder {
        setPipeline(_p: unknown) {}
        setBindGroup() {}
        draw(_count: number, _instances?: number) {
            return 'drawn';
        }
        drawIndexed(_count: number, _instances?: number) {}
        drawIndexedIndirect() {}
        executeBundles(_b: unknown[]) {}
    }
    class GPURenderBundleEncoder {
        setPipeline(_p: unknown) {}
        drawIndexed(_count: number, _instances?: number) {}
        finish() {
            return new GPURenderBundle();
        }
    }
    class GPUCommandEncoder {
        beginRenderPass() {
            return new GPURenderPassEncoder();
        }
        beginComputePass() {
            return {};
        }
    }
    class GPUQueue {
        submit() {}
        writeBuffer() {}
        writeTexture() {}
        copyExternalImageToTexture(_source: unknown, _dest: unknown, _size: unknown) {}
    }
    class GPUDevice {
        createBuffer(_d: unknown) {
            return new GPUBuffer();
        }
        createTexture(_d: unknown) {
            return new GPUTexture();
        }
        createRenderPipeline(_d: unknown) {
            return new GPURenderPipeline();
        }
        createRenderBundleEncoder() {
            return new GPURenderBundleEncoder();
        }
        createCommandEncoder() {
            return new GPUCommandEncoder();
        }
    }
    const page: any = { GPUBuffer, GPUTexture, GPURenderPassEncoder, GPURenderBundleEncoder, GPUCommandEncoder, GPUQueue, GPUDevice };
    return { page, device: new GPUDevice(), queue: new GPUQueue() };
}

describe('GPU memory math', () => {
    it('sizes textures with their mip levels, layers, blocks and samples', () => {
        // 1024 x 1024 RGBA8 with 11 mips: 4/3 of the top level, to the byte.
        expect(textureBytes({ size: [1024, 1024], format: 'rgba8unorm', mipLevelCount: 11 })).toBe(5_592_404);
        expect(textureBytes({ size: { width: 2048, height: 2048, depthOrArrayLayers: 8 }, format: 'depth32float' })).toBe(134_217_728);
        expect(textureBytes({ size: [1024, 1024], format: 'bc7-rgba-unorm' })).toBe(1024 * 1024);
        expect(textureBytes({ size: [1024, 1024], format: 'bc1-rgba-unorm-srgb' })).toBe(512 * 1024);
        // A 2 x 2 level still takes a whole 4 x 4 block.
        expect(textureBytes({ size: [2, 2], format: 'astc-4x4-unorm' })).toBe(16);
        expect(textureBytes({ size: [800, 600], format: 'bgra8unorm', sampleCount: 4 })).toBe(800 * 600 * 4 * 4);
        expect(textureBytes({ size: [64, 64, 64], format: 'r8unorm', dimension: '3d', mipLevelCount: 2 })).toBe(64 ** 3 + 32 ** 3);
    });
});

describe('GPU counting', () => {
    it('counts memory while it is alive, once per destroy', () => {
        const { page, device, queue } = fakePage();
        const stats = installGpuStats(page);
        expect(installGpuStats(page)).toBe(stats);
        const buf = device.createBuffer({ size: 256, usage: 0x20 });
        const staging = device.createBuffer({ size: 1000, usage: 0x2 });
        const tex = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x4 | 0x2 });
        const target = device.createTexture({ size: [8, 8], format: 'rgba16float', usage: 0x10 | 0x4 });
        expect(stats.memory.buffers.vertex).toEqual({ bytes: 256, count: 1 });
        expect(stats.memory.textures.other.bytes).toBe(64);
        expect(stats.memory.textures.target.bytes).toBe(512);
        // Staging buffers are counted apart from the stable total.
        expect(stats.memory.stable).toBe(256 + 64 + 512);
        expect(stats.memory.buffers.staging.bytes).toBe(1000);

        // A texture that gets pixels from the CPU is an image.
        queue.copyExternalImageToTexture({}, { texture: tex }, [4, 4]);
        expect(stats.memory.textures.image.bytes).toBe(64);
        expect(stats.memory.textures.other.bytes).toBe(0);

        buf.destroy();
        buf.destroy();
        expect(buf.destroyed).toBe(2);
        expect(stats.memory.buffers.vertex).toEqual({ bytes: 0, count: 0 });
        staging.destroy();
        target.destroy();
        expect(stats.memory.stable).toBe(64);
        // Depth arrays are shadow maps, and the list names every live texture.
        device.createTexture({ size: { width: 16, height: 16, depthOrArrayLayers: 2 }, format: 'depth32float', usage: 0x2 | 0x4, label: 'shadows' });
        expect(stats.memory.textures.shadow).toEqual({ bytes: 2048, count: 1 });
        expect(stats.textures().map((t) => [t.label, t.cls, t.bytes])).toEqual([['shadows', 'shadow', 2048], ['', 'image', 64]]);
    });

    it('counts draws, triangles and passes per frame, and bundles each time they run', () => {
        const { page, device, queue } = fakePage();
        const stats = installGpuStats(page);
        const lines = device.createRenderPipeline({ primitive: { topology: 'line-list' } });
        const tris = device.createRenderPipeline({});
        stats.beginFrame();
        const pass = device.createCommandEncoder().beginRenderPass();
        pass.setPipeline(tris);
        pass.setBindGroup();
        // The wrappers pass the result through.
        expect(pass.draw(6, 3)).toBe('drawn');
        pass.drawIndexed(36);
        pass.setPipeline(lines);
        pass.drawIndexed(100);
        pass.drawIndexedIndirect();
        queue.submit();
        stats.endFrame(2);
        const f = stats.snapshot().frame;
        expect(f).toMatchObject({ draws: 4, triangles: 2 * 3 + 12, instances: 5, renderPasses: 1, pipelines: 2, bindGroups: 1, submits: 1 });
        expect(stats.pipelinesCreated).toBe(2);

        // A bundle's draws count when it runs, every frame it runs, not when it was recorded.
        const enc = device.createRenderBundleEncoder();
        enc.setPipeline(tris);
        enc.drawIndexed(300, 2);
        const bundle = enc.finish();
        stats.beginFrame();
        stats.endFrame(1);
        expect(stats.snapshot().frame.draws).toBe(0);
        for (let i = 0; i < 2; i++) {
            stats.beginFrame();
            device.createCommandEncoder().beginRenderPass().executeBundles([bundle]);
            stats.endFrame(1);
            expect(stats.snapshot().frame).toMatchObject({ draws: 1, triangles: 200, instances: 2 });
        }
        // The peak over the recent frames and the CPU time.
        const s = stats.snapshot();
        expect(s.peak.draws).toBe(4);
        expect(s.cpu).toMatchObject({ median: 1, frames: 4 });
    });

    it('leaves out what the page lacks and never breaks a call', () => {
        const { page, device } = fakePage();
        delete page.GPURenderBundleEncoder;
        const stats = installGpuStats(page);
        // A descriptor it cannot read is counted as nothing.
        expect(() => device.createTexture(null)).not.toThrow();
        expect(() => device.createBuffer(undefined)).not.toThrow();
        expect(stats.memory.stable).toBeGreaterThanOrEqual(0);
    });
});

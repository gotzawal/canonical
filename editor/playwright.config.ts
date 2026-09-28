// Browser tests of the built editor (pnpm run editor:build first). WebGPU runs
// on the CPU with SwiftShader, headed under a virtual display, which is more
// reliable than headless: `xvfb-run -a pnpm run editor:e2e`. SwiftShader is
// CPU bound, so the tests run one at a time; compiling the shaders stalls the
// first frames for half a minute, and without the GPU watchdog that is no
// "Instance dropped" error.
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './test/e2e',
    outputDir: './test-results',
    timeout: 180_000,
    expect: { timeout: 60_000 },
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:8101',
        headless: false,
        viewport: { width: 1280, height: 800 },
        launchOptions: {
            args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-gpu-watchdog', '--no-sandbox'],
        },
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npx vite preview --config editor/vite.config.js --port 8101 --strictPort',
        cwd: '..',
        url: 'http://localhost:8101',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});

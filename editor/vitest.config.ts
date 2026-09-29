// Unit tests of the editor logic that runs without a browser: the store, the
// behavior formats, the script compiler, the room planner and the level
// check. Browser tests (Playwright) are in test/e2e.
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            // The engine needs WebGPU; the logic under test only names its classes.
            '@orillusion/core': here('./test/unit/engine.stub.ts'),
        },
    },
    test: {
        root: here('.'),
        include: ['test/unit/**/*.test.ts'],
        setupFiles: ['test/unit/setup.ts'],
        environment: 'node',
        // Benchmarks of the editor's work on a large synthetic scene, with budgets (test/bench/budgets.mjs).
        benchmark: {
            include: ['test/bench/**/*.bench.ts'],
        },
    },
});

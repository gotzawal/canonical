// Vite config for the browser-only scene editor (editor/).
// The editor imports the engine straight from ../src, so every build
// ships whatever engine code is on the branch being built.
import { defineConfig } from 'vite'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

function gitSha() {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
    try {
        return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
        return ''
    }
}

export default defineConfig({
    root: here('.'),
    // Relative base so the build works under any sub path,
    // e.g. https://<user>.github.io/<repo>/
    base: './',
    publicDir: false,
    define: {
        __EDITOR_BUILD__: JSON.stringify({
            sha: gitSha(),
            ref: process.env.GITHUB_REF_NAME || '',
            repo: process.env.GITHUB_REPOSITORY || '',
            time: new Date().toISOString(),
        }),
    },
    resolve: {
        alias: {
            '@orillusion/core': here('../src/index.ts'),
        },
    },
    // Parts of the engine dispatch on `constructor.name` (Struct sizes,
    // ValueOp, post-effect registry), so minification must keep names.
    esbuild: {
        keepNames: true,
    },
    server: {
        host: '0.0.0.0',
        port: 8100,
    },
    preview: {
        port: 8101,
    },
    build: {
        target: 'esnext',
        outDir: here('./dist'),
        emptyOutDir: true,
        chunkSizeWarningLimit: 8000,
        sourcemap: false,
    },
})

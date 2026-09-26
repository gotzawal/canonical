// Vite config for the browser-only scene editor (editor/).
// The editor imports the engine straight from ../src (and the particle
// package from ../packages/particle), so every build ships whatever engine
// code is on the branch being built.
//
// Two pages are built: the editor (index.html) and the game player
// (player.html). File > Build & Deploy copies the player's files into every
// game it builds; player-manifest.json lists them.
import { build as viteBuild, defineConfig } from 'vite'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

const PLAYER_MANIFEST = 'player-manifest.json'

function gitSha() {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
    try {
        return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
        return ''
    }
}

/** Settings the editor build and the on-demand player build (devPlayer) share. */
function shared() {
    return {
        root: here('.'),
        // Relative base so the build works under any sub path,
        // e.g. https://<user>.github.io/<repo>/
        base: './',
        // Favicons and logo files, copied as they are next to index.html.
        publicDir: here('./public'),
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
                '@orillusion/particle': here('../packages/particle/index.ts'),
            },
        },
        // Parts of the engine dispatch on `constructor.name` (Struct sizes,
        // ValueOp, post-effect registry), so minification must keep names.
        esbuild: {
            keepNames: true,
        },
    }
}

/**
 * Writes player-manifest.json: player.html and every file it loads (its
 * entry chunk, the chunks that imports, CSS and assets, the favicon).
 */
function playerManifest() {
    return {
        name: 'canonical-player-manifest',
        apply: 'build',
        writeBundle(options, bundle) {
            const entry = Object.values(bundle).find(
                (c) => c.type === 'chunk' && c.isEntry && (c.facadeModuleId || '').endsWith('player.html'),
            )
            if (!entry) return
            const files = new Set(['player.html'])
            const visit = (name) => {
                const item = bundle[name]
                if (!item || files.has(name)) return
                files.add(name)
                if (item.type !== 'chunk') return
                for (const n of [...item.imports, ...item.dynamicImports]) visit(n)
                for (const n of item.viteMetadata?.importedCss ?? []) files.add(n)
                for (const n of item.viteMetadata?.importedAssets ?? []) files.add(n)
            }
            visit(entry.fileName)
            if (fs.existsSync(path.join(options.dir, 'favicon.svg'))) files.add('favicon.svg')
            const manifest = { html: 'player.html', files: Array.from(files).sort() }
            fs.writeFileSync(path.join(options.dir, PLAYER_MANIFEST), JSON.stringify(manifest, null, 1))
        },
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
}

/**
 * The dev server has no production player to copy into games, so this
 * builds one on demand into Vite's cache folder, again after source
 * changes, and serves it: /player-manifest.json with base "__player/".
 */
function devPlayer() {
    let outDir = ''
    let building = null
    let dirty = true
    const buildPlayer = async () => {
        await viteBuild({
            ...shared(),
            configFile: false,
            mode: 'production',
            logLevel: 'warn',
            plugins: [playerManifest()],
            build: {
                target: 'esnext',
                outDir,
                emptyOutDir: true,
                chunkSizeWarningLimit: 8000,
                rollupOptions: { input: { player: here('./player.html') } },
            },
        })
        return JSON.parse(fs.readFileSync(path.join(outDir, PLAYER_MANIFEST), 'utf8'))
    }
    return {
        name: 'canonical-dev-player',
        apply: 'serve',
        configureServer(server) {
            outDir = path.join(server.config.cacheDir, 'canonical-player')
            const touch = () => (dirty = true)
            server.watcher.on('change', touch)
            server.watcher.on('add', touch)
            server.watcher.on('unlink', touch)
            server.middlewares.use(async (req, res, next) => {
                const url = decodeURIComponent((req.url || '').split('?')[0])
                try {
                    if (url === '/' + PLAYER_MANIFEST) {
                        if (dirty || !building) {
                            dirty = false
                            // One build at a time: they share the output folder.
                            const previous = building
                            const run = (async () => {
                                if (previous) await previous.catch(() => {})
                                return buildPlayer()
                            })()
                            building = run
                            run.catch(() => {
                                if (building === run) building = null
                            })
                        }
                        const manifest = await building
                        res.setHeader('Content-Type', MIME['.json'])
                        res.setHeader('Cache-Control', 'no-store')
                        res.end(JSON.stringify({ ...manifest, base: '__player/' }))
                        return
                    }
                    if (url.startsWith('/__player/')) {
                        if (building) await building.catch(() => {})
                        const file = path.resolve(outDir, '.' + url.slice('/__player'.length))
                        if (!file.startsWith(outDir + path.sep) || !fs.existsSync(file)) {
                            res.statusCode = 404
                            res.end('Not found')
                            return
                        }
                        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
                        res.setHeader('Cache-Control', 'no-store')
                        res.end(fs.readFileSync(file))
                        return
                    }
                } catch (e) {
                    server.config.logger.error(`[canonical] player build failed: ${e?.message || e}`)
                    res.statusCode = 500
                    res.end(`The player build failed: ${e?.message || e}`)
                    return
                }
                next()
            })
        },
    }
}

export default defineConfig({
    ...shared(),
    plugins: [playerManifest(), devPlayer()],
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
        rollupOptions: {
            input: {
                index: here('./index.html'),
                player: here('./player.html'),
            },
        },
    },
})

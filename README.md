<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="editor/public/logo-white.svg">
    <img src="editor/public/logo.svg" alt="Canonical logo" width="112">
  </picture>
</p>

<h1 align="center">Canonical</h1>

<p align="center">
  An open-source, AI-automated development editor based on the Orillusion WebGPU engine.
</p>

<p align="center">
  <a href="https://gotzawal.github.io/canonical/"><strong>Open the editor</strong></a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#the-ai-assistant">AI assistant</a>
  &nbsp;·&nbsp;
  <a href="#the-engine-orillusion">Engine</a>
  &nbsp;·&nbsp;
  <a href="#development">Development</a>
</p>


<img width="1200" height="679" alt="image" src="https://github.com/user-attachments/assets/813ddf3c-0550-4a57-90ab-7d66e75ef87e" />



Canonical is an editor for building interactive 3D for the web, where an AI assistant does the development work with you. You describe what you want; the assistant builds the scene, writes the scripts and shaders, runs the scene in Play mode to test its work, reads the errors and fixes them. Everything it does is ordinary editor work, so you can inspect, change or undo any of it by hand.

The editor runs entirely in the browser, with nothing to install and no server. It is published from this repository to **https://gotzawal.github.io/canonical/** every time `main` is updated.

| Name | What it is |
|---|---|
| **Canonical** | This project: the editor, its AI assistant and the tooling around them |
| **Orillusion** | The WebGPU engine Canonical is built on. Its source is included in this repository |

## Features

**AI assistant**

- Works on the open project through tools: it reads and edits the scene and imported models, writes and fixes scripts and shaders, changes the render graph, runs Play tests and reads the console
- With vision models it can also look at the viewport to check the result
- Everything one request changes is a single undo step
- Works with any OpenRouter model that supports tool calls

**Scene editing**

- Create primitives, lights, cameras and empties, import `.glb` / `.gltf` models and textures (drag and drop onto the viewport works too)
- Move / rotate / scale with the gizmo (`W` `E` `R`), snapping, undo / redo, multi-select, grouping, hierarchy drag and drop
- Materials: physically based Lit (normal, metallic-roughness, occlusion and emission maps, clear coat, transmission for glass and water), Unlit, Lambert or a custom shader, with presets and alpha blending or cutout
- Lights, sky, exposure, bloom, ambient occlusion, fog and global illumination (DDGI: light bounces between surfaces)
- Edit imported models: every mesh part (visibility, shadows, transform, which material it uses) and every material slot (the file's material, Unlit, Lambert or a custom shader; color, PBR values, alpha, texture). Changes are stored per instance as overrides and the model file is left untouched; clicking a part in the viewport opens it in the Inspector

**Code**

- JavaScript behaviours, and a Play mode (`Ctrl+P`) to run them; Stop puts the scene back exactly as it was
- WGSL material shaders and full screen post effects in the built-in code editor; properties declared in the code become Inspector controls
- The engine's render graph (passes and the resources they read and write): switch passes off and order the post chain

**Files**

- Scenes autosave to the browser (imported files live in IndexedDB)
- `Ctrl+S` downloads a `.scene.json` with assets, scripts and shaders embedded, `Ctrl+O` opens one
- **File > Build & Deploy** (`Ctrl+B`) turns the scene into a standalone web game: run it in a new tab, download it as a `.zip` for any static host, or publish it to GitHub Pages

**File > Open Example: Showcase** loads a scene that uses most of this, and **Help > Scripting & Shader Reference** documents the script API and the shader conventions.

## The AI assistant
Open the AI tab and use **Connect with OpenRouter**, or paste an API key in its settings. Any OpenRouter model that supports tool calls works.

The assistant has tools for the whole editor: reading the scene, creating and updating objects, model overrides, scripts, shaders, render passes and post effects, running Play tests, reading the console and, with vision models, capturing the viewport. It uses them in a loop: after writing a script or shader it reads the compile result and fixes the errors, and when behaviour matters it runs the scene and reads the logs before it reports back.

The key is kept in this browser's local storage, or only for the current tab when "Remember on this device" is off, and it is sent only to openrouter.ai. The editor contacts OpenRouter only when you open the AI tab (to list the models) and when you send a request. A request carries your message, a short description of the editor state and the results of the tools the model calls.

## Scripts and Play mode
A script is a class that extends `Script`. Its public fields show up in the Inspector, where each object can set its own values:

```js
export default class Spinner extends Script {
    speed = 90; // degrees per second

    update(dt) {
        this.object3D.rotationY += this.speed * dt;
    }
}
```

The lifecycle methods are `awake`, `start`, `update(dt)`, `lateUpdate(dt)`, `onDestroy`, `onKeyDown` / `onKeyUp(key)` and `onPointerDown` / `onPointerUp` / `onClick(e)`. Scripts also get `this.time`, `this.input` (keys, WASD / arrow axes, mouse) and helpers such as `find`, `spawn`, `destroy`, `setColor`, `lookAt`, `after` and `every`, and can import from `@orillusion/core`. Play renders through the scene's main camera, or the editor view when the scene has none. Script errors in the console link to their line.

### Scripts from scene files
Scripts run JavaScript in the editor page, which also holds your OpenRouter key. When you open a scene file, its scripts stay paused (they are not even compiled) until you choose **Enable Scripts**, so you can read them first. Scenes you make yourself and the built-in example are not affected.

## Shaders and the render graph
Shaders are WGSL. Properties are declared with comments, such as `// @property speed float 1 0 10` (types `float`, `color`, `vec4` and `texture`), and read as `materialUniform.speed`. A material shader implements `fn frag()`, and optionally `fn vert(...)`. It is either lit (it fills `ORI_ShadingInput` and uses the engine's PBR lighting and shadows) or unlit. A post shader implements `fn post(uv: vec2f) -> vec4f`, reads the image with `sceneColor(uv)` and runs before anti-aliasing and tone mapping. Compile errors show on their line, and the last version that compiled keeps rendering.

The Render Graph tab of the bottom dock lists the forward renderer's passes in execution order, with the resources each one reads and writes. Switching off a pass that an enabled pass still depends on is refused, with the reason.

## Materials and global illumination
A mesh's material is one of four types. **Lit** is the engine's physically based material: color, metallic, roughness and emission, normal / metallic-roughness / occlusion / emission maps with tiling and offset, clear coat, and transmission with index of refraction, thickness and tint for glass and water. **Unlit** shows its color and texture as they are, **Lambert** is a cheap matte material for directional lights, and **Custom Shader** uses a WGSL material shader. Every type can blend (opacity below 1) or cut out pixels below an alpha threshold (leaves, fences). The menu next to the Material title applies presets such as plastic, metal, car paint, glass, water and glow.

Each material slot of an imported model keeps the file's material or switches to Unlit, Lambert or a custom shader of its own; a custom shader can use the model's own normal, metallic-roughness, emission and occlusion maps. Models keep the transforms of their files, including node matrices (unit scale, Z-up to Y-up).

**Scene > Global Illumination** turns on DDGI: a grid of light probes captures the scene, and lit materials receive the light it bounces, so a red wall tints the floor next to it and shadows get indirect light. **Fit to Scene** sizes the grid to the meshes. The probes are captured again after every change, or every frame with Realtime; GI also works in Play mode and in built games.

## Build & Deploy
**File > Build & Deploy** (`Ctrl+B`, or the rocket button in the toolbar) makes a standalone web game of the scene. A game is a static folder: `index.html` with the player (the engine and Play mode without the editor), `game.json` with the scene, its scripts and shaders, and a `media/` folder with the models and textures it uses. It plays like Play mode: through the scene's main camera, or, when the scene has none, from the editor view at build time, where the right mouse button orbits, the middle button pans and the wheel zooms.

- **Run in New Tab** plays the scene the way the built game runs, with script errors shown on screen
- **Download .zip** gives the folder for any static host: itch.io (as an HTML game), Netlify, Cloudflare Pages or your own server. It has to be served over HTTP; opening `index.html` from disk does not work
- **GitHub Pages** pushes the game to a branch (`gh-pages` by default, which then holds only the game) of a repository, which it can create, and publishes it at `https://<owner>.github.io/<repository>/`. It needs a [personal access token](https://github.com/settings/tokens/new?scopes=public_repo&description=Canonical%20Editor) with the `public_repo` scope (`repo` for private repositories, where Pages needs a paid plan), or a fine-grained token with Contents, Pages and Administration (to create repositories) set to Read and write. Deploying again uploads only the files that changed. Before it replaces a branch that holds anything else than a game, or changes an existing Pages setup, it asks

The title, repository and branch are saved with the scene. The token is sent only to `api.github.com`; it is kept for the current tab, or in this browser's storage when "Remember on this device" is on, where scripts you run in the editor could read it. Builds leave out the scripts of an opened scene file until you enable them.

## The engine: Orillusion
[Orillusion](https://www.orillusion.com/) is an open-source 3D rendering engine for the web, written in TypeScript and built on WebGPU from the start rather than ported from WebGL. It aims for desktop-class rendering in the browser, which makes it a strong base for Canonical:

- **Built for modern GPUs.** WebGPU gives it compute shaders and lower CPU overhead than WebGL, and Orillusion uses compute for clustered lighting, global illumination and GPU particles.
- **High-end rendering.** Physically based materials, real-time shadows, image-based lighting and DDGI global illumination, plus post effects such as bloom, GTAO, screen space reflections, TAA, depth of field and volumetric fog.
- **A complete toolkit.** glTF / GLB, OBJ and 3D Tiles loading, skeletal and morph target animation, and optional packages for physics (Ammo.js or Rapier), particles and a physically based sky.
- **Easy to drive from an editor.** A scene is a tree of `Object3D` nodes with components attached, the same model the editor shows, and it is MIT licensed.

The engine source is in `src/` (the core, `@orillusion/core`) and `packages/` (plugins). The editor imports the core straight from `src/`, so every build runs the engine code of the branch being built. For the engine's own API and guides, see the [Orillusion documentation](https://www.orillusion.com/guide/) and the [Orillusion repository](https://github.com/Orillusion/orillusion).

## Development
You need Node.js (CI uses 22) and pnpm.

```bash
pnpm install
pnpm run editor             # dev server at http://localhost:8100
pnpm run editor:typecheck   # type check the editor
pnpm run editor:build       # static site in editor/dist
```

The build has two pages: the editor (`index.html`) and the game player (`player.html`), whose files `player-manifest.json` lists for Build & Deploy. The dev server builds the player the first time Build & Deploy needs it, which takes a little while.

`.github/workflows/editor-pages.yml` builds the editor for pull requests to `main` and publishes it to GitHub Pages when `main` is updated. It needs a one-time setting: **Settings > Pages > Build and deployment > Source: GitHub Actions**.

| Path | Contents |
|---|---|
| `editor/` | Canonical Editor: UI, viewport, scripting, shaders and the AI assistant |
| `editor/player.html`, `editor/src/player/` | The game player that Build & Deploy puts into every game |
| `editor/public/` | Favicons and the logo |
| `src/` | Orillusion engine core |
| `packages/` | Orillusion plugins (physics, particles, atmosphere, post effects and more) |
| `samples/` | Engine samples, served by `pnpm run dev` (they load assets from the `public` submodule: `git submodule update --init`) |
| `test/` | Engine tests |

### Browser support
The editor needs WebGPU: Chrome or Edge 113+ on Windows, macOS and ChromeOS, Chrome 121+ on Android, Safari 26+, and Firefox 141+ on Windows. On Linux, Chrome may need `chrome://flags/#enable-unsafe-webgpu` and Vulkan.

## Contributing
Issues and pull requests are welcome. Commit messages follow the [commit convention](.github/commit-convention.md), for example `feat(editor): ...`. For the engine's internals, scripts and samples, see the [Orillusion contributing guide](.github/contributing.md).

## License
Released under the [MIT](LICENSE) license. The Orillusion engine is copyright Orillusion and MIT licensed.

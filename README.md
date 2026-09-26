![Cover Art](https://github.com/Orillusion/orillusion-webgpu-samples/blob/main/logo_new.png)     
## Orillusion

[![Test](https://github.com/Orillusion/orillusion/actions/workflows/ci.yml/badge.svg)](https://github.com/Orillusion/orillusion/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@orillusion/core)](https://www.npmjs.com/package/@orillusion/core)

`Orillusion`  is a pure Web3D rendering engine which is fully developed based on the `WebGPU` standard. It aims to achieve desktop-level rendering effects and supports 3D rendering of complex scenes in the browser.

## Need to know
Beta version,  **NOT**  recommended for any commercial application.

## Contributing (ongoing)

`WebGPU` is the latest technology in the web domain and will play a crucial role in terms of 3D rendering as well as `AI/LLM` scenarios. 

We aim to create a dedicated technical community for the `WebGPU` field, bringing together outstanding developers. 

Hope more and more `front-end` developers could stay updated with the latest Web technologies `NOT ONLY` image slicing for web design.

Specifically, we will continuously update the excellent samples provided by open-source contributors, allowing everyone to see better works. 

Hope it could help highlight the very talented individual developers within the community!

<a href="https://www.youtube.com/@orillusion7225"><img src="https://raw.githubusercontent.com/Orillusion/assets/main/sample_src/light_city.gif" height="140"></a>
<a href="https://github.com/ID-Emmett"><img src="https://raw.githubusercontent.com/Orillusion/assets/main/sample_src/physical_car.gif" height="140"></a>
<a href="https://github.com/ID-Emmett"><img src="https://raw.githubusercontent.com/Orillusion/assets/main/sample_src/movie_camera.gif" height="140"></a>
<a href="https://github.com/ID-Emmett"><img src="https://raw.githubusercontent.com/Orillusion/assets/main/sample_src/helicopter.gif" height="140"></a>
<a href="https://www.youtube.com/@orillusion7225"><img src="https://raw.githubusercontent.com/Orillusion/assets/main/sample_src/shooting.gif" height="140"></a>
<a href="https://github.com/OriIIusion"><img src="https://github.com/Orillusion/assets/blob/main/sample_src/beijing_subway.gif" height="140"></a>
<a href="https://github.com/mate-h"><img src="https://github.com/Orillusion/assets/blob/main/sample_src/volumetric_clouds.gif" height="140"></a>
<a href="https://github.com/ID-Emmett"><img src="https://raw.githubusercontent.com/Orillusion/assets/main/sample_src/track_camera.gif" height="140"></a>
<a href="https://github.com/ID-Emmett"><img src="https://github.com/Orillusion/assets/blob/main/sample_src/pentagram.webp" height="140"></a>
<a href="https://github.com/OriIIusion"><img src="https://raw.githubusercontent.com/Orillusion/assets/main/sample_src/light_box.gif" height="140"></a>
<a href="https://github.com/seven1031"><img src="https://github.com/Orillusion/assets/blob/main/sample_src/rabbit_box.webp" height="140"></a>
<a href="https://github.com/seven1031"><img src="https://github.com/Orillusion/assets/blob/main/sample_src/fluid_mouse.webp" height="140"></a>
## Install

### NPM
We recommend using front-end build tools for developing Web3D applications, such  [Vite](https://vitejs.dev/) or [Webpack](https://webpack.js.org/).

- Install dependencies:
```text
npm install @orillusion/core --save
```
- Import on-demand:
```javascript
import { Engine3D, Camera3D } from '@orillusion/core'
```
- Import globally:
```javascript
import * as Orillusion from '@orillusion/core'
```

### CDN
In order to use the engine more conveniently, we support to use native `<script>` tag to import `Orillusion`. Three different ways to import using the official `CDN` link:

- **Global Build:** You can use `Orillusion` directly from a CDN via a script tag:
```html
<script src="https://unpkg.com/@orillusion/core/dist/orillusion.umd.js"></script>
<script>  
    const { Engine3D, Camera3D } = Orillusion  
</script>
```
The above link loads the global build of `Orillusion`, where all top-level APIs are exposed as properties on the global `Orillusion` object.

-  **ESModule Build:** We recommend using the [ESModule](https://developer.mozilla.org/docs/Web/JavaScript/Guide/Modules) way for development. As most browsers have supported `ES` module, we just need to import the `ES` build version of `orillusion.es.js`
```html
<script type="module">  
    import { Engine3D, Camera3D } from "https://unpkg.com/@orillusion/core/dist/orillusion.es.js" 
</script>
```

- **Import Maps:** In order to manage the name of dependencies, we recommend using [Import Maps](https://caniuse.com/import-maps)

```html
<!-- Define the name or address of ES Module -->  
<script  type="importmap">  
{  
    "imports": { "@orillusion/core": "https://unpkg.com/@orillusion/core/dist/orillusion.es.js" }  
}  
</script>  
<!-- Customerized names could be imported -->  
<script  type="module">  
    import { Engine3D, Camera3D } from "@orillusion/core"
</script>
```

## Usage
### Create Engine3D instance

Use `Engine3D.init()` to create a new engine instance. Each call returns an independent instance — you can run multiple engines side-by-side in the same page.

```javascript
import { Engine3D } from '@orillusion/core' 
Engine3D.init().then((engine) => {
    // Next
})
```
As `Engine3D.init()` is asynchronous, we recommend using `async/await` in the code
```javascript
import { Engine3D } from '@orillusion/core'  
async function demo(){  
    const engine = await Engine3D.init();
    // Next 
}  
demo()
```
### Create canvas
By default, `Engine3D.init()` creates a `canvas` the same size as the window. You can also create a `canvas` manually using `<canvas>` with an `id`

```html
<canvas id="canvas" width="800" height="500" />
```
Then get the `<canvas>` by `id` and pass it to `Engine3D.init()` via `canvasConfig`

```javascript
import { Engine3D } from '@orillusion/core';  
let canvas = document.getElementById('canvas')  

const engine = await Engine3D.init({
    canvasConfig: { canvas }
})
```
Please read the [Docs](https://www.orillusion.com/guide/) to Learn More.

## Platform
**Windows/Mac/Linux:**
- Chrome 113+
- Edge: 113+

**Android (Behind the `enable-unsafe-webgpu` flag):** 
- Chrome Canary 113+ 
- Edge Canary 113+

## Useful links
- [Official Web Site](https://www.orillusion.com/)
- [Documentation](https://www.orillusion.com/guide/)
- [Forum](https://forum.orillusion.com/)

## Editor
`editor/` is a scene editor that runs entirely in the browser: no install, no server. It is built from the engine source in this repository and published to GitHub Pages every time `main` is updated:

**https://gotzawal.github.io/canonical/**

- Create primitives, lights, cameras and empties, import `.glb` / `.gltf` models and textures (drag and drop onto the viewport works too)
- Move / rotate / scale with the gizmo (`W` `E` `R`), snapping, undo / redo, multi-select, grouping, hierarchy drag and drop
- Edit materials, lights, sky, exposure, bloom, ambient occlusion and fog
- Edit imported models: every mesh part (visibility, shadows, transform, which material it uses) and every material slot (color, PBR values, texture, or a custom shader). Changes are stored per instance as overrides and the model file is left untouched; clicking a part in the viewport opens it in the Inspector
- Write WGSL material shaders and full screen post effects in the built-in code editor; properties declared in the code become Inspector controls
- Inspect the engine's render graph (passes and the resources they read and write), switch passes off and order the post chain
- Write JavaScript behaviours and run the scene in Play mode (`Ctrl+P`); Stop puts the scene back exactly as it was
- An AI assistant (via OpenRouter) that edits the scene, writes and fixes scripts and shaders, runs Play tests and reads the console
- Scenes autosave to the browser (imported files live in IndexedDB); `Ctrl+S` downloads a `.scene.json` with assets, scripts and shaders embedded, `Ctrl+O` opens one

**File > Open Example: Showcase** loads a scene that uses most of this, and **Help > Scripting & Shader Reference** documents the script API and the shader conventions.

Run it locally with `pnpm run editor` (http://localhost:8100). `pnpm run editor:build` writes the static site to `editor/dist`.

The Pages deployment is done by `.github/workflows/editor-pages.yml`. It needs a one-time setting: **Settings > Pages > Build and deployment > Source: GitHub Actions**.

### Scripts and Play mode
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

### Shaders and the render graph
Shaders are WGSL. Properties are declared with comments, such as `// @property speed float 1 0 10` (types `float`, `color`, `vec4` and `texture`), and read as `materialUniform.speed`. A material shader implements `fn frag()`, and optionally `fn vert(...)`. It is either lit (it fills `ORI_ShadingInput` and uses the engine's PBR lighting and shadows) or unlit. A post shader implements `fn post(uv: vec2f) -> vec4f`, reads the image with `sceneColor(uv)` and runs before anti-aliasing and tone mapping. Compile errors show on their line, and the last version that compiled keeps rendering.

The Render Graph tab of the bottom dock lists the forward renderer's passes in execution order, with the resources each one reads and writes. Switching off a pass that an enabled pass still depends on is refused, with the reason.

### AI assistant
The AI tab works with any OpenRouter model that supports tool calls: use **Connect with OpenRouter** or paste an API key in its settings. The assistant reads the scene and edits it: objects, model overrides, scripts, shaders and render passes. It can also run Play tests, read the console and, with vision models, look at the viewport. Everything one request changes is a single undo step.

The key is kept in this browser's local storage, or only for the current tab when "Remember on this device" is off, and it is sent only to openrouter.ai. The editor contacts OpenRouter only when you open the AI tab (to list the models) and when you send a request. A request carries your message, a short description of the editor state and the results of the tools the model calls.

### Scripts from scene files
Scripts run JavaScript in the editor page, which also holds your OpenRouter key. When you open a scene file, its scripts stay paused (they are not even compiled) until you choose **Enable Scripts**, so you can read them first. Scenes you make yourself and the built-in example are not affected.

## Dev and Contribution
Please make sure to read the [Contributing Guide](.github/contributing.md) before developing or making a pull request.

## License 

Orillusion engine is released under the [MIT](https://opensource.org/licenses/MIT) license. 

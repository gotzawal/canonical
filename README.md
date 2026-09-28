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
  <a href="#the-pipeline-from-brief-to-finish">Pipeline</a>
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
- With vision models it can also look at the viewport, the shots and the images you attach (drop or paste them into the AI tab)
- Everything one request changes is a single undo step; edits you make by hand while it works stay steps of their own
- Decides as much as you want it to: from the way you write it judges whether to settle the details itself and move on or to work them out with you (and asks once when it cannot tell); its questions come with the assumption it goes ahead with, so they never hold up the work
- Remembers each project: the conversation is kept in the browser, long conversations are compacted, and a short scene memo carries the context to later sessions
- Works with any OpenRouter model that supports tool calls

**Pipeline**

- Stage gates from the planning brief to the finished scene: Brief, Level (greybox), Lighting, Materials, Effects, Finish, each with a checklist the assistant fills and you approve
- Concept images drawn with image models for you to review while the design takes shape, shots framed like the concept art, paintovers generated with image models, grayscale and color comparisons with a reference score, snapshots and a capture history per stage
- Greybox tools (buildings from a floor plan that are closed by construction, ramps, stairs, cones and pyramids, capsules, prefabs, a walk camera at eye height) and a level check (seams, gaps and holes, floating objects, what the player can reach, empty space), material slots with a world space triplanar shader and a shared swatch library, GPU particles and a color grade

**Characters and the player**

- Characters built into the editor (**Create > Character**, or Add Component > Character), as with pawns in Unreal: a body that stands on the scene's meshes, climbs steps, falls and is stopped by walls and other characters, and moves the way its controller says
- The player controls one (**Create > Player**, or Add Component > Player Controller): WASD or the arrow keys walk, Shift runs, Space jumps, a mouse drag (or Q and E) turns the camera and the wheel zooms; on phones and tablets a joystick appears under the left thumb, a button jumps, a finger turns the camera and two fingers pinch to zoom. The camera follows behind, looks from its eyes or leaves the scene's camera, and walls pull it in front of them. It works the same in built games
- NPCs are characters driven by their behavior tree (the **Move To** task walks to an object) or by scripts (`this.character`). All characters move together once a frame, and each reports its velocity, mode (idle, walk, run, jump, fall) and jump and landing events, for animation

**Scene editing**

- Create primitives, lights, cameras and empties, import `.glb` / `.gltf` models and textures (drag and drop onto the viewport works too)
- Move / rotate / scale with the gizmo (`W` `E` `R`), snapping, undo / redo, multi-select, grouping, hierarchy drag and drop
- Materials: physically based Lit (normal, metallic-roughness, occlusion and emission maps, clear coat, transmission for glass and water), Unlit, Lambert or a custom shader, with presets, cutout and alpha, additive or multiply blending
- Lights, sky, exposure, bloom, ambient occlusion, fog and global illumination (DDGI: light bounces between surfaces)
- Edit imported models: every mesh part (visibility, shadows, transform, which material it uses) and every material slot (the file's material, Unlit, Lambert or a custom shader; color, PBR values, alpha, texture). Changes are stored per instance as overrides and the model file is left untouched; clicking a part in the viewport opens it in the Inspector

**AI behavior**

- Behavior trees for scene objects (Selector, Sequence, script tasks, conditions, cooldowns) over typed blackboards, edited as an outliner, as JSON or by the assistant, with validation that names the node and field
- Small models run in the browser and only write blackboard values: Laya answers the trees' questions, and a scene adds its own (any small ONNX classifier, zero-shot NLI, sentence embedding or text generator, by the URL of its folder); without them every scene plays with the defaults
- A context pool per agent (recalled lore, dialogue lines, script notes) that the models see, Model tasks that classify or generate text from it (a talking NPC), a request scheduler shared by all agents, and a decision log of every answer

**Code**

- JavaScript behaviours, and a Play mode (`Ctrl+P`) to run them; Stop puts the scene back exactly as it was, keeping the scripts and shaders you changed while playing
- WGSL material shaders and full screen post effects in the built-in code editor; properties declared in the code become Inspector controls
- The engine's render graph (passes and the resources they read and write): switch passes off and order the post chain

**Files**

- Scenes autosave to the browser (imported files live in IndexedDB)
- `Ctrl+S` downloads a `.scene.json` with assets, scripts and shaders embedded, `Ctrl+O` opens one. Planning images (concepts, paintovers, captures, snapshots) are left out of it to keep it small
- `Ctrl+Shift+S` saves the whole project as a `.zip`, planning files included; **Open Scene or Project** opens either
- **File > Build & Deploy** (`Ctrl+B`) turns the scene into a standalone web game: run it in a new tab, download it as a `.zip` for any static host, or publish it to GitHub Pages

**File > Open Example: Showcase** loads a scene that uses most of this, and **Help > Scripting & Shader Reference** documents the script API and the shader conventions. **File > Open Example: Guard** shows a behavior tree (in Play, keys 1 to 3 make the player talk to the guard, and what was said changes the guard's judgment), and **Help > Behavior Tree Reference** lists every node type, field and edit operation.

## The AI assistant
Open the AI tab and use **Connect with OpenRouter**, or paste an API key in its settings. Any OpenRouter model that supports tool calls works.

The assistant has tools for the whole editor: reading the scene, creating and updating objects, model overrides, scripts, shaders, render passes and post effects, running Play tests, reading the console and, with vision models, capturing the viewport. It uses them in a loop: after writing a script or shader it reads the compile result and fixes the errors, and when behaviour matters it runs the scene and reads the logs before it reports back.

The key is kept in this browser's local storage, or only for the current tab when "Remember on this device" is off, and it is sent only to openrouter.ai. The editor contacts OpenRouter only when you open the AI tab (to list the models) and when you send a request. A request carries your message, a short description of the editor state and the results of the tools the model calls.

The assistant remembers each project: its conversation is stored in this browser with the project, and when a conversation grows long the older part is replaced by a summary. Requests are shaped for prompt caching, so the steps of a request and the next requests read the unchanged start (instructions, tool definitions, the conversation so far) from the provider's cache at a fraction of the input price: DeepSeek, Kimi, GLM, MiniMax, OpenAI, Grok and Gemini cache by themselves, and Claude and the models Alibaba serves (Qwen, DeepSeek V3.2) get cache_control marks, with an option to keep Claude's cache for an hour. Every request of a conversation carries the same OpenRouter session id, so the conversation stays with the provider that holds its cache. The share of prompt tokens read from the cache is shown next to the token count. After a stretch of work the assistant rewrites a short scene memo (Design tab), which every later request reads, so a new session knows where the work stands.

How much the assistant decides by itself follows the **Details** setting of the Design tab, which it sets from the way you write: short requests ("build me a castle") let it settle every detail, write its choices into the plan and move on, choosing paintovers, judging the shots and completing stages whose checklist is done; precise requests make it follow them and work out with you only what matters. When your words leave it open, it asks once, with two buttons in the chat. Its questions (at most three at a time) each say what it assumes meanwhile, so it keeps working, and **Keep the assumptions** in the Design tab accepts them.

Notifications appear in the corner of the page when the assistant finishes a request, when it proposes completing a stage, when it drew concept images for you to review, and at save checkpoints, which ask whether to download the project. Each card has **Don't show this notification**; the bell menu at the top turns them back on and can also show them as system notifications while the tab is in the background.

## The pipeline: from brief to finish
A scene goes through stages, in the order of a usual art pipeline. The pipeline bar at the top shows the current stage, its checklist and the button to complete it; the **Design** tab holds the stage, the brief, the structured plan, the shots, the material slots, the snapshots and the scene memo. Some checklist items are measured from the project (every listed object placed, every shot with a target), the others are ticked by hand or proposed by the assistant, and you complete a stage (or the assistant does once its checklist is done, when the Details setting lets it decide). Completing one captures every shot into its history and takes a snapshot of the scene that can be restored. An earlier stage can be reopened: the stages after it then need a recheck, and reopening the level marks the chosen paintovers as needing an update. The stage also decides which tools the assistant gets (in Lighting only lights, sky, exposure and GI) and, from Lighting to Effects, placement is locked except for lights, cameras and effects (the pipeline bar can unlock it).

1. **Brief.** Paste the planning document (or drop `.md` / `.txt` files) and drop the concept images on the start screen. The assistant first decides how the scene is built (the kind of place, its size, where the areas sit and how they connect), then structures the areas and their objects, the specs (player height, eye height, door width, step height), the mood (time of day, key light, palette), the play requirements (route, landmark sight lines, area order), the effects and the mapping of concepts to areas. What the brief leaves open it decides or asks about, by the Details setting. For areas without a concept it draws one with the image model (a view from outside or inside, an overview or a floor plan), which waits in the Design tab for you to approve, reject or have redrawn. When the brief changes later, only the areas that changed go back for rework.
2. **Level.** A greybox in one mid gray material: buildings, primitives, ramps, stairs, cones (with 4 segments a pyramid), capsules and prefabs (groups placed as instances; a prefab is edited on its own in the same view, and a `.glb` can later replace it in every instance). The assistant builds rooms from a floor plan of wall centerlines: rooms that share an edge share one wall, corners and junctions close without gaps, doors and windows are cut into the walls and floors and ceilings close the rooms, so a building is closed by construction. The player stands where the route starts. **Check the level** (Design tab, or the assistant) walks the grid of the level with the player's body and reports seams between walls, floors and ceilings, gaps in walls, holes in roofs and floors, floating objects, route points the player cannot reach, rooms without a way in and large empty spaces, with a plan view; a passing check of the current level ticks the checklist. While the greybox grows, the image model can paint a concept over the current view for review. Shots are camera bookmarks framed like the concepts, with the concept laid over the view. The walk camera (`V`) walks the route at the brief's eye height with the ground and walls in the way, and ticks route points as they are reached; the assistant checks sight lines from the player's eyes. The stage ends with a paintover per shot: the greybox capture and the concept go to an image model (OpenRouter's Image API; the options each model accepts are read from its parameter list), which keeps the composition and paints the style and mood over it. You can also upload a drawing. The chosen paintover becomes the shot's target for every later comparison; the concept stays as the record.
3. **Lighting.** Sky and time of day, key and fill lights (**Key light from the mood** points the sun the way the brief says), interior lights, exposure and GI, with every surface still gray. **Compare** in the shot bar sets a fresh capture next to the target in grayscale, with a score computed on a small grid without a model call (brightness, contrast, value structure and where it is too dark or bright). The score is a reference: you mark each shot that matches. The shadow-casting lights have to stay within the budget.
4. **Materials.** Material slots are the named surfaces of the level. Objects linked to a slot use a world space triplanar shader, so a texture keeps its real size on every mesh, with one roughness and one metallic value per slot. Swatches come from a library shared by every project in this browser: search it first, and generate a swatch with the image model (from the slot's description, with the concepts and paintovers as references) only when nothing fits. Every swatch is cropped square, its baked shading evened out, its edges blended so it tiles, its brightness kept within about sRGB 30-240 and stored as WebP. The **Reference room** shows the swatches under neutral light next to a gray ball and a chrome ball. Then the shots are compared in color and the lighting corrected for the new albedo.
5. **Effects.** Particles (the `packages/particle` GPU system, with presets for fire, smoke, sparks, embers, dust, rain, snow, mist and sparkles), fog, bloom and a vignette, checked against the effects of the brief and the frame rate budget, and compared with the paintovers again in grayscale.
6. **Finish.** A final lighting pass, then a lift / gamma / gain and saturation color grade as a post shader, and a last comparison of every shot, which you approve.

Planning images are marked as planning assets: they are saved in project files, but not in `.scene.json` files or built games.

Planned, not built yet: a Blender extension (sending GLBs over a local WebSocket to replace proxies by asset id, custom properties as glTF extras), an optimization stage after Finish (distance based LOD, instancing, draw call budget) and parallel tracks for sound, navmesh and UI.

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

The lifecycle methods are `awake`, `start`, `update(dt)`, `lateUpdate(dt)`, `onDestroy`, `onKeyDown` / `onKeyUp(key)`, `onPointerDown` / `onPointerUp` / `onClick(e)` and `onTaskAbort(task)` (a behavior tree aborted a script task). Scripts also get `this.time`, `this.input` (keys, WASD / arrow axes that include the on-screen joystick, mouse) and helpers such as `find`, `spawn`, `destroy`, `setColor`, `lookAt`, `after` and `every`, and can import from `@orillusion/core`. Play renders through the player's camera, else the scene's main camera, or the editor view when the scene has neither. The player needs no script: **Create > Player** adds a character with the built-in player controller, whose speeds, jump, body size and view are set in the Inspector. Scripts drive a character with `this.character` (`move`, `moveTo`, `jump`, `stop`) and read its state to animate it. Script errors in the console link to their line.

### Scripts from scene files
Scripts run JavaScript in the editor page, which also holds your OpenRouter key. When you open a scene file, its scripts stay paused (they are not even compiled) until you choose **Enable Scripts**, so you can read them first. Scenes you make yourself and the built-in example are not affected.

## Behavior trees and AI agents
An object runs a behavior tree once it has an **Agent** (Inspector > Add Component, or **Assign** in the Behavior tab). The tree reads a blackboard of typed keys (bool, number, probability, enum, string, object), and every key has one owner: fact keys are written by scripts (what the agent perceives, best as categories such as near / mid / far), AI keys by exactly one Ask node or Model task, and tree keys by Set Key and script tasks. Models only ever write AI keys and the tree decides by the standard rules, so a scene plays completely with the schema defaults when there is no model.

- Composites are Selector and Sequence; tasks are Script Task (calls a method of a script on the object, which returns true, false, `'running'` or a Promise and gets an AbortSignal and `onTaskAbort`), Move To (walks the agent's character to the object in an object key; it fails when the character gets stuck), Wait, Set Key, Ask and Model Task; decorators are Condition (also on an answer's confidence) and Cooldown; services are Ask and Recall.
- Each agent ticks 10 times a second, spread over the frames, between the scripts' `update` and `lateUpdate`. A tick checks the conditions again and never starts a running task again. Aborts go both ways: a running branch whose conditions fail is aborted, and a higher branch of a Selector whose conditions start to pass takes over.
- **Ask** turns AI keys into questions for [Laya](https://huggingface.co/convaiinnovations/laya) (ModernBERT-large with a decision head, Apache-2.0), which scores typed questions in one encoder pass: probability keys are asked yes or no, enum keys as a choice between their values (the value descriptions are the options) and string keys as a choice between memory items. An Ask asks when its node becomes active, when one of its facts changes, or every interval. Only the newest request of an Ask is written, an answer below its minimum confidence keeps the old value, and a minimum hold keeps a value for a while.
- **Models**: Laya and multilingual-e5-small are built in, and the **Models** view of the Behavior tab adds any small ONNX model with a `tokenizer.json` by the URL of its folder (a Hugging Face repository with an `onnx/` folder, or files hosted with the game). Each model has a kind, and the kind decides how it runs (`editor/src/play/ai/adapters.ts`): `laya` and `nli` (zero-shot, the facts as the premise, the options as hypotheses) are decide models for Ask nodes, `embedding` models embed the memory, `classifier` models give labels and their probabilities, and `causal-lm` models generate text with their key/value cache. An Ask picks its decide model (Laya by default).
- **Context pool**: each agent has named slots of text. A Recall service fills the slot named after it, a Model task with **History** adds the line it wrote (`Guard: Halt!`), and scripts use `this.blackboard.context` (`add('dialogue', 'Player: Hello')`, `set`, `clear`, `get`). An Ask with **Use Context** shows the whole pool to its model; templates (a Model task's input, queries, question texts) take `{key}`, `{context}` and `{context:slot}`.
- **Model Task** runs a classify or generate model on its input and writes the result to an AI key: a classifier's top label (string or enum key) or the probability of a label, a generator's text (string key), which it can also add to the dialogue and speak. It follows the Ask rules (newest request wins, minimum confidence) and fails after its timeout. A talking guard: a script adds the player's line to `dialogue`, and a Model task with the input `{context:dialogue}` and History `dialogue` answers.
- **Recall** finds memory items (lore, rumors, planning notes) by tag and then by embedding similarity, joins the best ones in id order within a token budget and puts them into the agent's context pool. The Memory view embeds the items in the editor with the memory's embed model (multilingual-e5-small unless the scene picks another) and stores the vectors (int8) in the scene. Scripts add memories while playing with `this.remember()` and keep them in a game save with `this.saveMemories()` and `this.loadMemories()`.
- The model jobs of all agents (Ask questions and Model tasks) go through one scheduler right after the engine drew a frame: an exact cache, a semantic cache (the same facts and a context at least 0.97 similar), identical jobs joined, the agents nearest the player first, batches of one model of at most 10 questions or texts (4 while a voice line waits; a generation goes alone), one batch at a time, a GPU time budget of 150 ms per second that follows the frame rate between 50 and 400, and no answer after 1.5 s of waiting.
- The models run in a worker with ONNX Runtime Web, on a WebGPU device of its own, or on WebAssembly when WebGPU is missing, fails or lacks fp16 (the Models view can also choose the CPU). They are downloaded once into the browser's cache, and the editor asks first: Laya is 340 MB (the 4-bit build of [dockndevai/laya-models](https://github.com/dockndevai/laya-models)). ONNX Runtime and the worker load only when a scene whose agents use a model plays; a built game downloads the models its scene uses.
- Scripts can talk: `this.say(text)` speaks with the browser's speech synthesis, one sentence at a time (a task's signal stops it), and `this.chat(prompt)` asks an OpenRouter model with the assistant's key (in the editor only).

The **Behavior** tab of the bottom dock shows a tree as an outliner, like the hierarchy: drag and drop, a context menu to add, wrap, duplicate and delete, decorators and services as tags on their node, and problems marked in red. The panel next to it edits the selected node with fields that come from the node type definitions, which also drive the validation, the assistant's tool descriptions and the reference. **Edit as JSON** opens the tree in the code dock. Every edit, from the panels, the JSON view or the assistant, goes through the same edit operations: a batch is applied whole or not at all, it is one undo step, and a validation error names the node and the field. While playing, the tree is locked and shows the chosen agent's active path, its blackboard and the latest answers, and the **Decisions** tab lists every Ask request and Model task of the session with the facts, context and input the model saw, the probabilities or text and what became of the answer. The assistant reads the outline, applies batches of edit operations, validates and reads the decision log by node id.

## Shaders and the render graph
Shaders are WGSL. Properties are declared with comments, such as `// @property speed float 1 0 10` (types `float`, `color`, `vec4` and `texture`), and read as `materialUniform.speed`. A material shader implements `fn frag()`, and optionally `fn vert(...)`. It is either lit (it fills `ORI_ShadingInput` and uses the engine's PBR lighting and shadows) or unlit. A post shader implements `fn post(uv: vec2f) -> vec4f`, reads the image with `sceneColor(uv)` and runs before anti-aliasing and tone mapping. Compile errors show on their line, and the last version that compiled keeps rendering.

The Render Graph tab of the bottom dock lists the forward renderer's passes in execution order, with the resources each one reads and writes. Switching off a pass that an enabled pass still depends on is refused, with the reason.

## Materials and global illumination
A mesh's material is one of four types. **Lit** is the engine's physically based material: color, metallic, roughness and emission, normal / metallic-roughness / occlusion / emission maps with tiling and offset, clear coat, and transmission with index of refraction, thickness and tint for glass and water. **Unlit** shows its color and texture as they are, **Lambert** is a cheap matte material for directional lights, and **Custom Shader** uses a WGSL material shader. Every type can be opaque, cut out pixels below an alpha threshold (leaves, fences), or be transparent with alpha, additive (glow, fire) or multiply (stains, tinted glass) blending; Auto blends when the opacity is below 1. The menu next to the Material title applies presets such as plastic, metal, car paint, glass, water and glow.

Settings you leave out keep neutral defaults: a Lit material without a metallic-roughness map uses its roughness and metallic values as they are, without a normal map it stays flat, and without occlusion or emission maps it gets none. On an imported model, a material slot changes only what you set; the file's alpha mode (opaque, cut-out or blend), its texture tiling and its maps stay as they are. On import the editor also corrects two places where the engine's glTF loader departs from glTF: MASK materials cut out (the engine blended them), and a material without a metallic-roughness texture uses its roughness factor unchanged (the engine halved it). glTF occlusion textures are still ignored by the engine.

Each material slot of an imported model keeps the file's material or switches to Unlit, Lambert or a custom shader of its own; a custom shader can use the model's own normal, metallic-roughness, emission and occlusion maps. Models keep the transforms of their files, including node matrices (unit scale, Z-up to Y-up).

**Scene > Global Illumination** turns on DDGI: a grid of light probes captures the scene, and lit materials receive the light it bounces, so a red wall tints the floor next to it and shadows get indirect light. **Fit to Scene** sizes the grid to the meshes. The probes are captured again after every change, or every frame with Realtime; GI also works in Play mode and in built games.

## Build & Deploy
**File > Build & Deploy** (`Ctrl+B`, or the rocket button in the toolbar) makes a standalone web game of the scene. A game is a static folder: `index.html` with the player (the engine and Play mode without the editor), `game.json` with the scene, its scripts and shaders, and a `media/` folder with the models and textures it uses. It plays like Play mode: through the player's camera (with its keyboard, mouse and touch controls, so it plays on phones too), else the scene's main camera, or, when the scene has neither, from the editor view at build time, where the right mouse button orbits, the middle button pans and the wheel zooms.

- **Run in New Tab** plays the scene the way the built game runs, with script errors shown on screen
- **Download .zip** gives the folder for any static host: itch.io (as an HTML game), Netlify, Cloudflare Pages or your own server. It has to be served over HTTP; opening `index.html` from disk does not work
- **GitHub Pages** pushes the game to a branch (`gh-pages` by default, which then holds only the game) of a repository, which it can create, and publishes it at `https://<owner>.github.io/<repository>/`. It needs a [personal access token](https://github.com/settings/tokens/new?scopes=public_repo&description=Canonical%20Editor) with the `public_repo` scope (`repo` for private repositories, where Pages needs a paid plan), or a fine-grained token with Contents, Pages and Administration (to create repositories) set to Read and write. Deploying again uploads only the files that changed. Before it replaces a branch that holds anything else than a game, or changes an existing Pages setup, it asks

A game whose agents ask or recall also gets ONNX Runtime and the inference worker (about 27 MB) and downloads the models into the player's browser the first time it runs, playing with the defaults meanwhile; other games leave these files out.

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
pnpm run editor:test        # unit tests of the editor's logic (Vitest, in Node)
pnpm run editor:build       # static site in editor/dist
xvfb-run -a pnpm run editor:e2e   # browser tests of the build (Playwright)
```

The editor type checks in strict mode. The engine and the particle package, which it imports as source, are a referenced project (`editor/tsconfig.engine.json`) checked as their declarations, so they keep their own, looser settings.

The build has two pages: the editor (`index.html`) and the game player (`player.html`), whose files `player-manifest.json` lists for Build & Deploy. The dev server builds the player the first time Build & Deploy needs it, which takes a little while.

`.github/workflows/editor-pages.yml` builds the editor for pull requests to `main` and publishes it to GitHub Pages when `main` is updated. It needs a one-time setting: **Settings > Pages > Build and deployment > Source: GitHub Actions**. `.github/workflows/editor-tests.yml` runs the unit and browser tests.

| Path | Contents |
|---|---|
| `editor/` | Canonical Editor: UI, viewport, scripting, shaders and the AI assistant |
| `editor/player.html`, `editor/src/player/` | The game player that Build & Deploy puts into every game |
| `editor/src/core/behavior/` | Behavior formats: node type definitions, edit operations, validation, outlines |
| `editor/src/play/ai/` | Agents while playing: tree runtime, blackboards, context pool, Ask and Model tasks, scheduler, memory, inference worker and model adapters, speech |
| `editor/public/` | Favicons and the logo |
| `src/` | Orillusion engine core |
| `packages/` | Orillusion plugins (physics, particles, atmosphere, post effects and more) |
| `samples/` | Engine samples, served by `pnpm run dev` (they load assets from the `public` submodule: `git submodule update --init`) |
| `test/` | Engine tests |

### Testing
Check a change with `pnpm run editor:typecheck`, `pnpm run editor:test` and `pnpm run editor:build`, then drive the built editor in a browser: `xvfb-run -a pnpm run editor:e2e` runs the Playwright tests in `editor/test/e2e` against `npx vite preview --config editor/vite.config.js`, which also serves the player app that Build & Deploy needs. What has worked for scripted runs (Playwright or plain CDP):

- **WebGPU without a GPU.** Chromium can run WebGPU on the CPU with SwiftShader: `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-gpu-watchdog`. On a server, run the browser headed under a virtual display (`xvfb-run -a node test.mjs`), which is more reliable than headless. Compiling the shaders stalls the first frames of a page for about half a minute; without the GPU watchdog that ends without an "Instance dropped" error, so the browser tests share one page per file.
- **Start clean.** The editor restores its last scene, layout and settings from localStorage and IndexedDB. Clear both and reload for a new scene. A new scene opens on the brief screen; "Work without a brief" dismisses it.
- **Wait for state, not time.** The editor is `window.__editor` (its store, pipeline, camera and so on). It is ready when `.viewport canvas.gpu` is there and `.viewport-loading` is gone. SwiftShader can stop drawing frames for many seconds after a load, and waits that poll on animation frames stop with it. So give `waitForFunction` a `{ polling: 100 }` interval, click with `el.click()` inside `page.evaluate` when Playwright's actionability waits time out, and wait for `!__editor.camera.animating` after camera moves.
- **Keys.** Shortcuts take digits by their position (`Shift+1` is the back view, not `!`), and letters by position too when the layout types another script (Korean, Cyrillic). For a symbol typed with Shift, press the symbol (`?`), not `Shift+/`.
- **The assistant without an account.** Put a dummy key in `localStorage['canonical-editor/openrouter-key']`. Then answer `https://openrouter.ai/api/v1/models` and `/api/v1/chat/completions` with `context.route`. A chat reply is a `text/event-stream` body of `data: {"choices":[{"delta":...}]}` lines ending with `data: [DONE]`, so a test can script tool calls step by step.
- **Logic without a browser.** Modules without the engine, such as the store, `core/refs.ts`, the behavior formats, the script compiler, the room planner and the level check, run in Node: `editor/test/unit` has their Vitest tests. `test/unit/setup.ts` stubs the few globals they touch (`window`, `document`, `localStorage`), and `@orillusion/core` resolves to a stub there. The level check runs on any `LevelScan` (boxes and a ray cast), so tests give it a level made of boxes.
- **The engine.** `pnpm run test:ci` runs `test/` in Electron with SwiftShader. The same page (`test/?auto` on `pnpm run dev`) also runs in Chromium when `window.electron` is stubbed to collect the results.
- **Load.** SwiftShader is CPU bound. With several browsers at once, the GPU process can lose its device ("Instance dropped" errors) or time out. Run browser tests one at a time, and rerun a failure on an idle machine before deciding it is not the change.

### Browser support
The editor needs WebGPU: Chrome or Edge 113+ on Windows, macOS and ChromeOS, Chrome 121+ on Android, Safari 26+, and Firefox 141+ on Windows. On Linux, Chrome may need `chrome://flags/#enable-unsafe-webgpu` and Vulkan.

On tablets and phones the side panels open from the top bar as drawers, or as sheets over the lower half of the view on a phone held upright. In the viewport one finger orbits, two fingers pan and pinch to zoom, and a long press opens the context menu.

## Contributing
Issues and pull requests are welcome. Commit messages follow the [commit convention](.github/commit-convention.md), for example `feat(editor): ...`. For the engine's internals, scripts and samples, see the [Orillusion contributing guide](.github/contributing.md).

## License
The two parts of this repository have different licenses:

| Part | License |
|---|---|
| The editor: `editor/` | [GNU Affero General Public License v3.0](editor/LICENSE) (AGPL-3.0-only) |
| The Orillusion engine: `src/`, `packages/` | [MIT](LICENSE), copyright Orillusion |

Under the AGPL you may use, change and share the editor, but whoever shares it or a changed version, or lets people use a changed version over a network, has to offer them its complete source under the same license. Games made with Build & Deploy include the player app, which is part of the editor and so under the AGPL too.

# Basis Universal transcoder

The WebAssembly transcoder the engine uses to turn KTX2 textures (Basis
Universal ETC1S or UASTC) into a GPU format the device can sample: BC, ETC2,
ASTC or plain RGBA8.

- `basis_transcoder.js` and `basis_transcoder.wasm` are copied unchanged from
  three.js 0.186.1 (`examples/jsm/libs/basis/`), a build of
  [Basis Universal](https://github.com/BinomialLLC/basis_universal) by Binomial
  LLC, under the Apache License 2.0 (`LICENSE`).
- `ktx2_worker.js` is the engine's own worker around them (see
  `src/textures/ktx2/KTX2Transcoder.ts`). It is plain JavaScript loaded as text,
  so bundling never renames anything inside it.

To update, replace both transcoder files together from a newer three.js
release and run the KTX2 tests (`editor/test/e2e/assets.spec.ts`).

// The Draco decoder files, in their own chunk: loaded the first time a Draco
// model is, so pages without one never fetch them. The leading underscore
// keeps this module out of the engine's index.
import wrapperJs from '../../../../../packages/draco/draco_wasm_wrapper_gltf.js?raw';
import workerJs from '../../../../../packages/draco/draco_worker.js?raw';
import wasmUrl from '../../../../../packages/draco/draco_decoder_gltf.wasm?url';

export { wrapperJs, workerJs, wasmUrl };

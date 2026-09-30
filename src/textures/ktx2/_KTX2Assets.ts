// The Basis transcoder files, in their own chunk: loaded the first time a
// KTX2 texture is, so pages without one never fetch them. The leading
// underscore keeps this module out of the engine's index.
import transcoderJs from '../../../packages/basis/basis_transcoder.js?raw';
import workerJs from '../../../packages/basis/ktx2_worker.js?raw';
import wasmUrl from '../../../packages/basis/basis_transcoder.wasm?url';

export { transcoderJs, workerJs, wasmUrl };

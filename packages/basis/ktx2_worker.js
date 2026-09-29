// The engine's KTX2 (Basis Universal) transcoding worker. It runs right after
// basis_transcoder.js in one classic worker script (see
// src/textures/ktx2/KTX2Transcoder.ts), and stays plain JavaScript loaded as
// text so that no bundler renames anything in it.
//
// In:  { type: 'init', wasm: ArrayBuffer }
//      { type: 'transcode', id, buffer: ArrayBuffer, table }
//      where table[encoding][opaque|alpha] lists { name, format, compressed },
//      best first (KTX2TranscodeTarget.rankTargets).
// Out: { type: 'done', id, width, height, alpha, encoding, format, srgb, levels: [{ width, height, data }] }
//      { type: 'error', id, message }
/* global BASIS */
let basis = null;

self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'init') {
        basis = new Promise((resolve, reject) => {
            const module = {
                wasmBinary: msg.wasm,
                onRuntimeInitialized: () => resolve(module),
                onAbort: (why) => reject(new Error('the Basis transcoder stopped: ' + why)),
            };
            const ready = BASIS(module);
            if (ready && typeof ready.catch === 'function') ready.catch(reject);
        }).then((module) => {
            module.initializeBasis();
            return module;
        });
        // Transcode requests report the failure.
        basis.catch(() => {});
        return;
    }
    if (msg.type === 'transcode') {
        Promise.resolve(basis).then((module) => {
            if (!module) throw new Error('the KTX2 worker was not initialised');
            const out = transcode(module, msg.buffer, msg.table);
            self.postMessage(Object.assign({ type: 'done', id: msg.id }, out), out.levels.map((level) => level.data.buffer));
        }).catch((err) => {
            self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
        });
    }
};

function transcode(module, buffer, table) {
    const file = new module.KTX2File(new Uint8Array(buffer));
    try {
        if (!file.isValid()) throw new Error('invalid or unsupported KTX2 file');
        const encoding = file.isUASTC() ? 'uastc' : file.isETC1S() ? 'etc1s' : '';
        if (!encoding) {
            throw new Error(file.isHDR && file.isHDR() ? 'HDR KTX2 textures are not supported' : 'the KTX2 file is not Basis Universal (ETC1S or UASTC)');
        }
        const width = file.getWidth();
        const height = file.getHeight();
        const levels = file.getLevels();
        if (!width || !height || !levels) throw new Error('the KTX2 file has no image');
        if ((file.getFaces() || 1) > 1 || (file.getLayers() || 1) > 1) throw new Error('KTX2 cube maps and texture arrays are not supported');
        const alpha = !!file.getHasAlpha();
        // Block-compressed GPU formats need a base level that is whole blocks.
        const aligned = width % 4 === 0 && height % 4 === 0;
        const list = table[encoding][alpha ? 'alpha' : 'opaque'];
        const target = list.find((t) => aligned || !t.compressed) || list[list.length - 1];
        const format = module.transcoder_texture_format[target.name];
        if (!format) throw new Error('the Basis transcoder has no format ' + target.name);
        if (!file.startTranscoding()) throw new Error('KTX2 transcoding failed to start');
        const out = [];
        for (let level = 0; level < levels; level++) {
            const info = file.getImageLevelInfo(level, 0, 0);
            const data = new Uint8Array(file.getImageTranscodedSizeInBytes(level, 0, 0, format.value));
            if (!file.transcodeImage(data, level, 0, 0, format.value, 0, -1, -1)) throw new Error('KTX2 level ' + level + ' failed to transcode');
            out.push({ width: info.origWidth, height: info.origHeight, data });
        }
        // KHR_DF_TRANSFER_SRGB
        const srgb = file.getDFDTransferFunc() === 2;
        return { width, height, alpha, encoding, format: target.format, srgb, levels: out };
    } finally {
        file.close();
        file.delete();
    }
}

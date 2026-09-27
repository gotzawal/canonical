// Where the models come from. They are downloaded once into the browser's
// Cache Storage and never put into the editor or into built games (GitHub
// Pages takes files of at most 100 MB, the decision model alone is 337 MB).

export type ModelKind = 'decision' | 'embedder';

export interface ModelSource {
    id: string;
    kind: ModelKind;
    label: string;
    /** Base URL; the file names below are relative to it. */
    base: string;
    /** The ONNX model: one file, or parts to join in order listed in a manifest ({ total_bytes, parts: [{ file, bytes, sha256 }] }). */
    model: { file: string } | { manifest: string };
    /** Decision models: sequence limits, special token ids and calibration temperatures. */
    config?: string;
    tokenizer: string;
    tokenizerConfig?: string;
    /** Download size in bytes, about. */
    size: number;
    license: string;
    homepage: string;
    /** Embedders: how token states become one vector. 'output' takes the model's sentence_embedding. */
    pooling?: 'mean' | 'cls' | 'output';
    queryPrefix?: string;
    passagePrefix?: string;
    /** Keep the first dims components (Matryoshka models), then normalize. */
    dims?: number;
    maxLength?: number;
}

export const MODELS: ModelSource[] = [
    {
        id: 'laya-en-q4',
        kind: 'decision',
        label: 'Laya English, 4-bit (ModernBERT-large)',
        base: 'https://raw.githubusercontent.com/dockndevai/laya-models/main/english/',
        model: { manifest: 'manifest.json' },
        config: 'config.json',
        tokenizer: 'tokenizer.json',
        tokenizerConfig: 'tokenizer_config.json',
        size: 340_000_000,
        license: 'Apache-2.0 (weights by Convai Innovations; ONNX 4-bit build by dockndevai)',
        homepage: 'https://huggingface.co/convaiinnovations/laya',
    },
    {
        id: 'e5-small',
        kind: 'embedder',
        label: 'multilingual-e5-small (int8)',
        base: 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/',
        model: { file: 'onnx/model_quantized.onnx' },
        tokenizer: 'tokenizer.json',
        tokenizerConfig: 'tokenizer_config.json',
        size: 135_000_000,
        license: 'MIT (intfloat/multilingual-e5-small)',
        homepage: 'https://huggingface.co/intfloat/multilingual-e5-small',
        pooling: 'mean',
        queryPrefix: 'query: ',
        passagePrefix: 'passage: ',
        dims: 384,
        maxLength: 512,
    },
];

export const DEFAULT_DECISION_MODEL = 'laya-en-q4';

/** A registry model, or a custom decision model laid out like the default one at `id` (a URL ending in /). */
export function modelSource(id: string, kind: ModelKind): ModelSource | undefined {
    const known = MODELS.find((m) => m.id === id && m.kind === kind);
    if (known) return known;
    if (!/^https?:\/\//.test(id)) return undefined;
    const base = id.endsWith('/') ? id : id + '/';
    const like = MODELS.find((m) => m.kind === kind)!;
    return { ...like, id, label: `Custom (${base})`, base, homepage: base, license: 'see the source' };
}

export function modelUrl(src: ModelSource, file: string): string {
    return new URL(file, src.base).href;
}

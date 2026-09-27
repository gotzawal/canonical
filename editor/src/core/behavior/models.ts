// Models: what a scene can load and how each kind runs. Like nodeTypes.ts,
// this is the one place that describes them: the Models view builds its
// inputs from MODEL_KINDS, validate.ts checks against it, the reference and
// the assistant read it, and the inference worker runs a model with the
// adapter of the same kind (play/ai/adapters.ts). A new kind of model needs
// an entry here and an adapter there.

import type { AiModelDoc } from '../types';
import type { FieldDef } from './nodeTypes';

/** What a model does for the trees. */
export type ModelTask = 'decide' | 'embed' | 'classify' | 'generate';

export const MODEL_TASKS: { task: ModelTask; label: string; usedBy: string }[] = [
    { task: 'decide', label: 'Decide', usedBy: 'Ask nodes: yes / no and choice questions about the facts and the context' },
    { task: 'embed', label: 'Embed', usedBy: 'Memory: Recall and choices from memory find items by meaning' },
    { task: 'classify', label: 'Classify', usedBy: 'Model tasks: a label and its probability for a text' },
    { task: 'generate', label: 'Generate', usedBy: 'Model tasks: text that continues a prompt (lines of dialogue)' },
];

export interface ModelKindDef {
    kind: string;
    task: ModelTask;
    label: string;
    description: string;
    /** The usual ONNX file of such a model in its folder. */
    file: string;
    /** Settings of the kind (AiModelDoc.options). */
    options: FieldDef[];
    /** A public model of the kind, to start from (the Models view's Add form offers it). */
    example?: { name: string; url: string; file?: string; options?: Record<string, string | number> };
}

const opt = (name: string, kind: FieldDef['kind'], label: string, description: string, d: unknown, extra: Partial<FieldDef> = {}): FieldDef => ({ name, kind, label, description, default: d, ...extra });

export const MODEL_KINDS: ModelKindDef[] = [
    {
        kind: 'laya',
        task: 'decide',
        label: 'Laya',
        description: 'Laya (convaiinnovations/laya): one encoder pass scores typed questions. config.json holds its sequence limits, special tokens and temperatures.',
        file: 'manifest.json',
        options: [],
    },
    {
        kind: 'nli',
        task: 'decide',
        label: 'Zero-shot (NLI)',
        description:
            'Any natural language inference classifier (MNLI, XNLI) answers Ask questions zero-shot: the facts and context are the premise, each option a hypothesis; the entailment scores give the probabilities. A yes / no question should read as a statement ("The stranger is a threat.").',
        file: 'onnx/model_quantized.onnx',
        options: [
            opt('hypothesis', 'text', 'Hypothesis', 'How a choice question and an option become a hypothesis.', '{question} {option}'),
            opt('entailment', 'text', 'Entailment Label', 'The label of entailment in config.json.', 'entailment'),
            opt('contradiction', 'text', 'Contradiction Label', 'The label of contradiction in config.json.', 'contradiction'),
            opt('maxLength', 'integer', 'Max Tokens', 'Premise and hypothesis are cut to this many tokens.', 512, { min: 16, max: 4096 }),
        ],
        example: { name: 'nli-deberta-v3-xsmall', url: 'https://huggingface.co/Xenova/nli-deberta-v3-xsmall/resolve/main/' },
    },
    {
        kind: 'embedding',
        task: 'embed',
        label: 'Sentence embedding',
        description: 'A sentence embedding model (e5, MiniLM, BGE, GTE): memory items and queries become vectors compared by cosine.',
        file: 'onnx/model_quantized.onnx',
        options: [
            opt('pooling', 'choice', 'Pooling', 'How token states become one vector: their mean, the first token, or the model\'s own sentence_embedding output.', 'mean', {
                choices: [
                    { value: 'mean', label: 'Mean' },
                    { value: 'cls', label: 'First token (CLS)' },
                    { value: 'output', label: 'Model output' },
                ],
            }),
            opt('queryPrefix', 'text', 'Query Prefix', 'Put before queries (e5: "query: ").', ''),
            opt('passagePrefix', 'text', 'Passage Prefix', 'Put before memory items (e5: "passage: ").', ''),
            opt('dims', 'integer', 'Dimensions', 'Keep the first this many components (Matryoshka models); 0 keeps all.', 0, { min: 0, max: 4096 }),
            opt('maxLength', 'integer', 'Max Tokens', 'Texts are cut to this many tokens.', 512, { min: 8, max: 8192 }),
        ],
        example: { name: 'all-MiniLM-L6-v2', url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/', options: { maxLength: 256 } },
    },
    {
        kind: 'classifier',
        task: 'classify',
        label: 'Text classifier',
        description: 'A sequence classification model (sentiment, emotion, intent, toxicity): the probability of each label for a text.',
        file: 'onnx/model_quantized.onnx',
        options: [
            opt('labels', 'text', 'Labels', 'Label names in the model\'s output order, separated by commas; empty takes id2label of config.json.', ''),
            opt('maxLength', 'integer', 'Max Tokens', 'Texts are cut to this many tokens.', 512, { min: 8, max: 8192 }),
        ],
        example: { name: 'distilbert-sst-2 (sentiment)', url: 'https://huggingface.co/Xenova/distilbert-base-uncased-finetuned-sst-2-english/resolve/main/' },
    },
    {
        kind: 'causal-lm',
        task: 'generate',
        label: 'Text generator',
        description:
            'A small causal language model exported for ONNX Runtime (SmolLM, Qwen, TinyStories, GPT-2): continues the prompt token by token with its key/value cache, until a stop text, the end token or the task\'s token limit.',
        file: 'onnx/model_quantized.onnx',
        options: [
            opt('prompt', 'text', 'Prompt', 'How the task\'s input becomes the prompt: {input} is the input. Put an instruct model\'s chat format here, e.g. <|im_start|>user\\n{input}<|im_end|>\\n<|im_start|>assistant\\n.', '{input}'),
            opt('stop', 'text', 'Stop At', 'Generation stops at any of these texts, separated by |; \\n is a line break.', '\\n'),
            opt('maxLength', 'integer', 'Window', 'Most tokens of prompt and output together; the start of a longer prompt is cut.', 1024, { min: 32, max: 8192 }),
        ],
        example: {
            name: 'SmolLM2-135M-Instruct',
            url: 'https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/resolve/main/',
            options: { prompt: '<|im_start|>user\\n{input}<|im_end|>\\n<|im_start|>assistant\\n' },
        },
    },
];

/** Built-in models: usable by id without an entry in the scene. */
export interface BuiltinModel extends AiModelDoc {
    /** Download size in bytes, about. */
    size: number;
    license: string;
    homepage: string;
}

export const BUILTIN_MODELS: BuiltinModel[] = [
    {
        id: 'laya-en-q4',
        name: 'Laya English, 4-bit (ModernBERT-large)',
        kind: 'laya',
        url: 'https://raw.githubusercontent.com/dockndevai/laya-models/main/english/',
        file: 'manifest.json',
        options: {},
        size: 340_000_000,
        license: 'Apache-2.0 (weights by Convai Innovations; ONNX 4-bit build by dockndevai)',
        homepage: 'https://huggingface.co/convaiinnovations/laya',
    },
    {
        id: 'e5-small',
        name: 'multilingual-e5-small (int8)',
        kind: 'embedding',
        url: 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/',
        file: 'onnx/model_quantized.onnx',
        options: { pooling: 'mean', queryPrefix: 'query: ', passagePrefix: 'passage: ', dims: 384, maxLength: 512 },
        size: 135_000_000,
        license: 'MIT (intfloat/multilingual-e5-small)',
        homepage: 'https://huggingface.co/intfloat/multilingual-e5-small',
    },
];

/** Ask nodes without a model use this one. */
export const DEFAULT_DECIDE_MODEL = 'laya-en-q4';

export function modelKind(kind: string): ModelKindDef | undefined {
    return MODEL_KINDS.find((k) => k.kind === kind);
}

/** A model by id: the scene's first, then the built-in ones. */
export function findModel(id: string, sceneModels: readonly AiModelDoc[]): AiModelDoc | BuiltinModel | undefined {
    return sceneModels.find((m) => m.id === id) ?? BUILTIN_MODELS.find((m) => m.id === id);
}

export function modelTask(m: Pick<AiModelDoc, 'kind'> | undefined): ModelTask | undefined {
    return m ? modelKind(m.kind)?.task : undefined;
}

/** Every model a scene can use: its own, then the built-in ones. */
export function allModels(sceneModels: readonly AiModelDoc[]): (AiModelDoc | BuiltinModel)[] {
    return [...sceneModels, ...BUILTIN_MODELS.filter((b) => !sceneModels.some((m) => m.id === b.id))];
}

/** An option of a model, or the default of its kind. */
export function modelOption<T = unknown>(m: Pick<AiModelDoc, 'kind' | 'options'>, name: string): T {
    const v = m.options?.[name];
    if (v !== undefined && v !== null && v !== '') return v as T;
    return modelKind(m.kind)?.options.find((o) => o.name === name)?.default as T;
}

/** Tells a model's files apart: a changed URL or file is another download. */
export function modelFingerprint(m: Pick<AiModelDoc, 'kind' | 'url' | 'file'>): string {
    return `${m.kind}|${m.url}|${m.file}`;
}

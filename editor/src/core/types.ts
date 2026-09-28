// Scene document: the editor's source of truth. It is plain JSON so it can be
// snapshotted for undo/redo, autosaved and written to a file. The engine scene
// is rebuilt from it by engine/sync.ts.

import type { Vec3 } from './math';
import type { AnimationDoc, BodyDoc, CameraDoc, CharacterDoc, EnvironmentDoc, LightDoc, MeshDoc, ModelDoc, ParticlesDoc, PlayerDoc, SpecsDoc } from './model';

export type { Vec3 };

// Components and settings defined by their schemas (core/model.ts).
export type {
    AlphaMode, AnimationDoc, BodyDoc, BodyType, CameraDoc, CharacterDoc, EnvironmentDoc, GeometryDoc, GeometryType, GIDoc, LightDoc, LightType, MaterialDoc, MaterialOverride,
    MaterialType, MeshDoc, ModelDoc, ParticleShape, ParticlesDoc, PartOverride, PlayerDoc, PlayerView, SkyType, SlotShading, SpecsDoc,
} from './model';

/** Value of a script property or a shader property. Colors are #rrggbb strings, vectors number arrays. */
export type ParamValue = number | string | boolean | number[];

/** A script attached to a node. */
export interface ScriptRef {
    /** Script asset id. */
    script: string;
    enabled: boolean;
    /** Values for the script's public fields, overriding the defaults in code. */
    props: Record<string, ParamValue>;
}

/** A node with these components, e.g. `NodeWith<'mesh'>` from makeMeshNode. */
export type NodeWith<K extends keyof NodeDoc> = NodeDoc & Required<Pick<NodeDoc, K>>;

export interface NodeDoc {
    id: string;
    name: string;
    /** Parent node id, or null for scene root. Sibling order is array order. */
    parent: string | null;
    visible: boolean;
    position: Vec3;
    /** Euler angles in degrees, engine convention. */
    rotation: Vec3;
    scale: Vec3;
    mesh?: MeshDoc;
    light?: LightDoc;
    model?: ModelDoc;
    camera?: CameraDoc;
    particles?: ParticlesDoc;
    /** A character: the object walks through the level in Play mode. */
    character?: CharacterDoc;
    /** The player controls the object's character in Play mode. */
    player?: PlayerDoc;
    /** A physics body: the object falls and collides in Play mode. */
    body?: BodyDoc;
    /** Skeletal animation of the node's model: its clip, and a character's clip per mode. */
    animation?: AnimationDoc;
    scripts?: ScriptRef[];
    /** AI behavior: the object runs a behavior tree in Play mode. */
    agent?: AgentDoc;
    /**
     * Prefab instance: the id of the prefab (SceneDoc.prefabs). The node's
     * children are generated from the prefab (see prefabChild).
     */
    prefab?: string;
    /** Generated from the prefab of an ancestor instance; replaced whenever the prefab changes. */
    prefabChild?: boolean;
}

/**
 * A reusable group of primitives (a greybox asset) placed as instances.
 * Once the final mesh exists, a model asset replaces the template in every
 * instance: importing a .glb into the prefab stores it under `asset`.
 */
export interface PrefabDoc {
    id: string;
    name: string;
    /**
     * Template nodes. Nodes with parent null sit directly under an instance,
     * positioned relative to the prefab's pivot (the bottom center).
     */
    nodes: NodeDoc[];
    /** Asset id reserved for the model that replaces the template. */
    asset: string;
    /** True once a model is stored under `asset`: instances show the model instead of the template. */
    useModel?: boolean;
    /** Offset that puts the model's bottom center on the pivot. */
    modelOffset?: Vec3;
}

/**
 * 'image' is a picture used for planning (concepts, paintovers, captures,
 * attachments), 'data' a JSON blob (scene snapshots). Neither is used by the
 * game.
 */
export type AssetKind = 'model' | 'texture' | 'image' | 'data';

export interface AssetMeta {
    id: string;
    name: string;
    kind: AssetKind;
    mime: string;
    size: number;
    /**
     * 'design' assets belong to the planning pipeline. Scene files (Ctrl+S)
     * list them without their data to stay small; project files carry them.
     */
    purpose?: 'design';
    /** Pixel size of images, when known. */
    width?: number;
    height?: number;
}

/** A JavaScript behaviour that runs in Play mode (see play/script.ts). */
export interface ScriptDoc {
    id: string;
    /** File-like name, e.g. "Rotator.js". */
    name: string;
    code: string;
}

export type ShaderKind = 'material' | 'post';

/**
 * A WGSL shader written in the editor. Material shaders render meshes,
 * post shaders run as a full screen pass in the render graph's post chain.
 * Properties are declared in the code with `// @property` lines.
 */
export interface ShaderDoc {
    id: string;
    /** File-like name, e.g. "Hologram.wgsl". */
    name: string;
    kind: ShaderKind;
    /** Material shaders only: lit surfaces go through the PBR lighting. */
    lighting: 'lit' | 'unlit';
    code: string;
}

/** A custom post effect in the post chain. */
export interface PostDoc {
    id: string;
    /** Post shader asset id. */
    shader: string;
    enabled: boolean;
    params: Record<string, ParamValue>;
}

/** User changes to the engine's render graph. */
export interface RenderGraphDoc {
    /** Built-in passes switched off, by pass name. */
    disabled: string[];
    /** Custom post effects, in chain order (before anti-aliasing and tone mapping). */
    posts: PostDoc[];
}

/** Scene format version. 2 added the AI behavior data (blackboards, behaviors, memory, agents), 3 the scene's AI models. */
export const SCENE_VERSION = 3;

export interface SceneDoc {
    format: 'canonical-scene';
    version: typeof SCENE_VERSION;
    name: string;
    environment: EnvironmentDoc;
    assets: AssetMeta[];
    scripts: ScriptDoc[];
    shaders: ShaderDoc[];
    renderGraph: RenderGraphDoc;
    nodes: NodeDoc[];
    /** Prefab definitions; their instances are expanded into `nodes`. */
    prefabs: PrefabDoc[];
    /** Blackboard schemas: the keys behavior trees read and write. Trees can share one. */
    blackboards: BlackboardSchemaDoc[];
    /** Behavior trees; objects run them through NodeDoc.agent. */
    behaviors: BehaviorTreeDoc[];
    /** What agents can recall: planning notes and lore, embedded in the editor. */
    memory: MemoryDoc;
    /** AI models the scene loads besides the built-in ones (core/behavior/models.ts). */
    aiModels: AiModelDoc[];
    build?: BuildDoc;
    /** The planning pipeline: brief, structure, shots and stage state. Not part of built games. */
    design: DesignDoc;
}

// ---------------------------------------------------------------- behavior
//
// AI behavior (see play/ai/ for the runtime and core/behavior/ for editing).
// Three formats: blackboard schemas, behavior trees and decision log
// entries. The model only writes blackboard values; trees decide what to do
// with the standard behavior tree rules, so a scene plays with the schema
// defaults when no model is available.

/**
 * Value types of blackboard keys. 'probability' is a number in 0..1, 'enum'
 * one of the key's values, 'object' a scene object (a node id in the
 * document; the engine object while playing).
 */
export type BlackboardKeyType = 'bool' | 'number' | 'probability' | 'enum' | 'string' | 'object';

/**
 * Who writes a key. 'fact': scripts only, for what the agent perceives
 * (categories such as near / mid / far change less often than numbers).
 * 'ai': exactly one Ask of the tree; the value comes with a confidence, a
 * source and a time. 'tree': Set Key tasks and script tasks of the tree,
 * for goals (a move target) and the step of a sequence.
 */
export type BlackboardKeyOwner = 'fact' | 'ai' | 'tree';

/** A blackboard value. Object keys hold a node id (or null) in documents. */
export type BlackboardValue = boolean | number | string | null;

export interface EnumValueDoc {
    value: string;
    /** Short description; Choice questions show it to the model as the option text. */
    description: string;
}

export interface BlackboardKeyDoc {
    /** Unique in the schema, e.g. "threat". */
    name: string;
    type: BlackboardKeyType;
    /** Value until something writes the key, and the value AI keys keep without a model. */
    default: BlackboardValue;
    description: string;
    owner: BlackboardKeyOwner;
    /** Enum keys: the allowed values, in order. */
    values?: EnumValueDoc[];
}

export interface BlackboardSchemaDoc {
    id: string;
    name: string;
    /** Revision, raised by every edit. */
    version: number;
    keys: BlackboardKeyDoc[];
}

export type BtCompositeType = 'selector' | 'sequence';
export type BtTaskType = 'script' | 'wait' | 'set_key' | 'move_to' | 'ask' | 'infer';
export type BtNodeType = BtCompositeType | BtTaskType;
export type BtDecoratorType = 'condition' | 'cooldown';
export type BtServiceType = 'recall' | 'ask';

/** eq / ne: equal, not equal; ge / le: at least, at most; set: has a value (see the reference). */
export type CompareOp = 'eq' | 'ne' | 'ge' | 'le' | 'set';

export interface ConditionDecoratorDoc {
    type: 'condition';
    key: string;
    op: CompareOp;
    value: BlackboardValue;
    /** AI keys: the answer's confidence must be at least this. */
    minConfidence: number;
}

export interface CooldownDecoratorDoc {
    type: 'cooldown';
    /** After the node finishes it cannot run again for this long. */
    seconds: number;
}

export type BtDecoratorDoc = ConditionDecoratorDoc | CooldownDecoratorDoc;

export type AskPriority = 'low' | 'normal' | 'high';
export type AskTrigger = 'activate' | 'facts' | 'interval';

export interface AskQuestionDoc {
    /** The AI key the answer is written to. Probability keys are asked as Noul, enum keys as Choice. */
    key: string;
    /** The question for this key, e.g. "Is the player about to attack?". */
    text: string;
}

/** Settings shared by the Ask task and the Ask service. */
export interface AskSettingsDoc {
    /** A decide model (scene or built-in); empty for the default one. */
    model: string;
    questions: AskQuestionDoc[];
    /** Fact keys the model sees; a change of their write version triggers the Ask service. */
    facts: string[];
    /** Also show the model the agent's context pool (what Recall found, dialogue lines...). */
    context: boolean;
    /** Answers less confident than this keep the key's previous value. */
    minConfidence: number;
    /** Seconds a written value stays before another answer may change it. */
    minHold: number;
    priority: AskPriority;
    /** Options of Choice questions: the key's enum values, or memory items found by a search (string keys). */
    choices: 'enum' | 'memory';
    /** Memory choices: search text, {key} is replaced with the blackboard value. */
    memoryQuery: string;
    memoryTags: string[];
    memoryCount: number;
}

interface BtNodeBase {
    /** Readable name, fixed and unique in the tree (nodes and services share it), e.g. "threat_gate". */
    id: string;
    note?: string;
    decorators?: BtDecoratorDoc[];
    services?: BtServiceDoc[];
}

export interface SelectorNodeDoc extends BtNodeBase {
    type: 'selector';
    children: BtNodeDoc[];
}

export interface SequenceNodeDoc extends BtNodeBase {
    type: 'sequence';
    children: BtNodeDoc[];
}

export interface ScriptTaskDoc extends BtNodeBase {
    type: 'script';
    /** Method of a script on the agent's object. */
    method: string;
    /** Script file or class name; empty searches every script on the object. */
    script: string;
}

export interface WaitTaskDoc extends BtNodeBase {
    type: 'wait';
    seconds: number;
    /** Random deviation, plus or minus seconds. */
    deviation: number;
}

/** Walks the agent's character to the object in an object key. */
export interface MoveToTaskDoc extends BtNodeBase {
    type: 'move_to';
    target: string;
    /** Arrived this close, meters. */
    radius: number;
    run: boolean;
}

export interface SetKeyTaskDoc extends BtNodeBase {
    type: 'set_key';
    key: string;
    value: BlackboardValue;
}

export interface AskTaskDoc extends BtNodeBase, AskSettingsDoc {
    type: 'ask';
}

/**
 * Runs a classify or generate model on a text made from a template (blackboard
 * values and the context pool) and writes the result to an AI key.
 */
export interface InferTaskDoc extends BtNodeBase {
    type: 'infer';
    /** A classify or generate model (scene or built-in). */
    model: string;
    /** The model's input: {key} is a blackboard value, {context} the context pool, {context:slot} one slot. */
    input: string;
    /** AI key for the result: string (the text or the top label), enum (the top label) or probability (P of `label`). */
    output: string;
    /** Classifiers with a probability output: the label whose probability is written (empty: the top label's). */
    label: string;
    /** Classifier results less confident than this keep the key's value. */
    minConfidence: number;
    /** Text generators: most new tokens, and the sampling temperature (0 takes the likeliest token). */
    maxTokens: number;
    temperature: number;
    /** A context slot the written result is added to as "Name: text" (a dialogue); empty for none. */
    history: string;
    /** Speak the written text. */
    speak: boolean;
    /** Seconds the task waits for the result before it fails. */
    timeout: number;
}

export type BtNodeDoc = SelectorNodeDoc | SequenceNodeDoc | ScriptTaskDoc | WaitTaskDoc | SetKeyTaskDoc | MoveToTaskDoc | AskTaskDoc | InferTaskDoc;
export type BtCompositeDoc = SelectorNodeDoc | SequenceNodeDoc;

interface BtServiceBase {
    /** Readable name, unique in the tree (shared with the nodes). */
    id: string;
    note?: string;
    /** Seconds between runs while the node it is attached to is active. */
    interval: number;
    /** Random deviation of the interval, as a fraction (0.2 = plus or minus 20%). */
    jitter: number;
}

export interface RecallServiceDoc extends BtServiceBase {
    type: 'recall';
    /** Search text; {key} is replaced with the blackboard value. */
    query: string;
    tags: string[];
    /** How many memory items to take (the best matches). */
    count: number;
    /** Most tokens the assembled context may take. */
    tokenBudget: number;
}

export interface AskServiceDoc extends BtServiceBase, AskSettingsDoc {
    type: 'ask';
    /** When to ask: when the node becomes active, when a fact changes, every interval. */
    triggers: AskTrigger[];
}

export type BtServiceDoc = RecallServiceDoc | AskServiceDoc;

export interface BehaviorTreeDoc {
    id: string;
    name: string;
    /** Revision, raised by every edit. */
    version: number;
    /** Blackboard schema id. */
    schema: string;
    root: BtNodeDoc;
}

/** A behavior tree attached to an object (same shape as ScriptRef). */
export interface AgentDoc {
    /** Behavior tree id. */
    tree: string;
    enabled: boolean;
    /** Initial values by key name, replacing the schema defaults for this object. */
    values: Record<string, BlackboardValue>;
}

export interface MemoryItemDoc {
    /** Readable id, unique in the scene; a Choice from memory writes it to the key. */
    id: string;
    text: string;
    tags: string[];
    /** Embedding made in the editor (int8, base64). Missing until embedded. */
    vector?: string;
}

export interface MemoryDoc {
    /** Embed model the vectors were made with (a scene or built-in model id). */
    embedder: string;
    items: MemoryItemDoc[];
}

/**
 * An AI model a scene loads: any small ONNX model with a tokenizer.json, run
 * by one of the model kinds (core/behavior/models.ts). Laya and
 * multilingual-e5 are built in and need no entry.
 */
export interface AiModelDoc {
    /** Readable id, unique among the scene's and the built-in models; nodes use it. */
    id: string;
    name: string;
    /** How it runs: laya, nli, embedding, classifier or causal-lm. */
    kind: string;
    /** Folder with tokenizer.json, config.json and the ONNX file, ending with /. */
    url: string;
    /** The ONNX file in the folder, or a manifest.json of parts. */
    file: string;
    /** Settings of the kind (pooling, labels, stop strings...). */
    options: Record<string, BlackboardValue>;
}

/**
 * What happened to one answer. written: stored in the key. low_confidence:
 * below the Ask's minimum, the key kept its value. superseded: a newer
 * request of the same Ask was made. held: the key's minimum hold time had
 * not passed. timeout: no answer within 1.5 s. unavailable: no model.
 */
export type AskOutcome = 'written' | 'low_confidence' | 'superseded' | 'held' | 'timeout' | 'unavailable';

export interface DecisionQuestion {
    key: string;
    /** noul and choice: Ask questions; classify and generate: Model tasks (text: their input). */
    format: 'noul' | 'choice' | 'classify' | 'generate';
    text: string;
    /** Choice options: the value written to the key and the text the model saw. */
    options?: { value: string; text: string }[];
    /** Probability per option (noul: [false, true]); null without an answer. */
    probabilities: number[] | null;
    /** The answer: P(true) for Noul, the chosen value for Choice. */
    value: BlackboardValue;
    /** Probability of the chosen answer (Noul: of the likelier side). */
    confidence: number | null;
    outcome: AskOutcome;
}

/** One entry of the decision log: one Ask request and what became of it. */
export interface DecisionLogEntry {
    /** Play time in seconds, frame number and wall clock time. */
    time: number;
    frame: number;
    at: string;
    /** Object (node id and name), tree, tree revision, Ask node id and the request's number. */
    agent: string;
    agentName: string;
    tree: string;
    treeVersion: number;
    node: string;
    seq: number;
    /** Fact values the model saw, and what the context held (memory item ids, other slots by name). */
    facts: Record<string, BlackboardValue>;
    context: string[];
    questions: DecisionQuestion[];
    /** Provider and model with its calibration, cache hit, milliseconds from request to answer. */
    provider: string;
    model: string;
    cache: 'none' | 'exact' | 'semantic' | 'joined';
    latency: number;
    /** Right or wrong, set by a person. Only the format exists in v1. */
    label: 'right' | 'wrong' | null;
}

// ------------------------------------------------------------------ design

/**
 * Stages of the pipeline, in order: planning input, level (greybox),
 * lighting, materials (with a second lighting pass), effects, finish.
 */
export type StageId = 'brief' | 'level' | 'light' | 'material' | 'effects' | 'finish';

/** 'recheck': done before, but an earlier stage was reopened or the brief changed. */
export type StageStatus = 'todo' | 'active' | 'done' | 'recheck';

/** Stored state of a checklist item (automatic items are computed, see design/stages.ts). */
export interface CheckItemDoc {
    id: string;
    /** Text of items added by the user or the assistant; empty for built-in items. */
    text: string;
    done: boolean;
    by?: 'user' | 'ai';
    note?: string;
}

export interface StageDoc {
    status: StageStatus;
    checks: CheckItemDoc[];
    /** The assistant proposed completing the stage; the user approves it. */
    proposal?: { summary: string; at: string } | null;
    doneAt?: string;
    /** Why the stage needs another look. */
    recheck?: string;
}

export interface AreaObjectDoc {
    name: string;
    count?: number;
    note?: string;
    /** Placed in the level (ticked by the user or the assistant). */
    placed?: boolean;
}

export interface AreaDoc {
    id: string;
    name: string;
    description: string;
    /** What the area needs. */
    objects: AreaObjectDoc[];
    /** Mood of this area when it differs from the scene's mood. */
    mood?: string;
    /** Rough placement for the greybox in meters: center on the ground, size x y z. */
    bounds?: { center: Vec3; size: Vec3 } | null;
    /** Earliest stage the area has to go through again after the brief changed it. */
    rework?: StageId | null;
    reworkNote?: string;
}

/** How the scene is built: decided first, before the areas. */
export interface LayoutDoc {
    /** Kind of place, overall size, ground, how the areas sit and connect. */
    summary: string;
    /** Overall footprint x and z and height y, in meters. */
    size?: Vec3 | null;
    connections: { from: string; to: string; kind?: string; note?: string }[];
}

export interface MoodDoc {
    description: string;
    timeOfDay: string;
    /** Key light direction in degrees (azimuth around +Y from +Z, elevation above the horizon) and color. */
    keyLight: { azimuth: number; elevation: number; color: string; note: string };
    palette: string[];
}

export interface RoutePointDoc {
    id: string;
    name: string;
    area?: string | null;
    position?: Vec3 | null;
    note?: string;
    /** Reached with the walk camera. */
    visited?: boolean;
}

export interface SightlineDoc {
    id: string;
    /** Route point or area id, or a free description. */
    from: string;
    /** Landmark: object name, area id or a description. */
    to: string;
    note?: string;
    /** Checked: true visible, false blocked, missing not checked yet. */
    ok?: boolean | null;
}

/** Play requirements: route, landmark sight lines and the order of areas. */
export interface PlayDoc {
    route: RoutePointDoc[];
    sightlines: SightlineDoc[];
    areaOrder: string[];
    notes: string;
}

export interface EffectItemDoc {
    id: string;
    name: string;
    area?: string | null;
    note?: string;
    done?: boolean;
}

export interface ConceptDoc {
    /** Image asset id. */
    asset: string;
    area?: string | null;
    note?: string;
    /**
     * Concepts the image model made: 'proposed' until the user approves one
     * (rejecting removes it). Concepts the user gave need no review.
     */
    review?: 'proposed' | 'approved';
    /** The instruction a generated concept was made from. */
    prompt?: string;
}

export interface PaintoverDoc {
    asset: string;
    source: 'generated' | 'upload';
    at: string;
    model?: string;
    prompt?: string;
    seed?: number | null;
    /** Asset ids of the reference images. */
    refs?: string[];
    params?: Record<string, ParamValue>;
    cost?: number | null;
}

export interface ShotCaptureDoc {
    stage: StageId;
    asset: string;
    at: string;
    /** Match with the target image (0..100) when it was captured. */
    score?: number | null;
    /** Captured by hand during the stage (not at its completion). */
    manual?: boolean;
    /** How the score was measured: lightness only, or the whole color. */
    compare?: 'gray' | 'color';
}

/** A camera bookmark framed like a concept image. */
export interface ShotDoc {
    id: string;
    name: string;
    area?: string | null;
    /** The concept this shot matches, kept as the record of the original idea. */
    concept?: string | null;
    camera: CameraState;
    /** Frame width / height (the concept image's). */
    aspect: number;
    paintovers: PaintoverDoc[];
    /** Chosen paintover: the target every later comparison uses. */
    target?: string | null;
    /** The level or the framing changed after the target was chosen. */
    stale?: boolean;
    history: ShotCaptureDoc[];
    /** Accepted in the final comparison. */
    approved?: boolean;
    /** Stages in which the user judged the shot to match its target. */
    matched?: StageId[];
}

/** A named surface of the level; its swatch is applied with the world space triplanar shader. */
export interface MaterialSlotDoc {
    id: string;
    name: string;
    description: string;
    /** Albedo swatch texture asset, or null while the slot is empty. */
    swatch?: string | null;
    color: string;
    roughness: number;
    metallic: number;
    /** Meters per texture tile. */
    tile: number;
    /** Meant as a plain color without a swatch (painted metal, glass). */
    flat?: boolean;
}

export interface SnapshotDoc {
    id: string;
    /** 'data' asset holding the scene JSON. */
    asset: string;
    name: string;
    stage?: StageId | null;
    at: string;
    /** Assets the snapshot uses, kept in the browser while the snapshot exists. */
    assets: string[];
}

export interface QuestionDoc {
    id: string;
    text: string;
    answer: string;
    area?: string | null;
    /** What the assistant goes ahead with while the question is open; a question with one does not hold up the stage. */
    assumed?: string;
}

/**
 * How much the user wants to settle themselves: 'quick' lets the assistant
 * decide the details and move on, 'detailed' works them out with the user.
 * Missing until the assistant judged it from the user's words or asked.
 */
export type DetailLevel = 'quick' | 'detailed';

/** The last level check (design/levelCheck.ts), for the level as it was then. */
export interface LevelCheckDoc {
    at: string;
    ok: boolean;
    /** The level it checked (levelSignature): once the level changes, the result is stale. */
    signature: string;
    /** Findings in a line, e.g. "2 seams, 1 route point out of reach". */
    summary: string;
}

export interface DesignDoc {
    version: 1;
    /** Project id; keys the assistant's saved conversation in this browser. */
    id: string;
    brief: {
        text: string;
        /** The user chose to work without a brief. */
        skipped?: boolean;
        /** Brief text the current structure was made from. */
        structured?: string;
        structuredAt?: string;
    };
    layout: LayoutDoc;
    areas: AreaDoc[];
    concepts: ConceptDoc[];
    specs: SpecsDoc;
    mood: MoodDoc;
    play: PlayDoc;
    effects: EffectItemDoc[];
    materials: MaterialSlotDoc[];
    budget: { shadowLights: number; fps: number };
    questions: QuestionDoc[];
    shots: ShotDoc[];
    stage: StageId;
    stages: Record<StageId, StageDoc>;
    snapshots: SnapshotDoc[];
    /** Short running context of the scene for the assistant, refreshed at checkpoints. */
    memo: { text: string; at?: string };
    /** Placement stays editable in the stages that lock it. */
    unlocked?: boolean;
    /** How much of the detail the assistant decides itself. */
    detail?: DetailLevel;
    /** The last level check. */
    levelCheck?: LevelCheckDoc | null;
}

/** Build & Deploy settings of a project (File > Build & Deploy). */
export interface BuildDoc {
    /** Page title of the game; the scene name when empty. */
    title?: string;
    /** GitHub repository: "name" or "owner/name". */
    repo?: string;
    /** Branch GitHub Pages publishes. */
    branch?: string;
}

/** Editor camera state. Saved with the scene but kept out of undo history. */
export interface CameraState {
    target: Vec3;
    /** Degrees around +Y. */
    yaw: number;
    /** Degrees above the horizon. */
    pitch: number;
    distance: number;
    fov: number;
}

/** The file written by "Save" and read by "Open". */
export interface SceneFile extends SceneDoc {
    camera?: CameraState;
    /** Asset blobs, base64 encoded, keyed by asset id. */
    embedded?: Record<string, string>;
}

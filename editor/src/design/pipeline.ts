// The pipeline: stage gates, checklists, stage completion (shot captures and
// a scene snapshot), reopening earlier stages, shots and snapshots. All
// changes go through the store, so they autosave, undo and save with the
// scene like any other edit.

import { getAssetBlob, putAsset, putDesignImage } from '../core/assets';
import { compareImages, type CompareMode, type CompareResult } from '../core/compare';
import { makeLightNode } from '../core/defaults';
import { designAssetIds, stageIndex, STAGE_IDS } from '../core/design';
import { Emitter } from '../core/events';
import { uid } from '../core/ids';
import { confirmDialog, toast } from '../core/messages';
import type { Store } from '../core/store';
import type {
    AssetMeta, CameraState, DesignDoc, NodeDoc, SceneDoc, ShotCaptureDoc, ShotDoc, SnapshotDoc, StageId, Vec3,
} from '../core/types';
import type { Runtime } from '../engine/runtime';
import type { ScriptCompiler } from '../play/compiler';
import type { Player } from '../play/player';
import type { CameraController } from '../viewport/cameraController';
import { syncSlots } from './materialSlots';
import { cameraFov, FRAME_MARGIN, frameFov, frameRect } from './shotCamera';
import { nextStage, stageDef, stageProgress, type CheckState } from './stages';

interface PipelineEvents {
    /** A long operation (captures) started or ended. */
    busy: boolean;
    /** The shot shown in the viewport changed. */
    shot: string | null;
    /** Open the comparison of a shot (it is shown first). */
    compare: string;
    /** The assistant proposes completing the current stage (its summary). */
    proposed: string;
    /** A stage was completed; `next` is the new current stage. */
    completed: { stage: StageId; next: StageId | null };
}

/** What the pipeline works with. `blocked` tells why the view cannot show the scene now ('' when it can). */
export interface PipelineHost {
    store: Store;
    runtime: Runtime;
    camera: CameraController;
    player: Player;
    compiler: ScriptCompiler;
    blocked(): string;
}

/** Snapshot file: the scene without its design section. */
interface SnapshotFile {
    format: 'canonical-snapshot';
    version: 1;
    scene: Omit<SceneDoc, 'design'>;
    camera?: CameraState;
}

const now = () => new Date().toISOString();

export class Pipeline extends Emitter<PipelineEvents> {
    busy = false;
    /** Shot framed in the viewport (see ui/shotView.ts). */
    activeShot: string | null = null;
    /** The view's field of view before a shot was shown. */
    private viewFov: number | null = null;
    /** The last progress worked out, for the document version it was worked out for. */
    private progressCache: { version: number; stage: StageId; fps: number; result: ReturnType<typeof stageProgress> } | null = null;

    constructor(private host: PipelineHost) {
        super();
        host.store.on('load', () => {
            // The loaded scene comes with its own camera.
            this.viewFov = null;
            this.showShot(null);
        });
        host.store.on('change', (hint) => {
            // Shots are in the design section.
            if (hint && !hint.design && (hint.nodes || hint.env || hint.meta || hint.behavior)) return;
            if (this.activeShot && !this.shot(this.activeShot)) this.showShot(null);
        });
    }

    private get store() {
        return this.host.store;
    }

    get design(): DesignDoc {
        return this.store.doc.design;
    }

    progress(stage: StageId = this.design.stage): { done: number; total: number; open: CheckState[]; items: CheckState[] } {
        // Views and the assistant ask again and again; some items look at every object (placed objects, the level check).
        const fps = Math.round(this.host.runtime.fps);
        const c = this.progressCache;
        if (c && c.version === this.store.version && c.stage === stage && c.fps === fps) return c.result;
        const result = stageProgress({ doc: this.store.doc, design: this.design, fps: this.host.runtime.fps }, stage);
        this.progressCache = { version: this.store.version, stage, fps, result };
        return result;
    }

    // --------------------------------------------------------------- locks

    /** Placement is locked in the current stage (and not unlocked by the user). */
    get placementLocked(): boolean {
        return stageDef(this.design.stage).locksPlacement && !this.design.unlocked && this.design.stages[this.design.stage].status !== 'done';
    }

    /** Nodes that keep their place while placement is locked: all but lights, cameras, effects and the player. */
    isPinned(node: NodeDoc | undefined): boolean {
        return !!node && !node.light && !node.camera && !node.particles && !node.player;
    }

    /**
     * Why the nodes may not be moved or deleted now, or '' when they may:
     * the lock holds pinned nodes, also those under a light or camera,
     * which would go with it. The one check for every way of editing.
     */
    placementBlock(ids: string[]): string {
        if (!this.placementLocked) return '';
        const moved = ids.flatMap((id) => [this.store.node(id), ...this.store.descendants(id)]);
        if (!moved.some((n) => this.isPinned(n))) return '';
        return `Placement is locked in the ${stageDef(this.design.stage).title} stage: only lights, cameras and effects move, without objects under them. It can be unlocked in the pipeline bar.`;
    }

    /** True when the nodes may be moved or deleted; otherwise tells the user why not. */
    canPlace(ids: string[], quiet = false): boolean {
        const why = this.placementBlock(ids);
        if (why && !quiet) toast(why, 'info', 5000);
        return !why;
    }

    setUnlocked(v: boolean) {
        this.store.commit(v ? 'Unlock Placement' : 'Lock Placement', (d) => {
            if (v) d.design.unlocked = true;
            else delete d.design.unlocked;
        }, { design: true });
    }

    // ----------------------------------------------------------- key light

    /**
     * Points the key light (the first directional light; one is made when
     * there is none) the way the mood describes it, with its color, and
     * puts the atmospheric sky's sun in the same place. Returns its id.
     */
    applyKeyLight(): string {
        const k = this.design.mood.keyLight;
        const wrap = (v: number) => ((v % 360) + 360) % 360;
        // Directional lights shine along local +Z: from the key light's azimuth and elevation toward the scene.
        const rotation: Vec3 = [Math.round(k.elevation * 10) / 10, Math.round(wrap(k.azimuth + 180) * 10) / 10, 0];
        let id = '';
        this.store.commit('Apply Key Light', (d) => {
            let sun = d.nodes.find((n) => n.light?.type === 'directional' && n.visible) ?? d.nodes.find((n) => n.light?.type === 'directional');
            if (!sun) {
                sun = makeLightNode('directional');
                sun.name = 'Sun';
                d.nodes.push(sun);
            }
            sun.rotation = rotation;
            sun.light!.color = k.color;
            id = sun.id;
            // The sky's sun follows the same rule as a light driving it (AtmosphericComponent).
            d.environment.sunX = wrap(rotation[1] + 90) / 360;
            d.environment.sunY = Math.max(0, Math.min(1, rotation[0] / 180 + 0.5));
        });
        return id;
    }

    // ----------------------------------------------------------- checklist

    setCheck(stage: StageId, id: string, done: boolean, by: 'user' | 'ai' = 'user', note?: string) {
        this.store.commit(done ? 'Check Item' : 'Uncheck Item', (d) => {
            const st = d.design.stages[stage];
            const item = st.checks.find((c) => c.id === id);
            if (item) {
                item.done = done;
                item.by = by;
                if (note !== undefined) item.note = note || undefined;
            } else st.checks.push({ id, text: '', done, by, ...(note ? { note } : {}) });
        }, { design: true });
    }

    addCheck(stage: StageId, text: string, by: 'user' | 'ai' = 'user'): string {
        const id = uid('ck');
        this.store.commit('Add Checklist Item', (d) => {
            d.design.stages[stage].checks.push({ id, text: text.trim(), done: false, by });
        }, { design: true });
        return id;
    }

    removeCheck(stage: StageId, id: string) {
        this.store.commit('Remove Checklist Item', (d) => {
            const st = d.design.stages[stage];
            st.checks = st.checks.filter((c) => c.id !== id);
        }, { design: true });
    }

    /** The assistant asks to complete the current stage. */
    propose(summary: string) {
        const stage = this.design.stage;
        this.store.commit('Propose Stage Completion', (d) => {
            d.design.stages[stage].proposal = { summary: summary.trim(), at: now() };
        }, { design: true });
        this.emit('proposed', summary.trim());
    }

    dismissProposal() {
        const stage = this.design.stage;
        this.store.commit('Dismiss Proposal', (d) => {
            d.design.stages[stage].proposal = null;
        }, { design: true });
    }

    // ------------------------------------------------------------- stages

    /**
     * Completes the current stage: captures every shot into its history,
     * takes a scene snapshot and moves on. Asks first when checklist items
     * are open; refused while the shots cannot be captured.
     */
    async complete(force = false): Promise<boolean> {
        if (this.busy) return false;
        const design = this.design;
        const id = design.stage;
        const def = stageDef(id);
        if (design.stages[id].status === 'done') return false;
        const block = design.shots.length ? this.host.blocked() : '';
        if (block) {
            toast(block, 'info', 5000);
            return false;
        }
        const prog = this.progress(id);
        if (prog.open.length && !force) {
            const list = prog.open.map((i) => `- ${i.text}${i.detail ? ` (${i.detail})` : ''}`).join('\n');
            const ok = await confirmDialog(`Complete ${def.title}?`, `${prog.open.length} checklist item${prog.open.length === 1 ? ' is' : 's are'} still open:\n${list}\n\nComplete the stage anyway?`, 'Complete Anyway');
            if (!ok) return false;
        }
        this.host.player.stop();
        this.setBusy(true);
        try {
            const at = now();
            const captures: { shot: string; meta: AssetMeta; score?: number; compare?: CompareMode }[] = [];
            for (const shot of design.shots) {
                try {
                    const blob = await this.captureShot(shot.id);
                    const meta = await putDesignImage(blob, `${fileStem(shot.name)}-${id}.jpg`);
                    const scored = def.compare && shot.target ? await this.score(blob, shot.target, shot.aspect, def.compare) : null;
                    captures.push({ shot: shot.id, meta, ...(scored != null ? { score: scored, compare: def.compare } : {}) });
                } catch (e: any) {
                    console.warn('[pipeline] shot capture failed', shot.name, e);
                }
            }
            const { meta: snapMeta, snap } = await this.makeSnapshot(`${def.title} complete`, id);
            const next = nextStage(id);
            this.store.commit(`Complete Stage: ${def.title}`, (d) => {
                d.assets.push(snapMeta);
                for (const c of captures) addToHistory(d, c.shot, c.meta, { stage: id, at, ...(c.score != null ? { score: c.score, compare: c.compare } : {}) });
                d.design.snapshots.push(snap);
                const st = d.design.stages[id];
                st.status = 'done';
                st.doneAt = at;
                st.proposal = null;
                delete st.recheck;
                if (id === 'brief') {
                    d.design.brief.structured = d.design.brief.text;
                    d.design.brief.structuredAt ??= at;
                }
                if (next) {
                    d.design.stage = next;
                    d.design.stages[next].status = 'active';
                    delete d.design.unlocked;
                }
            }, { design: true });
            this.emit('completed', { stage: id, next });
            return true;
        } catch (e: any) {
            toast(`Completing the stage failed: ${e?.message || e}`, 'error');
            return false;
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * Goes back to an earlier stage. The stages after it need a recheck;
     * reopening the level (or the brief) marks the chosen paintovers as
     * needing an update.
     */
    async reopen(id: StageId, ask = true): Promise<boolean> {
        const design = this.design;
        const cur = stageIndex(design.stage);
        const target = stageIndex(id);
        const finished = design.stages[design.stage].status === 'done';
        if (target > cur || (target === cur && !finished)) return false;
        const later = STAGE_IDS.slice(target + 1, cur + 1).map((s) => stageDef(s).title);
        const stale = target <= stageIndex('level') ? design.shots.filter((s) => s.target).length : 0;
        if (ask) {
            const lines = [
                later.length ? `${later.join(', ')} will need a recheck.` : '',
                stale ? `The chosen paintovers of ${stale} shot${stale === 1 ? '' : 's'} will be marked as needing an update.` : '',
            ].filter(Boolean);
            if (!(await confirmDialog(`Reopen ${stageDef(id).title}?`, lines.join(' ') || 'The stage becomes the current one again.', 'Reopen'))) return false;
        }
        const title = stageDef(id).title;
        this.store.commit(`Reopen Stage: ${title}`, (d) => {
            const dd = d.design;
            STAGE_IDS.forEach((s, i) => {
                if (i <= target) return;
                const st = dd.stages[s];
                if (st.status === 'done' || st.status === 'recheck' || (st.status === 'active' && st.doneAt)) {
                    st.status = 'recheck';
                    st.recheck = `${title} was reopened`;
                    // Hand-ticked items have to be confirmed again.
                    for (const c of st.checks) c.done = false;
                } else if (st.status === 'active') st.status = 'todo';
                st.proposal = null;
            });
            dd.stage = id;
            dd.stages[id].status = 'active';
            dd.stages[id].proposal = null;
            delete dd.unlocked;
            if (target <= stageIndex('level')) for (const s of dd.shots) if (s.target) s.stale = true;
            // Matches judged in the reopened stage and after it are judged again,
            // and so is the final approval.
            for (const s of dd.shots) {
                delete s.approved;
                if (!s.matched) continue;
                s.matched = s.matched.filter((m) => stageIndex(m) < target);
                if (!s.matched.length) delete s.matched;
            }
        }, { design: true });
        return true;
    }

    private setBusy(v: boolean) {
        this.busy = v;
        this.emit('busy', v);
    }

    // ----------------------------------------------------------- snapshots

    private async makeSnapshot(name: string, stage: StageId | null): Promise<{ meta: AssetMeta; snap: SnapshotDoc }> {
        const scene = JSON.parse(JSON.stringify(this.store.doc)) as SceneDoc;
        delete (scene as Partial<SceneDoc>).design;
        scene.assets = scene.assets.filter((a) => a.purpose !== 'design');
        const file: SnapshotFile = { format: 'canonical-snapshot', version: 1, scene, camera: this.store.camera };
        const at = now();
        const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
        const meta = await putAsset(blob, `snapshot-${fileStem(name)}-${at.slice(0, 19).replace(/[:T]/g, '-')}.json`, 'data', undefined, { purpose: 'design' });
        const snap: SnapshotDoc = { id: uid('sn'), asset: meta.id, name, stage, at, assets: scene.assets.map((a) => a.id) };
        return { meta, snap };
    }

    async takeSnapshot(name = 'Snapshot'): Promise<SnapshotDoc> {
        const { meta, snap } = await this.makeSnapshot(name, this.design.stage);
        this.store.commit('Take Snapshot', (d) => {
            d.assets.push(meta);
            d.design.snapshots.push(snap);
        }, { design: true });
        return snap;
    }

    /** Puts the scene back the way it was in a snapshot (the design section stays). One undo step. */
    async restoreSnapshot(id: string, ask = true): Promise<boolean> {
        const snap = this.design.snapshots.find((s) => s.id === id);
        if (!snap) return false;
        const file = await this.readSnapshot(snap);
        if (!file) {
            toast('This snapshot is not stored in this browser.', 'error');
            return false;
        }
        if (ask && !(await confirmDialog('Restore snapshot?', `Put the scene back the way it was at "${snap.name}" (${snap.at.slice(0, 16).replace('T', ' ')})? The design section stays as it is; Undo brings the current scene back.`, 'Restore'))) {
            return false;
        }
        this.host.player.stop();
        const s = file.scene;
        // A snapshot can come with an opened file: script code the scene does
        // not have yet stays paused until the user reads and enables it, as
        // for the file itself (compiling runs it). Paused before the commit compiles.
        const known = new Set(this.store.doc.scripts.map((x) => x.code));
        if (this.host.compiler.trusted && s.scripts.some((x) => !known.has(x.code))) {
            this.host.compiler.setTrusted(false);
            toast('The snapshot brings back script code: its scripts are paused until you enable them.', 'info', 6000);
        }
        this.store.commit(`Restore Snapshot: ${snap.name}`, (d) => {
            d.environment = s.environment;
            d.scripts = s.scripts;
            d.shaders = s.shaders;
            d.renderGraph = s.renderGraph;
            d.nodes = s.nodes;
            d.prefabs = s.prefabs ?? [];
            // The objects' agents need the trees, schemas, memory and models of the same time.
            d.blackboards = s.blackboards;
            d.behaviors = s.behaviors;
            d.memory = s.memory;
            d.aiModels = s.aiModels;
            // The design section stays, so do the files it uses: planning images,
            // and the swatches of its material slots (plain textures).
            const swatches = new Set(d.design.materials.map((m) => m.swatch).filter(Boolean));
            const designAssets = d.assets.filter((a) => a.purpose === 'design' || swatches.has(a.id));
            const ids = new Set(designAssets.map((a) => a.id));
            d.assets = [...s.assets.filter((a) => !ids.has(a.id)), ...designAssets];
            // Linked surfaces follow the slots as they are now.
            syncSlots(d);
        });
        this.store.select([]);
        return true;
    }

    async readSnapshot(snap: SnapshotDoc): Promise<SnapshotFile | null> {
        const { getAssetBlob } = await import('../core/assets');
        const blob = await getAssetBlob(snap.asset);
        if (!blob) return null;
        try {
            const file = JSON.parse(await blob.text()) as SnapshotFile;
            if (file?.format !== 'canonical-snapshot' || !file.scene) return null;
            // Repair it like any scene from a file.
            const { sanitize } = await import('../core/store');
            return { ...file, scene: sanitize({ ...file.scene, design: undefined }) };
        } catch {
            return null;
        }
    }

    deleteSnapshot(id: string) {
        this.store.commit('Delete Snapshot', (d) => {
            const snap = d.design.snapshots.find((s) => s.id === id);
            d.design.snapshots = d.design.snapshots.filter((s) => s.id !== id);
            if (snap) d.assets = d.assets.filter((a) => a.id !== snap.asset);
        }, { design: true });
    }

    // --------------------------------------------------------------- shots

    shot(id: string | null | undefined): ShotDoc | undefined {
        return id ? this.design.shots.find((s) => s.id === id) : undefined;
    }

    /** Frame of a shot in the viewport, and the camera field of view that shows it. */
    frameFor(aspect: number, margin = FRAME_MARGIN) {
        const [w, h] = this.host.runtime.cssSize;
        const rect = frameRect(aspect, w, h, margin);
        return { rect, viewH: h };
    }

    /** Camera state that shows the shot through its frame in the current viewport. */
    shotCamera(shot: ShotDoc, margin = FRAME_MARGIN): CameraState {
        const { rect, viewH } = this.frameFor(shot.aspect, margin);
        return { ...shot.camera, target: [...shot.camera.target] as ShotDoc['camera']['target'], fov: cameraFov(shot.camera.fov, rect.h, viewH) };
    }

    /** The current view as a shot camera, for a frame of `aspect` shown with the frame margin. */
    viewAsShot(aspect: number): CameraState {
        const cam = this.store.camera;
        const { rect, viewH } = this.frameFor(aspect, this.activeShot ? FRAME_MARGIN : 1);
        return { ...cam, target: [...cam.target] as CameraState['target'], fov: frameFov(cam.fov, rect.h, viewH) };
    }

    /** Creates a shot from the current view; with a concept image its frame takes the image's aspect. */
    createShot(opts: { name?: string; concept?: string | null; area?: string | null; aspect?: number } = {}): ShotDoc {
        const conceptMeta = opts.concept ? this.store.doc.assets.find((a) => a.id === opts.concept) : undefined;
        const aspect = opts.aspect ?? (conceptMeta?.width && conceptMeta.height ? conceptMeta.width / conceptMeta.height : 16 / 9);
        const concept = opts.concept ? this.design.concepts.find((c) => c.asset === opts.concept) : undefined;
        const shot: ShotDoc = {
            id: uid('sh'),
            name: opts.name?.trim() || `Shot ${this.design.shots.length + 1}`,
            area: opts.area ?? concept?.area ?? null,
            concept: opts.concept ?? null,
            camera: this.viewAsShot(aspect),
            aspect,
            paintovers: [],
            target: null,
            history: [],
        };
        this.store.commit('Create Shot', (d) => {
            d.design.shots.push(shot);
        }, { design: true });
        return shot;
    }

    updateShot(id: string, patch: ShotPatch, label = 'Edit Shot') {
        this.store.commit(label, (d) => {
            const s = d.design.shots.find((x) => x.id === id);
            if (s) patchShot(s, patch);
        }, { design: true });
    }

    /** Makes a paintover the shot's target, the image every later comparison uses (null clears it). */
    choosePaintover(shotId: string, asset: string | null) {
        this.updateShot(shotId, { target: asset }, asset ? 'Choose Paintover' : 'Clear Paintover Target');
    }

    deletePaintover(shotId: string, asset: string) {
        this.store.commit('Delete Paintover', (d) => {
            const s = d.design.shots.find((x) => x.id === shotId);
            if (!s) return;
            s.paintovers = s.paintovers.filter((p) => p.asset !== asset);
            if (s.target === asset) patchShot(s, { target: null });
            // The file goes too unless something else uses it.
            if (!designAssetIds(d.design).has(asset)) d.assets = d.assets.filter((a) => a.id !== asset);
        }, { design: true });
    }

    /** Stores the current view as the shot's camera (while the shot is shown). */
    updateShotFromView(id: string) {
        const shot = this.shot(id);
        if (shot) this.updateShot(id, { camera: this.viewAsShot(shot.aspect) }, 'Update Shot');
    }

    deleteShot(id: string) {
        if (this.activeShot === id) this.showShot(null);
        this.store.commit('Delete Shot', (d) => {
            d.design.shots = d.design.shots.filter((s) => s.id !== id);
        }, { design: true });
    }

    /** Shows a shot: the camera moves to it and the viewport draws its frame. */
    showShot(id: string | null, animate = true) {
        const shot = this.shot(id);
        // A shot widens the lens to fit its frame; hiding it goes back to the
        // view's own lens (else every new shot from the view came out wider).
        if (shot && !this.activeShot) this.viewFov = this.store.camera.fov;
        this.activeShot = shot ? shot.id : null;
        if (shot) {
            const cam = this.shotCamera(shot);
            if (animate) this.host.camera.animateTo(cam, 320);
            else this.host.camera.jump(cam);
        } else if (this.viewFov !== null) {
            this.host.camera.jump({ ...this.store.camera, fov: this.viewFov });
            this.viewFov = null;
        }
        this.emit('shot', this.activeShot);
    }

    /** Shows a shot with its comparison card open. */
    openCompare(id: string) {
        if (this.activeShot !== id) this.showShot(id);
        this.emit('compare', id);
    }

    /**
     * Renders a shot: the camera jumps to it for a couple of frames, the
     * frame is cut out of the canvas, and the view goes back.
     */
    async captureShot(id: string, maxWidth = 1600): Promise<Blob> {
        const shot = this.shot(id);
        if (!shot) throw new Error('No such shot.');
        return this.captureCamera(shot.camera, shot.aspect, maxWidth);
    }

    /**
     * Renders a view: `camera` holds the frame's field of view, `aspect` the
     * frame's shape. The editor view comes back afterwards.
     */
    async captureCamera(camera: CameraState, aspect: number, maxWidth = 1600): Promise<Blob> {
        const block = this.host.blocked();
        if (block) throw new Error(block);
        const runtime = this.host.runtime;
        const prev = { ...this.store.camera, target: [...this.store.camera.target] as CameraState['target'] };
        const { rect, viewH } = this.frameFor(aspect, 1);
        runtime.setGridVisible(false);
        runtime.gi.setHelpersVisible(false);
        try {
            this.host.camera.jump({ ...camera, target: [...camera.target] as CameraState['target'], fov: cameraFov(camera.fov, rect.h, viewH) });
            return await runtime.captureFrame({ crop: rect, maxWidth, frames: 3, type: 'image/jpeg', quality: 0.9 });
        } finally {
            this.host.camera.jump(prev);
            runtime.setGridVisible(this.store.prefs.grid && !this.store.playing);
            runtime.gi.setHelpersVisible(this.store.prefs.giProbes && !this.store.playing);
        }
    }

    /** Captures a shot now and adds it to the shot's history (marked as a manual capture). */
    async captureShotAsset(id: string, label = 'capture', score?: number | null): Promise<AssetMeta> {
        const blob = await this.captureShot(id);
        return this.addCapture(id, blob, label, score != null ? { score } : {});
    }

    /** Adds a capture to the shot's history (as a manual capture of the current stage). */
    async addCapture(id: string, blob: Blob, label: string, extra: { score?: number; compare?: CompareMode } = {}): Promise<AssetMeta> {
        const shot = this.shot(id);
        const meta = await putDesignImage(blob, `${fileStem(shot?.name ?? 'shot')}-${label}.jpg`);
        const stage = this.design.stage;
        this.store.commit('Capture Shot', (d) => addToHistory(d, id, meta, { stage, at: now(), manual: true, ...extra }), { design: true });
        return meta;
    }

    // ---------------------------------------------------------- comparison

    /** The comparison mode of the current stage (gray until the Materials stage). */
    get compareMode(): CompareMode {
        return stageDef(this.design.stage).compare ?? 'gray';
    }

    private async score(capture: Blob, target: string, aspect: number, mode: CompareMode): Promise<number | null> {
        const blob = await getAssetBlob(target);
        if (!blob) return null;
        return (await compareImages(capture, blob, aspect, mode)).score;
    }

    /**
     * Compares a shot with its target paintover (its concept while it has
     * no target): a fresh capture scored on a small grid, no model call.
     * Nothing is stored.
     */
    async compareShot(id: string, mode: CompareMode = this.compareMode): Promise<{ blob: Blob; result: CompareResult; against: 'target' | 'concept'; ref: string }> {
        const shot = this.shot(id);
        if (!shot) throw new Error('No such shot.');
        const ref = shot.target ?? shot.concept;
        if (!ref) throw new Error(`${shot.name} has no target paintover or concept image to compare with.`);
        const refBlob = await getAssetBlob(ref);
        if (!refBlob) throw new Error('The target image is not stored in this browser.');
        const blob = await this.captureShot(id);
        const result = await compareImages(blob, refBlob, shot.aspect, mode);
        return { blob, result, against: shot.target ? 'target' : 'concept', ref };
    }

    /**
     * Marks a shot as matching its target in the current stage, keeping the
     * compared capture in its history, or clears the mark. The user judges.
     */
    async markMatched(id: string, on: boolean, evidence?: { blob: Blob; score: number; mode: CompareMode }) {
        const stage = this.design.stage;
        const shot = this.shot(id);
        if (!shot) return;
        const meta = on && evidence ? await putDesignImage(evidence.blob, `${fileStem(shot.name)}-${stage}-match.jpg`) : null;
        this.store.commit(on ? 'Mark Shot as Matching' : 'Unmark Shot', (d) => {
            const s = d.design.shots.find((x) => x.id === id);
            if (!s) return;
            const set = new Set(s.matched ?? []);
            if (on) set.add(stage);
            else set.delete(stage);
            if (set.size) s.matched = [...set];
            else delete s.matched;
            if (meta && evidence) addToHistory(d, id, meta, { stage, at: now(), manual: true, score: evidence.score, compare: evidence.mode });
        }, { design: true });
    }
}

export type ShotPatch = Partial<Pick<ShotDoc, 'name' | 'area' | 'concept' | 'camera' | 'aspect' | 'target' | 'approved' | 'stale'>>;

/**
 * Changes a shot inside a commit. Its matches and approval were judged
 * against its target as it is framed: a new target or framing drops them,
 * and a new framing marks the target as needing an update (it was painted
 * over the old one).
 */
export function patchShot(s: ShotDoc, patch: ShotPatch) {
    const reframed = (!!patch.camera && !sameView(patch.camera, s.camera)) || (patch.aspect !== undefined && patch.aspect !== s.aspect);
    if (reframed || (patch.target !== undefined && patch.target !== s.target)) {
        delete s.matched;
        delete s.approved;
    }
    Object.assign(s, patch);
    if (reframed && s.target) s.stale = true;
    if (patch.target !== undefined) delete s.stale;
    if (s.stale === false) delete s.stale;
    if (s.approved === false) delete s.approved;
}

/** The same view but for rounding (a view goes through the frame's field of view and back). */
function sameView(a: CameraState, b: CameraState): boolean {
    const x = [...a.target, a.yaw, a.pitch, a.distance, a.fov];
    const y = [...b.target, b.yaw, b.pitch, b.distance, b.fov];
    return x.every((v, i) => Math.abs(v - y[i]) < 1e-4);
}

/** Manual captures (by hand or by the assistant) a shot keeps; the captures of stage completions all stay. */
const KEEP_CAPTURES = 12;

/**
 * Adds a capture and its file to a shot's history (inside a commit). Past
 * KEEP_CAPTURES manual captures the oldest go, and so do their files unless
 * something else uses them.
 */
function addToHistory(d: SceneDoc, shotId: string, meta: AssetMeta, capture: Omit<ShotCaptureDoc, 'asset'>) {
    const shot = d.design.shots.find((s) => s.id === shotId);
    if (!shot) return;
    d.assets.push(meta);
    shot.history.push({ ...capture, asset: meta.id });
    const old = new Set(shot.history.filter((c) => c.manual).slice(0, -KEEP_CAPTURES));
    if (!old.size) return;
    shot.history = shot.history.filter((c) => !old.has(c));
    const used = designAssetIds(d.design);
    const gone = new Set([...old].map((c) => c.asset));
    d.assets = d.assets.filter((a) => !gone.has(a.id) || used.has(a.id));
}

function fileStem(name: string): string {
    return name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shot';
}

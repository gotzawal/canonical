// The pipeline: stage gates, checklists, stage completion (shot captures and
// a scene snapshot), reopening earlier stages, shots and snapshots. All
// changes go through the store, so they autosave, undo and save with the
// scene like any other edit.

import { putAsset, putDesignImage } from '../core/assets';
import { stageIndex, STAGE_IDS } from '../core/design';
import { Emitter } from '../core/events';
import { uid } from '../core/ids';
import type {
    AssetMeta, CameraState, DesignDoc, NodeDoc, SceneDoc, ShotDoc, SnapshotDoc, StageId,
} from '../core/types';
import type { Editor } from '../editor';
import { confirmDialog, toast } from '../ui/overlays';
import { notices } from '../ui/notify';
import { cameraFov, FRAME_MARGIN, frameFov, frameRect } from './shotCamera';
import { nextStage, stageDef, stageProgress, type CheckState } from './stages';

interface PipelineEvents {
    /** A long operation (captures) started or ended. */
    busy: boolean;
    /** The shot shown in the viewport changed. */
    shot: string | null;
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

    constructor(private editor: Editor) {
        super();
        editor.store.on('load', () => this.showShot(null));
        editor.store.on('change', () => {
            if (this.activeShot && !this.shot(this.activeShot)) this.showShot(null);
        });
    }

    private get store() {
        return this.editor.store;
    }

    get design(): DesignDoc {
        return this.store.doc.design;
    }

    progress(stage: StageId = this.design.stage): { done: number; total: number; open: CheckState[]; items: CheckState[] } {
        return stageProgress({ doc: this.store.doc, design: this.design, fps: this.editor.runtime.fps }, stage);
    }

    // --------------------------------------------------------------- locks

    /** Placement is locked in the current stage (and not unlocked by the user). */
    get placementLocked(): boolean {
        return stageDef(this.design.stage).locksPlacement && !this.design.unlocked && this.design.stages[this.design.stage].status !== 'done';
    }

    /** Nodes that keep their place while placement is locked: all but lights, cameras and effects. */
    isPinned(node: NodeDoc | undefined): boolean {
        return !!node && !node.light && !node.camera;
    }

    /**
     * True when the nodes may be moved, created or deleted; otherwise tells
     * the user why not.
     */
    canPlace(ids: string[], quiet = false): boolean {
        if (!this.placementLocked) return true;
        const pinned = ids.map((id) => this.store.node(id)).filter((n) => this.isPinned(n));
        if (!pinned.length) return true;
        if (!quiet) toast(`Placement is locked in the ${stageDef(this.design.stage).title} stage. Unlock it in the pipeline bar to move objects.`, 'info', 4500);
        return false;
    }

    setUnlocked(v: boolean) {
        this.store.commit(v ? 'Unlock Placement' : 'Lock Placement', (d) => {
            if (v) d.design.unlocked = true;
            else delete d.design.unlocked;
        }, { design: true });
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
        notices.show({
            kind: 'stage',
            key: 'stage-proposal',
            icon: 'flag',
            title: `The assistant proposes completing ${stageDef(stage).title}`,
            body: summary.trim().slice(0, 240),
            actions: [{ label: 'Review', primary: true, run: () => this.editor.emit('show-design', undefined) }],
        });
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
     * are open.
     */
    async complete(force = false): Promise<boolean> {
        if (this.busy) return false;
        const design = this.design;
        const id = design.stage;
        const def = stageDef(id);
        if (design.stages[id].status === 'done') return false;
        const prog = this.progress(id);
        if (prog.open.length && !force) {
            const list = prog.open.map((i) => `- ${i.text}${i.detail ? ` (${i.detail})` : ''}`).join('\n');
            const ok = await confirmDialog(`Complete ${def.title}?`, `${prog.open.length} checklist item${prog.open.length === 1 ? ' is' : 's are'} still open:\n${list}\n\nComplete the stage anyway?`, 'Complete Anyway');
            if (!ok) return false;
        }
        if (this.editor.player.state !== 'stopped') this.editor.stopPlay();
        this.setBusy(true);
        try {
            const at = now();
            const captures: { shot: string; meta: AssetMeta }[] = [];
            for (const shot of design.shots) {
                try {
                    const blob = await this.captureShot(shot.id);
                    const meta = await putDesignImage(blob, `${fileStem(shot.name)}-${id}.jpg`);
                    captures.push({ shot: shot.id, meta });
                } catch (e: any) {
                    console.warn('[pipeline] shot capture failed', shot.name, e);
                }
            }
            const { meta: snapMeta, snap } = await this.makeSnapshot(`${def.title} complete`, id);
            const next = nextStage(id);
            this.store.commit(`Complete Stage: ${def.title}`, (d) => {
                d.assets.push(...captures.map((c) => c.meta), snapMeta);
                for (const c of captures) d.design.shots.find((s) => s.id === c.shot)?.history.push({ stage: id, asset: c.meta.id, at });
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
            notices.show({ kind: 'stage', key: 'stage-proposal', icon: 'check', title: `${def.title} complete`, body: next ? `Next: ${stageDef(next).long}.` : 'Every stage is complete.', timeout: 6000 });
            this.editor.checkpoints?.stageCompleted(def.title, next ? stageDef(next).title : null);
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
        if (this.editor.player.state !== 'stopped') this.editor.stopPlay();
        const s = file.scene;
        this.store.commit(`Restore Snapshot: ${snap.name}`, (d) => {
            d.environment = s.environment;
            d.scripts = s.scripts;
            d.shaders = s.shaders;
            d.renderGraph = s.renderGraph;
            d.nodes = s.nodes;
            d.prefabs = s.prefabs ?? [];
            const designAssets = d.assets.filter((a) => a.purpose === 'design');
            const ids = new Set(designAssets.map((a) => a.id));
            d.assets = [...s.assets.filter((a) => !ids.has(a.id)), ...designAssets];
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
        const [w, h] = this.editor.runtime.cssSize;
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

    updateShot(id: string, patch: Partial<Pick<ShotDoc, 'name' | 'area' | 'concept' | 'aspect' | 'target' | 'approved' | 'stale'>>, label = 'Edit Shot') {
        this.store.commit(label, (d) => {
            const s = d.design.shots.find((x) => x.id === id);
            if (!s) return;
            Object.assign(s, patch);
            if (patch.target !== undefined) delete s.stale;
            if (s.stale === false) delete s.stale;
            if (s.approved === false) delete s.approved;
        }, { design: true });
    }

    /** Stores the current view as the shot's camera (while the shot is shown). */
    updateShotFromView(id: string) {
        const shot = this.shot(id);
        if (!shot) return;
        const camera = this.viewAsShot(shot.aspect);
        this.store.commit('Update Shot', (d) => {
            const s = d.design.shots.find((x) => x.id === id);
            if (s) s.camera = camera;
        }, { design: true });
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
        this.activeShot = shot ? shot.id : null;
        if (shot) {
            const cam = this.shotCamera(shot);
            if (animate) this.editor.camera.animateTo(cam, 320);
            else this.editor.camera.jump(cam);
        }
        this.emit('shot', this.activeShot);
    }

    /**
     * Renders a shot: the camera jumps to it for a couple of frames, the
     * frame is cut out of the canvas, and the view goes back.
     */
    async captureShot(id: string, maxWidth = 1600): Promise<Blob> {
        const shot = this.shot(id);
        if (!shot) throw new Error('No such shot.');
        const runtime = this.editor.runtime;
        const prev = { ...this.store.camera, target: [...this.store.camera.target] as CameraState['target'] };
        const { rect } = this.frameFor(shot.aspect, 1);
        runtime.setGridVisible(false);
        runtime.gi.setHelpersVisible(false);
        try {
            this.editor.camera.jump(this.shotCamera(shot, 1));
            return await runtime.captureFrame({ crop: rect, maxWidth, frames: 3, type: 'image/jpeg', quality: 0.9 });
        } finally {
            this.editor.camera.jump(prev);
            runtime.setGridVisible(this.store.prefs.grid && !this.store.playing);
            runtime.gi.setHelpersVisible(this.store.prefs.giProbes && !this.store.playing);
        }
    }

    /** Captures a shot now and adds it to the shot's history (marked as a manual capture). */
    async captureShotAsset(id: string, label = 'capture', score?: number | null): Promise<AssetMeta> {
        const shot = this.shot(id);
        const blob = await this.captureShot(id);
        const meta = await putDesignImage(blob, `${fileStem(shot?.name ?? 'shot')}-${label}.jpg`);
        const stage = this.design.stage;
        this.store.commit('Capture Shot', (d) => {
            d.assets.push(meta);
            d.design.shots.find((s) => s.id === id)?.history.push({ stage, asset: meta.id, at: now(), manual: true, ...(score != null ? { score } : {}) });
        }, { design: true });
        return meta;
    }
}

function fileStem(name: string): string {
    return name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shot';
}

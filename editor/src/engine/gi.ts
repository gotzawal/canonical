import {
    ColorPass, EntityCollect, GIPass, GIProbeMaterial, GIProbeMaterialType, GlobalBindGroup, LightBase, MeshRenderer,
    Object3D, Probe, RenderNode, SphereGeometry, Vector3,
} from '@orillusion/core';
import { clampGIGrid, GI_ATLAS_SIZE, GI_OCT_SIZE, GI_PROBE_SIZE, GI_SOURCE_SIZE } from '../core/giLimits';
import type { GIDoc, Vec3 } from '../core/types';
import type { Runtime } from './runtime';

/**
 * Engine GI settings every runtime starts with. GI itself stays off; the
 * probe counts are the largest grid the editor allows because the engine
 * sizes its probe buffer once, from these counts, when the scene's light
 * data is created.
 */
export function giEngineSetting() {
    return {
        enable: false,
        probeXCount: 16,
        probeYCount: 2,
        probeZCount: 16,
        probeSize: GI_PROBE_SIZE,
        probeSourceTextureSize: GI_SOURCE_SIZE,
        octRTSideSize: GI_OCT_SIZE,
        octRTMaxSize: GI_ATLAS_SIZE,
        autoRenderProbe: false,
        realTimeGI: false,
        debug: false,
    };
}

/**
 * Lets the renderers of an object tree (a loaded model) show up in the GI
 * probe captures. Renderers the editor creates itself set castGI directly.
 */
export function castGI(root: Object3D) {
    root.traverse((o: Object3D) => {
        o.components.forEach((c) => {
            if (c instanceof RenderNode && !c.castGI) {
                c.castGI = true;
                // Creates the GI pass for materials that are already set.
                if (c.materials?.length) c.refreshRenderClassification();
            }
        });
    });
}

/**
 * Dynamic diffuse global illumination (DDGI) for one runtime.
 *
 * GIPass joins the render graph the first time GI is switched on, so scenes
 * without GI pay nothing for it, and then stays: switching GI off stops the
 * pass and recompiles the materials, which go back to the sky's ambient
 * light. The probes are captured over several frames after every change
 * (or continuously in realtime mode).
 */
export class GIController {
    private installed = false;
    private probes: Probe[] = [];
    private grid = '';
    private on = false;
    private realtime = false;
    /** Frames left in the current capture after a change. */
    private captureFrames = 0;
    private helpers: Object3D | null = null;
    private helperGrid = '';
    private helpersWanted = false;
    /** Set when switching GI on failed, so it is not retried every frame. */
    error = '';

    constructor(private runtime: Runtime) {
        runtime.onFrame(() => this.tick());
    }

    get enabled(): boolean {
        return this.on;
    }

    private get setting() {
        return this.runtime.engine.setting.gi;
    }

    /** Applies the document's GI settings. */
    apply(gi: GIDoc) {
        if (!gi.enable) {
            if (this.on) this.disable();
            this.error = '';
            return;
        }
        if (!this.install()) return;
        const s = this.setting;
        const counts = clampGIGrid(gi.counts);
        const spacing = Math.max(0.1, gi.spacing);
        s.offsetX = gi.center[0];
        s.offsetY = gi.center[1];
        s.offsetZ = gi.center[2];
        s.probeSpace = spacing;
        s.maxDistance = spacing * 1.73;
        s.normalBias = spacing * 0.05;
        s.indirectIntensity = Math.max(0, gi.intensity);
        // The engine scales its bounce value by 10 and treats 0.025 as the
        // default, so the document's 0..1 maps onto 0..0.1.
        s.bounceIntensity = Math.min(1, Math.max(0, gi.bounce)) * 0.1;
        s.probeXCount = counts[0];
        s.probeYCount = counts[1];
        s.probeZCount = counts[2];
        this.realtime = gi.realtime;

        const grid = counts.join('x');
        const rebuilt = grid !== this.grid;
        if (rebuilt) this.buildProbes(counts);
        else this.placeProbes(counts);
        this.volume()?.setVolumeDataChange();

        if (!this.on) {
            this.on = true;
            s.enable = true;
            // Renderers are created casting GI (see SceneSync); lights flag
            // their changes to the GI lighting pass.
            for (const light of this.lights()) light.castGI = true;
            this.refreshMaterials();
        }
        this.capture(rebuilt);
        this.updateHelpers();
    }

    /** The scene changed: capture the probes again (continuous in realtime mode anyway). */
    invalidate() {
        if (this.on) this.capture(false);
    }

    /** Shows a small sphere per probe with the light it captured (editor only). */
    setHelpersVisible(visible: boolean) {
        this.helpersWanted = visible;
        this.updateHelpers();
    }

    /** World box spanned by the probes, and the spacing between them. */
    bounds(): { min: Vec3; max: Vec3; spacing: number } | null {
        if (!this.on) return null;
        const s = this.setting;
        const half = [s.probeXCount, s.probeYCount, s.probeZCount].map((n) => ((n - 1) * s.probeSpace) / 2);
        const c = [s.offsetX, s.offsetY, s.offsetZ];
        return {
            min: [c[0] - half[0], c[1] - half[1], c[2] - half[2]],
            max: [c[0] + half[0], c[1] + half[1], c[2] + half[2]],
            spacing: s.probeSpace,
        };
    }

    // -------------------------------------------------------------- internal

    /** Adds GIPass and a ColorPass that reads its output; rolls back on failure. */
    private install(): boolean {
        if (this.installed) return true;
        if (this.error) return false;
        const graph = this.runtime.view.renderGraph;
        if (!graph) return false;
        let added = false;
        let replaced = false;
        try {
            graph.add(GIPass);
            added = true;
            graph.replace('ColorPass', ColorPass, { giEnabled: true });
            replaced = true;
            graph.compile();
        } catch (e: any) {
            this.error = `Global illumination could not start: ${e?.message || e}`;
            console.error('[editor] ' + this.error);
            try {
                if (replaced) graph.replace('ColorPass', ColorPass, { giEnabled: false });
                if (added) graph.remove('GIPass');
                graph.compile();
            } catch (e2) {
                console.error('[editor] render graph could not be restored', e2);
            }
            this.runtime.notifyGraphChanged();
            return false;
        }
        this.installed = true;
        this.runtime.notifyGraphChanged();
        return true;
    }

    private disable() {
        const s = this.setting;
        this.on = false;
        s.enable = false;
        s.autoRenderProbe = false;
        s.realTimeGI = false;
        this.captureFrames = 0;
        this.clearProbes();
        this.refreshMaterials();
        this.updateHelpers();
    }

    private giPass(): GIPass | null {
        return (this.runtime.view.renderGraph?.getPass('GIPass') as GIPass | null) ?? null;
    }

    private volume() {
        return GlobalBindGroup.getLightEntries(this.runtime.scene)?.irradianceVolume ?? null;
    }

    private buildProbes(counts: Vec3) {
        this.clearProbes();
        const [nx, ny, nz] = counts;
        for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
                for (let x = 0; x < nx; x++) {
                    const probe = new Probe();
                    probe.index = x + z * nx + y * nx * nz;
                    probe.name = `GIProbe ${x}_${y}_${z}`;
                    this.probes[probe.index] = probe;
                }
            }
        }
        this.placeProbes(counts);
        for (const probe of this.probes) EntityCollect.instance.addGIProbe(this.runtime.scene, probe);
        // Forget the capture history of the previous grid.
        this.volume()?.probesBufferData?.fill(-1);
        this.grid = counts.join('x');
    }

    private placeProbes(counts: Vec3) {
        const volume = this.volume();
        if (!volume) return;
        const p = new Vector3();
        const [nx, ny, nz] = counts;
        for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
                for (let x = 0; x < nx; x++) {
                    const probe = this.probes[x + z * nx + y * nx * nz];
                    if (!probe) continue;
                    volume.calcPosition(x, y, z, p);
                    probe.x = p.x;
                    probe.y = p.y;
                    probe.z = p.z;
                }
            }
        }
    }

    private clearProbes() {
        const scene = this.runtime.scene;
        for (const probe of this.probes) {
            EntityCollect.instance.removeGIProbe(scene, probe);
            try {
                probe.destroy();
            } catch { /* already gone */ }
        }
        this.probes = [];
        this.grid = '';
    }

    /**
     * Probes are captured one per frame and the irradiance converges over
     * several passes, so a change keeps the capture running for a while.
     * A new grid restarts from the first probe (the pass would otherwise
     * continue at an index the new list may not have).
     */
    private capture(restart: boolean) {
        const s = this.setting;
        this.captureFrames = Math.max(this.captureFrames, 240, this.probes.length * 3);
        s.autoRenderProbe = true;
        s.realTimeGI = true;
        if (restart) this.giPass()?.startRenderGI(0);
    }

    private tick() {
        if (!this.on || this.captureFrames <= 0) return;
        if (this.realtime) return;
        if (--this.captureFrames > 0) return;
        // Stop after the probe cycle in flight completes.
        this.setting.autoRenderProbe = false;
        this.setting.realTimeGI = false;
    }

    private lights(): LightBase[] {
        const out: LightBase[] = [];
        this.runtime.scene.traverse((o: Object3D) => {
            o.components.forEach((c) => {
                if (c instanceof LightBase) out.push(c);
            });
        });
        return out;
    }

    /**
     * Whether a material samples the probes is compiled into its shader
     * (the USEGI define), so switching GI recompiles every material in use.
     */
    private refreshMaterials() {
        const seen = new Set<unknown>();
        this.runtime.scene.traverse((o: Object3D) => {
            o.components.forEach((c) => {
                if (!(c instanceof RenderNode)) return;
                for (const m of c.materials ?? []) {
                    if (!m?.shader || seen.has(m)) continue;
                    seen.add(m);
                    for (const list of m.shader.passShader.values()) {
                        for (const pass of list) {
                            pass.noticeShaderChange();
                            pass.noticeValueChange();
                        }
                    }
                }
            });
        });
    }

    private updateHelpers() {
        const want = this.on && this.helpersWanted;
        if (!want || this.helperGrid !== this.grid) {
            if (this.helpers) {
                this.helpers.removeFromParent();
                this.helpers.destroy();
                this.helpers = null;
            }
            this.helperGrid = '';
        }
        if (!want) return;
        const radius = Math.max(0.03, this.setting.probeSpace * 0.08);
        if (!this.helpers) {
            const root = new Object3D();
            root.name = 'GIProbeHelpers';
            const geometry = new SphereGeometry(1, 12, 8);
            const ctx = this.runtime.engine.context3D;
            for (const probe of this.probes) {
                const o = new Object3D();
                const mr = o.addComponent(MeshRenderer);
                mr.geometry = geometry;
                mr.material = new GIProbeMaterial(GIProbeMaterialType.CastGI, probe.index, ctx);
                mr.castShadow = false;
                mr.castGI = false;
                root.addChild(o);
            }
            this.runtime.scene.addChild(root);
            this.helpers = root;
            this.helperGrid = this.grid;
        }
        const children = this.helpers.entityChildren as Object3D[];
        this.probes.forEach((probe, i) => {
            const o = children[i];
            if (!o) return;
            o.x = probe.x;
            o.y = probe.y;
            o.z = probe.z;
            o.scaleX = o.scaleY = o.scaleZ = radius;
        });
    }

    /** True for the probe helper spheres (the player skips them when picking). */
    isHelper(o: Object3D): boolean {
        return !!this.helpers && (o === this.helpers || o.transform.parent?.object3D === this.helpers);
    }
}

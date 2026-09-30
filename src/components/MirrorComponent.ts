import { Camera3D } from '../core/Camera3D';
import { Object3D } from '../core/entities/Object3D';
import { View3D } from '../core/View3D';
import { Engine3D } from '../Engine3D';
import { Material } from '../materials/Material';
import { MirrorMaterial } from '../materials/MirrorMaterial';
import { Texture } from '../gfx/graphics/webGpu/core/texture/Texture';
import { MeshRenderer } from './renderer/MeshRenderer';
import { SceneCaptureCameraComponent } from './SceneCaptureCameraComponent';
import { Vector3 } from '../math/Vector3';
import { ComponentBase } from './ComponentBase';
import { RegisterComponent } from '../util/SerializeDecoration';
import { RendererMaskUtil } from '../gfx/renderJob/passRenderer/state/RendererMask';

/**
 * One-stop planar mirror component. Attach to an Object3D that already
 * carries a {@link MeshRenderer} whose material samples a `mirrorMap`
 * texture in screen space — a {@link MirrorMaterial} (a plain tinted
 * mirror), or any material of your own that declares `mirrorMap` (water
 * that distorts the reflection by its waves and blends it by a fresnel
 * term) — and the component sets up the rest:
 *
 *   1. Spawns an off-screen {@link Camera3D} at the plane-mirror of
 *      the main camera (refreshed every frame from
 *      {@link MirrorComponent.onUpdate}).
 *   2. Attaches a {@link SceneCaptureCameraComponent} so that camera
 *      renders the scene into a render target every frame, with its near
 *      plane moved onto the mirror plane so what lies behind the mirror
 *      (the floor under a pond, the room behind a wall mirror) stays out
 *      of the reflection.
 *   3. Tags the host renderer with {@link MirrorComponent.MIRROR_MASK}
 *      and configures the capture's `excludeMask` so the mirror surface
 *      does not capture itself (avoids feedback / "mirror in mirror"
 *      recursion artefacts).
 *   4. Binds the capture RT into the host material's `mirrorMap` as soon
 *      as the capture pass has produced a texture, and again whenever the
 *      host renderer gets another material.
 *
 * Usage
 * -----
 *
 * ```ts
 * const floor = new Object3D();
 * const mr = floor.addComponent(MeshRenderer);
 * mr.geometry = new PlaneGeometry(40, 40);
 * mr.material = new MirrorMaterial();
 * floor.addComponent(MirrorComponent);
 * scene.addChild(floor);
 * ```
 *
 * By default the component follows the view: it reflects whatever camera
 * {@link View3D.camera} is at the time (a game that switches cameras keeps
 * its reflection), along that camera's view direction, and takes the
 * mirror plane (point + normal) from the host's world transform every
 * frame, so a moving or tilted host keeps a correct reflection.
 *
 * Limits
 * ------
 *
 * - The capture renders the scene a second time, every frame the camera
 *   is in front of the mirror. {@link resolutionScale} (a share of the
 *   canvas) keeps its cost in line with the screen.
 * - Multiple mirrors in the same scene all share
 *   {@link MIRROR_MASK} — that means no mirror captures any other
 *   mirror surface (good — prevents feedback) but it also means a
 *   mirror can not appear in another mirror's reflection. If you
 *   need cross-mirror reflections, give each mirror a unique bit on
 *   {@link MeshRenderer.rendererMask} + a matching `excludeMask` set
 *   on its {@link captureComponent} manually.
 *
 * @group Components
 */
@RegisterComponent(MirrorComponent, 'MirrorComponent')
export class MirrorComponent extends ComponentBase {
    /**
     * Custom {@link RendererMask} bit reserved for "this is a mirror
     * surface and should not appear in other mirrors". Bit 11 is
     * unclaimed by the engine's built-in mask values (highest is
     * {@link RendererMask.Graphic3D} = `1 << 10`). Exposed so user
     * code can check / clear it on hand-managed renderers.
     */
    public static readonly MIRROR_MASK = 1 << 11;

    /** Capture render-target width in pixels, when {@link resolutionScale}
     *  is 0. Forwarded to {@link SceneCaptureCameraComponent.width}. */
    public width: number = 1024;

    /** Capture render-target height in pixels, when {@link resolutionScale} is 0. */
    public height: number = 1024;

    /** When above 0, the capture follows the canvas size: this share of
     *  its pixels on each side (0.5: half the width and half the height).
     *  The reflection is sampled in screen space, so a capture of the
     *  canvas's shape keeps its pixels square. */
    public resolutionScale: number = 0;

    /** A world-space point lying on the mirror plane. Taken from the host
     *  every frame while {@link followHost} is on. */
    public mirrorPlanePoint: Vector3 = new Vector3();

    /** Unit normal of the mirror plane in world space, facing the side
     *  that is reflected: the host's world +Y axis (transform.up) while
     *  {@link followHost} is on — a PlaneGeometry's face. */
    public mirrorPlaneNormal: Vector3 = new Vector3(0, 1, 0);

    /** Take the mirror plane from the host's world transform every frame,
     *  so it moves and turns with the host. Off, set
     *  {@link mirrorPlanePoint} / {@link mirrorPlaneNormal} yourself. */
    public followHost: boolean = true;

    /** Where the mirror surface is along the host's local +Y axis, from
     *  its origin, in local units: 0 for a plane, half the height for the
     *  top of a centered box. */
    public surfaceOffset: number = 0;

    /** How far behind the mirror plane (world units) geometry still
     *  reflects, so what touches the surface keeps its reflection. */
    public clipBias: number = 0.02;

    /** The scene's main camera that this mirror reflects. When left
     *  null, the mirror follows {@link View3D.camera}, whichever camera
     *  that is at the time. */
    public mainCamera: Camera3D | null = null;

    /** World-space point an explicitly set {@link mainCamera} looks at.
     *  While following the view, the camera's view direction is used. */
    public mainTarget: Vector3 = new Vector3(0, 0, 0);

    private _captureRoot: Object3D | null = null;
    private _captureCam: Camera3D | null = null;
    private _capture: SceneCaptureCameraComponent | null = null;
    private _material: Material | null = null;
    private _boundTexture: Texture | null = null;
    /** What the material's mirrorMap showed before the capture, given back when they part. */
    private _fallback: Texture | null = null;
    private _hostRenderer: MeshRenderer | null = null;
    /** {@link mainCamera} was not set: reflect the view's camera, whichever it is. */
    private _followView: boolean = false;

    private _mirrorPos = new Vector3();
    private _mirrorTarget = new Vector3();
    private _mirrorUp = new Vector3();
    private _target = new Vector3();

    /** Live reference to the auto-created scene-capture component, in
     *  case advanced users want to tweak its properties (clearColor,
     *  includeSky, …). Null until start. */
    public get captureComponent(): SceneCaptureCameraComponent | null {
        return this._capture;
    }

    /** The host material the capture is bound into: a {@link MirrorMaterial}
     *  or another material with a `mirrorMap` texture. Null while the host
     *  has none. */
    public get material(): Material | null {
        return this._material;
    }

    public start(): void {
        // Use start (not onEnable) for setup so the capture-node allocation
        // is one-shot, and the onEnable / onDisable cycle only toggles the
        // capture component's enable rather than tearing down GPU
        // resources. ComponentBase calls onEnable BEFORE start on first
        // attach, so doing this work in onEnable would have to defend
        // against not-yet-resolved view/camera references.
        const view = this.transform?.view3D;
        if (!view) {
            console.warn('[MirrorComponent] no view3D in start — mirror disabled.');
            return;
        }
        this._setup(view);
    }

    public onEnable(_view?: View3D): void {
        // Resume capture when the mirror is re-enabled. Setup happened
        // in start() — we only flip the capture component's enable
        // here so SceneCapturePass starts/stops scheduling captures.
        if (this._capture) this._capture.enable = true;
    }

    public onDisable(_view?: View3D): void {
        // Pause capture without tearing down the capture chain. The RT
        // stays bound on the material, so the surface keeps showing the
        // last captured frame — which is the right behaviour for
        // freeze-frame disable. If you need full teardown, destroy
        // the component instead.
        if (this._capture) this._capture.enable = false;
    }

    public onUpdate(view?: View3D): void {
        if (!this._captureCam || !this._captureRoot || !this._capture) return;
        view ??= this.transform?.view3D;
        if (this._followView && view?.camera) this.mainCamera = view.camera;
        const main = this.mainCamera;
        if (!main) return;

        this._trackHost();
        if (this.followHost) {
            const tr = this.object3D.transform;
            const m = tr.worldMatrix.rawData;
            const k = this.surfaceOffset;
            this.mirrorPlanePoint.set(m[12] + m[4] * k, m[13] + m[5] * k, m[14] + m[6] * k);
            this.mirrorPlaneNormal.copy(tr.up).normalize();
        }

        // Nothing to reflect while the camera is behind the mirror.
        const camPos = main.transform.worldPosition;
        const N = this.mirrorPlaneNormal, P = this.mirrorPlanePoint;
        const side = (camPos.x - P.x) * N.x + (camPos.y - P.y) * N.y + (camPos.z - P.z) * N.z;
        this._capture.needUpdate = side > 0;
        if (side <= 0) return;

        // Reflect the camera's position, a point along its view and its up
        // vector across the mirror plane. The capture camera looks the
        // mirrored way, which is the reflection up to a left-right flip
        // that the mirror's sampling undoes.
        if (this._followView) {
            Vector3.add(camPos, main.transform.forward, this._target);
        } else {
            this._target.copy(this.mainTarget);
        }
        this._reflectPoint(camPos, this._mirrorPos);
        this._reflectPoint(this._target, this._mirrorTarget);
        this._reflectDirection(main.transform.up, this._mirrorUp);

        this._captureRoot.transform.lookAt(this._mirrorPos, this._mirrorTarget, this._mirrorUp);
        this._captureRoot.transform.localPosition = this._mirrorPos;
        this._captureRoot.transform.updateWorldMatrix(true);

        // The main camera's projection (a resize or another camera changes
        // it), then the near plane onto the mirror plane.
        const cam = this._captureCam;
        cam.perspective(main.fov, main.aspect, main.near, main.far);
        this._clipToMirror(cam);

        if (this.resolutionScale > 0 && view) {
            const [w, h] = view.engine3D.context3D.presentationSize;
            this._capture.width = Math.max(16, Math.round(w * this.resolutionScale));
            this._capture.height = Math.max(16, Math.round(h * this.resolutionScale));
        } else {
            this._capture.width = this.width;
            this._capture.height = this.height;
        }

        // Late-bind the capture RT into the host's material on the first
        // frame it becomes available (SceneCaptureCameraComponent allocates
        // it lazily), and again when the host gets another material.
        const tex = this._capture.getCaptureTexture();
        if (tex && this._material && this._boundTexture !== tex) {
            this._material.shader.setTexture('mirrorMap', tex);
            this._boundTexture = tex;
        }
    }

    private _setup(view: View3D): void {
        this._trackHost();
        if (!this._hostRenderer) {
            console.warn('[MirrorComponent] no MeshRenderer found on host Object3D — mirror disabled.');
            return;
        }

        // Default mainCamera to the active view's camera, whichever it is
        // at the time. This is the primary reason setup is in start()
        // rather than onEnable() — the user can attach MirrorComponent
        // without naming a camera and the component picks up whatever the
        // View3D is rendering through.
        this._followView = !this.mainCamera;
        if (this._followView) this.mainCamera = view.camera;
        const main = this.mainCamera;
        if (!main) {
            console.warn('[MirrorComponent] no main camera — set mainCamera explicitly or attach the view first.');
            return;
        }

        // Spin up the capture camera under the scene root (NOT under the
        // host) so its world transform isn't double-folded by the host's
        // transform.
        this._captureRoot = new Object3D();
        this._captureRoot.name = 'MirrorComponent.captureRoot';
        this._captureCam = this._captureRoot.addComponent(Camera3D);
        this._captureCam.perspective(main.fov, main.aspect, main.near, main.far);

        this._capture = this._captureRoot.addComponent(SceneCaptureCameraComponent);
        this._capture.width = this.width;
        this._capture.height = this.height;
        // Captures only while the camera is in front of the mirror (onUpdate).
        this._capture.updateMode = 'manual';
        // Skip the mirror surface itself; otherwise the floor's back face
        // would render into its own reflection RT.
        this._capture.excludeMask = MirrorComponent.MIRROR_MASK;

        view.scene.addChild(this._captureRoot);
    }

    /** Follows the host's renderer and material: tags the renderer, and binds into another material. */
    private _trackHost(): void {
        const host = this.object3D.getComponent(MeshRenderer);
        if (host !== this._hostRenderer) {
            this._hostRenderer = host;
            // Tag the host renderer so the capture skips it. addMask is
            // idempotent so repeated calls won't accumulate duplicate bits.
            if (host) host.rendererMask = RendererMaskUtil.addMask(host.rendererMask, MirrorComponent.MIRROR_MASK);
        }
        const mat = this._hostRenderer?.material ?? null;
        const usable = mat && (mat instanceof MirrorMaterial || !!mat.shader?.getTexture('mirrorMap')) ? mat : null;
        if (usable !== this._material) {
            this._release();
            this._material = usable;
            this._fallback = usable?.shader.getTexture('mirrorMap') ?? null;
        }
    }

    /** Gives the material back what its mirrorMap showed before the capture. */
    private _release(): void {
        const mat = this._material;
        if (mat && this._boundTexture && mat.shader?.getTexture('mirrorMap') === this._boundTexture) {
            const ctx = this.transform?.view3D?.engine3D?.context3D;
            mat.shader.setTexture('mirrorMap', this._fallback ?? Engine3D.resFor(ctx).whiteTexture);
        }
        this._material = null;
        this._boundTexture = null;
        this._fallback = null;
    }

    /**
     * Moves the capture camera's near plane onto the mirror plane: an
     * oblique projection (Lengyel's, for the 0..1 depth range), so the
     * capture keeps only what is in front of the mirror. The far plane
     * tilts to still pass through the far corner of the view.
     */
    private _clipToMirror(cam: Camera3D): void {
        const N = this.mirrorPlaneNormal, P = this.mirrorPlanePoint;
        // The plane in world space, positive on the reflected side, moved
        // clipBias behind the surface.
        const d = -(N.x * P.x + N.y * P.y + N.z * P.z) + this.clipBias;
        // Into view space: planes transform by the transpose of the view's
        // inverse, the camera's world matrix (column-major).
        const w = cam.transform.worldMatrix.rawData;
        const cx = N.x * w[0] + N.y * w[1] + N.z * w[2] + d * w[3];
        const cy = N.x * w[4] + N.y * w[5] + N.z * w[6] + d * w[7];
        const cz = N.x * w[8] + N.y * w[9] + N.z * w[10] + d * w[11];
        const cw = N.x * w[12] + N.y * w[13] + N.z * w[14] + d * w[15];
        // The capture camera sits behind the plane; otherwise leave the projection as it is.
        if (cw >= 0) return;
        const p = cam.projectionMatrix.rawData;
        // The corner of the view frustum opposite the plane, in view space.
        const qx = Math.sign(cx / p[0]) / p[0];
        const qy = Math.sign(cy / p[5]) / p[5];
        const qz = 1;
        const qw = (1 - p[10]) / p[14];
        const dot = cx * qx + cy * qy + cz * qz + cw * qw;
        if (!(Math.abs(dot) > 1e-12)) return;
        const a = 1 / dot;
        p[2] = cx * a;
        p[6] = cy * a;
        p[10] = cz * a;
        p[14] = cw * a;
    }

    /** Reflect a world-space point across (mirrorPlanePoint, mirrorPlaneNormal).
     *  A' = A − 2 · ((A − P) · N) · N. Result is written into `out`. */
    private _reflectPoint(p: Vector3, out: Vector3): void {
        const N = this.mirrorPlaneNormal;
        const P = this.mirrorPlanePoint;
        const dx = p.x - P.x, dy = p.y - P.y, dz = p.z - P.z;
        const d = dx * N.x + dy * N.y + dz * N.z;
        out.set(p.x - 2 * d * N.x, p.y - 2 * d * N.y, p.z - 2 * d * N.z);
    }

    /** Reflect a world-space direction across the mirror plane normal.
     *  D' = D − 2 · (D · N) · N. Result is written into `out`. */
    private _reflectDirection(dir: Vector3, out: Vector3): void {
        const N = this.mirrorPlaneNormal;
        const k = dir.x * N.x + dir.y * N.y + dir.z * N.z;
        out.set(dir.x - 2 * k * N.x, dir.y - 2 * k * N.y, dir.z - 2 * k * N.z);
    }

    public destroy(force?: boolean): void {
        // The material outlives the capture, which is destroyed with its root.
        this._release();
        if (this._captureRoot) {
            this._captureRoot.removeFromParent();
            this._captureRoot.destroy(force);
        }
        this._captureRoot = null;
        this._captureCam = null;
        this._capture = null;
        this._hostRenderer = null;
        super.destroy?.(force);
    }
}

import {
    AnimationCurve, BlendMode, Keyframe, MinMaxCurve, MinMaxCurveState, Object3D, PlaneGeometry, Texture, Vector3, Vector4,
} from '@orillusion/core';
import {
    EmitLocation, ParticleEmitterModule, ParticleGravityModifierModule, ParticleMaterial, ParticleOverLifeColorModule,
    ParticleOverLifeScaleModule, ParticleStandardSimulator, ParticleSystem, ShapeType, SimulatorSpace,
} from '@orillusion/particle';
import type { ParticlesDoc } from '../core/types';
import { hexToColor } from './color';

// Particle emitters on the GPU (packages/particle). The simulator bakes
// its particles when it starts, so a changed emitter is built again.

const SHAPES: Record<ParticlesDoc['shape'], ShapeType> = {
    box: ShapeType.Box,
    circle: ShapeType.Circle,
    sphere: ShapeType.Sphere,
    hemisphere: ShapeType.Hemisphere,
};

/**
 * A value between min and max. The emitter evaluates curves at a random
 * time for each particle, so a straight line from min to max gives a
 * uniform random value in the range.
 */
function range(min: number, max: number): MinMaxCurve {
    const c = new MinMaxCurve(1);
    if (min === max) {
        c.setScalar(min);
        return c;
    }
    const a = new Keyframe(0, min);
    const b = new Keyframe(1, max);
    a.outSlope = b.inSlope = max - min;
    a.inSlope = b.outSlope = max - min;
    c.maxCurve = new AnimationCurve([a, b]);
    c.minCurve = new AnimationCurve([new Keyframe(0, min), new Keyframe(1, min)]);
    c.minMaxState = MinMaxCurveState.kMMCCurve;
    return c;
}

/** Adds a particle system for `p` to `obj`, drawing `texture` on each particle. */
export function buildParticles(obj: Object3D, p: ParticlesDoc, texture: Texture): ParticleSystem {
    const ps = obj.addComponent(ParticleSystem);
    ps.geometry = new PlaneGeometry(1, 1, 1, 1, Vector3.Z_AXIS);
    const mat = new ParticleMaterial();
    mat.baseMap = texture;
    mat.blendMode = p.blend === 'add' ? BlendMode.ADD : BlendMode.NORMAL;
    ps.material = mat;

    const sim = ps.useSimulator(ParticleStandardSimulator);
    sim.simulatorSpace = p.local ? SimulatorSpace.Local : SimulatorSpace.World;
    sim.looping = true;
    sim.preheatTime = p.prewarm;

    const em = sim.addModule(ParticleEmitterModule);
    // One emission cycle as long as the longest life, so the loop is seamless.
    const cycle = Math.max(1, p.life[1]);
    em.maxParticle = Math.max(1, Math.min(p.max, Math.ceil(p.rate * cycle)));
    em.duration = cycle;
    em.emissionRate = Math.max(0.01, p.rate);
    em.startLifecycle = range(p.life[0], p.life[1]);
    em.shapeType = SHAPES[p.shape];
    em.emitLocation = EmitLocation.Volume;
    em.radius = Math.max(0.0001, p.radius);
    em.boxSize = new Vector3(p.box[0], p.box[1], p.box[2]);
    em.startScale = range(p.size[0], p.size[1]);
    em.startRotation = range(p.spin[0], p.spin[1]);
    em.startVelocityX = range(p.velocityMin[0], p.velocityMax[0]);
    em.startVelocityY = range(p.velocityMin[1], p.velocityMax[1]);
    em.startVelocityZ = range(p.velocityMin[2], p.velocityMax[2]);

    sim.addModule(ParticleGravityModifierModule).gravity = new Vector3(p.gravity[0], p.gravity[1], p.gravity[2]);
    const color = sim.addModule(ParticleOverLifeColorModule);
    color.startColor = hexToColor(p.colorStart);
    color.endColor = hexToColor(p.colorEnd);
    color.startAlpha = p.alphaStart;
    color.endAlpha = p.alphaEnd;
    sim.addModule(ParticleOverLifeScaleModule).scaleSegments = [new Vector4(1, 1, 1, 1), new Vector4(p.sizeEnd, p.sizeEnd, p.sizeEnd, 1)];

    ps.play();
    return ps;
}

let dotUrl = '';

/** A soft round dot (white, alpha falling off to the edge), the default particle sprite. */
export function dotTextureUrl(): string {
    if (dotUrl) return dotUrl;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    dotUrl = c.toDataURL('image/png') + '#dot.png';
    return dotUrl;
}

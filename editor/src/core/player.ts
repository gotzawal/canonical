// The built-in player controller component (NodeDoc.player): its defaults
// and the repair of documents from files. The runtime is in
// play/playerController.ts.

import { makeMeshNode } from './defaults';
import type { NodeDoc, PlayerDoc, PlayerView, SpecsDoc } from './types';

export const PLAYER_VIEWS: { value: PlayerView; label: string }[] = [
    { value: 'third', label: 'Third Person' },
    { value: 'first', label: 'First Person' },
    { value: 'scene', label: 'Scene Camera' },
];

/** A player sized like the brief's specs (the editor's defaults without one). */
export function defaultPlayer(specs?: Pick<SpecsDoc, 'playerHeight' | 'playerRadius' | 'eyeHeight' | 'stepHeight'>): PlayerDoc {
    return {
        view: 'third',
        speed: 3,
        runSpeed: 6,
        jump: 4.5,
        gravity: 14,
        height: specs?.playerHeight ?? 1.8,
        radius: specs?.playerRadius ?? 0.35,
        eyeHeight: specs?.eyeHeight ?? 1.65,
        stepHeight: specs?.stepHeight ?? 0.3,
        distance: 4,
        lookSpeed: 1,
        invertY: false,
        collide: true,
    };
}

/** The player object: a capsule of the body's size with the controller, standing on y = 0. */
export function makePlayerNode(specs?: Parameters<typeof defaultPlayer>[0]): NodeDoc {
    const player = defaultPlayer(specs);
    const node = makeMeshNode('capsule');
    node.name = 'Player';
    node.mesh!.geometry = { type: 'capsule', radius: player.radius, height: player.height, segments: 24 };
    node.mesh!.material.color = '#e0a040';
    node.position = [0, player.height / 2, 0];
    node.player = player;
    return node;
}

const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: unknown, d: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, finite(v, d)));

/** Repairs a player component from a file; null when it is not one. */
export function sanitizePlayer(raw: unknown): PlayerDoc | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const p = raw as Record<string, unknown>;
    const d = defaultPlayer();
    const height = clamp(p.height, d.height, 0.2, 20);
    return {
        view: PLAYER_VIEWS.some((v) => v.value === p.view) ? (p.view as PlayerView) : d.view,
        speed: clamp(p.speed, d.speed, 0, 100),
        runSpeed: clamp(p.runSpeed, d.runSpeed, 0, 200),
        jump: clamp(p.jump, d.jump, 0, 100),
        gravity: clamp(p.gravity, d.gravity, 0, 200),
        height,
        radius: clamp(p.radius, d.radius, 0.05, height / 2),
        eyeHeight: clamp(p.eyeHeight, d.eyeHeight, 0.05, height),
        stepHeight: clamp(p.stepHeight, d.stepHeight, 0, height / 2),
        distance: clamp(p.distance, d.distance, 0.5, 100),
        lookSpeed: clamp(p.lookSpeed, d.lookSpeed, 0.05, 10),
        invertY: p.invertY === true,
        collide: p.collide !== false,
    };
}

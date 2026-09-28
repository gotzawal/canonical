// Characters (NodeDoc.character) and the player's control of one
// (NodeDoc.player): their defaults and the repair of documents from files.
// The runtime is in play/character.ts and play/playerController.ts.

import { makeMeshNode } from './defaults';
import type { CharacterDoc, NodeDoc, PlayerDoc, PlayerView, SpecsDoc } from './types';

export const PLAYER_VIEWS: { value: PlayerView; label: string }[] = [
    { value: 'third', label: 'Third Person' },
    { value: 'first', label: 'First Person' },
    { value: 'scene', label: 'Scene Camera' },
];

type Body = Pick<SpecsDoc, 'playerHeight' | 'playerRadius' | 'eyeHeight' | 'stepHeight'>;

/** A character sized like the brief's specs (the editor's defaults without one). */
export function defaultCharacter(specs?: Body): CharacterDoc {
    return {
        height: specs?.playerHeight ?? 1.8,
        radius: specs?.playerRadius ?? 0.35,
        eyeHeight: specs?.eyeHeight ?? 1.65,
        stepHeight: specs?.stepHeight ?? 0.3,
        speed: 3,
        runSpeed: 6,
        jump: 4.5,
        gravity: 14,
        collide: true,
    };
}

export function defaultPlayer(): PlayerDoc {
    return { view: 'third', distance: 4, lookSpeed: 1, invertY: false };
}

/** A capsule of the body's size standing on y = 0 with a character; the player's with `player`. */
export function makeCharacterNode(specs?: Body, player = false): NodeDoc {
    const character = defaultCharacter(specs);
    const node = makeMeshNode('capsule');
    node.name = player ? 'Player' : 'Character';
    node.mesh.geometry = { type: 'capsule', radius: character.radius, height: character.height, segments: 24 };
    node.mesh.material.color = player ? '#e0a040' : '#5f9fe0';
    node.position = [0, character.height / 2, 0];
    node.character = character;
    if (player) node.player = defaultPlayer();
    return node;
}

const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: unknown, d: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, finite(v, d)));
const record = (raw: unknown) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);

/** Repairs a character from a file; null when it is not one. */
export function sanitizeCharacter(raw: unknown): CharacterDoc | null {
    const c = record(raw);
    if (!c) return null;
    const d = defaultCharacter();
    const height = clamp(c.height, d.height, 0.2, 20);
    return {
        height,
        radius: clamp(c.radius, d.radius, 0.05, height / 2),
        eyeHeight: clamp(c.eyeHeight, d.eyeHeight, 0.05, height),
        stepHeight: clamp(c.stepHeight, d.stepHeight, 0, height / 2),
        speed: clamp(c.speed, d.speed, 0, 100),
        runSpeed: clamp(c.runSpeed, d.runSpeed, 0, 200),
        jump: clamp(c.jump, d.jump, 0, 100),
        gravity: clamp(c.gravity, d.gravity, 0, 200),
        collide: c.collide !== false,
    };
}

/** Repairs the player's control from a file; null when it is not one. */
export function sanitizePlayer(raw: unknown): PlayerDoc | null {
    const p = record(raw);
    if (!p) return null;
    const d = defaultPlayer();
    return {
        view: PLAYER_VIEWS.some((v) => v.value === p.view) ? (p.view as PlayerView) : d.view,
        distance: clamp(p.distance, d.distance, 0.5, 100),
        lookSpeed: clamp(p.lookSpeed, d.lookSpeed, 0.05, 10),
        invertY: p.invertY === true,
    };
}

// Characters (NodeDoc.character) and the player's control of one
// (NodeDoc.player): defaults and new character objects. Their fields are in
// core/model.ts, the runtime in play/character.ts and play/playerController.ts.

import { makeMeshNode } from './defaults';
import { Character, Player } from './model';
import { defaults } from './schema';
import type { CharacterDoc, NodeDoc, PlayerDoc, SpecsDoc } from './types';

type Body = Pick<SpecsDoc, 'playerHeight' | 'playerRadius' | 'eyeHeight' | 'stepHeight'> & Partial<Pick<SpecsDoc, 'maxSlope'>>;

/** A character sized like the brief's specs (the editor's defaults without one). */
export const defaultCharacter = (specs?: Body): CharacterDoc =>
    Character.parse({ height: specs?.playerHeight, radius: specs?.playerRadius, eyeHeight: specs?.eyeHeight, stepHeight: specs?.stepHeight, maxSlope: specs?.maxSlope });

export const defaultPlayer = (): PlayerDoc => defaults(Player);

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

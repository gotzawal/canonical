// Requests the pipeline's buttons send to the assistant: the start of a
// project, structuring the brief, and going on with a stage.

import type { StageId } from '../core/types';
import { stageDef, stepOf } from './stages';

/**
 * The request that starts a project from the start screen: the user's words
 * are already the brief. The chat shows only their words. `fresh`: the scene
 * still holds the new scene's sample objects.
 */
export function startPrompt(request: string, images: number, fresh: boolean): string {
    return [
        `I want to make this: ${request || '(see the attached images)'}`,
        images ? `The ${images} attached image${images === 1 ? ' is' : 's are'} my reference${images === 1 ? '' : 's'}, already concept images of the plan.` : '',
        'This is the start of a new scene and my words above are its brief (read_design section "brief" has them with any document I attached).',
        fresh ? 'The scene still has the sample cube and sphere of a new scene: remove them, and keep or resize the ground as the plan needs.' : '',
        'Give the scene a short name first (update_design scene_name). Then structure the brief with update_design (from_brief true): decide how the scene is built (the kind of place, its size in meters, compact, the ground, where each area sits and how the areas connect), then the areas with their objects, the specs, the mood, the play requirements and the effects.',
        'Decide what the brief leaves open yourself. Draw a concept image for areas without one if you can, then build the Layout step: the greybox level, closed and walkable (check_level until it passes), with the player at the start of the route, and a painted reference image for every shot.',
        'End your turn when the layout is ready, with a short summary of what you built, so I can look at it. Answer in the language I wrote in.',
    ].filter(Boolean).join(' ');
}

/**
 * "Keep going": the next part of the current stage, after the user liked the
 * result so far. `auto`: nobody answered for a while (AI settings,
 * Auto-approve), which counts as approved.
 */
export function continuePrompt(stage: StageId, approved: boolean, auto = false): string {
    const step = stepOf(stage);
    return [
        approved ? (auto ? 'I did not answer for a while, so it counts as approved.' : 'I like how it looks so far.') : 'Keep going where you stopped.',
        STAGE_PROMPTS[stage],
        `Keep going through the ${step.title} step (now ${stageDef(stage).title}) and end your turn when it is done, or when you need me to look at something.`,
    ].join(' ');
}

/** Structuring the brief: decide how the scene is built first, then the rest. */
export function structurePrompt(restructure: boolean): string {
    if (restructure) {
        return [
            'The planning brief changed since it was structured. Read the brief and the current design with read_design, then update the structure with update_design.',
            'Change only what the brief changed and keep the ids of areas that stay. Tell me which areas changed; they are flagged for rework in the stages they affect.',
            'Answer in the language of the brief.',
        ].join(' ');
    }
    return [
        'Structure the planning brief. Read it with read_design (section "brief") and look at the concept images (view_images).',
        'Name the scene if it has no name yet (update_design scene_name).',
        'First decide how the scene is built: the kind of place, its overall size in meters (compact: no more space than the areas need), the ground, where each area sits (bounds) and how the areas connect. Save that as the layout.',
        'Then list the areas with the objects each one needs, the specs (player height, eye height, door width and height, step height, steepest slope), the mood (time of day, key light direction and color, palette), the play requirements (the route through the level with positions, landmark sight lines, the order of the areas), the effects the brief asks for, and map every concept image to its area.',
        'Save everything with update_design (from_brief true). What the brief leaves open: decide it yourself when the detail level is quick (the default); when it is detailed, ask me only what changes the plan a lot (ask_user, at most 3 questions, each with the assumption you go ahead with).',
        'For areas without a concept image, draw one with generate_concept if you can, so I can see how the design will look.',
        'When the checklist is done, propose completing the stage. Finish with a short summary. Answer in the language of the brief.',
    ].join(' ');
}

/** "Work on this stage" requests. */
export const STAGE_PROMPTS: Record<StageId, string> = {
    brief: structurePrompt(false),
    level: [
        'Work on the Level stage (greybox). Read the plan with read_design.',
        'Build the layout in the gray greybox material only (no colors or textures, material slots are fine), under one group per area named after the area: the ground, every building and interior with build_rooms (closed and compact, doors on the route), ramps and stairs, and every object the areas list. Reuse repeated objects as prefabs, and put many copies of one thing (trees, rocks, fence posts) under one group object with instancing: {} so they draw together.',
        'An outdoor level larger than a courtyard stands on a terrain (create_terrain: an island for an island, else hills, mountains or plains, sized to the layout): sculpt flat sites for the buildings and level paths along the route (sculpt_terrain flatten and path), and spread the trees and large rocks over it with scatter (solid trunk or box, heights above the shore, avoiding the buildings, the paths and the play area) rather than placing them one by one.',
        'Place the player where the route starts (place_player). Run check_level and fix what it finds (seams, gaps, holes, floating objects, route points out of reach, rooms without a way in, large empty spaces) until it passes.',
        'Walk the route with the player\'s body (walk_route) and fix what stops it, check every landmark sight line from the player\'s eye height (check_sightline with its id), frame a shot for every concept image (create_shot), play-test where scripts matter (run_play_test) and tick what is done with update_checklist (level.play once the walk reaches every point).',
        'Then paint a reference image over every shot (generate_paintover): when the detail level is quick choose the targets yourself (choose_paintover), otherwise ask me to choose. Tell me what is left. Answer in the language of the brief.',
    ].join(' '),
    light: [
        'Work on the Lighting stage (pass 1). Every surface stays gray, so only the light is judged. Read the mood with read_design, and see the level\'s extent and the lights it has with review_lighting.',
        'Plan the light before placing it, and tell me the plan in a few lines: the key light (the sun or moon outdoors, the main window or lamp inside) as the mood says; the fill (the sky\'s brightness, ambient occlusion, global illumination); the practical lights the scene shows (lamps, torches, windows) and accents. Decide which cast shadows: the key light always; a practical light only where its shadows fall on the play area and are seen; fill lights never.',
        'Set the time of day and the sky\'s brightness (a solid color sky for interiors; the sky model is chosen in the Effects stage, but for realistic outdoor light an HDRI sky from the Library, search_library kind hdri then add_from_library, lights the scene like its photo: turn the key light to where the photo\'s sun is), the key light (apply_key_light points it and the sky\'s sun the way the mood says), fill and interior lights (spot lights for pools of light, point lights for lamps), exposure, ambient occlusion and global illumination.',
        'Give each shadow-casting light shadow settings that fit its role (light.shadow in create_objects and update_objects): resolution high for the key light where the camera comes close, medium for lights over the play area, low for small, dim or far ones; update static for lamps where the shadows of moving characters do not matter, auto elsewhere; for the sun a coverage by the level\'s size (area: one map around the light, placed over a small level; follow: around the camera, for a level larger than the range; cascades: 2 to 4 maps from the camera out, for large outdoor levels) and a range that just covers the play area. Check the plan with review_lighting (each light\'s memory, what its shadow reaches, advice) and keep within the budgets of shadow lights and shadow memory.',
        'Compare every shot with its paintover in grayscale (compare_shot) and adjust until the value structure matches; I mark the shots that match (with the detail level quick, you judge them: mark_shot_matching). Tick what is done with update_checklist and propose completing the stage when it matches.',
        'Answer in the language of the brief.',
    ].join(' '),
    material: [
        'Work on the Materials stage. Define the material slots of the level (set_material_slot) and assign them to the objects (assign_material_slot).',
        'For every slot search the swatch library (search_swatches) and the Library\'s realistic scanned materials (search_library kind material: color, normal and ARM maps at their real tile size) and put a fitting one on it (use_swatch, or add_from_library with the slot); generate swatches (generate_swatch) only when nothing fits. Their textures are sized for the surface (tile times specs.texel_density: raise it for surfaces seen up close, lower it for large, far ones) and compressed. One roughness and one metallic value per material (a material with an ARM map takes its own).',
        'Cover the ground where the plan has vegetation with grass (create_objects type grass, standing on the ground object), and make water and mirrors: a plane with a mirror component and the Water material shader (write_shader template water, then assign_shader).',
        'Give every terrain its surface layers from the slots (update_objects terrain.layers: the first covers everything; then sand low by the water, rock on slopes over about 35 degrees, snow high up), paint paths and fields with sculpt_terrain paint, and scatter small decoration over it (grass tufts, flowers, pebbles: not solid, align 1, a draw distance of 40 to 80 m).',
        'Then do lighting pass 2: correct light intensities and exposure for the new albedo (scanned materials have their real, darker albedo, bricks about 0.1: brighten the fill, the sky, global illumination and exposure rather than the slot colors), compare the shots in color (compare_shot with mode color) and tick the checklist.',
        'Answer in the language of the brief.',
    ].join(' '),
    effects: [
        'Work on the Effects stage. Choose the sky model with set_environment sky: atmospheric (single scattering: fast, right for day skies) or physical (multiple scattering: deep sunsets, dusk and twilight glow, optional clouds for outdoor scenes that show a lot of sky); keep a solid color sky for interiors.',
        'Add the effects the plan lists (read_design, section effects): particles (add_particles from a preset, then tune it) and post effects with set_environment: fog (height fog for valleys and mist), volumetric fog, god rays through the sun\'s shadows, bloom, screen space reflections (ssr) on polished and wet surfaces; and a vignette (add_vignette).',
        'Mark each effect done with update_design as you finish it, compare the shots again (also in grayscale, so the value structure holds) and keep the frame rate within the budget.',
        'Answer in the language of the brief.',
    ].join(' '),
    finish: [
        'Work on the Finish stage: a final lighting pass and polish, then color grading with a lift, gamma, gain and saturation post effect (add_color_grade).',
        'Then review the optimization of everything with review_performance and act on what it finds: the frame rate against the budget; shadow maps (review_lighting per light); textures (compress the ones that are not and cap sizes a surface does not need, set_texture_options); repeated objects to put under instancing groups; draw calls and triangles; the effects that cost the most; the download size of the built game. Change what it points at, measure again, and tick the review item with a note on what you changed and what you left and why.',
        'Compare every shot with its paintover (compare_shot) and tell me which ones look ready to approve (with the detail level quick, approve them yourself: mark_shot_matching).',
        'Answer in the language of the brief.',
    ].join(' '),
};

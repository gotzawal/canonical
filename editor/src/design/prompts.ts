// Requests the pipeline's buttons send to the assistant.

import type { StageId } from '../core/types';

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
        'If the detail level is not set yet, judge it from how the brief is written (set_detail_level); only if you cannot tell, ask me once (ask_detail_level) and stop there.',
        'First decide how the scene is built: the kind of place, its overall size in meters (compact: no more space than the areas need), the ground, where each area sits (bounds) and how the areas connect. Save that as the layout.',
        'Then list the areas with the objects each one needs, the specs (player height, eye height, door width and height, step height, steepest slope), the mood (time of day, key light direction and color, palette), the play requirements (the route through the level with positions, landmark sight lines, the order of the areas), the effects the brief asks for, and map every concept image to its area.',
        'Save everything with update_design (from_brief true). What the brief leaves open: decide it yourself when the detail level is quick; when it is detailed, ask me only what changes the plan a lot (ask_user, at most 3 questions, each with the assumption you go ahead with).',
        'For areas without a concept image, draw one with generate_concept if you can, so I can review how the design will look.',
        'When the checklist is done, propose completing the stage. Finish with a short summary. Answer in the language of the brief.',
    ].join(' ');
}

/** "Work on this stage" requests. */
export const STAGE_PROMPTS: Record<StageId, string> = {
    brief: structurePrompt(false),
    level: [
        'Work on the Level stage (greybox). Read the plan with read_design.',
        'Build the layout in the gray greybox material only (no colors or textures, material slots are fine), under one group per area named after the area: the ground, every building and interior with build_rooms (closed and compact, doors on the route), ramps and stairs, and every object the areas list. Reuse repeated objects as prefabs.',
        'Place the player where the route starts (place_player). Run check_level and fix what it finds (seams, gaps, holes, floating objects, route points out of reach, rooms without a way in, large empty spaces) until it passes.',
        'Frame a shot for every concept image (create_shot), check the landmark sight lines from the player\'s eye height (check_sightline), play-test (run_play_test) and tick what is done with update_checklist.',
        'Then make a paintover of every shot (generate_paintover): when the detail level is quick choose the targets yourself (choose_paintover), otherwise ask me to choose. Tell me what is left. Answer in the language of the brief.',
    ].join(' '),
    light: [
        'Work on the Lighting stage (pass 1). Placement is locked and every surface stays gray, so only the light is judged. Read the mood with read_design.',
        'Set the sky and time of day, the key light (apply_key_light points it the way the mood says), fill and interior lights, exposure and global illumination. Keep the shadow-casting lights within the budget.',
        'Compare every shot with its paintover in grayscale (compare_shot) and adjust until the value structure matches; I mark the shots that match (with the detail level quick, you judge them: mark_shot_matching). Tick what is done with update_checklist and propose completing the stage when it matches.',
        'Answer in the language of the brief.',
    ].join(' '),
    material: [
        'Work on the Materials stage. Define the material slots of the level (set_material_slot) and assign them to the objects (assign_material_slot).',
        'For every slot search the swatch library first (search_swatches) and put a fitting one on it (use_swatch); generate swatches (generate_swatch) only when nothing fits. One roughness and one metallic value per material.',
        'Then do lighting pass 2: correct light intensities and exposure for the new albedo, compare the shots in color (compare_shot with mode color) and tick the checklist.',
        'Answer in the language of the brief.',
    ].join(' '),
    effects: [
        'Work on the Effects stage. Add the effects the plan lists (read_design, section effects): particles (add_particles from a preset, then tune it) and post effects such as fog and bloom (set_environment) and a vignette (add_vignette).',
        'Mark each effect done with update_design as you finish it, compare the shots again (also in grayscale, so the value structure holds) and keep the frame rate within the budget.',
        'Answer in the language of the brief.',
    ].join(' '),
    finish: [
        'Work on the Finish stage: a final lighting pass and polish, then color grading with a lift, gamma, gain and saturation post effect (add_color_grade).',
        'Compare every shot with its paintover (compare_shot) and tell me which ones look ready to approve (with the detail level quick, approve them yourself: mark_shot_matching).',
        'Answer in the language of the brief.',
    ].join(' '),
};

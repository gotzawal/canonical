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
        'First decide how the scene is built: the kind of place, its overall size in meters, the ground, where each area sits (bounds) and how the areas connect. Save that as the layout.',
        'Then list the areas with the objects each one needs, the specs (player height, eye height, door width and height, step height, steepest slope), the mood (time of day, key light direction and color, palette), the play requirements (the route through the level, landmark sight lines, the order of the areas), the effects the brief asks for, and map every concept image to its area.',
        'Save everything with update_design (from_brief true). Where the brief leaves something open, ask me with ask_user instead of guessing.',
        'Finish with a short summary. Answer in the language of the brief.',
    ].join(' ');
}

/** "Work on this stage" requests. */
export const STAGE_PROMPTS: Record<StageId, string> = {
    brief: structurePrompt(false),
    level: [
        'Work on the Level stage (greybox). Read the plan with read_design.',
        'Build the layout in the gray greybox material only (no colors or textures, material slots are fine): ground, floors, walls and openings sized by the specs, ramps and stairs, and every object the areas list, under one group per area named after the area. Reuse repeated objects as prefabs.',
        'Add a player capsule for scale. Frame a shot for every concept image (create_shot), check the route and the landmark sight lines from the player\'s eye height (capture_player_view, check_sightline) and tick what is done with update_checklist.',
        'When the route and sight lines pass, make a paintover of every shot (generate_paintover) and ask me to choose the targets. Tell me what is left. Answer in the language of the brief.',
    ].join(' '),
    light: [
        'Work on the Lighting stage (pass 1). Placement is locked and every surface stays gray, so only the light is judged. Read the mood with read_design.',
        'Set the sky and time of day, the key light (apply_key_light points it the way the mood says), fill and interior lights, exposure and global illumination. Keep the shadow-casting lights within the budget.',
        'Compare every shot with its paintover in grayscale (compare_shot) and adjust until the value structure matches; I mark the shots that match. Tick what is done with update_checklist and propose completing the stage when it matches.',
        'Answer in the language of the brief.',
    ].join(' '),
    material: [
        'Work on the Materials stage. Define the material slots of the level (set_material_slot) and assign them to the objects (assign_material_slot).',
        'For every slot search the swatch library first (search_swatches) and generate a swatch only when nothing fits. One roughness and one metallic value per material.',
        'Then do lighting pass 2: correct light intensities and exposure for the new albedo, compare the shots in color (compare_shot with mode color) and tick the checklist.',
        'Answer in the language of the brief.',
    ].join(' '),
    effects: [
        'Work on the Effects stage. Add the effects the plan lists (read_design, section effects): particles and post effects such as fog, bloom and vignette.',
        'Mark each effect done with update_design as you finish it, compare the shots again (also in grayscale, so the value structure holds) and keep the frame rate within the budget.',
        'Answer in the language of the brief.',
    ].join(' '),
    finish: [
        'Work on the Finish stage: a final lighting pass and polish, then color grading with a lift, gamma, gain and saturation post effect (add_color_grade).',
        'Compare every shot with its paintover (compare_shot) and tell me which ones look ready to approve.',
        'Answer in the language of the brief.',
    ].join(' '),
};

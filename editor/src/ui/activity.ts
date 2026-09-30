// What the assistant's tools do, in the user's words: the chat's steps and
// the status over the view say "Building rooms", not "build_rooms".

const ACTIVITY: Record<string, string> = {
    // scene
    get_scene: 'Looking at the scene',
    get_object: 'Looking at an object',
    create_objects: 'Building',
    update_objects: 'Adjusting objects',
    delete_objects: 'Removing objects',
    select_objects: 'Selecting objects',
    set_environment: 'Setting the sky and the light',
    list_model_parts: 'Looking at a model',
    set_model_material: 'Changing a model\'s materials',
    set_model_part: 'Changing a model',
    add_model: 'Placing a model',
    search_library: 'Searching the library',
    add_from_library: 'Adding from the library',
    import_url: 'Downloading a file',
    view_images: 'Looking at images',
    capture_viewport: 'Looking at the view',
    // plan
    read_design: 'Reading the plan',
    update_design: 'Planning the scene',
    ask_user: 'Noting questions',
    set_detail_level: 'Planning',
    update_checklist: 'Checking the work',
    propose_stage_complete: 'Finishing a step',
    apply_key_light: 'Setting the sun',
    // level
    build_rooms: 'Building rooms',
    check_level: 'Checking the level',
    place_player: 'Placing the player',
    create_prefab: 'Making a reusable piece',
    place_prefab: 'Placing pieces',
    create_shot: 'Framing a view',
    update_shot: 'Framing a view',
    delete_shot: 'Removing a view',
    capture_shot: 'Capturing a view',
    compare_shot: 'Comparing with the reference',
    mark_shot_matching: 'Judging a view',
    capture_player_view: 'Looking through the player\'s eyes',
    check_sightline: 'Checking what the player sees',
    // images
    generate_concept: 'Drawing a reference image',
    generate_paintover: 'Painting a reference image',
    choose_paintover: 'Choosing a reference image',
    image_model_info: 'Checking the image model',
    // materials
    set_material_slot: 'Defining materials',
    assign_material_slot: 'Assigning materials',
    search_swatches: 'Looking for textures',
    use_swatch: 'Applying a texture',
    generate_swatch: 'Painting a texture',
    view_materials: 'Looking at the materials',
    // effects
    add_particles: 'Adding effects',
    update_particles: 'Tuning effects',
    add_vignette: 'Adding a vignette',
    add_color_grade: 'Grading the colors',
    // code
    write_script: 'Writing a script',
    read_script: 'Reading a script',
    attach_script: 'Attaching a script',
    detach_script: 'Detaching a script',
    set_script_props: 'Tuning a script',
    delete_script: 'Removing a script',
    write_shader: 'Writing a shader',
    read_shader: 'Reading a shader',
    assign_shader: 'Applying a shader',
    delete_shader: 'Removing a shader',
    get_render_graph: 'Reading the render passes',
    set_render_pass: 'Changing the render passes',
    add_post_effect: 'Adding a screen effect',
    update_post_effect: 'Tuning a screen effect',
    remove_post_effect: 'Removing a screen effect',
    get_console: 'Reading the console',
    run_play_test: 'Testing in Play',
    play: 'Playing the scene',
    stop: 'Stopping Play',
    // behavior
    get_behavior_outline: 'Reading a behavior tree',
    apply_behavior_ops: 'Editing a behavior tree',
    validate_behavior: 'Checking a behavior tree',
    get_decision_log: 'Reading the decisions',
};

/** "Building rooms" for build_rooms; unknown tools read as their name. */
export function activityLabel(tool: string): string {
    if (ACTIVITY[tool]) return ACTIVITY[tool];
    const words = tool.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

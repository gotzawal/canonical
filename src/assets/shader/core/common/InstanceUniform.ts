/**
 * @internal
 */
export let InstanceUniform: string = /*wgsl*/ `
    #if USE_INSTANCEDRAW
        struct InstanceUniform {
            matrixIDs : array<i32>
        };
        // Binding 7 of group 2 is the lit shaders' irradianceData.
        @group(2) @binding(6)
        var<storage, read> instanceDrawID : InstanceUniform;
    #endif
`

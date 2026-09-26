
/**
 * Loader Setting
 * @group Setting
 */
export type LoaderSetting = {
    /**
     * Number of concurrent loading
     */
    numConcurrent: number;

    /**
     * Apply the `matrix` of glTF nodes. A glTF node can give its transform
     * as a matrix instead of translation / rotation / scale (exporters often
     * put unit conversion or Z-up to Y-up there). Off by default: content
     * made for this loader, such as the samples, compensates for the matrix
     * being ignored, which left those nodes with an identity transform.
     */
    gltfNodeMatrix?: boolean;
};

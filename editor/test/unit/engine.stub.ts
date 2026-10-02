// Stands in for @orillusion/core in unit tests: modules under test import
// engine classes by name but do not use them in the tested paths.

export class Vector3 {
    static UP = new Vector3(0, 1, 0);
    constructor(public x = 0, public y = 0, public z = 0) {}
}
export class Object3D {}
export class Quaternion {
    set() {
        return this;
    }
}
export class RenderNode {}
export class Transform {
    static LOCAL_ONCHANGE = 'LOCAL_ONCHANGE';
}
export const VertexAttributeName = { position: 'position', indices: 'indices' };
export const isSrgbFormat = (format: unknown) => typeof format === 'string' && format.endsWith('-srgb');
// Base classes the shader module extends at load (its parsing is tested).
export class Texture {}
export class PostBase {}

// A tiny skinned model for the animation tests: a two-bone post (Hips at
// the feet, Spine halfway up) with Idle, Walk and Run clips that bend the
// Spine more and more, as an embedded .gltf.

const rings = [0, 1, 2];
const corners = [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]];

/** A rotation about z by `deg` degrees, as a glTF quaternion. */
const bend = (deg: number) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];

export function rigGltf(): string {
    const positions = rings.flatMap((y) => corners.flatMap(([x, z]) => [x, y, z]));
    const normals = rings.flatMap(() => corners.flatMap(([x, z]) => [x / 0.2828, 0, z / 0.2828]));
    const uvs = rings.flatMap((y) => corners.flatMap((_, i) => [i / 3, y / 2]));
    // Ring 0 follows the Hips, ring 2 the Spine, ring 1 both.
    const joints = rings.flatMap((y) => corners.flatMap(() => [y === 0 ? 0 : 1, 0, 0, 0]));
    const weights = rings.flatMap((y) => corners.flatMap(() => (y === 1 ? [0.5, 0.5, 0, 0] : [1, 0, 0, 0])));
    const indices: number[] = [];
    for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
            const a = r * 4 + c;
            const b = r * 4 + ((c + 1) % 4);
            indices.push(a, b, b + 4, a, b + 4, a + 4);
        }
    }
    indices.push(0, 2, 1, 0, 3, 2, 8, 9, 10, 8, 10, 11);
    // Hips at the origin, Spine 1 m up: their inverse bind matrices.
    const ibm = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1];
    const times = [0, 0.5, 1];
    const clips: [string, number][] = [['Idle', 5], ['Walk', 20], ['Run', 45]];

    const parts: [ArrayLike<number>, 'f32' | 'u16'][] = [
        [positions, 'f32'], [normals, 'f32'], [uvs, 'f32'], [joints, 'u16'], [weights, 'f32'], [indices, 'u16'], [ibm, 'f32'], [times, 'f32'],
        ...clips.map(([, deg]): [number[], 'f32'] => [[...bend(0), ...bend(deg), ...bend(0)], 'f32']),
    ];
    const views: { byteOffset: number; byteLength: number }[] = [];
    const bytes: number[] = [];
    for (const [data, type] of parts) {
        const typed = type === 'f32' ? new Float32Array(Array.from(data)) : new Uint16Array(Array.from(data));
        views.push({ byteOffset: bytes.length, byteLength: typed.byteLength });
        bytes.push(...new Uint8Array(typed.buffer));
        while (bytes.length % 4) bytes.push(0);
    }
    const F32 = 5126;
    const U16 = 5123;
    const accessor = (view: number, type: string, count: number, componentType = F32, extra = {}) => ({ bufferView: view, componentType, count, type, ...extra });
    const gltf = {
        asset: { version: '2.0', generator: 'morglay tests' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
            { name: 'Rig', children: [1, 2] },
            { name: 'Body', mesh: 0, skin: 0 },
            { name: 'Hips', children: [3] },
            { name: 'Spine', translation: [0, 1, 0] },
        ],
        meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, JOINTS_0: 3, WEIGHTS_0: 4 }, indices: 5, material: 0 }] }],
        materials: [{ name: 'Skin', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.5, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
        skins: [{ joints: [2, 3], inverseBindMatrices: 6, skeleton: 2 }],
        animations: clips.map(([name], i) => ({
            name,
            samplers: [{ input: 7, output: 8 + i, interpolation: 'LINEAR' }],
            channels: [{ sampler: 0, target: { node: 3, path: 'rotation' } }],
        })),
        accessors: [
            accessor(0, 'VEC3', 12, F32, { min: [-0.2, 0, -0.2], max: [0.2, 2, 0.2] }),
            accessor(1, 'VEC3', 12),
            accessor(2, 'VEC2', 12),
            accessor(3, 'VEC4', 12, U16),
            accessor(4, 'VEC4', 12),
            accessor(5, 'SCALAR', indices.length, U16),
            accessor(6, 'MAT4', 2),
            accessor(7, 'SCALAR', 3, F32, { min: [0], max: [1] }),
            ...clips.map((_, i) => accessor(8 + i, 'VEC4', 3)),
        ],
        bufferViews: views.map((v) => ({ buffer: 0, ...v })),
        buffers: [{ byteLength: bytes.length, uri: 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes)) }],
    };
    return JSON.stringify(gltf);
}

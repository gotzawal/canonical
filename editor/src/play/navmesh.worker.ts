// Bakes navigation meshes off the main thread (play/navmeshRuntime.ts
// sends the level's triangles and the recast settings, and gets the baked
// mesh back as bytes), so a large level does not stall the frame.

import { exportNavMesh, init } from 'recast-navigation';
import { generateSoloNavMesh, generateTiledNavMesh } from 'recast-navigation/generators';

const ready = init();

self.onmessage = async (e: MessageEvent) => {
    const { id, positions, indices, config, tiled } = e.data as {
        id: number;
        positions: Float32Array;
        indices: Uint32Array;
        config: Record<string, number>;
        tiled: boolean;
    };
    try {
        await ready;
        const started = performance.now();
        const result = tiled ? generateTiledNavMesh(positions, indices, config) : generateSoloNavMesh(positions, indices, config);
        if (!result.success || !result.navMesh) throw new Error((result as { error?: string }).error || 'the level has nothing to walk on');
        const data = exportNavMesh(result.navMesh).slice();
        result.navMesh.destroy();
        (self as unknown as Worker).postMessage({ id, data, ms: performance.now() - started }, [data.buffer]);
    } catch (err: any) {
        (self as unknown as Worker).postMessage({ id, error: String(err?.message || err) });
    }
};

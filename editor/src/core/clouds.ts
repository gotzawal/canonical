// Starting points for the volumetric clouds (Environment.clouds): each sets
// the shape settings together, and the sliders tune from there.

import type { EnvironmentDoc } from './types';

type CloudLook = Pick<EnvironmentDoc['clouds'], 'coverage' | 'type' | 'size' | 'clumping' | 'variety' | 'softness' | 'detail' | 'density' | 'bottom' | 'thickness'>;

export const CLOUD_PRESETS: { id: string; label: string; description: string; look: CloudLook }[] = [
    { id: 'fair', label: 'Fair', description: 'Small white heaps on a blue sky.', look: { coverage: 0.35, type: 0.85, size: 0.8, clumping: 0.4, variety: 0.4, softness: 0.2, detail: 0.6, density: 1, bottom: 1200, thickness: 1500 } },
    { id: 'puffs', label: 'Puffs', description: 'Many small cotton puffs scattered over the sky.', look: { coverage: 0.35, type: 0.9, size: 0.6, clumping: 0.1, variety: 0.3, softness: 0.2, detail: 0.6, density: 1, bottom: 1000, thickness: 1200 } },
    { id: 'scattered', label: 'Scattered', description: 'Heaps of all sizes over half the sky.', look: { coverage: 0.5, type: 0.75, size: 1.2, clumping: 0.6, variety: 0.6, softness: 0.3, detail: 0.6, density: 1, bottom: 1500, thickness: 2000 } },
    { id: 'broken', label: 'Broken', description: 'Large masses with gaps of sky.', look: { coverage: 0.7, type: 0.6, size: 1.6, clumping: 0.8, variety: 0.5, softness: 0.35, detail: 0.5, density: 1.2, bottom: 1500, thickness: 2200 } },
    { id: 'overcast', label: 'Overcast', description: 'A grey layer over the whole sky.', look: { coverage: 0.95, type: 0.2, size: 2.5, clumping: 1, variety: 0.3, softness: 0.6, detail: 0.3, density: 1.5, bottom: 1200, thickness: 1800 } },
    { id: 'towering', label: 'Towering', description: 'Tall, dense heaps building up.', look: { coverage: 0.55, type: 1, size: 1.5, clumping: 0.7, variety: 0.4, softness: 0.15, detail: 0.7, density: 1.4, bottom: 1200, thickness: 5000 } },
    { id: 'sheets', label: 'High Sheets', description: 'Thin veils and streaks high up, drawn out by the wind.', look: { coverage: 0.6, type: 0.05, size: 2.5, clumping: 0.5, variety: 0.6, softness: 0.8, detail: 0.8, density: 0.5, bottom: 6000, thickness: 800 } },
];

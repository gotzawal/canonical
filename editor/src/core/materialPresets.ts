// One-click starting points for primitive materials (Material section menu
// and the AI tools). A preset keeps the color and textures and sets the rest.

import type { MaterialDoc } from './types';

export interface MaterialPreset {
    id: string;
    label: string;
    apply(m: MaterialDoc): void;
}

/** Back to a plain lit material, keeping color, opacity, textures and tiling. */
function lit(m: MaterialDoc, metallic: number, roughness: number) {
    m.type = 'lit';
    m.shader = null;
    delete m.params;
    m.metallic = metallic;
    m.roughness = roughness;
    m.emissive = '#000000';
    m.emissiveIntensity = 1;
    for (const k of ['clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'thickness', 'attenuationColor', 'attenuationDistance'] as const) {
        delete m[k];
    }
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
    { id: 'plastic', label: 'Plastic', apply: (m) => lit(m, 0, 0.45) },
    { id: 'rubber', label: 'Rubber', apply: (m) => lit(m, 0, 0.95) },
    { id: 'metal', label: 'Polished Metal', apply: (m) => lit(m, 1, 0.2) },
    { id: 'brushed', label: 'Brushed Metal', apply: (m) => lit(m, 1, 0.55) },
    {
        id: 'carpaint',
        label: 'Car Paint (Clear Coat)',
        apply: (m) => {
            lit(m, 0.5, 0.4);
            m.clearcoat = 1;
            m.clearcoatRoughness = 0.05;
        },
    },
    {
        id: 'glass',
        label: 'Glass',
        apply: (m) => {
            lit(m, 0, 0.05);
            m.transmission = 1;
            m.ior = 1.5;
            m.opacity = 1;
            delete m.alphaMode;
        },
    },
    {
        id: 'water',
        label: 'Water',
        apply: (m) => {
            lit(m, 0, 0.02);
            m.transmission = 1;
            m.ior = 1.33;
            m.thickness = 0.5;
            m.attenuationColor = '#6fc3e8';
            m.attenuationDistance = 2;
            m.opacity = 1;
            delete m.alphaMode;
        },
    },
    {
        id: 'glow',
        label: 'Glow',
        apply: (m) => {
            lit(m, 0, 0.5);
            m.emissive = m.color;
            m.emissiveIntensity = 3;
        },
    },
    {
        id: 'matte',
        label: 'Matte (Lambert)',
        apply: (m) => {
            m.type = 'lambert';
            m.shader = null;
            delete m.params;
        },
    },
    {
        id: 'unlit',
        label: 'Unlit',
        apply: (m) => {
            m.type = 'unlit';
            m.shader = null;
            delete m.params;
        },
    },
];

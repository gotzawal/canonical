import { describe, expect, it } from 'vitest';
import { defaultDesign, designAssetIds, dropRecords, RECORD_KINDS, recordAssets } from '../../src/core/design';
import type { DesignDoc } from '../../src/core/types';

const cam = { target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 5, fov: 50 };

function design(): DesignDoc {
    const d = defaultDesign();
    d.concepts = [{ asset: 'concept' }];
    d.shots = [
        {
            id: 'sh1', name: 'Shot', concept: 'concept', camera: cam, aspect: 1.5, target: 'chosen',
            paintovers: [
                { asset: 'chosen', source: 'generated', at: '', refs: ['ref1'] },
                { asset: 'other', source: 'generated', at: '', refs: ['ref2', 'concept'] },
            ],
            history: [{ stage: 'light', asset: 'cap1', at: '' }, { stage: 'material', asset: 'cap2', at: '' }],
        },
    ];
    d.snapshots = [{ id: 'v1', asset: 'snap', name: 'Lighting complete', at: '', assets: ['tex'], thumb: 'thumb' }];
    return d;
}

describe('planning records', () => {
    it('sorts the images by kind and never counts a concept', () => {
        const ids = recordAssets(design());
        expect([...ids.captures]).toEqual(['cap1', 'cap2']);
        expect([...ids.paintovers].sort()).toEqual(['other', 'ref2']);
        expect([...ids.targets].sort()).toEqual(['chosen', 'ref1']);
        expect([...ids.snapshots].sort()).toEqual(['snap', 'thumb']);
        for (const set of Object.values(ids)) expect(set.has('concept')).toBe(false);
    });

    it('drops the chosen kinds and keeps the rest', () => {
        const d = design();
        const n = dropRecords(d, ['captures', 'paintovers']);
        expect(n).toEqual({ captures: 2, paintovers: 1, targets: 0, snapshots: 0 });
        expect(d.shots[0].history).toEqual([]);
        expect(d.shots[0].paintovers.map((p) => p.asset)).toEqual(['chosen']);
        expect(d.shots[0].target).toBe('chosen');
        expect(d.snapshots).toHaveLength(1);
    });

    it('keeps only the concept images when everything goes', () => {
        const d = design();
        dropRecords(d, RECORD_KINDS);
        expect(d.shots[0]).toMatchObject({ target: null, paintovers: [], history: [], concept: 'concept' });
        expect(d.snapshots).toEqual([]);
        expect([...designAssetIds(d)]).toEqual(['concept']);
    });
});

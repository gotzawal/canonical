import { describe, expect, it } from 'vitest';
import { Animation } from '../../src/core/model';
import { clipFor } from '../../src/play/animation';

describe('clipFor', () => {
    const clips = ['Survey', 'Walk', 'Run', 'Jump_Start'];

    it("picks a clip named for a character's mode", () => {
        const doc = Animation.parse({});
        expect(clipFor(clips, doc, 'idle')).toBe('Survey');
        expect(clipFor(clips, doc, 'walk')).toBe('Walk');
        expect(clipFor(clips, doc, 'run')).toBe('Run');
        expect(clipFor(clips, doc, 'jump')).toBe('Jump_Start');
        // Nothing fits: the clip playing goes on.
        expect(clipFor(clips, doc, 'fall')).toBeNull();
    });

    it('takes the clip set for a mode, when the model has it', () => {
        const doc = Animation.parse({ walk: 'Run', run: 'Sprint' });
        expect(clipFor(clips, doc, 'walk')).toBe('Run');
        expect(clipFor(clips, doc, 'run')).toBe('Run');
    });
});

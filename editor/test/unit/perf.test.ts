import { describe, expect, it } from 'vitest';
import { callSite } from '../../src/core/perf';
import { Emitter, probeListeners, timed } from '../../src/core/events';

describe('listener timing', () => {
    it('names where a listener was added, from a stack trace', () => {
        const chrome = [
            'Error',
            '    at site (http://localhost:8100/src/core/perf.ts:52:26)',
            '    at Store.on (http://localhost:8100/src/core/events.ts?t=1:44:31)',
            '    at onChanges (http://localhost:8100/src/ui/batch.ts:30:22)',
            '    at new HierarchyPanel (http://localhost:8100/src/ui/hierarchy.ts?t=1727580000000:77:15)',
        ].join('\n');
        expect(callSite(chrome)).toBe('HierarchyPanel (ui/hierarchy.ts:77)');
        const firefox = ['site@http://localhost:8100/src/core/perf.ts:52:26', 'on@http://localhost:8100/src/core/events.ts:44:31', 'AssetsPanel@http://localhost:8100/src/ui/assetsPanel.ts:44:9'].join('\n');
        expect(callSite('Error\n' + firefox)).toBe('AssetsPanel (ui/assetsPanel.ts:44)');
        expect(callSite('Error\n    at https://example.org/assets/index-abc.js:1:2345')).toBe('(index-abc.js:1)');
        // A build: every module in one file.
        const built = ['Error', '    at Object.site (https://x.org/assets/index-abc.js:1:100)', '    at Store.on (https://x.org/assets/index-abc.js:1:200)', '    at new InspectorPanel (https://x.org/assets/index-abc.js:1:300)'].join('\n');
        expect(callSite(built)).toBe('InspectorPanel (index-abc.js:1)');
    });

    it('times every listener while a probe is installed', () => {
        const calls: string[] = [];
        probeListeners({ site: () => 'here', record: (type, site, _start, ms) => void calls.push(`${type} ${site} ${ms >= 0}`) });
        try {
            const e = new Emitter<{ ping: number }>();
            e.on('ping', () => {});
            e.emit('ping', 1);
            timed('frame', 'there', () => {});
        } finally {
            probeListeners(null);
        }
        expect(calls).toEqual(['ping here true', 'frame there true']);
    });
});

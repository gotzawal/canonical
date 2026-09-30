import { describe, expect, it, vi } from 'vitest';
import { groupTotals, modelTotals, usageCsv, UsageLog } from '../../src/ai/usage';
import { newScene } from '../../src/core/defaults';
import { Store } from '../../src/core/store';
import { drawParams } from '../../src/openrouter/imageQuality';
import type { ImageModel } from '../../src/openrouter/images';

// The log is kept in IndexedDB, which Node has not: a map stands in.
vi.mock('../../src/core/db', () => {
    const kv = new Map<string, unknown>();
    return {
        kvGet: async (k: string) => kv.get(k),
        kvSet: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
        kvDelete: async (k: string) => void kv.delete(k),
    };
});

describe('image quality', () => {
    it('picks the resolution and quality a model lists for each level', () => {
        const model = {
            id: 'm',
            name: 'M',
            supported_parameters: { resolution: { type: 'enum', values: ['1K', '2K', '4K'] }, quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high'] } },
        } as ImageModel;
        expect(drawParams(model, 'low')).toEqual({ quality: 'low', resolution: '1K' });
        expect(drawParams(model, 'medium')).toEqual({ quality: 'medium', resolution: '1K' });
        expect(drawParams(model, 'high')).toEqual({ quality: 'high', resolution: '2K' });
        expect(drawParams({ ...model, supported_parameters: { resolution: { type: 'enum', values: ['0.5K', '1K', '2K'] } } }, 'low')).toEqual({ resolution: '0.5K' });
        // What a model does not list is left to it.
        expect(drawParams(undefined, 'high')).toEqual({});
    });
});

describe('usage log', () => {
    it('counts each piece of work, and keeps none that spent nothing', async () => {
        const log = new UsageLog(new Store(newScene()));
        await log.loading;
        const req = log.begin('request', 'Build a "cabin", please');
        req.chat('acme/model', { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.01 });
        req.chat('acme/model', { prompt_tokens: 1200, completion_tokens: 70, cost: 0.02 });
        req.sent(2, 'low');
        req.tool();
        req.images('acme/painter', 2, 0.08, 'high');
        req.end();
        log.begin('memo', 'Scene memo').end();
        // Calls of scripts in a row add up in one entry.
        log.script('acme/model', { prompt_tokens: 10, completion_tokens: 5 });
        log.script('acme/model', { prompt_tokens: 10, completion_tokens: 5 });

        expect(log.entries.map((e) => [e.kind, e.calls])).toEqual([['request', 2], ['script', 2]]);
        const e = log.entries[0];
        expect([e.prompt, e.cached, e.completion, e.sent, e.made, e.tools, e.seeQuality, e.drawQuality, e.running]).toEqual([2200, 800, 120, 2, 2, 1, 'low', 'high', undefined]);
        const t = log.totals();
        expect([t.count, t.calls, t.prompt, t.completion, t.made]).toEqual([2, 4, 2220, 130, 2]);
        expect(t.cost).toBeCloseTo(0.11);
        expect(modelTotals(log.entries).map(([m, x]) => [m, x.calls, x.made])).toEqual([['acme/model', 4, 0], ['acme/painter', 0, 2]]);
        expect(groupTotals(log.entries, (x) => x.kind).map(([k, x]) => [k, x.count])).toEqual([['request', 1], ['script', 1]]);
        expect(usageCsv(log.entries).split('\n')[1]).toContain('"Build a ""cabin"", please"');
    });

    it('keeps the totals of work it no longer lists', async () => {
        const log = new UsageLog(new Store(newScene()));
        await log.loading;
        for (let i = 0; i < 1003; i++) {
            const task = log.begin('request', `request ${i}`);
            task.chat('acme/model', { prompt_tokens: 1, completion_tokens: 1 });
            task.end();
        }
        expect(log.entries.length).toBe(1000);
        expect(log.entries[0].label).toBe('request 3');
        expect(log.totals().prompt).toBe(1003);
        log.clear();
        expect([log.entries.length, log.totals().count]).toEqual([0, 0]);
    });
});

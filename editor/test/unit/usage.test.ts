import { describe, expect, it, vi } from 'vitest';
import { groupTotals, modelTotals, usageCsv, UsageLog, workTotals } from '../../src/ai/usage';
import { newScene } from '../../src/core/defaults';
import { Store } from '../../src/core/store';
import { drawParams } from '../../src/openrouter/imageQuality';
import { dataUrlSize, imageTokens } from '../../src/openrouter/imageTokens';
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

    it('reads an image\'s size from its data and estimates its tokens per provider', () => {
        // A PNG header of a 1200 x 800 image.
        const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0xb0, 0, 0, 0x03, 0x20, 8, 2, 0, 0, 0];
        expect(dataUrlSize(`data:image/png;base64,${btoa(String.fromCharCode(...png))}`)).toEqual({ w: 1200, h: 800 });
        expect(imageTokens('anthropic/claude', 1024, 683, undefined)).toBe(933);
        expect(imageTokens('openai/gpt', 1024, 683, 'low')).toBe(85);
        expect(imageTokens('openai/gpt', 1024, 683, undefined)).toBe(85 + 170 * 4);
        expect(imageTokens('google/gemini', 1024, 683, undefined)).toBe(258 * 2);
    });
});

describe('usage log', () => {
    it('counts each piece of work and its time, and keeps none that spent nothing', async () => {
        const log = new UsageLog(new Store(newScene()));
        await log.loading;
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const req = log.begin('request', 'Build a "cabin", please');
        req.chat('acme/model', { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.01 }, { imageTokens: 300, work: 'objects', ms: 4000 });
        req.chat('acme/model', { prompt_tokens: 1200, completion_tokens: 70, cost: 0.02 }, { work: 'answer', ms: 1000 });
        req.sent(2, 'low');
        now = 5000;
        req.tool('images');
        req.images('acme/painter', 2, 0.08, 'high');
        now = 8000;
        req.end();
        clock.mockRestore();
        log.begin('memo', 'Scene memo').end();
        // Calls of scripts in a row add up in one entry.
        log.script('acme/model', { prompt_tokens: 10, completion_tokens: 5 });
        log.script('acme/model', { prompt_tokens: 10, completion_tokens: 5 });

        expect(log.entries.map((e) => [e.kind, e.calls])).toEqual([['request', 2], ['script', 2]]);
        const e = log.entries[0];
        expect([e.prompt, e.cached, e.completion, e.sent, e.made, e.tools, e.seeQuality, e.drawQuality, e.running]).toEqual([2200, 800, 120, 2, 2, 1, 'low', 'high', undefined]);
        // Split by what each call worked on; the images made count for the tool that made them.
        expect(e.imageTokens).toBe(300);
        expect(workTotals(log.entries).map(([k, x]) => [k, x.calls, x.prompt, x.imageTokens, x.made])).toEqual([['answer', 1, 1200, 0, 0], ['objects', 1, 1000, 300, 0], ['images', 0, 0, 0, 2]]);
        const t = log.totals();
        expect([t.count, t.calls, t.prompt, t.completion, t.made]).toEqual([2, 4, 2220, 130, 2]);
        expect(t.cost).toBeCloseTo(0.11);
        expect(modelTotals(log.entries).map(([m, x]) => [m, x.calls, x.made])).toEqual([['acme/model', 4, 0], ['acme/painter', 0, 2]]);
        expect(groupTotals(log.entries, (x) => x.kind).map(([k, x]) => [k, x.count])).toEqual([['request', 1], ['script', 1]]);
        // Its time: waiting for the model, and the tool running until the request ended; a script's calls are no work time.
        expect([e.ms, e.modelMs, e.toolMs, t.splitMs, log.workTime()]).toEqual([8000, 5000, 3000, 8000, 8000]);
        expect(workTotals(log.entries).map(([k, x]) => [k, x.ms])).toEqual([['answer', 1000], ['objects', 4000], ['images', 3000]]);
        const row = usageCsv(log.entries).split('\n')[1];
        expect(row).toContain('"Build a ""cabin"", please"');
        expect(row.endsWith(',5.0,3.0')).toBe(true);
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

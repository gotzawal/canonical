import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/ai/registry';
import { definition } from '../../src/ai/toolUtil';
import { ALL_TOOL_GROUPS } from '../../src/design/stages';

describe('tool registry', () => {
    it('names every tool once', () => {
        const names = TOOLS.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.every((n) => /^[a-z_]+$/.test(n))).toBe(true);
    });

    it('offers every tool in some stage group', () => {
        for (const t of TOOLS) {
            expect(t.groups.length, t.name).toBeGreaterThan(0);
            for (const g of t.groups) expect(ALL_TOOL_GROUPS, `${t.name}: ${g}`).toContain(g);
        }
    });

    it('describes arguments the model can send', () => {
        for (const t of TOOLS) {
            const { parameters } = definition(t).function;
            expect(parameters.type).toBe('object');
            for (const r of t.required ?? []) expect(Object.keys(parameters.properties as object), `${t.name} requires ${r}`).toContain(r);
            expect(JSON.stringify(parameters), t.name).not.toMatch(/undefined/);
        }
    });
});

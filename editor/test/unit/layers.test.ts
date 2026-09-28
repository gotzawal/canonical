import { describe, expect, it } from 'vitest';

// The layers of editor/src: the editor, the pipeline, Play and the assistant
// report to the UI through events (core/messages.ts, the editor's events)
// instead of importing it, and what editor.ts is built from never imports it.

const sources = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const modules = new Map(Object.entries(sources).map(([file, text]) => [file.slice('../../src/'.length, -'.ts'.length), text]));

/** Modules a module imports, type imports included: "core/store" for '../core/store'. */
function importsOf(name: string): string[] {
    const out: string[] = [];
    for (const [, spec] of modules.get(name)!.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'";]*?from\s+['"](\.[^'"]+)['"]/g)) {
        const parts = name.split('/').slice(0, -1);
        for (const p of spec.split('/')) {
            if (p === '..') parts.pop();
            else if (p !== '.') parts.push(p);
        }
        const target = [parts.join('/'), parts.join('/') + '/index'].find((t) => modules.has(t));
        if (target) out.push(target);
    }
    return out;
}

describe('layers', () => {
    it('keeps the UI out of the code below it', () => {
        const below = /^(core|engine|play|design|ai|openrouter|build)\/|^editor$/;
        const wrong = [...modules.keys()].filter((m) => below.test(m)).flatMap((m) => importsOf(m).filter((d) => d.startsWith('ui/')).map((d) => `${m} -> ${d}`));
        expect(wrong).toEqual([]);
    });

    it('builds the editor from modules that do not import it', () => {
        const seen = new Set<string>();
        const todo = importsOf('editor');
        while (todo.length) {
            const m = todo.pop()!;
            if (seen.has(m)) continue;
            seen.add(m);
            todo.push(...importsOf(m));
        }
        expect(seen.has('editor')).toBe(false);
        expect(seen.has('ai/agent')).toBe(false);
    });
});

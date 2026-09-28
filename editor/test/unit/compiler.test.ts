import { describe, expect, it } from 'vitest';
import { emptyScene } from '../../src/core/defaults';
import { Store } from '../../src/core/store';
import { PAUSED_MESSAGE, ScriptCompiler, scriptLocation, transformModule } from '../../src/play/compiler';

const scriptDoc = (code: string, name = 'Spin.js') => ({ id: 's_1', name, code });

describe('transformModule', () => {
    it('turns imports and exports into plain code on the same lines', () => {
        const src = "import { Vector3 } from '@orillusion/core';\nimport Script from 'canonical';\nexport default class Spin extends Script {}\n";
        const t = transformModule(src);
        expect(t.error).toBeNull();
        expect(t.defaultName).toBe('Spin');
        expect(t.code.split('\n').length).toBe(src.split('\n').length);
        expect(t.code).toContain('const { Vector3 } = __import("@orillusion/core");');
        expect(t.code).toContain('class Spin extends Script');
        expect(t.code).not.toMatch(/\bexport\b/);
    });

    it('refuses modules scripts cannot import, with the line', () => {
        const t = transformModule("// a comment\nimport fs from 'fs';\n");
        expect(t.error).toMatchObject({ line: 2 });
        expect(t.error!.message).toMatch(/Cannot import "fs"/);
    });
});

describe('ScriptCompiler', () => {
    const compiler = (trusted = true) => new ScriptCompiler(new Store(emptyScene()), trusted);

    it('finds the class, its fields and its lifecycle methods', () => {
        const c = compiler().compile(scriptDoc(`export default class Spin extends Script {
    speed = 90;
    axis = [0, 1, 0];
    tint = '#ff8800';
    label = 'spin';
    ignored = { a: 1 };
    update(dt) {}
    onClick() {}
}`));
        expect(c.error).toBeNull();
        expect(c.className).toBe('Spin');
        expect(c.methods).toEqual(expect.arrayContaining(['update', 'onClick']));
        expect(c.fields).toEqual([
            { name: 'speed', type: 'number', default: 90 },
            { name: 'axis', type: 'vec3', default: [0, 1, 0] },
            { name: 'tint', type: 'color', default: '#ff8800' },
            { name: 'label', type: 'string', default: 'spin' },
        ]);
    });

    it('asks for a class that extends Script', () => {
        const c = compiler().compile(scriptDoc('export default class Plain {}'));
        expect(c.cls).toBeNull();
        expect(c.error!.message).toMatch(/extends Script/);
    });

    it('reports errors thrown while the module runs', () => {
        const c = compiler().compile(scriptDoc("throw new TypeError('boom');"));
        expect(c.error!.message).toBe('TypeError: boom');
    });

    it('never runs scripts while they are paused', () => {
        const c = compiler(false).compile(scriptDoc("globalThis.ran = true; export default class A extends Script {}"));
        expect(c.paused).toBe(true);
        expect(c.error!.message).toBe(PAUSED_MESSAGE);
        expect((globalThis as any).ran).toBeUndefined();
    });

    it('maps stack frames of scripts to their lines', () => {
        const err = { stack: 'Error: x\n    at Spin.update (canonical-script/s_1/Spin.js:5:9)' };
        expect(scriptLocation(err)).toEqual({ id: 's_1', name: 'Spin.js', line: 4, column: 9 });
        expect(scriptLocation(new Error('elsewhere'))).toBeNull();
    });
});

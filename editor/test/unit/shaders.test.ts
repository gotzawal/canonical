import { describe, expect, it } from 'vitest';
import { SHADER_TEMPLATES } from '../../src/core/templates';
import { buildSource, parseShader } from '../../src/engine/shaders';

const material = (body: string) => `fn frag() {\n${body}\n}\n`;

describe('material shaders that read the scene behind them', () => {
    it('are found by the scene helpers they call', () => {
        expect(parseShader(material('let d = sceneDepth(screenUV()) - surfaceDepth();'), 'material').usesScene).toBe(true);
        expect(parseShader(material('let c = sceneBehind(screenUV(), 0.0);'), 'material').usesScene).toBe(true);
        expect(parseShader(material('let c = vec3f(1.0);'), 'material').usesScene).toBe(false);
        // Post shaders have their own sceneColor and never get these.
        expect(parseShader('fn post(uv: vec2f) -> vec4f { let d = sceneDepth(uv); return vec4f(d); }', 'post').usesScene).toBe(false);
    });

    it('get the scene bindings and helpers in their source', () => {
        const parsed = parseShader(material('let c = sceneBehind(screenUV(), 0.0);'), 'material');
        const src = buildSource({ kind: 'material', lighting: 'lit' }, parsed);
        expect(src).toContain('var sceneColorPyramid: texture_2d<f32>;');
        expect(src).toContain('var sceneDepthMap: texture_depth_2d;');
        expect(src).toContain('fn sceneDepth(uv: vec2f) -> f32');
        // The helpers come before the user code, so error lines still match.
        expect(src.indexOf('fn sceneBehind(')).toBeLessThan(src.indexOf('morglay_user_code_begin'));
        expect(buildSource({ kind: 'material', lighting: 'lit' }, parseShader(material(''), 'material'))).not.toContain('sceneDepthMap');
    });

    it('cannot be shadowed by properties named like their textures', () => {
        const parsed = parseShader('// @property sceneDepthMap float 1\n' + material(''), 'material');
        expect(parsed.errors.map((e) => e.message).join()).toMatch(/reserved/);
    });

    it('include the Water template, which also reads the mirror', () => {
        const water = SHADER_TEMPLATES.find((t) => t.id === 'water')!;
        const parsed = parseShader(water.code, 'material');
        expect(parsed.errors).toEqual([]);
        expect(parsed.usesScene).toBe(true);
        expect(parsed.usesMirror).toBe(true);
        expect(parsed.usesTerrain).toBe(false);
        expect(parsed.props.map((p) => p.name)).toEqual(expect.arrayContaining(['absorption', 'scattering', 'clarity', 'distortion', 'foamWidth', 'caustics']));
    });
});

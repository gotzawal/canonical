import { expect, test } from '@playwright/test';
import { scriptedAssistant, sharedEditor, toolResults, type ScriptedCall } from './editor';

let assistant: Awaited<ReturnType<typeof scriptedAssistant>>;
const editor = sharedEditor(async (page) => {
    assistant = await scriptedAssistant(page);
});

test.beforeEach(() => editor.reset());
test.afterEach(() => expect(editor.errors).toEqual([]));

/** Sends a request that the assistant answers with `turns` of tool calls; resolves with the tool results. */
async function ask(turns: ScriptedCall[][]): Promise<unknown[]> {
    const before = assistant.sent.length;
    assistant.turns = [...turns, 'Done.'];
    await editor.page().evaluate(() => window.__editor.askAI('Build it.', true));
    await expect.poll(() => assistant.sent.length, { timeout: 60_000 }).toBe(before + turns.length + 1);
    return toolResults(assistant.sent.slice(before));
}

const node = (name: string) => editor.page().evaluate((n) => window.__editor.store.doc.nodes.find((x) => x.name === n), name);

test('offers component fields in the tool schemas', async () => {
    await ask([]);
    const tools = assistant.sent[assistant.sent.length - 1].tools as { function: { name: string; parameters: any } }[];
    const create = tools.find((t) => t.function.name === 'create_objects')!.function.parameters;
    const fields = create.properties.objects.items.properties;
    expect(fields.character.properties.step_height).toMatchObject({ type: 'number', minimum: 0 });
    expect(fields.light.properties.outer_angle).toMatchObject({ minimum: 1, maximum: 179 });
    expect(fields.material.properties.transmission).toMatchObject({ minimum: 0, maximum: 1 });
    expect(fields.material.properties.preset.enum).toContain('glass');
});

test('creates and changes objects, the environment and particles with its tools', async () => {
    const results = await ask([
        [{
            name: 'create_objects',
            args: {
                objects: [
                    { type: 'capsule', name: 'Guard', position: [2, 0.9, 0], character: { step_height: 0.5, run_speed: 7 }, material: { color: 'red', roughness: 2, transmission: 0.5 } },
                    { type: 'spot_light', name: 'Lamp', position: [0, 4, 0], light: { outer_angle: 45, cast_shadow: true } },
                ],
            },
        }],
        [
            { name: 'set_environment', args: { bloom: { enable: true, intensity: 1.5 }, fog: { color: '#223344' }, gi: { counts: [40, 2, 40] } } },
            { name: 'add_particles', args: { preset: 'fire', name: 'Fire', position: [0, 0.2, 0], life: [2, 1] } },
        ],
        [{ name: 'update_objects', args: { updates: [{ id: 'Guard', player: { view: 'first' } }] } }],
    ]);
    expect(results.filter((r: any) => r?.error)).toEqual([]);

    const guard = (await node('Guard'))!;
    expect(guard.character).toMatchObject({ stepHeight: 0.5, runSpeed: 7 });
    expect(guard.player!.view).toBe('first');
    expect(guard.mesh!.material).toMatchObject({ color: '#ff0000', roughness: 1, transmission: 0.5 });
    expect((await node('Lamp'))!.light).toMatchObject({ type: 'spot', outerAngle: 45, castShadow: true });
    expect((await node('Fire'))!.particles!.life).toEqual([1, 2]);
    const env = await editor.page().evaluate(() => window.__editor.store.doc.environment);
    expect(env.bloom).toEqual({ enable: true, intensity: 1.5, threshold: 1 });
    expect(env.fog.color).toBe('#223344');
    expect(env.gi.counts.every((c) => c <= 16)).toBe(true);
});

test('tells the assistant which argument does not fit', async () => {
    const [result] = await ask([[{ name: 'create_objects', args: { objects: [{ type: 'box', name: 'Crate', character: { speed: 'fast' } }] } }]]);
    expect((result as { error: string }).error).toMatch(/character\.speed/);
    expect(await node('Crate')).toBeUndefined();
});

test('offers only the tools the AI settings allow and refuses the others', async () => {
    const [result] = await ask([[{ name: 'play', args: {} }]]);
    expect((result as { error: string }).error).toBe('Play is turned off in the AI settings.');
    const names = (assistant.sent[assistant.sent.length - 1].tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toContain('get_scene');
    for (const off of ['play', 'run_play_test', 'capture_viewport', 'generate_swatch', 'generate_concept']) expect(names).not.toContain(off);
});

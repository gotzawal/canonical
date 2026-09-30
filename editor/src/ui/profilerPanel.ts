// The Profiler tab of the dock: what a frame costs, and what takes the GPU
// memory and the download. Frame: the frame rate, the engine's CPU time and,
// per render graph pass, CPU time, draws, triangles and, on devices with
// timestamp queries, GPU time. GPU memory: textures by kind and buffers by
// use, then every texture, largest first. Download: what a build ships for
// each asset the scene uses. Everything downloads as a JSON report.

import { formatBytes } from '../core/assets';
import { download } from '../core/persistence';
import type { Editor } from '../editor';
import { assetSizes, type AssetSize } from '../build/sizes';
import { TEXTURE_CLASSES, type GpuSnapshot, type PassStats, type TextureClass, type TextureInfo } from '../engine/gpuStats';
import { onChanges } from './batch';
import { clear, h } from './dom';
import { icon } from './icons';
import { SelectField, button } from './widgets';

export const TEXTURE_KINDS: Record<TextureClass, string> = {
    image: 'Scene textures and images',
    data: 'Data textures (tables, generated)',
    shadow: 'Shadow maps',
    environment: 'Sky and environment maps',
    target: 'Render targets (screen buffers)',
    other: 'Compute outputs (post effects, depth pyramid, GI)',
};

/**
 * What a texture is for, by its name: the effect or part of the renderer
 * that made it. The first pattern that matches names it.
 */
const OWNERS: [RegExp, string][] = [
    [/^gtao/i, 'Ambient occlusion'],
    [/^ssr/i, 'Screen space reflections'],
    [/^fogTex/, 'Fog'],
    [/^VolumetricFog/, 'Volumetric fog'],
    [/^godRay/, 'God rays'],
    [/^bloom/, 'Bloom'],
    [/^(irradiance|giLighting|giBounce|giProbe)/, 'Global illumination probes'],
    [/^reflection/i, 'Reflection probes'],
    [/^terrain/, 'Terrain layers'],
    [/^_MotionVector/, 'Motion vectors'],
    [/^_HiZPyramid/, 'Depth pyramid'],
    [/^_SceneColorPyramid/, 'Scene color for see-through materials'],
    [/^(ColorPassGBuffer|zPreDepth)/, 'Scene color, depth and G-buffer'],
    [/^(FXAAPost|TonemapPost)/, 'Anti-aliasing and tone mapping'],
];

/** What uses a texture: its class for scene textures, shadows and skies, else the effect that made it. */
export function textureOwner(t: Pick<TextureInfo, 'label' | 'width' | 'height' | 'format' | 'cls'>): string {
    if (t.cls === 'image' || t.cls === 'data' || t.cls === 'shadow' || t.cls === 'environment') return TEXTURE_KINDS[t.cls];
    const name = textureName(t);
    for (const [re, owner] of OWNERS) if (re.test(name)) return owner;
    return t.cls === 'target' ? 'Other render targets' : 'Other compute outputs';
}

const PASS_NAMES: Record<string, string> = {
    'Outside the graph': 'Engine updates (outside the graph)',
};

/** Rows the texture list shows. */
const TEXTURE_ROWS = 80;

export class ProfilerPanel {
    readonly el: HTMLElement;
    private summary: HTMLElement;
    private frameCol: HTMLElement;
    private memoryCol: HTMLElement;
    private sizeCol: HTMLElement;
    private visible = false;
    private timer = 0;
    private filter: TextureClass | 'all' = 'all';
    private sizes: AssetSize[] | null = null;
    private sizesKey = '';
    private sizing = false;

    constructor(private editor: Editor) {
        this.summary = h('span', { class: 'graph-summary' });
        this.frameCol = h('div', { class: 'profiler-col' });
        this.memoryCol = h('div', { class: 'profiler-col' });
        this.sizeCol = h('div', { class: 'profiler-col' });
        this.el = h(
            'div',
            { class: 'graph-panel profiler' },
            h(
                'div',
                { class: 'graph-toolbar' },
                icon('gauge', 15),
                h('span', { class: 'graph-title', text: 'Profiler' }),
                this.summary,
                h('div', { class: 'spacer' }),
                button('Download report', () => void this.report(), 'small subtle', 'save'),
            ),
            h('div', { class: 'profiler-body' }, this.frameCol, this.memoryCol, this.sizeCol),
        );
        // New assets, other compression or other uses of them change the download (a drag does not).
        onChanges(editor.store, (hint) => {
            if (!hint?.transform) this.sizesKey = '';
        });
        editor.store.on('load', () => (this.sizesKey = ''));
    }

    setVisible(v: boolean) {
        this.visible = v;
        const stats = this.editor.runtime.stats;
        if (stats) stats.profileGpu = v;
        clearInterval(this.timer);
        if (!v) return;
        this.render();
        this.timer = window.setInterval(() => this.render(), 1000);
    }

    private render() {
        if (!this.visible) return;
        const stats = this.editor.runtime.stats;
        if (!stats) {
            clear(this.frameCol);
            this.frameCol.append(h('p', { class: 'muted small pad', text: 'GPU statistics are off in this view.' }));
            return;
        }
        const s = stats.snapshot(60);
        const passes = stats.passes(60);
        const gpu = passes.some((p) => p.gpu !== null) ? passes.reduce((n, p) => n + (p.gpu ?? 0), 0) : null;
        this.summary.textContent = [
            `${this.editor.runtime.fps.toFixed(0)} fps`,
            `CPU ${s.cpu.median.toFixed(1)} ms`,
            gpu !== null ? `GPU ${gpu.toFixed(1)} ms` : '',
            `${s.peak.draws.toLocaleString('en-US')} draws`,
            `${formatBytes(s.memory.stable)} GPU memory`,
        ].filter(Boolean).join(' · ');
        this.renderFrame(s, passes, stats.gpuTimed);
        this.renderMemory(s, stats.textures());
        void this.renderSizes();
    }

    private renderFrame(s: GpuSnapshot, passes: PassStats[], timed: boolean) {
        clear(this.frameCol);
        const cpu = passes.reduce((n, p) => n + p.cpu, 0);
        const gpu = passes.some((p) => p.gpu !== null) ? passes.reduce((n, p) => n + (p.gpu ?? 0), 0) : null;
        const most = Math.max(0.001, ...passes.map((p) => Math.max(p.cpu, p.gpu ?? 0)));
        const ms = (v: number | null) => (v === null ? '-' : v < 0.05 ? '<0.1' : v.toFixed(1));
        this.frameCol.append(
            h('div', { class: 'group-label', text: 'Frame' }),
            h('div', {
                class: 'muted small',
                text: `Median ${s.cpu.median.toFixed(1)} ms of CPU for the engine (95% of frames under ${s.cpu.p95.toFixed(1)} ms), ${s.peak.renderPasses} render and ${s.peak.computePasses} compute passes, ${s.peak.triangles.toLocaleString('en-US')} triangles. Averages of the last second, per pass in the order they run.`,
            }),
            table(
                ['Pass', 'CPU ms', 'GPU ms', 'Draws', 'Triangles', ''],
                [
                    ...passes.map((p) => [
                        PASS_NAMES[p.name] ?? p.name,
                        ms(p.cpu),
                        ms(p.gpu),
                        Math.round(p.draws).toLocaleString('en-US'),
                        Math.round(p.triangles).toLocaleString('en-US'),
                        bar(Math.max(p.cpu, p.gpu ?? 0) / most),
                    ]),
                    ['Total', ms(cpu), ms(gpu), Math.round(passes.reduce((n, p) => n + p.draws, 0)).toLocaleString('en-US'), Math.round(passes.reduce((n, p) => n + p.triangles, 0)).toLocaleString('en-US'), ''],
                ],
                1,
            ),
            h('div', {
                class: 'muted small',
                text: timed
                    ? 'GPU times come from timestamp queries, a few frames apart; the browser may round them to a tenth of a millisecond.'
                    : 'GPU time per pass is not available here: it needs timestamp queries that the device reports back. The CPU times are what recording each pass costs.',
            }),
        );
    }

    private renderMemory(s: GpuSnapshot, textures: TextureInfo[]) {
        clear(this.memoryCol);
        const m = s.memory;
        const b = m.buffers;
        const rows: [string, number, number][] = [
            ...TEXTURE_CLASSES.map((c) => [TEXTURE_KINDS[c], m.textures[c].count, m.textures[c].bytes] as [string, number, number]),
            ['Geometry buffers (vertices, indices)', b.vertex.count + b.index.count, b.vertex.bytes + b.index.bytes],
            ['Uniform and storage buffers', b.uniform.count + b.storage.count + b.other.count, b.uniform.bytes + b.storage.bytes + b.other.bytes],
        ];
        const most = Math.max(1, ...rows.map((r) => r[2]));
        const filter = new SelectField<TextureClass | 'all'>(
            [{ value: 'all', label: 'All textures' }, ...TEXTURE_CLASSES.map((c) => ({ value: c, label: TEXTURE_KINDS[c] }))],
            this.filter,
            (v) => {
                this.filter = v;
                this.render();
            },
        );
        const shown = textures.filter((t) => this.filter === 'all' || t.cls === this.filter);
        // The screen's buffers and the effects' textures, by what made them.
        const owners = new Map<string, [number, number]>();
        for (const t of textures) {
            if (t.cls === 'image' || t.cls === 'data') continue;
            const o = owners.get(textureOwner(t)) ?? [0, 0];
            owners.set(textureOwner(t), [o[0] + 1, o[1] + t.bytes]);
        }
        const byOwner = [...owners].sort((a, b) => b[1][1] - a[1][1]);
        const mostOwner = Math.max(1, ...byOwner.map(([, [, bytes]]) => bytes));
        this.memoryCol.append(
            h('div', { class: 'group-label', text: 'GPU memory' }),
            h('div', { class: 'muted small', text: `${formatBytes(m.stable)} the editor asked for (an estimate: drivers pad textures, and the browser allocates for itself).` }),
            table(['Kind', 'Count', 'Size', ''], rows.map(([name, count, bytes]) => [name, count.toLocaleString('en-US'), formatBytes(bytes), bar(bytes / most)]), 1),
            h('div', { class: 'group-label', text: 'Render targets, effects and shadows' }),
            table(['Used by', 'Textures', 'Size', ''], byOwner.map(([name, [count, bytes]]) => [name, count.toLocaleString('en-US'), formatBytes(bytes), bar(bytes / mostOwner)]), 1),
            h('div', { class: 'profiler-filter' }, h('div', { class: 'group-label', text: `Textures (${shown.length})` }), filter.el),
            table(
                ['Texture', 'Size', 'Format', 'Memory'],
                shown.slice(0, TEXTURE_ROWS).map((t) => [
                    h('span', { class: 'profiler-name', text: textureName(t), title: `${textureOwner(t)}\n${TEXTURE_KINDS[t.cls]}\n${t.label || '(no label)'}` }),
                    `${t.width} x ${t.height}${t.layers > 1 ? ` x ${t.layers}` : ''}${t.mips > 1 ? `, ${t.mips} mips` : ''}${t.samples > 1 ? `, ${t.samples}x` : ''}`,
                    t.format,
                    formatBytes(t.bytes),
                ]),
                3,
            ),
        );
        if (shown.length > TEXTURE_ROWS) this.memoryCol.append(h('div', { class: 'muted small', text: `${shown.length - TEXTURE_ROWS} smaller ones not listed (the report has them all).` }));
    }

    private async renderSizes() {
        const doc = this.editor.store.doc;
        const key = JSON.stringify(doc.assets.map((a) => [a.id, a.size, a.compress, a.packed?.size]));
        if (key !== this.sizesKey && !this.sizing) {
            this.sizing = true;
            try {
                this.sizes = await assetSizes(doc);
                this.sizesKey = key;
            } catch {
                this.sizes = null;
            } finally {
                this.sizing = false;
            }
        }
        if (!this.visible) return;
        clear(this.sizeCol);
        const sizes = this.sizes ?? [];
        const shipped = sizes.reduce((n, a) => n + a.shipped, 0);
        const files = sizes.reduce((n, a) => n + a.file, 0);
        const pending = sizes.filter((a) => a.how === 'pending').length;
        const most = Math.max(1, ...sizes.map((a) => a.shipped));
        const HOW: Record<AssetSize['how'], string> = { file: 'file', copy: 'compressed', pending: 'file (copy not made yet)' };
        this.sizeCol.append(
            h('div', { class: 'group-label', text: 'Download' }),
            h('div', {
                class: 'muted small',
                text: sizes.length
                    ? `The assets the scene uses: ${formatBytes(shipped)} in a build with Compress on (the files are ${formatBytes(files)}), plus the player app.${pending ? ` ${pending} copies are not made yet and count as their files.` : ''}`
                    : 'The scene uses no asset files.',
            }),
        );
        if (sizes.length) {
            this.sizeCol.append(
                table(
                    ['Asset', 'Kind', 'File', 'Shipped', ''],
                    sizes.map((a) => [
                        h('span', { class: 'profiler-name', text: a.name, title: HOW[a.how] }),
                        a.kind,
                        formatBytes(a.file),
                        `${formatBytes(a.shipped)}${a.how === 'pending' ? ' *' : ''}`,
                        bar(a.shipped / most),
                    ]),
                    2,
                ),
            );
        }
    }

    /** Everything the tab shows, and every texture, as a JSON file. */
    private async report() {
        const stats = this.editor.runtime.stats;
        const doc = this.editor.store.doc;
        const s = stats?.snapshot(60);
        const data = {
            scene: doc.name,
            at: new Date().toISOString(),
            fps: Math.round(this.editor.runtime.fps * 10) / 10,
            frame: s ? { cpuMs: { median: s.cpu.median, p95: s.cpu.p95 }, counts: s.peak, gpuTimed: stats!.gpuTimed, passes: stats!.passes(60) } : null,
            memory: s?.memory ?? null,
            textures: stats?.textures().map((t) => ({ ...t, name: textureName(t), kind: TEXTURE_KINDS[t.cls], usedBy: textureOwner(t) })) ?? [],
            buffers: stats?.buffers() ?? [],
            assets: await assetSizes(doc),
        };
        const stem = doc.name.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scene';
        download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${stem}-profile.json`);
    }
}

/**
 * A texture's name from its label: the engine labels textures with their
 * name, size and format run together, and unnamed ones with an id.
 */
export function textureName(t: Pick<TextureInfo, 'label' | 'width' | 'height' | 'format'>): string {
    let name = t.label;
    const tail = `${t.width}${t.height}${t.format}`;
    if (name.endsWith(tail)) name = name.slice(0, -tail.length);
    if (!name || name === 'NaN' || name === 'undefined' || /^[0-9a-f]{8,}(-[0-9a-f]{4,})*$/i.test(name)) return '(unnamed)';
    return name;
}

function bar(f: number): HTMLElement {
    return h('div', { class: 'profiler-bar' }, h('div', { style: { width: `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%` } }));
}

/** A table whose first `words` columns are text, the rest numbers. */
function table(head: string[], rows: (string | HTMLElement | null)[][], words: number): HTMLElement {
    const cls = (i: number) => (i < words ? 'word' : '');
    return h(
        'table',
        { class: 'usage-table profiler-table' },
        h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: cls(i), text: c })))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: cls(i) }, c ?? ''))))),
    );
}

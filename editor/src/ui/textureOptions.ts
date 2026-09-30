// How a texture or model asset ships in games: as its compressed copy or as
// its file, with its textures at what size, and what that saves. Opened
// from the texture rows of the inspector (for the role the row uses the
// texture in) and from its Model section.

import { formatBytes, getAssetBlob, imageSize } from '../core/assets';
import { DEFAULT_MAX_SIZE, derivedOptions, MAX_SIZES, shipsAsIs, shipsCopy, type DerivedRole } from '../core/derived';
import type { TextureCompression } from '../core/types';
import { gltfExtensions } from '../build/modelInfo';
import { copyBlockBytes, encodedSize, textureMemory } from '../derive/encode';
import type { Editor } from '../editor';
import { h } from './dom';
import { popover } from './overlays';
import { button, row, SelectField } from './widgets';

const ROLE_TEXT: Record<DerivedRole, string> = { color: 'as a color map', normal: 'as a normal map', data: 'as a data map', model: 'for games' };

type Mode = NonNullable<TextureCompression['mode']>;

/** What the file tells about itself: an image's size, whether a model is Draco compressed. */
interface FileFacts {
    size: { width: number; height: number } | null;
    draco: boolean;
}

export function openTextureOptions(editor: Editor, anchor: HTMLElement, assetId: string, role: DerivedRole) {
    const body = h('div', { class: 'texture-options' });
    const model = role === 'model';
    let facts: FileFacts | null = null;
    let offStatus = () => {};
    const close = popover(anchor, body, 'texture-options-popover', () => offStatus());

    const render = async () => {
        const meta = editor.store.doc.assets.find((a) => a.id === assetId);
        if (!meta) return close();
        const mode: Mode = meta.compress?.mode ?? 'auto';
        const modeField = new SelectField<Mode>(
            [
                { value: 'auto', label: model ? 'Auto (ETC1S colors, UASTC maps)' : role === 'color' ? 'Auto (ETC1S, smallest)' : 'Auto (UASTC)' },
                { value: 'high', label: 'High quality (UASTC)' },
                { value: 'off', label: 'Off (ship the file)' },
            ],
            mode,
            (v) => editor.setTextureCompression(assetId, { mode: v }),
        );
        const sizeField = new SelectField<string>(
            [{ value: '0', label: `Auto (${DEFAULT_MAX_SIZE})` }, ...MAX_SIZES.map((n) => ({ value: String(n), label: String(n) }))],
            String(meta.compress?.maxSize ?? 0),
            (v) => editor.setTextureCompression(assetId, { maxSize: Number(v) || undefined }),
        );
        const status = editor.derived.statusOf(meta, role);
        const opts = derivedOptions(role, meta.compress);
        if (!facts) {
            const blob = await getAssetBlob(assetId);
            facts = {
                size: blob && !model ? await imageSize(blob).catch(() => null) : null,
                draco: !!blob && model && !!(await gltfExtensions(blob))?.includes('KHR_draco_mesh_compression'),
            };
        }
        const { size, draco } = facts;
        // Compressed already: the file is what games get, whatever the options.
        const asIs = shipsAsIs(meta) || draco;
        const lines: string[] = [];
        let action: HTMLElement | null = null;
        if (meta.packed) lines.push(`Compressed in the editor: it replaced ${meta.packed.from} (${formatBytes(meta.packed.size)}), and games get it as it is.`);
        else if (asIs) lines.push(draco ? 'Draco compressed already: games get the file as it is.' : 'A KTX2 file already: games get it as it is.');
        else if (!opts) lines.push('Games get the file itself.');
        else if (status.state === 'ready' && status.copy) {
            const c = status.copy;
            if (model) {
                const textures = c.textures ?? 0;
                lines.push(`Ready: ${formatBytes(c.bytes)} to download (the file is ${formatBytes(meta.size)}), with ${textures} texture${textures === 1 ? '' : 's'} in KTX2 and packed geometry.`);
                if (!shipsCopy({ role, bytes: c.bytes, textures }, meta)) lines.push('It saves nothing here, so games get the file.');
            } else {
                lines.push(`Ready: ${c.opts.codec.toUpperCase()} ${c.width} x ${c.height}, ${formatBytes(c.bytes)} to download (the file is ${formatBytes(meta.size)}).`);
                if (size) lines.push(`GPU memory: ${formatBytes(textureMemory(size.width, size.height))} as the file, ${formatBytes(textureMemory(c.width, c.height, copyBlockBytes(c.opts.codec, c.alpha)))} compressed.`);
            }
        } else {
            if (status.state === 'queued') lines.push('Waiting to be compressed.');
            else if (status.state === 'encoding') lines.push('Compressing...');
            else if (status.state === 'failed') lines.push(`Compression failed: ${status.error ?? 'unknown error'}. Games get the file.`);
            else lines.push(editor.store.prefs.backgroundCompression ? 'Not compressed yet: it is made in the background, or when you build.' : 'Not compressed yet: it is made when you build.');
            if (model) lines.push('Its textures go to KTX2 (a quarter or less of the GPU memory) and its geometry is packed without loss.');
            else if (size) {
                const s = encodedSize(size.width, size.height, opts.maxSize);
                lines.push(`GPU memory: ${formatBytes(textureMemory(size.width, size.height))} as the file, about ${formatBytes(textureMemory(s.width, s.height, copyBlockBytes(opts.codec, false)))} compressed.`);
            }
            if (status.state === 'none' || status.state === 'failed') {
                action = button('Compress Now', () => void editor.derived.ensure(meta, role).catch(() => {}), 'small');
            }
        }
        // Keep only the compressed file (the project gets smaller; the options then no longer apply).
        let replace: HTMLElement | null = null;
        if (!asIs && opts) {
            replace = editor.derived.isPacking(assetId)
                ? h('div', { class: 'muted small', text: 'Compressing the file...' })
                : button('Compress File', () => void editor.compressFiles([assetId]), 'small', undefined);
            replace.title = 'Replaces the original with its compressed form, which the editor and games then use; the original is removed from the project.';
        }
        body.replaceChildren(
            h('div', { class: 'texture-options-title', text: `${meta.name} ${ROLE_TEXT[role]}` }),
            ...(asIs
                ? []
                : [
                    row('Compression', modeField.el, model
                        ? 'How its textures are encoded: ETC1S is the smallest and suits colors; UASTC keeps normal and data maps (and sharp colors) close to the file.'
                        : 'ETC1S is the smallest and suits colors; UASTC keeps normal and data maps (and sharp colors) close to the file.'),
                    row(model ? 'Texture Size' : 'Max Size', sizeField.el, model ? 'The longest side of each of its textures, in pixels' : 'The longer side of the copy, in pixels'),
                ]),
            h('div', { class: 'texture-options-status muted small' }, ...lines.map((text) => h('div', { text }))),
            h('div', { class: 'inline' }, ...(action ? [action] : []), ...(replace ? [replace] : [])),
        );
    };
    offStatus = editor.derived.on('status', (id) => id === assetId && void render());
    // Asset option changes (and their undo); object edits and drags leave it be.
    const offChange = editor.store.on('change', (hint) => {
        if (hint && (hint.nodes || hint.env || hint.behavior)) return;
        void render();
    });
    const stop = offStatus;
    offStatus = () => {
        stop();
        offChange();
    };
    void editor.derived.check(editor.store.doc.assets.find((a) => a.id === assetId)!, role).then(() => render());
    void render();
}

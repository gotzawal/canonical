// How a texture asset ships in games: compressed (KTX2) or as its file, at
// what size, and what that saves. Opened from the texture rows of the
// inspector for the role the row uses the texture in.

import { formatBytes, getAssetBlob, imageSize } from '../core/assets';
import { DEFAULT_MAX_SIZE, derivedOptions, MAX_SIZES, shipsAsIs } from '../core/derived';
import type { TextureCompression, TextureRole } from '../core/types';
import { copyBlockBytes, encodedSize, textureMemory } from '../derive/encode';
import type { Editor } from '../editor';
import { h } from './dom';
import { popover } from './overlays';
import { button, row, SelectField } from './widgets';

const ROLE_TEXT: Record<TextureRole, string> = { color: 'a color map', normal: 'a normal map', data: 'a data map' };

type Mode = NonNullable<TextureCompression['mode']>;

export function openTextureOptions(editor: Editor, anchor: HTMLElement, assetId: string, role: TextureRole) {
    const body = h('div', { class: 'texture-options' });
    const sizeCache: { value?: { width: number; height: number } | null } = {};
    let offStatus = () => {};
    const close = popover(anchor, body, 'texture-options-popover', () => offStatus());

    const render = async () => {
        const meta = editor.store.doc.assets.find((a) => a.id === assetId);
        if (!meta) return close();
        const mode: Mode = meta.compress?.mode ?? 'auto';
        const modeField = new SelectField<Mode>(
            [
                { value: 'auto', label: role === 'color' ? 'Auto (ETC1S, smallest)' : 'Auto (UASTC)' },
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
        if (sizeCache.value === undefined) {
            const blob = await getAssetBlob(assetId);
            sizeCache.value = blob ? await imageSize(blob).catch(() => null) : null;
        }
        const size = sizeCache.value;
        const lines: string[] = [];
        let action: HTMLElement | null = null;
        const ktx2 = shipsAsIs(meta);
        if (ktx2) lines.push('A KTX2 file already: games get it as it is.');
        else if (!opts) lines.push('Games get the file itself.');
        else if (status.state === 'ready' && status.copy) {
            const c = status.copy;
            lines.push(`Ready: ${c.opts.codec.toUpperCase()} ${c.width} x ${c.height}, ${formatBytes(c.bytes)} to download (the file is ${formatBytes(meta.size)}).`);
            if (size) lines.push(`GPU memory: ${formatBytes(textureMemory(size.width, size.height))} as the file, ${formatBytes(textureMemory(c.width, c.height, copyBlockBytes(c.opts.codec, c.alpha)))} compressed.`);
        } else {
            if (status.state === 'queued') lines.push('Waiting to be compressed.');
            else if (status.state === 'encoding') lines.push('Compressing...');
            else if (status.state === 'failed') lines.push(`Compression failed: ${status.error ?? 'unknown error'}. Games get the file.`);
            else lines.push(editor.store.prefs.backgroundCompression ? 'Not compressed yet: it is made in the background, or when you build.' : 'Not compressed yet: it is made when you build.');
            if (size) {
                const s = encodedSize(size.width, size.height, opts.maxSize);
                lines.push(`GPU memory: ${formatBytes(textureMemory(size.width, size.height))} as the file, about ${formatBytes(textureMemory(s.width, s.height, copyBlockBytes(opts.codec, false)))} compressed.`);
            }
            if (status.state === 'none' || status.state === 'failed') {
                action = button('Compress Now', () => void editor.derived.ensure(meta, role).catch(() => {}), 'small');
            }
        }
        body.replaceChildren(
            h('div', { class: 'texture-options-title', text: `${meta.name} as ${ROLE_TEXT[role]}` }),
            ...(ktx2
                ? []
                : [
                    row('Compression', modeField.el, 'ETC1S is the smallest and suits colors; UASTC keeps normal and data maps (and sharp colors) close to the file.'),
                    row('Max Size', sizeField.el, 'The longer side of the copy, in pixels'),
                ]),
            h('div', { class: 'texture-options-status muted small' }, ...lines.map((text) => h('div', { text }))),
            ...(action ? [action] : []),
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

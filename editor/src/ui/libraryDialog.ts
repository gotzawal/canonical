// The Library: the asset catalogs of core/library.ts to browse and search.
// Picking an item copies its file into the project (a model is placed in
// the scene too, and can be dragged into the viewport); a sound can be
// heard first. More catalogs, and single files, are added by URL.

import type { Editor } from '../editor';
import { formatBytes } from '../core/assets';
import { catalogList, catalogUrl, loadCatalog, searchLibrary, type LibraryCatalog, type LibraryItem, type LibraryKind } from '../core/library';
import { ASSET_MIME } from './assetsPanel';
import { clear, h } from './dom';
import { icon } from './icons';
import { modal, promptText, toast, type Modal } from './overlays';
import { button, iconButton } from './widgets';

let current: LibraryDialog | null = null;

/** Items being dragged from the Library into the viewport, by drag payload. */
const dragged = new Map<string, LibraryItem>();

/** The Library item a drag payload ("library:<key>") names. */
export function draggedLibraryItem(ref: string): LibraryItem | undefined {
    return dragged.get(ref);
}

export function openLibraryDialog(editor: Editor, opts: { kind?: LibraryKind | null; query?: string } = {}) {
    current?.close();
    current = new LibraryDialog(editor, opts);
}

const KINDS: { kind: LibraryKind | null; label: string }[] = [
    { kind: null, label: 'All' },
    { kind: 'model', label: 'Models' },
    { kind: 'material', label: 'Materials' },
    { kind: 'hdri', label: 'Skies' },
    { kind: 'audio', label: 'Sounds' },
    { kind: 'texture', label: 'Images' },
];

/** How many tiles are shown at once (a search narrows them down). */
const SHOWN = 240;

class LibraryDialog {
    private modal: Modal;
    private search: HTMLInputElement;
    private kinds: HTMLElement;
    private catalogSelect: HTMLSelectElement;
    private grid: HTMLElement;
    private status: HTMLElement;
    private catalogs: LibraryCatalog[] = [];
    private errors: string[] = [];
    private timer = 0;
    private preview: HTMLAudioElement | null = null;
    private previewing: string | null = null;
    private adding = new Set<string>();

    constructor(private editor: Editor, private opts: { kind?: LibraryKind | null; query?: string }) {
        this.search = h('input', { class: 'text lib-search', attrs: { type: 'search', placeholder: 'Search names and tags (rock, chair, brick, sky)...', spellcheck: 'false' } });
        this.search.value = opts.query ?? '';
        this.search.addEventListener('keydown', (e) => e.stopPropagation());
        this.search.addEventListener('input', () => {
            clearTimeout(this.timer);
            this.timer = window.setTimeout(() => this.render(), 150);
        });
        this.kinds = h('div', { class: 'lib-kinds' });
        this.catalogSelect = h('select', { class: 'select lib-catalog' });
        this.catalogSelect.addEventListener('change', () => this.render());
        this.grid = h('div', { class: 'lib-grid' });
        this.status = h('span', { class: 'muted small po-status' });
        const head = h(
            'div',
            { class: 'lib-head' },
            this.search,
            this.kinds,
            h('div', { class: 'spacer' }),
            this.catalogSelect,
            iconButton('plus', 'Add a catalog by its link', () => void this.addCatalog()),
            iconButton('trash', 'Remove the chosen catalog', () => this.removeCatalog()),
        );
        this.modal = modal('Library', h('div', { class: 'lib-dialog' }, head, this.grid), { cls: 'po-modal lib-modal', onClose: () => this.dispose() });
        const credits = button('Credits', () => this.credits(), 'subtle', 'book');
        const fromUrl = button('Import from Link...', () => void importFromLink(this.editor), 'subtle', 'link');
        this.modal.footer.append(credits, fromUrl, h('div', { class: 'spacer' }), this.status, button('Close', () => this.modal.close()));
        this.renderKinds(opts.kind ?? null);
        void this.load();
    }

    close() {
        this.modal.close();
    }

    private dispose() {
        this.preview?.pause();
        this.preview = null;
        if (current === this) current = null;
    }

    private async load() {
        this.status.textContent = 'Reading the catalogs...';
        const urls = catalogList(this.editor.store.prefs.libraryCatalogs);
        const results = await Promise.allSettled(urls.map((u) => loadCatalog(u)));
        if (this.modal.closed) return;
        this.catalogs = [];
        this.errors = [];
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') this.catalogs.push(r.value);
            else this.errors.push(`${urls[i]}: ${r.reason?.message || r.reason}`);
        });
        const chosen = this.catalogSelect.value;
        clear(this.catalogSelect);
        this.catalogSelect.append(h('option', { text: 'Every catalog', attrs: { value: '' } }));
        for (const c of this.catalogs) this.catalogSelect.append(h('option', { text: `${c.name} (${c.items.length})`, attrs: { value: c.url } }));
        if (this.catalogs.some((c) => c.url === chosen)) this.catalogSelect.value = chosen;
        this.render();
    }

    private kind: LibraryKind | null = null;

    private renderKinds(kind: LibraryKind | null) {
        this.kind = kind;
        clear(this.kinds);
        for (const k of KINDS) {
            const b = h('button', { class: 'chip' + (k.kind === kind ? ' active' : ''), text: k.label, attrs: { type: 'button' } });
            b.addEventListener('click', () => {
                this.renderKinds(k.kind);
                this.render();
            });
            this.kinds.append(b);
        }
    }

    private render() {
        const chosen = this.catalogSelect.value;
        const items = this.catalogs.filter((c) => !chosen || c.url === chosen).flatMap((c) => c.items);
        const found = searchLibrary(items, this.search.value, this.kind);
        clear(this.grid);
        if (!found.length) {
            const why = this.catalogs.length ? 'Nothing matches: try other words, or another kind.' : 'No catalog could be read.';
            this.grid.append(h('div', { class: 'muted small pad', text: why }));
        }
        for (const item of found.slice(0, SHOWN)) this.grid.append(this.tile(item));
        const shown = Math.min(found.length, SHOWN);
        const errors = this.errors.length ? ` ${this.errors.length} catalog${this.errors.length === 1 ? '' : 's'} could not be read.` : '';
        this.status.textContent = `${shown} of ${found.length} item${found.length === 1 ? '' : 's'}.${errors}`;
        this.status.title = this.errors.join('\n');
    }

    private inProject(item: LibraryItem): boolean {
        return this.editor.store.doc.assets.some((a) => a.source?.item === item.id);
    }

    private tile(item: LibraryItem): HTMLElement {
        const key = `${item.catalog}|${item.id}`;
        const pic = item.thumbUrl
            ? h('img', { attrs: { src: item.thumbUrl, alt: item.name, loading: 'lazy', draggable: 'false' } })
            : h('div', { class: 'lib-icon' }, icon(item.kind === 'audio' ? 'speaker' : 'model', 40));
        const facts: string[] = [];
        if (item.kind === 'model') {
            if (item.extent) facts.push(`${item.extent.map((v) => +v.toFixed(2)).join(' x ')} m`);
            if (item.tris) facts.push(`${item.tris} tris`);
            if (item.animations?.length) facts.push(`${item.animations.length} clips`);
        } else if (item.kind === 'audio' && item.seconds) facts.push(`${item.seconds} s`);
        else if (item.kind === 'material' && item.tile) facts.push(`${item.tile} m tile`, ...(item.mapUrls?.normal ? ['normal'] : []), ...(item.mapUrls?.arm ? ['ARM'] : []), ...(item.mapUrls?.height ? ['height'] : []));
        else if (item.pixels) facts.push(`${item.pixels[0]} x ${item.pixels[1]}`);
        facts.push(formatBytes(item.bytes));
        const src = item.sourceInfo;
        const title = [item.name, src ? `${src.name}${item.author ? `, by ${item.author}` : ` by ${src.author}`}, ${src.license}` : '', item.tags.length ? `Tags: ${item.tags.join(', ')}` : '', item.animations?.length ? `Clips: ${item.animations.join(', ')}` : '']
            .filter(Boolean)
            .join('\n');
        const inProject = this.inProject(item);
        // A material goes on the selected object's slot (else into the swatches); an HDRI onto the sky.
        const label = item.kind === 'material' ? (this.selectedSlot() ? 'Use on Slot' : 'Add to Swatches') : item.kind === 'hdri' ? 'Use as Sky' : inProject ? (item.kind === 'model' ? 'Place' : 'In project') : 'Add';
        const reusable = item.kind === 'model' || item.kind === 'material' || item.kind === 'hdri';
        const add = button(label, () => void this.add(item, tile), 'small' + (inProject && !reusable ? '' : ' primary'), item.kind === 'model' ? 'plus' : 'check');
        if (inProject && !reusable) add.disabled = true;
        const listen = item.kind === 'audio' ? iconButton(this.previewing === item.url ? 'stop' : 'play', 'Listen', () => this.listen(item)) : null;
        const tile = h(
            'div',
            { class: 'po-tile lib-tile' + (this.adding.has(key) ? ' running' : ''), title, attrs: { draggable: item.kind === 'texture' ? 'false' : 'true' } },
            pic,
            h('div', { class: 'po-tile-bar' }, h('span', { class: 'po-label', text: item.name }), h('div', { class: 'spacer' }), listen),
            h('div', { class: 'muted small lib-facts', text: facts.join(' · ') }),
            h('div', { class: 'po-tile-actions' }, add, h('span', { class: 'muted small lib-pack', text: src?.name ?? '' })),
        );
        if (item.kind === 'model' || item.kind === 'audio') {
            tile.addEventListener('dragstart', (e) => {
                dragged.set(key, item);
                e.dataTransfer!.setData(ASSET_MIME, `library:${key}`);
                e.dataTransfer!.effectAllowed = 'copy';
            });
            if (item.kind === 'model') tile.addEventListener('dblclick', () => void this.add(item, tile));
        }
        return tile;
    }

    private async add(item: LibraryItem, tile: HTMLElement) {
        const key = `${item.catalog}|${item.id}`;
        if (this.adding.has(key)) return;
        this.adding.add(key);
        tile.classList.add('running');
        try {
            if (item.kind === 'material') {
                const slot = this.selectedSlot();
                const res = await this.editor.addLibraryMaterial(item, slot?.id);
                toast(res.slot ? `${res.slot.name} uses ${item.name} now, sized and compressed for its surfaces.` : `${item.name} is in the swatches: put it on a material slot (Design tab, Materials).`, 'success');
                return;
            }
            const { asset, reused } = await this.editor.addFromLibrary(item, { sky: item.kind === 'hdri' });
            const what = item.kind === 'hdri' ? 'The sky shows' : asset.kind === 'model' ? 'Placed' : 'Added';
            toast(`${what} ${item.name}${reused ? '' : ` (${formatBytes(asset.size)} copied into the project)`}.${asset.kind === 'audio' ? ' Play it with an Audio component or from a script.' : item.kind === 'hdri' ? ' Point the key light where its sun is.' : ''}`, 'success');
        } catch (e: any) {
            toast(e?.message || String(e), 'error');
        } finally {
            this.adding.delete(key);
            if (!this.modal.closed) this.render();
        }
    }

    /** The material slot of the selected object, if it follows one. */
    private selectedSlot() {
        const store = this.editor.store;
        const id = store.primary?.mesh?.material.slot;
        return id ? store.doc.design.materials.find((s) => s.id === id) : undefined;
    }

    private listen(item: LibraryItem) {
        this.preview?.pause();
        if (this.previewing === item.url) {
            this.previewing = null;
            this.render();
            return;
        }
        const a = new Audio(item.url);
        this.preview = a;
        this.previewing = item.url;
        a.addEventListener('ended', () => {
            if (this.preview !== a) return;
            this.previewing = null;
            if (!this.modal.closed) this.render();
        });
        void a.play().catch((e) => toast(`The sound could not be played: ${e?.message || e}`, 'error'));
        this.render();
    }

    private async addCatalog() {
        const url = await promptText('Add a catalog', 'Link to a catalog.json made like the editor\'s own (scripts/mirror-library.mjs makes one); the site must let other sites read it, as GitHub raw links do.', {
            placeholder: 'https://raw.githubusercontent.com/you/assets/main/library/catalog.json',
            ok: 'Add',
        });
        if (!url) return;
        let abs: string;
        try {
            abs = catalogUrl(url);
            await loadCatalog(abs);
        } catch (e: any) {
            toast(e?.message || String(e), 'error');
            return;
        }
        const list = this.editor.store.prefs.libraryCatalogs;
        if (!list.includes(abs)) this.editor.store.setPrefs({ libraryCatalogs: [...list, abs] });
        this.catalogSelect.value = abs;
        await this.load();
        this.catalogSelect.value = abs;
        this.render();
    }

    private removeCatalog() {
        const url = this.catalogSelect.value;
        const list = this.editor.store.prefs.libraryCatalogs;
        if (!url || !list.includes(url)) {
            toast(url ? 'The editor\'s own catalog stays.' : 'Choose an added catalog first.', 'info');
            return;
        }
        this.editor.store.setPrefs({ libraryCatalogs: list.filter((u) => u !== url) });
        this.catalogSelect.value = '';
        void this.load();
    }

    /** The credits of the chosen catalog (LICENSES.md next to it), or of every catalog. */
    private credits() {
        const chosen = this.catalogs.filter((c) => !this.catalogSelect.value || c.url === this.catalogSelect.value);
        const lines = chosen.flatMap((c) => c.sources.map((s) => `${s.name} by ${s.author} (${s.license}): ${s.url}`));
        const body = h(
            'div',
            { class: 'lib-credits' },
            h('p', { class: 'muted small', text: 'Files copied from the Library keep where they came from; built games list them in credits.txt.' }),
            ...lines.map((l) => h('div', { class: 'small', text: l })),
        );
        const m = modal('Library Credits', body, {});
        m.footer.append(button('Close', () => m.close(), 'primary'));
    }
}

/** Asks for a link and downloads the model, image or sound into the project (a model is placed). */
export async function importFromLink(editor: Editor) {
    const url = await promptText('Import from link', 'Link to a .glb or .gltf model, an image or a sound. The file is copied into the project, so the scene keeps it if the link goes away.', {
        placeholder: 'https://...',
        ok: 'Import',
    });
    if (!url) return;
    try {
        const { asset, reused } = await editor.importUrl(url);
        toast(`${reused ? 'Used' : 'Imported'} ${asset.name}${reused ? ' (the project had it already)' : ''}.`, 'success');
    } catch (e: any) {
        toast(e?.message || String(e), 'error');
    }
}

/** Asks for a link and opens the scene or project there. */
export async function openFromLink(editor: Editor) {
    const url = await promptText('Open link', 'Link to a scene (.json) or project (.zip). Its scripts stay paused until you enable them.', { placeholder: 'https://...', ok: 'Open' });
    if (url) await editor.openUrl(url);
}

import { buildGame, gameScene, slug, type BuiltGame } from '../build/build';
import { PREVIEW_KEY, type PreviewData } from '../build/gameFile';
import { deployToGitHub, explainError, waitForPages, type DeployResult } from '../build/github';
import { createZip } from '../build/zip';
import { formatBytes } from '../core/assets';
import { download, usedAssetIds } from '../core/persistence';
import type { Editor } from '../editor';
import { h } from './dom';
import { icon } from './icons';
import { confirmDialog, dialog, toast } from './overlays';
import { button, CheckboxField, iconButton, row } from './widgets';

// File > Build & Deploy: test the scene as a standalone game, download it
// as a .zip for any static host, or publish it to GitHub Pages.

const DEPLOY_KEY = 'canonical-editor/deploy';
const TOKEN_KEY = 'canonical-editor/github-token';
const PREVIEW_WINDOW = 'canonical-preview';

/** Preferences of this browser; title, repository and branch belong to the scene (SceneDoc.build). */
interface DeploySettings {
    create: boolean;
    /** Keep the token in localStorage (otherwise only while this tab is open). */
    remember: boolean;
}

/** The token for this tab when it is not remembered. */
let sessionToken = '';

function loadSettings(): DeploySettings {
    const defaults: DeploySettings = { create: true, remember: false };
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(DEPLOY_KEY) || '{}') };
    } catch {
        return defaults;
    }
}

function saveSettings(s: DeploySettings) {
    try {
        localStorage.setItem(DEPLOY_KEY, JSON.stringify(s));
    } catch { /* ignore */ }
}

function loadToken(): string {
    try {
        return localStorage.getItem(TOKEN_KEY) || sessionToken;
    } catch {
        return sessionToken;
    }
}

function saveToken(token: string, remember: boolean) {
    sessionToken = token;
    try {
        if (remember && token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }
}

/** Opens the scene in the player page, the way the built game runs it. */
export function openPreview(editor: Editor, title: string): boolean {
    const store = editor.store;
    const data: PreviewData = {
        title: title.trim() || store.doc.name,
        scene: gameScene(store.doc, true),
        camera: store.camera,
        trusted: editor.compiler.trusted,
    };
    try {
        localStorage.setItem(PREVIEW_KEY, JSON.stringify(data));
    } catch (e: any) {
        toast(`The scene could not be handed to the preview: ${e?.message || e}`, 'error');
        return false;
    }
    // A named window: running again reloads the same tab.
    const win = window.open(new URL('player.html?preview', document.baseURI).href, PREVIEW_WINDOW);
    if (!win) {
        toast('The browser blocked the new tab. Allow pop-ups for this site and try again.', 'error');
        return false;
    }
    win.focus();
    return true;
}

export function showBuildDialog(editor: Editor) {
    const store = editor.store;
    if (editor.player.state !== 'stopped') editor.stopPlay();
    const applied = editor.applyCodeEdits();
    if (applied) toast(`Applied ${applied} edited file(s) first.`, 'info');

    const settings = loadSettings();
    const saved = store.doc.build ?? {};
    let busy = false;

    // ------------------------------------------------------------- title
    const titleInput = h('input', { class: 'text', attrs: { type: 'text', spellcheck: 'false', placeholder: store.doc.name } });
    titleInput.value = saved.title ?? '';
    titleInput.addEventListener('keydown', (e) => e.stopPropagation());
    const title = () => titleInput.value.trim() || store.doc.name || 'Game';

    // ----------------------------------------------------------- summary
    const summary = h('div', { class: 'build-summary' });
    const notes = h('div', { class: 'build-notes' });
    const renderSummary = () => {
        const doc = store.doc;
        const used = usedAssetIds(doc);
        const assets = doc.assets.filter((a) => used.has(a.id));
        const bytes = assets.reduce((s, a) => s + (a.size || 0), 0);
        const cameras = doc.nodes.filter((n) => n.camera);
        const main = cameras.find((n) => n.camera!.main) ?? cameras[0];
        const parts = [
            `${doc.nodes.length} object${doc.nodes.length === 1 ? '' : 's'}`,
            `${doc.scripts.length} script${doc.scripts.length === 1 ? '' : 's'}`,
            `${doc.shaders.length} shader${doc.shaders.length === 1 ? '' : 's'}`,
            `${assets.length} asset${assets.length === 1 ? '' : 's'}${assets.length ? ` (${formatBytes(bytes)})` : ''}`,
        ];
        summary.textContent = parts.join(' · ');

        notes.replaceChildren();
        const note = (kind: 'info' | 'warn', text: string, ...extra: Node[]) =>
            notes.append(h('div', { class: `build-note ${kind}` }, icon(kind === 'warn' ? 'alert' : 'info', 14), h('span', { text }), ...extra));
        note(
            'info',
            main
                ? `The game renders through the camera "${main.name}".`
                : 'The scene has no camera, so the game starts from the current editor view: right drag orbits, middle drag pans, the wheel zooms.',
        );
        if (!editor.compiler.trusted && doc.scripts.length) {
            note(
                'warn',
                'The scripts of the opened file are paused: builds leave them out and previews run without them.',
                button('Enable Scripts', () => {
                    editor.enableScripts();
                    renderSummary();
                }, 'small'),
            );
        } else {
            const broken = doc.scripts.filter((s) => editor.compiler.get(s.id)?.error).map((s) => s.name);
            if (broken.length) note('warn', `Scripts with errors: ${broken.join(', ')}. They fail in the game too.`);
        }
        const badShaders = doc.shaders.filter((s) => editor.shaders.status(s.id).state === 'error').map((s) => s.name);
        if (badShaders.length) note('warn', `Shaders with errors: ${badShaders.join(', ')}.`);
    };
    renderSummary();

    // --------------------------------------------------------------- log
    const logEl = h('div', { class: 'build-log', attrs: { role: 'log', hidden: true } });
    const log = (text: string, kind: 'info' | 'error' | 'success' = 'info') => {
        logEl.hidden = false;
        logEl.append(h('div', { class: `build-log-line ${kind}`, text }));
        logEl.scrollTop = logEl.scrollHeight;
    };
    const result = h('div', { class: 'build-result', attrs: { hidden: true } });

    // ----------------------------------------------------------- actions
    const runBtn = button('Run in New Tab', () => {
        if (openPreview(editor, title())) log('Opened the preview tab.');
    }, 'primary', 'play');

    const zipBtn = button('Download .zip', () => void run(async () => {
        const game = await build();
        log('Compressing...');
        const zip = await createZip(game.files);
        const name = `${slug(game.title)}.zip`;
        download(zip, name);
        log(`Downloaded ${name} (${formatBytes(zip.size)}, ${game.files.length} files).`, 'success');
    }), '', 'save');

    // ------------------------------------------------------- GitHub Pages
    const tokenInput = h('input', { class: 'text', attrs: { type: 'password', placeholder: 'ghp_... or github_pat_...', spellcheck: 'false', autocomplete: 'off' } });
    tokenInput.value = loadToken();
    tokenInput.addEventListener('keydown', (e) => e.stopPropagation());
    const showToken = iconButton('eye', 'Show token', () => (tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password'));
    let remember = settings.remember;
    const rememberBox = new CheckboxField(remember, (v) => (remember = v), 'Remember on this device');
    const repoInput = h('input', { class: 'text', attrs: { type: 'text', spellcheck: 'false', placeholder: slug(title()) } });
    repoInput.value = saved.repo ?? '';
    repoInput.addEventListener('keydown', (e) => e.stopPropagation());
    titleInput.addEventListener('input', () => repoInput.setAttribute('placeholder', slug(title())));
    const branchInput = h('input', { class: 'text', attrs: { type: 'text', spellcheck: 'false', placeholder: 'gh-pages' } });
    branchInput.value = saved.branch ?? '';
    branchInput.addEventListener('keydown', (e) => e.stopPropagation());
    let create = settings.create;
    const createBox = new CheckboxField(create, (v) => (create = v), 'Create the repository if it does not exist');

    const deployBtn = button('Deploy', () => void run(async () => {
        const token = tokenInput.value.trim();
        if (!token) throw new Error('Paste a GitHub token first (see "Create a token").');
        const repo = repoInput.value.trim() || slug(title());
        const branch = branchInput.value.trim() || 'gh-pages';
        saveToken(token, remember);
        saveSettings({ create, remember });
        // The scene remembers where it was deployed (see saveBuildDoc), so its next deploy goes there too.
        if (!repoInput.value.trim()) repoInput.value = repo;
        const game = await build();
        let deployed: DeployResult;
        try {
            deployed = await deployToGitHub(game.files, {
                token,
                repo,
                branch,
                create,
                title: game.title,
                ask: (t, m, ok) => confirmDialog(t, m, ok, true),
                log: (text) => log(text),
            });
        } catch (e) {
            throw new Error(explainError(e));
        }
        showResult(deployed);
        if (deployed.pagesError) {
            log('The files are on GitHub, but Pages is not set up. Turn it on in the repository under Settings > Pages.', 'error');
            return;
        }
        log('Waiting for GitHub Pages to publish (usually about a minute)...');
        const repoName = new URL(deployed.repoUrl).pathname.replace(/^\/+/, '');
        try {
            const live = await waitForPages(token, repoName, deployed.commit);
            if (live) {
                log(`Live at ${deployed.url}`, 'success');
                if (!document.body.contains(logEl)) toast(`Your game is live at ${deployed.url}`, 'success', 8000);
            } else {
                log('GitHub Pages is still publishing; the link works once it is done.');
            }
        } catch (e: any) {
            log(`GitHub Pages reported a problem: ${explainError(e)}`, 'error');
        }
    }), 'primary', 'rocket');

    const showResult = (r: DeployResult) => {
        result.hidden = false;
        result.replaceChildren(
            icon('check', 15),
            h('a', { text: r.url, attrs: { href: r.url, target: '_blank', rel: 'noopener' } }),
            h('a', { class: 'muted', text: 'Repository', attrs: { href: `${r.repoUrl}/tree/${r.branch}`, target: '_blank', rel: 'noopener' } }),
        );
    };

    const actionButtons = [runBtn, zipBtn, deployBtn];
    /** Runs one action at a time and reports its errors in the log. */
    const run = async (fn: () => Promise<void>) => {
        if (busy) return;
        busy = true;
        for (const b of actionButtons) b.disabled = true;
        try {
            await fn();
        } catch (e: any) {
            const message = e?.message || String(e);
            log(message, 'error');
            if (!document.body.contains(logEl)) toast(message, 'error');
        } finally {
            busy = false;
            for (const b of actionButtons) b.disabled = false;
        }
    };
    /** Keeps the title, repository and branch with the scene (no undo step of their own). */
    const saveBuildDoc = () => {
        const next = { ...(store.doc.build ?? {}) };
        const set = (k: 'title' | 'repo' | 'branch', v: string) => {
            if (v) next[k] = v;
            else delete next[k];
        };
        set('title', titleInput.value.trim());
        set('repo', repoInput.value.trim());
        set('branch', branchInput.value.trim());
        if (JSON.stringify(next) === JSON.stringify(store.doc.build ?? {})) return;
        store.patch(
            (doc) => {
                doc.build = Object.keys(next).length ? next : undefined;
            },
            { meta: true },
        );
    };

    const build = async (): Promise<BuiltGame> => {
        saveBuildDoc();
        logEl.replaceChildren();
        result.hidden = true;
        if (import.meta.env.DEV) log('The dev server builds the player app first; the first build takes a while.');
        const game = await buildGame(store.doc, { title: title(), camera: store.camera, scripts: editor.compiler.trusted }, (t) => log(t));
        for (const w of game.warnings) log(w, 'error');
        log(`Built "${game.title}": ${game.files.length} files, ${formatBytes(game.size)}.`);
        return game;
    };

    const body = h(
        'div',
        { class: 'build-dialog' },
        row('Title', titleInput, 'Shown as the page title of the game'),
        summary,
        notes,
        h('h3', null, icon('play', 14), h('span', { text: 'Test' })),
        h('div', { class: 'build-action' }, runBtn, h('p', { class: 'muted small', text: 'Plays the scene in a new tab the way the built game runs, without the editor.' })),
        h('h3', null, icon('save', 14), h('span', { text: 'Download' })),
        h(
            'div',
            { class: 'build-action' },
            zipBtn,
            h('p', { class: 'muted small', text: 'A folder with index.html for any static host: itch.io (HTML game), Netlify, Cloudflare Pages or your own server. It must be served over HTTP; opening index.html from disk does not work.' }),
        ),
        h('h3', null, icon('github', 14), h('span', { text: 'GitHub Pages' })),
        row('Token', h('div', { class: 'inline' }, tokenInput, showToken)),
        row(
            '',
            h(
                'div',
                { class: 'inline' },
                rememberBox.el,
                h('a', {
                    class: 'small',
                    text: 'Create a token',
                    attrs: { href: 'https://github.com/settings/tokens/new?scopes=public_repo&description=Canonical%20Editor', target: '_blank', rel: 'noopener' },
                }),
            ),
        ),
        row('Repository', repoInput, 'A name in your account, or owner/name'),
        row('Branch', branchInput, 'The branch GitHub Pages publishes; it will contain only the game'),
        row('', createBox.el),
        h('div', { class: 'build-action' }, deployBtn, h('p', { class: 'muted small', text: 'Pushes the game to the branch and publishes it with GitHub Pages at https://<owner>.github.io/<repository>/.' })),
        logEl,
        result,
        h('p', {
            class: 'muted small',
            text: 'The token needs the "public_repo" scope ("repo" for private repositories, where Pages needs a paid plan). It is sent only to api.github.com. A remembered token stays in this browser, where scripts you run in the editor can read it.',
        }),
    );
    void dialog('Build & Deploy', body, [{ label: 'Close' }]);
    titleInput.focus();
    titleInput.select();
}

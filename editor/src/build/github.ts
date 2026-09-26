// Publishes a built game to GitHub Pages straight from the browser with the
// GitHub REST API: the files become one commit on a branch (gh-pages by
// default) and Pages is pointed at that branch.

import { blobToBase64 } from '../core/assets';
import { GAME_FILE } from './gameFile';
import type { ZipEntry } from './zip';

const API = 'https://api.github.com';
/** GitHub refuses files over 100 MB. */
const MAX_FILE = 100 * 1024 * 1024;

export interface DeployOptions {
    token: string;
    /** "name" (in the token owner's account) or "owner/name". */
    repo: string;
    branch: string;
    /** Create the repository when it does not exist. */
    create: boolean;
    title: string;
    /** Asks the user a yes / no question; false cancels the deploy. */
    ask: (title: string, message: string, ok: string) => Promise<boolean>;
    log: (text: string) => void;
}

export interface DeployResult {
    /** The published site, e.g. https://owner.github.io/name/ */
    url: string;
    repoUrl: string;
    branch: string;
    commit: string;
    /** Set when the files were pushed but Pages could not be set up. */
    pagesError?: string;
}

export class GitHubError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

interface Repo {
    name: string;
    owner: { login: string };
    html_url: string;
    default_branch: string;
    private: boolean;
}

interface Pages {
    html_url?: string;
    build_type?: 'legacy' | 'workflow' | null;
    source?: { branch: string; path: string } | null;
}

async function request<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
        res = await fetch(API + path, {
            method,
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch (e: any) {
        throw new GitHubError(0, `Could not reach GitHub (${e?.message || e}).`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }
    if (!res.ok) {
        const details = Array.isArray(data?.errors)
            ? data.errors.map((e: any) => (typeof e === 'string' ? e : e?.message || e?.code)).filter(Boolean).join('; ')
            : '';
        const message = (data?.message || res.statusText || 'Request failed') + (details ? ` (${details})` : '');
        throw new GitHubError(res.status, message);
    }
    return data as T;
}

/** Git's id of a file: SHA-1 of "blob <size>\0<content>". Null without WebCrypto. */
async function gitBlobSha(bytes: Uint8Array): Promise<string | null> {
    if (!globalThis.crypto?.subtle) return null;
    const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(head.length + bytes.length);
    all.set(head);
    all.set(bytes, head.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function toBlob(data: ZipEntry['data']): Promise<Blob> {
    if (data instanceof Blob) return data;
    return new Blob([data as BlobPart]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

function refPath(branch: string): string {
    return branch.split('/').map(encodeURIComponent).join('/');
}

export function explainError(e: any): string {
    if (e instanceof GitHubError) {
        if (e.status === 401) return 'GitHub rejected the token. Check that it is correct and not expired.';
        if (e.status === 403 || e.status === 404) {
            return `${e.message}. The token may lack a permission: a classic token needs the "public_repo" scope ("repo" for private repositories); a fine-grained token needs Contents, Pages and Administration (to create repositories) set to Read and write.`;
        }
        return e.message;
    }
    return e?.message || String(e);
}

/** True for what GitHub puts in a new repository, which a deploy may replace without asking. */
function isStarterFile(path: string): boolean {
    return /^(readme|license|licence)(\.(md|txt))?$|^\.git(ignore|attributes)$|^\.nojekyll$/i.test(path);
}

export async function deployToGitHub(files: ZipEntry[], opts: DeployOptions): Promise<DeployResult> {
    const { token, log } = opts;
    const branch = opts.branch.trim() || 'gh-pages';
    if (!/^[\w.\-/]+$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
        throw new Error(`"${branch}" is not a valid branch name.`);
    }
    for (const f of files) {
        const size = f.data instanceof Blob ? f.data.size : typeof f.data === 'string' ? f.data.length : f.data.length;
        if (size > MAX_FILE) throw new Error(`${f.path} is larger than 100 MB, the most GitHub accepts for one file.`);
    }

    log('Signing in to GitHub...');
    const user = await request<{ login: string }>(token, 'GET', '/user');
    const spec = opts.repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const [owner, name] = spec.includes('/') ? spec.split('/', 2) : [user.login, spec];
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
        throw new Error(`"${opts.repo}" is not a repository name. Use "name" or "owner/name".`);
    }

    let repo: Repo | null = null;
    try {
        repo = await request<Repo>(token, 'GET', `/repos/${owner}/${name}`);
    } catch (e) {
        if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
    let created = false;
    if (!repo) {
        if (!opts.create) throw new Error(`Repository ${owner}/${name} was not found, or the token cannot access it.`);
        log(`Creating the repository ${owner}/${name}...`);
        const body = {
            name,
            description: `${opts.title}, made with Canonical Editor`,
            homepage: `https://${owner.toLowerCase()}.github.io/${name}/`,
            // Git's data API needs a first commit to exist.
            auto_init: true,
        };
        repo =
            owner.toLowerCase() === user.login.toLowerCase()
                ? await request<Repo>(token, 'POST', '/user/repos', body)
                : await request<Repo>(token, 'POST', `/orgs/${owner}/repos`, body);
        created = true;
    }
    const base = `/repos/${repo.owner.login}/${repo.name}`;
    const full = `${repo.owner.login}/${repo.name}`;

    // The branch as it is now: its commit becomes the parent of ours.
    let parent: string | null = null;
    const existing = new Map<string, string>();
    let initialized = false;
    for (let attempt = 0; ; attempt++) {
        try {
            const ref = await request<{ object: { sha: string } }>(token, 'GET', `${base}/git/ref/heads/${refPath(branch)}`);
            parent = ref.object.sha;
            break;
        } catch (e) {
            if (!(e instanceof GitHubError)) throw e;
            if (e.status === 404) break;
            // 409: the repository is empty, or was created a moment ago and is not ready yet.
            if (e.status !== 409 || attempt >= 6) throw e;
            if (!created && !initialized) {
                // Git's data API needs a first commit.
                log('The repository is empty; adding a README first...');
                await request(token, 'PUT', `${base}/contents/README.md`, {
                    message: 'Initial commit',
                    content: btoa(`# ${repo.name}\n\nMade with Canonical Editor.\n`),
                });
                initialized = true;
            }
            await sleep(1500);
        }
    }
    if (parent) {
        const commit = await request<{ tree: { sha: string } }>(token, 'GET', `${base}/git/commits/${parent}`);
        const tree = await request<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
            token,
            'GET',
            `${base}/git/trees/${commit.tree.sha}?recursive=1`,
        );
        const top = tree.tree.filter((t) => !t.path.includes('/')).map((t) => t.path);
        const isGame = top.includes(GAME_FILE);
        if (!isGame && !top.every(isStarterFile)) {
            const shown = top.slice(0, 8).join(', ') + (top.length > 8 ? `, and ${top.length - 8} more` : '');
            const ok = await opts.ask(
                `Replace the files on ${branch}?`,
                `Branch "${branch}" of ${full} holds files that are not a game built with this editor (${shown}). Deploying makes the branch contain only the game; the old files stay in the branch history. Deploy to another branch (such as gh-pages) to keep them.`,
                'Replace',
            );
            if (!ok) throw new Error('Deploy cancelled.');
        }
        for (const t of tree.tree) if (t.type === 'blob') existing.set(t.path, t.sha);
    }
    const known = new Set(existing.values());

    // Upload the files GitHub does not have yet.
    let uploaded = 0;
    let reused = 0;
    let done = 0;
    const entries = await pool(files, 4, async (f) => {
        const blob = await toBlob(f.data);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const sha = await gitBlobSha(bytes);
        let finalSha = sha;
        if (!sha || !known.has(sha)) {
            const res = await request<{ sha: string }>(token, 'POST', `${base}/git/blobs`, {
                content: await blobToBase64(blob),
                encoding: 'base64',
            });
            finalSha = res.sha;
            uploaded++;
        } else {
            reused++;
        }
        done++;
        if (done === files.length || done % 5 === 0) log(`Uploading files: ${done} of ${files.length}`);
        return { path: f.path, mode: '100644', type: 'blob', sha: finalSha! };
    });
    if (reused) log(`${uploaded} file${uploaded === 1 ? '' : 's'} uploaded, ${reused} unchanged.`);

    log('Creating the commit...');
    const tree = await request<{ sha: string }>(token, 'POST', `${base}/git/trees`, { tree: entries });
    const commit = await request<{ sha: string }>(token, 'POST', `${base}/git/commits`, {
        message: `Deploy ${opts.title} from Canonical Editor`,
        tree: tree.sha,
        parents: parent ? [parent] : [],
    });
    if (parent) {
        await request(token, 'PATCH', `${base}/git/refs/heads/${refPath(branch)}`, { sha: commit.sha, force: false });
    } else {
        await request(token, 'POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    }
    log(`Pushed ${commit.sha.slice(0, 7)} to ${full}@${branch}.`);

    const result: DeployResult = {
        url: `https://${repo.owner.login.toLowerCase()}.github.io/${repo.name}/`,
        repoUrl: repo.html_url,
        branch,
        commit: commit.sha,
    };
    try {
        const pages = await setupPages(token, base, branch, full, opts);
        if (pages?.html_url) result.url = pages.html_url;
    } catch (e) {
        result.pagesError = explainError(e);
        log(`GitHub Pages could not be set up: ${result.pagesError}`);
    }
    return result;
}

async function setupPages(token: string, base: string, branch: string, full: string, opts: DeployOptions): Promise<Pages | null> {
    const source = { branch, path: '/' };
    let pages: Pages | null = null;
    try {
        pages = await request<Pages>(token, 'GET', `${base}/pages`);
    } catch (e) {
        if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
    if (!pages) {
        opts.log('Turning on GitHub Pages...');
        return request<Pages>(token, 'POST', `${base}/pages`, { build_type: 'legacy', source });
    }
    const same = pages.build_type !== 'workflow' && pages.source?.branch === branch && (pages.source?.path ?? '/') === '/';
    if (same) return pages;
    const current = pages.build_type === 'workflow' ? 'a GitHub Actions workflow' : `branch "${pages.source?.branch}" (${pages.source?.path})`;
    const ok = await opts.ask(
        'Change the GitHub Pages source?',
        `GitHub Pages of ${full} is published from ${current}. Publish it from "${branch}" instead? The site then shows the game.`,
        'Change',
    );
    if (!ok) throw new Error(`the files are on "${branch}", but Pages still publishes ${current}`);
    opts.log(`Publishing GitHub Pages from ${branch}...`);
    await request(token, 'PUT', `${base}/pages`, { build_type: 'legacy', source });
    return request<Pages>(token, 'GET', `${base}/pages`);
}

/**
 * Waits until GitHub Pages has built `commit`. Resolves true when it is
 * live, false on timeout; rejects when the Pages build failed.
 */
export async function waitForPages(token: string, repo: string, commit: string, timeoutMs = 180000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    const [owner, name] = repo.split('/');
    while (Date.now() < end) {
        await sleep(5000);
        try {
            const build = await request<{ status: string; commit: string; error?: { message?: string | null } }>(
                token,
                'GET',
                `/repos/${owner}/${name}/pages/builds/latest`,
            );
            if (build.commit === commit) {
                if (build.status === 'built') return true;
                if (build.status === 'errored') throw new Error(build.error?.message || 'The GitHub Pages build failed.');
            }
        } catch (e) {
            if (e instanceof GitHubError && e.status === 404) continue;
            throw e;
        }
    }
    return false;
}

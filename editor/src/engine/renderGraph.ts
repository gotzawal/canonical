import type { RenderGraph, RenderGraphPass } from '@orillusion/core';
import { Emitter } from '../core/events';
import type { Store } from '../core/store';
import type { PostDoc } from '../core/types';
import type { Runtime } from './runtime';
import type { EditorPost, ShaderManager } from './shaders';
import type { SceneSync } from './sync';

export interface PassInfo {
    name: string;
    enabled: boolean;
    reads: string[];
    writes: string[];
    creates: string[];
    deps: string[];
    /** Position in the compiled execution order, -1 when not scheduled. */
    order: number;
    /** Switching it off would leave nothing on screen. */
    essential: boolean;
}

export interface EdgeInfo {
    from: string;
    to: string;
    /** Resource name, or 'dependsOn' for explicit ordering edges. */
    label: string;
    kind: 'data' | 'mutate' | 'dep';
}

export interface GraphInfo {
    passes: PassInfo[];
    edges: EdgeInfo[];
    /** Last error from applying the document's pass switches. */
    error: string;
}

interface PostInstance {
    doc: string;
    shader: string;
    version: number;
    post: EditorPost;
}

const ESSENTIAL = new Set(['GUIPass']);

interface GraphEvents {
    /** Pass states or the post chain changed. */
    changed: void;
}

/**
 * Applies RenderGraphDoc to the engine: switches built-in passes off and on
 * (refusing changes the graph cannot compile) and keeps the custom post
 * effects in the post chain in document order.
 */
export class RenderGraphController extends Emitter<GraphEvents> {
    private posts = new Map<string, PostInstance>();
    private lastKey = '';
    private error = '';

    constructor(private runtime: Runtime, private store: Store, private shaders: ShaderManager, private sync: SceneSync) {
        super();
        store.on('change', () => this.apply());
        store.on('load', () => this.apply(true));
        shaders.on('compiled', () => this.apply(true));
        // GI adds passes the first time it is switched on.
        runtime.onGraphChanged(() => this.apply(true));
        // Pass reads and writes are only known once the graph compiled for the first frame.
        const off = runtime.onFrame(() => {
            off();
            this.apply(true);
            this.emit('changed', undefined);
        });
    }

    get graph(): RenderGraph | null {
        return (this.runtime.view.renderGraph as RenderGraph | null) ?? null;
    }

    /** Applies the document's render graph settings when they changed. */
    apply(force = false) {
        const rg = this.store.doc.renderGraph;
        const versions = rg.posts.map((p) => this.shaders.version(p.shader)).join(',');
        const key = JSON.stringify(rg) + '|' + versions;
        if (!force && key === this.lastKey) return;
        this.lastKey = key;
        this.applyPasses(rg.disabled);
        this.applyPosts(rg.posts);
        this.emit('changed', undefined);
    }

    private applyPasses(disabled: string[]) {
        const graph = this.graph;
        if (!graph) return;
        const off = new Set(disabled);
        const errors: string[] = [];
        for (const pass of graph.passes) {
            const want = !off.has(pass.name) || ESSENTIAL.has(pass.name);
            if (pass.enabled === want) continue;
            const err = this.trySet(graph, pass.name, want);
            if (err) errors.push(err);
        }
        this.error = errors.join('\n');
    }

    /** Enables or disables one pass; returns an error message and leaves it unchanged when the graph would not compile. */
    private trySet(graph: RenderGraph, name: string, enabled: boolean): string {
        if (!enabled && ESSENTIAL.has(name)) return `${name} presents the image and cannot be switched off.`;
        try {
            if (enabled) graph.enablePass(name);
            else graph.disablePass(name);
            graph.compile();
            return '';
        } catch (e: any) {
            try {
                if (enabled) graph.disablePass(name);
                else graph.enablePass(name);
                graph.compile();
            } catch (e2) {
                console.error('[editor] render graph could not be restored', e2);
            }
            return `${name}: ${e?.message || e}`;
        }
    }

    /**
     * Checks whether a pass can be switched without breaking the graph.
     * The graph is left as it was.
     */
    canSet(name: string, enabled: boolean): string {
        const graph = this.graph;
        if (!graph) return 'The renderer has not started yet.';
        const pass = graph.getPass(name);
        if (!pass) return `There is no pass named "${name}".`;
        if (pass.enabled === enabled) return '';
        const err = this.trySet(graph, name, enabled);
        if (!err) {
            // Put it back; the document change applies it for real.
            this.trySet(graph, name, !enabled);
        }
        return err;
    }

    private applyPosts(docs: PostDoc[]) {
        const next: PostInstance[] = [];
        const keep = new Set<string>();
        for (const d of docs) {
            const version = this.shaders.version(d.shader);
            let inst = this.posts.get(d.id);
            if (!inst || inst.shader !== d.shader || inst.version !== version) {
                const post = this.shaders.createPost(d.shader, d.id);
                if (!post) continue;
                post.onTextures = (assets) => {
                    for (const { name, asset } of assets) {
                        void this.sync.loadTexture(asset).then((tex) => {
                            if (tex) post.setTexture(name, tex);
                        });
                    }
                };
                inst = { doc: d.id, shader: d.shader, version, post };
            }
            inst.post.setValues(d.params);
            inst.post.enable = d.enabled;
            next.push(inst);
            keep.add(d.id);
        }
        const dropped = Array.from(this.posts.values()).filter((i) => !next.includes(i));
        this.runtime.setCustomPosts(next.map((i) => i.post));
        for (const inst of dropped) this.sync.disposeLater(inst.post as any);
        this.posts = new Map(next.map((i) => [i.doc, i]));
    }

    /** Snapshot of the graph for the render graph panel and the AI tools. */
    info(): GraphInfo {
        const graph = this.graph;
        if (!graph) return { passes: [], edges: [], error: this.error };
        const compiled: string[] = ((graph as any)._compiled as string[] | null) ?? [];
        const passes: PassInfo[] = graph.passes.map((p: RenderGraphPass) => ({
            name: p.name,
            enabled: p.enabled,
            reads: Array.from(p.reads ?? []),
            writes: Array.from(p.writes ?? []),
            creates: Array.from(p.creates ?? []),
            deps: Array.from(p.dependencies ?? []),
            order: compiled.indexOf(p.name),
            essential: ESSENTIAL.has(p.name),
        }));
        const edges: EdgeInfo[] = [];
        const byName = new Map(passes.map((p) => [p.name, p]));
        const scheduled = compiled.map((n) => byName.get(n)).filter(Boolean) as PassInfo[];
        const writers = new Map<string, PassInfo[]>();
        for (const p of scheduled) {
            for (const w of p.writes) {
                if (!writers.has(w)) writers.set(w, []);
                writers.get(w)!.push(p);
            }
        }
        for (const [res, ws] of writers) {
            for (let i = 1; i < ws.length; i++) {
                if (ws[i - 1] !== ws[i]) edges.push({ from: ws[i - 1].name, to: ws[i].name, label: res, kind: 'mutate' });
            }
        }
        for (const p of scheduled) {
            for (const r of p.reads) {
                const ws = (writers.get(r) ?? []).filter((w) => w.order < p.order && w !== p);
                const last = ws[ws.length - 1];
                if (last) edges.push({ from: last.name, to: p.name, label: r, kind: 'data' });
            }
            for (const d of p.deps) {
                if (byName.get(d)?.order !== undefined && byName.get(d)!.order >= 0) edges.push({ from: d, to: p.name, label: 'dependsOn', kind: 'dep' });
            }
        }
        return { passes, edges, error: this.error };
    }

    /** Post chain in execution order, for display. */
    chain(): { name: string; enabled: boolean; custom: string | null; final: boolean }[] {
        const pass: any = this.graph?.getPass('PostPass');
        const list: Map<string, any> | undefined = pass?.postList;
        if (!list) return [];
        const customByClass = new Map(Array.from(this.posts.values()).map((i) => [i.post.constructor.name, i.doc]));
        const out: { name: string; enabled: boolean; custom: string | null; final: boolean }[] = [];
        const push = (final: boolean) => {
            for (const [name, post] of list) {
                if (!!post.isFinalPass !== final) continue;
                out.push({ name, enabled: !!post.enable, custom: customByClass.get(name) ?? null, final });
            }
        };
        push(false);
        push(true);
        return out;
    }
}

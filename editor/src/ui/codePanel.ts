import type { Editor } from '../editor';
import { applyBehaviorOps } from '../core/behavior/ops';
import { validateTree } from '../core/behavior/validate';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES, className } from '../core/templates';
import type { BehaviorTreeDoc, ScriptDoc, ShaderDoc } from '../core/types';
import type { ShaderMessage } from '../engine/shaders';
import { onChanges, touches } from './batch';
import { CodeEditor, type Diagnostic } from './codeEditor';
import { clear, h, shortcutLabel } from './dom';
import { icon } from './icons';
import { confirmDialog, showMenu, toast, type MenuItem } from './overlays';
import { SelectField, TextField, button, iconButton } from './widgets';

export type CodeKind = 'script' | 'shader' | 'behavior';

/** A behavior tree as the JSON view shows it. */
export function treeJson(t: BehaviorTreeDoc): string {
    return JSON.stringify({ id: t.id, name: t.name, version: t.version, schema: t.schema, root: t.root }, null, 2) + '\n';
}

/** 1-based line of a character position. */
function lineAt(text: string, pos: number): number {
    return text.slice(0, Math.max(0, pos)).split('\n').length;
}

/** The line where a node or service id is written in a tree's JSON (0 when not found). */
function idLine(text: string, id: string | undefined): number {
    if (!id) return 0;
    const i = text.indexOf(`"id": ${JSON.stringify(id)}`);
    return i < 0 ? 0 : lineAt(text, i);
}

/** Editor for one script or shader: code, apply, diagnostics and actions. */
export class CodePanel {
    readonly el: HTMLElement;
    readonly code: CodeEditor;
    private status: HTMLElement;
    private problems: HTMLElement;
    private banner: HTMLElement;
    /** Scripts only: shown while scripts are paused. */
    private pausedBar: HTMLElement | null = null;
    private meta: HTMLElement;
    private nameField: TextField;
    private kindField: SelectField<'material' | 'post'> | null = null;
    private lightingField: SelectField<'lit' | 'unlit'> | null = null;
    private actionButton: HTMLButtonElement | null = null;
    private draftDiagnostics: Diagnostic[] | null = null;
    private checkTimer = 0;
    private checkSerial = 0;
    private offs: (() => void)[] = [];
    /** Source the draft was last synced with. */
    private base: string;
    onDirty: (dirty: boolean) => void = () => {};

    constructor(private editor: Editor, readonly kind: CodeKind, readonly id: string) {
        const doc = this.doc!;
        this.base = doc.code;
        this.code = new CodeEditor({
            language: kind === 'script' ? 'js' : kind === 'behavior' ? 'json' : 'wgsl',
            value: doc.code,
            onChange: () => this.onEdit(),
            onSave: () => this.apply(),
        });
        this.status = h('span', { class: 'code-status' });
        this.problems = h('div', { class: 'code-problems' });
        this.banner = h('div', { class: 'code-banner', attrs: { hidden: true } });
        if (kind === 'script') {
            this.pausedBar = h(
                'div',
                { class: 'code-banner', attrs: { hidden: true } },
                icon('alert', 14),
                h('span', { text: 'Scripts from the opened scene file are paused. Read the code before you enable it.' }),
                button('Enable Scripts', () => editor.enableScripts(), 'small'),
            );
        }
        this.meta = h('span', { class: 'code-meta' });
        this.nameField = new TextField(doc.name, (v) => {
            if (kind === 'script') editor.renameScript(id, v);
            else if (kind === 'behavior') editor.applyBehaviorOps([{ op: 'update_tree', tree: id, name: v.replace(/\.json$/i, '').trim() }], { label: 'Rename Tree' });
            else editor.updateShader(id, { name: v });
        });
        this.nameField.el.classList.add('code-name');

        const controls: Node[] = [];
        if (kind === 'shader') {
            const sd = doc as ShaderDoc;
            this.kindField = new SelectField<'material' | 'post'>(
                [
                    { value: 'material', label: 'Material shader' },
                    { value: 'post', label: 'Post effect' },
                ],
                sd.kind,
                (v) => editor.updateShader(id, { kind: v }),
            );
            this.lightingField = new SelectField<'lit' | 'unlit'>(
                [
                    { value: 'lit', label: 'Lit' },
                    { value: 'unlit', label: 'Unlit' },
                ],
                sd.lighting,
                (v) => editor.updateShader(id, { lighting: v }),
            );
            controls.push(this.kindField.el, this.lightingField.el);
        }
        this.actionButton = button('', () => this.primaryAction(), 'small');
        const applyBtn = button('Apply', () => this.apply(), 'small primary', 'check');
        applyBtn.title = `Apply changes (${shortcutLabel('Mod+S')})`;
        const aiBtn = button('Ask AI', (e) => this.aiMenu(e), 'small', 'sparkle');
        const more = iconButton('dots', 'More', (e) => this.moreMenu(e));

        this.el = h(
            'div',
            { class: 'code-panel' },
            h(
                'div',
                { class: 'code-toolbar' },
                icon(kind === 'script' ? 'script' : kind === 'behavior' ? 'behavior' : 'shader', 15),
                this.nameField.el,
                ...controls,
                this.meta,
                h('div', { class: 'spacer' }),
                this.status,
                applyBtn,
                this.actionButton,
                aiBtn,
                more,
            ),
            this.banner,
            this.pausedBar,
            h('div', { class: 'code-main' }, this.code.el, this.problems),
        );

        const store = editor.store;
        // Scripts and shaders change without a hint, behavior trees with a behavior hint. The action
        // button also follows the post chain (environment) and the selected objects' meshes.
        const changes = onChanges(store, (hint) => {
            if (kind === 'behavior' ? touches(hint, 'behavior') : touches(hint)) this.onDocChange();
            else if (touches(hint, 'nodes', 'env')) this.refreshAction();
        });
        this.offs.push(
            changes.off,
            store.on('load', () => this.onDocChange()),
            store.on('selection', () => this.refreshAction()),
        );
        if (kind === 'shader') this.offs.push(editor.shaders.on('status', (sid) => sid === id && this.refreshStatus()));
        else if (kind === 'behavior') this.offs.push(editor.player.on('state', () => this.refreshStatus()));
        else {
            this.offs.push(editor.compiler.on('compiled', (sid) => sid === id && this.refreshStatus()));
            this.offs.push(editor.player.on('issue', (issue) => issue.script === id && this.refreshStatus()));
            this.offs.push(editor.player.on('state', () => this.refreshStatus()));
        }
        this.refreshAction();
        this.refreshStatus();
    }

    get doc(): ScriptDoc | ShaderDoc | undefined {
        const d = this.editor.store.doc;
        if (this.kind === 'behavior') {
            const t = d.behaviors.find((x) => x.id === this.id);
            return t ? { id: t.id, name: `${t.name}.json`, code: treeJson(t) } : undefined;
        }
        return this.kind === 'script' ? d.scripts.find((s) => s.id === this.id) : d.shaders.find((s) => s.id === this.id);
    }

    get title(): string {
        return this.doc?.name ?? '(deleted)';
    }

    get dirty(): boolean {
        const doc = this.doc;
        return !!doc && this.code.value !== doc.code;
    }

    dispose() {
        for (const off of this.offs) off();
        clearTimeout(this.checkTimer);
    }

    focus() {
        this.code.focus();
    }

    apply() {
        const doc = this.doc;
        if (!doc) return;
        const value = this.code.value;
        if (this.kind === 'behavior') {
            this.applyTree(value);
            return;
        }
        this.base = value;
        this.banner.hidden = true;
        if (this.kind === 'script') this.editor.updateScript(this.id, value);
        else this.editor.updateShader(this.id, { code: value });
        this.draftDiagnostics = null;
        this.onDirty(false);
        this.refreshStatus();
    }

    /**
     * Problems of a tree's JSON: its syntax, then a dry run of the edit
     * operation Apply uses, so typing shows what Apply would say. Structural
     * errors come back without an operation (Apply refuses them); problems
     * such as a missing key are listed and can be saved.
     */
    private treeDraft(value: string): { list: Diagnostic[]; op: Record<string, unknown> | null } {
        let parsed: any;
        try {
            parsed = JSON.parse(value);
        } catch (e: any) {
            const msg = String(e?.message || e);
            const pos = /position (\d+)/.exec(msg);
            return { list: [{ line: pos ? lineAt(value, Number(pos[1])) : 0, column: 1, message: `Not valid JSON: ${msg}`, severity: 'error' }], op: null };
        }
        if (!parsed || typeof parsed !== 'object' || !parsed.root) return { list: [{ line: 1, column: 1, message: 'The JSON needs a "root" node.', severity: 'error' }], op: null };
        const op = { op: 'replace_tree', tree: this.id, root: parsed.root, name: parsed.name, schema: parsed.schema };
        const r = applyBehaviorOps(this.editor.store.doc, [op], 'lenient');
        if (!r.ok) return { list: r.errors.map((e) => ({ line: idLine(value, e.node), column: 1, message: `${e.node ? `${e.node}: ` : ''}${e.field ? `${e.field}: ` : ''}${e.message}`, severity: 'error' })), op: null };
        const list: Diagnostic[] = r.issues
            .filter((i) => i.tree === this.id)
            .map((i) => ({ line: idLine(value, i.node), column: 1, message: `${i.node ? `${i.node}: ` : ''}${i.field ? `${i.field}: ` : ''}${i.message}`, severity: i.severity }));
        return { list, op };
    }

    /**
     * Saves the JSON view: it goes through the same edit operation and
     * validation as every other edit. Structural errors refuse it (with the
     * line); problems such as a missing key are saved and shown.
     */
    private applyTree(value: string) {
        const draft = this.treeDraft(value);
        if (!draft.op) {
            this.draftDiagnostics = draft.list;
            this.refreshStatus();
            return;
        }
        const r = this.editor.applyBehaviorOps([draft.op], { label: 'Edit Tree JSON' });
        if (!r.ok) {
            this.draftDiagnostics = r.errors.map((e) => ({ line: idLine(value, e.node), column: 1, message: `${e.node ? `${e.node}: ` : ''}${e.field ? `${e.field}: ` : ''}${e.message}`, severity: 'error' }));
            this.refreshStatus();
            return;
        }
        const doc = this.doc;
        this.base = doc?.code ?? value;
        this.code.setValue(this.base);
        this.banner.hidden = true;
        this.draftDiagnostics = null;
        this.onDirty(false);
        this.refreshStatus();
    }

    revert() {
        const doc = this.doc;
        if (!doc) return;
        this.base = doc.code;
        this.code.setValue(doc.code);
        this.banner.hidden = true;
        this.draftDiagnostics = null;
        this.onDirty(false);
        this.refreshStatus();
    }

    /** Jumps to a line, e.g. from a console message. */
    reveal(line: number, column = 1) {
        this.code.revealLine(line, column);
    }

    // ------------------------------------------------------------- internals

    private onEdit() {
        this.onDirty(this.dirty);
        this.status.textContent = this.dirty ? 'Unsaved changes' : this.status.textContent;
        clearTimeout(this.checkTimer);
        this.checkTimer = window.setTimeout(() => void this.checkDraft(), 450);
    }

    private async checkDraft() {
        const doc = this.doc;
        if (!doc) return;
        const serial = ++this.checkSerial;
        const code = this.code.value;
        if (code === doc.code) {
            this.draftDiagnostics = null;
            this.refreshStatus();
            return;
        }
        let list: Diagnostic[];
        if (this.kind === 'behavior') {
            list = this.treeDraft(code).list;
        } else if (this.kind === 'script') {
            const c = this.editor.compiler.compile({ ...(doc as ScriptDoc), code });
            list = c.error && !c.paused ? [{ line: c.error.line, column: c.error.column, message: c.error.message, severity: 'error' }] : [];
        } else {
            const sd = doc as ShaderDoc;
            const res = await this.editor.shaders.analyze({ ...sd, code });
            list = res.messages.map(toDiagnostic);
        }
        if (serial !== this.checkSerial) return;
        this.draftDiagnostics = list;
        this.refreshStatus();
    }

    private onDocChange() {
        const doc = this.doc;
        if (!doc) return;
        this.nameField.set(doc.name);
        if (this.kind === 'shader') {
            this.kindField?.set((doc as ShaderDoc).kind);
            this.lightingField?.set((doc as ShaderDoc).lighting);
            if (this.lightingField) this.lightingField.el.hidden = (doc as ShaderDoc).kind === 'post';
        }
        if (doc.code !== this.base) {
            if (this.code.value === this.base) {
                // Not edited here: follow the document (undo, AI edits).
                this.base = doc.code;
                this.code.setValue(doc.code);
                this.draftDiagnostics = null;
            } else if (doc.code !== this.code.value) {
                this.banner.hidden = false;
                clear(this.banner);
                this.banner.append(
                    icon('alert', 14),
                    h('span', { text: 'This file was changed outside this editor.' }),
                    button('Load their version', () => this.revert(), 'small'),
                    button('Keep mine', () => {
                        this.base = doc.code;
                        this.banner.hidden = true;
                    }, 'small subtle'),
                );
            }
        }
        this.onDirty(this.dirty);
        this.refreshAction();
        this.refreshStatus();
    }

    private diagnostics(): Diagnostic[] {
        if (this.draftDiagnostics) return this.draftDiagnostics;
        if (this.kind === 'shader') return this.editor.shaders.status(this.id).messages.map(toDiagnostic);
        if (this.kind === 'behavior') {
            const d = this.editor.store.doc;
            const t = d.behaviors.find((x) => x.id === this.id);
            if (!t) return [];
            const text = this.code.value;
            return validateTree(t, d.blackboards, d.memory, d.aiModels).map((i) => ({ line: idLine(text, i.node), column: 1, message: `${i.node ? `${i.node}: ` : ''}${i.field ? `${i.field}: ` : ''}${i.message}`, severity: i.severity }));
        }
        const c = this.editor.compiler.get(this.id);
        const list: Diagnostic[] = [];
        if (c?.error && !c.paused) list.push({ line: c.error.line, column: c.error.column, message: c.error.message, severity: 'error' });
        if (c?.fieldError) list.push({ line: 0, column: 0, message: c.fieldError, severity: 'warning' });
        for (const issue of this.editor.player.issues) {
            if (issue.script !== this.id) continue;
            list.push({ line: issue.line, column: 1, message: `${issue.method}() on "${issue.node}": ${issue.message}`, severity: 'error' });
        }
        return list;
    }

    private refreshStatus() {
        const diags = this.diagnostics();
        this.code.setDiagnostics(diags);
        const errors = diags.filter((d) => d.severity === 'error').length;
        const warnings = diags.length - errors;
        let text = '';
        let cls = 'code-status';
        if (this.kind === 'behavior') {
            text = errors ? `${errors} error${errors > 1 ? 's' : ''}` : warnings ? `${warnings} warning${warnings > 1 ? 's' : ''}` : 'Valid';
            if (this.editor.player.state !== 'stopped') text += ' · locked while playing';
            this.meta.textContent = 'Saved through the same edit operations and checks as the outliner';
        } else if (this.kind === 'shader') {
            const st = this.editor.shaders.status(this.id);
            if (st.state === 'compiling') text = 'Compiling...';
            else if (errors) text = `${errors} error${errors > 1 ? 's' : ''}` + (this.editor.shaders.isValid(this.id) ? ' (last good version in use)' : '');
            else if (st.state === 'ok') text = 'Compiled';
        } else {
            const c = this.editor.compiler.get(this.id);
            if (this.pausedBar) this.pausedBar.hidden = !c?.paused;
            if (errors) text = `${errors} error${errors > 1 ? 's' : ''}`;
            else if (c?.paused) text = 'Paused';
            else if (c?.cls) text = 'Ready';
            this.meta.textContent = c?.cls
                ? [c.className, c.fields.length ? `fields: ${c.fields.map((f) => f.name).join(', ')}` : '', c.methods.length ? `${c.methods.join(', ')}` : '']
                      .filter(Boolean)
                      .join(' · ')
                : '';
        }
        if (this.kind === 'shader') {
            const props = this.editor.shaders.props(this.id);
            this.meta.textContent = props.length ? `properties: ${props.map((p) => p.name).join(', ')}` : '';
        }
        if (this.dirty) text = (text ? text + ' · ' : '') + 'unsaved';
        cls += errors ? ' error' : warnings ? ' warn' : text === 'Compiled' || text === 'Ready' || text === 'Valid' ? ' ok' : '';
        this.status.className = cls;
        this.status.textContent = text;

        clear(this.problems);
        this.problems.hidden = diags.length === 0;
        for (const d of diags) {
            const row = h(
                'button',
                { class: 'problem ' + d.severity, attrs: { type: 'button' } },
                icon(d.severity === 'error' ? 'alert' : 'info', 13),
                h('span', { class: 'problem-line', text: d.line ? `Line ${d.line}` : 'General' }),
                h('span', { class: 'problem-text', text: d.message }),
            );
            row.addEventListener('click', () => d.line && this.code.revealLine(d.line, d.column || 1));
            this.problems.appendChild(row);
        }
    }

    private refreshAction() {
        const btn = this.actionButton;
        const doc = this.doc;
        if (!btn || !doc) return;
        const sel = this.editor.store.selection;
        let label = '';
        let title = '';
        if (this.kind === 'behavior') {
            label = 'Show in Outliner';
            title = 'Open this tree in the Behavior tab';
            btn.disabled = false;
        } else if (this.kind === 'script') {
            label = 'Attach to Selection';
            title = sel.length ? `Add this script to ${sel.length} selected object(s)` : 'Select objects to attach this script to';
            btn.disabled = !sel.length;
        } else if ((doc as ShaderDoc).kind === 'material') {
            label = 'Assign to Selection';
            const meshes = sel.filter((id) => this.editor.store.node(id)?.mesh);
            title = meshes.length ? `Render ${meshes.length} selected mesh(es) with this shader` : 'Select mesh objects to use this shader';
            btn.disabled = !meshes.length;
        } else {
            const inChain = this.editor.store.doc.renderGraph.posts.some((p) => p.shader === this.id);
            label = inChain ? 'Show in Render Graph' : 'Add to Post Chain';
            title = inChain ? 'This effect is in the post chain' : 'Run this effect in the render graph post chain';
            btn.disabled = false;
        }
        btn.replaceChildren(icon('link', 14), h('span', { text: label }));
        btn.title = title;
    }

    private primaryAction() {
        const doc = this.doc;
        if (!doc) return;
        if (this.dirty) this.apply();
        const sel = this.editor.store.selection;
        if (this.kind === 'behavior') {
            this.editor.showBehavior({ tree: this.id });
        } else if (this.kind === 'script') {
            this.editor.attachScript(sel, this.id);
            toast(`Attached ${doc.name} to ${sel.length} object(s)`, 'success');
        } else if ((doc as ShaderDoc).kind === 'material') {
            this.editor.assignShader(sel, this.id);
        } else {
            if (!this.editor.store.doc.renderGraph.posts.some((p) => p.shader === this.id)) this.editor.addPostEffect(this.id);
            this.editor.emit('show-graph', undefined);
        }
    }

    private aiMenu(e: MouseEvent) {
        const doc = this.doc;
        if (!doc) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const what = this.kind === 'script' ? 'script' : this.kind === 'behavior' ? 'behavior tree' : 'shader';
        const ref = `${what} "${doc.name}" (id ${doc.id})`;
        const errors = this.diagnostics().filter((d) => d.severity === 'error');
        const items: MenuItem[] = [
            {
                label: 'Fix the errors',
                icon: 'alert',
                enabled: () => errors.length > 0,
                action: () => {
                    if (this.dirty) this.apply();
                    this.editor.askAI(
                        this.kind === 'behavior'
                            ? `Fix the problems of the ${ref}: read it with get_behavior_outline, then fix it with apply_behavior_ops and check it with validate_behavior.`
                            : `Fix the errors in the ${ref}. Read it first, apply a corrected version and check it compiles.`,
                        true,
                    );
                },
            },
            {
                label: 'Explain this code',
                icon: 'info',
                action: () => this.editor.askAI(`Explain what the ${ref} does, briefly, section by section.`, true),
            },
            {
                label: 'Improve / extend...',
                icon: 'sparkle',
                action: () => this.editor.askAI(`Change the ${ref} so that `, false),
            },
        ];
        showMenu(items, r.right - 200, r.bottom + 4);
    }

    private moreMenu(e: MouseEvent) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const doc = this.doc;
        if (!doc) return;
        const replace = async (code: string): Promise<boolean> => {
            if (this.code.value.trim() && !(await confirmDialog('Replace code', 'Replace the current code with the template?', 'Replace'))) return false;
            this.code.setValue(code);
            this.onEdit();
            return true;
        };
        const templates: MenuItem[] =
            this.kind === 'behavior'
                ? []
                : this.kind === 'script'
                ? SCRIPT_TEMPLATES.map((t) => ({ label: t.label, action: () => void replace(t.code(className(doc.name))) }))
                : SHADER_TEMPLATES.filter((t) => t.kind === (doc as ShaderDoc).kind).map((t) => ({
                      label: t.label,
                      action: () =>
                          void replace(t.code).then((done) => {
                              // Only once the code is replaced: Cancel keeps the shader as it was.
                              if (done && (doc as ShaderDoc).lighting !== t.lighting) this.editor.updateShader(this.id, { lighting: t.lighting });
                          }),
                  }));
        showMenu(
            [
                { label: 'Revert Changes', icon: 'undo', enabled: () => this.dirty, action: () => this.revert() },
                ...(this.kind === 'behavior'
                    ? []
                    : ([
                          { label: 'Replace with Template', icon: 'copy', submenu: templates },
                          { separator: true },
                          {
                              label: 'Delete File',
                              icon: 'trash',
                              action: () => void (this.kind === 'script' ? this.editor.deleteScript(this.id) : this.editor.deleteShader(this.id)),
                          },
                      ] as MenuItem[])),
            ],
            r.right - 220,
            r.bottom + 4,
        );
    }
}

function toDiagnostic(m: ShaderMessage): Diagnostic {
    return { line: m.line, column: m.column, message: m.message, severity: m.severity };
}

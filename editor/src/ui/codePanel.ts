import type { Editor } from '../editor';
import { SCRIPT_TEMPLATES, SHADER_TEMPLATES, className } from '../core/templates';
import type { ScriptDoc, ShaderDoc } from '../core/types';
import type { ShaderMessage } from '../engine/shaders';
import { CodeEditor, type Diagnostic } from './codeEditor';
import { clear, h, shortcutLabel } from './dom';
import { icon } from './icons';
import { confirmDialog, showMenu, toast, type MenuItem } from './overlays';
import { SelectField, TextField, button, iconButton } from './widgets';

export type CodeKind = 'script' | 'shader';

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
            language: kind === 'script' ? 'js' : 'wgsl',
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
                icon(kind === 'script' ? 'script' : 'shader', 15),
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
        this.offs.push(
            store.on('change', () => this.onDocChange()),
            store.on('load', () => this.onDocChange()),
            store.on('selection', () => this.refreshAction()),
        );
        if (kind === 'shader') this.offs.push(editor.shaders.on('status', (sid) => sid === id && this.refreshStatus()));
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
        this.base = value;
        this.banner.hidden = true;
        if (this.kind === 'script') this.editor.updateScript(this.id, value);
        else this.editor.updateShader(this.id, { code: value });
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
        if (this.kind === 'script') {
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
        if (this.kind === 'shader') {
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
        cls += errors ? ' error' : warnings ? ' warn' : text === 'Compiled' || text === 'Ready' ? ' ok' : '';
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
        if (this.kind === 'script') {
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
        if (this.kind === 'script') {
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
        const what = this.kind === 'script' ? 'script' : 'shader';
        const ref = `${what} "${doc.name}" (id ${doc.id})`;
        const errors = this.diagnostics().filter((d) => d.severity === 'error');
        const items: MenuItem[] = [
            {
                label: 'Fix the errors',
                icon: 'alert',
                enabled: () => errors.length > 0,
                action: () => {
                    if (this.dirty) this.apply();
                    this.editor.askAI(`Fix the errors in the ${ref}. Read it first, apply a corrected version and check it compiles.`, true);
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
        const replace = async (code: string) => {
            if (this.code.value.trim() && !(await confirmDialog('Replace code', 'Replace the current code with the template?', 'Replace'))) return;
            this.code.setValue(code);
            this.onEdit();
        };
        const templates: MenuItem[] =
            this.kind === 'script'
                ? SCRIPT_TEMPLATES.map((t) => ({ label: t.label, action: () => void replace(t.code(className(doc.name))) }))
                : SHADER_TEMPLATES.filter((t) => t.kind === (doc as ShaderDoc).kind).map((t) => ({
                      label: t.label,
                      action: () => {
                          void replace(t.code);
                          if ((doc as ShaderDoc).lighting !== t.lighting) this.editor.updateShader(this.id, { lighting: t.lighting });
                      },
                  }));
        showMenu(
            [
                { label: 'Revert Changes', icon: 'undo', enabled: () => this.dirty, action: () => this.revert() },
                { label: 'Replace with Template', icon: 'copy', submenu: templates },
                { separator: true },
                {
                    label: 'Delete File',
                    icon: 'trash',
                    action: () => void (this.kind === 'script' ? this.editor.deleteScript(this.id) : this.editor.deleteShader(this.id)),
                },
            ],
            r.right - 220,
            r.bottom + 4,
        );
    }
}

function toDiagnostic(m: ShaderMessage): Diagnostic {
    return { line: m.line, column: m.column, message: m.message, severity: m.severity };
}

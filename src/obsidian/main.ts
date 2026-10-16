import { Plugin, PluginSettingTab, Setting, Modal, Notice, MarkdownView, type App } from 'obsidian';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Checker, DEFAULTS, mistakeKey, isCancelled, type Mistake, type Settings } from '../core/checker';

class Insertion extends WidgetType {
  constructor(private index: number) { super(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'local-grammar-insertion'; el.textContent = '▏';
    el.dataset.lgIndex = String(this.index); el.setAttribute('aria-label', 'Grammar suggestion');
    return el;
  }
}

export default class LocalGrammar extends Plugin {
  settings: Settings = { ...DEFAULTS };
  checker = new Checker();
  editors = new Set<GrammarEditor>();
  status!: HTMLElement;
  async onload() {
    this.settings = { ...DEFAULTS, ...await this.loadData() };
    this.status = this.addStatusBarItem(); this.status.setText('Grammar: ready');
    const owner = this;
    this.registerEditorExtension(ViewPlugin.fromClass(class extends GrammarEditor {
      constructor(view: EditorView) { super(view, owner); }
    }, { decorations: value => value.decorations }));
    this.addCommand({ id: 'check-note', name: 'Check current note and review all suggestions', hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'g' }], editorCallback: editor => {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView);
      const instance = [...this.editors].find(e => e.view.dom.closest('.markdown-source-view') === active?.contentEl.querySelector('.markdown-source-view'));
      if (instance) void instance.check(true);
      else new Notice('Open a note in editing mode to check grammar.');
    } });
    this.addCommand({ id: 'show-suggestion', name: 'Show suggestion at cursor', hotkeys: [{ modifiers: ['Alt'], key: 'Enter' }], editorCallback: () => {
      const active = this.app.workspace.getActiveViewOfType(MarkdownView);
      const instance = [...this.editors].find(e => active?.contentEl.contains(e.view.dom));
      if (instance) {
        const pos = instance.view.state.selection.main.head;
        const nearest = instance.mistakes.find(m => m.from <= pos && m.to >= pos) ?? instance.mistakes.find(m => m.from >= pos);
        if (nearest) new Suggestions(this.app, instance, [nearest]).open();
        else new Notice('No suggestion at or after the cursor. Run Check current note first.');
      }
    } });
    this.addSettingTab(new GrammarSettings(this.app, this));
  }
  async changed() {
    await this.saveData(this.settings); this.checker.clear();
    for (const editor of this.editors) editor.reset();
  }
  onunload() { for (const editor of this.editors) editor.destroy(); }
}

class GrammarEditor {
  decorations: DecorationSet = Decoration.none;
  mistakes: Mistake[] = [];
  snapshot = '';
  ignored = new Set<string>();
  private timer?: number;
  private request?: AbortController;
  private click: (event: MouseEvent) => void;
  constructor(readonly view: EditorView, readonly owner: LocalGrammar) {
    owner.editors.add(this);
    this.click = event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-lg-index]');
      if (!target) return;
      const mistake = this.mistakes[Number(target.dataset.lgIndex)];
      if (mistake) { event.preventDefault(); new Suggestions(owner.app, this, [mistake]).open(); }
    };
    view.dom.addEventListener('click', this.click);
    this.schedule();
  }
  update(update: ViewUpdate) {
    if (update.docChanged) { this.ignored.clear(); this.reset(); }
  }
  reset() {
    this.request?.abort(); clearTimeout(this.timer);
    this.mistakes = []; this.decorations = Decoration.none;
    // Schedule an empty transaction outside CM's update cycle to refresh decorations.
    queueMicrotask(() => { if (this.owner.editors.has(this)) this.view.dispatch({}); });
    this.schedule();
  }
  private schedule() {
    if (this.owner.settings.autoCheck) this.timer = window.setTimeout(() => {
      if (this.view.composing) this.schedule();
      else void this.check(false);
    }, 1100);
  }
  async check(review: boolean) {
    clearTimeout(this.timer); this.request?.abort();
    const controller = new AbortController(); this.request = controller;
    const text = this.view.state.doc.toString(); this.snapshot = text;
    this.owner.status.setText('Grammar: checking locally…');
    try {
      const all = await this.owner.checker.check(text, this.owner.settings, controller.signal);
      if (controller.signal.aborted || this.view.state.doc.toString() !== text) return;
      this.mistakes = all.filter(m => !this.ignored.has(mistakeKey(m)));
      this.refresh();
      this.owner.status.setText(`Grammar: ${this.mistakes.length} suggestion${this.mistakes.length === 1 ? '' : 's'}`);
      if (review) new Suggestions(this.owner.app, this).open();
    } catch (error) {
      if (isCancelled(error)) return;
      this.owner.status.setText('Grammar: unavailable - check settings');
      new Notice(error instanceof Error ? error.message : String(error), 12000);
    }
  }
  refresh() {
    this.decorations = Decoration.set(this.mistakes.map((m, i) => m.from === m.to
      ? Decoration.widget({ widget: new Insertion(i), side: 1 }).range(m.from)
      : Decoration.mark({ class: 'local-grammar-mark', attributes: { 'data-lg-index': String(i), title: m.explanation } }).range(m.from, m.to)), true);
    this.view.dispatch({});
  }
  apply(m: Mistake) {
    if (!this.mistakes.includes(m) || this.view.state.doc.toString() !== this.snapshot) {
      new Notice('Suggestion is stale. Check the note again.'); return;
    }
    this.view.dispatch({ changes: { from: m.from, to: m.to, insert: m.replacement } });
    void this.check(false);
  }
  ignore(m: Mistake) {
    if (!this.mistakes.includes(m)) return;
    this.ignored.add(mistakeKey(m)); this.mistakes = this.mistakes.filter(other => other !== m); this.refresh();
    this.owner.status.setText(`Grammar: ${this.mistakes.length} suggestion${this.mistakes.length === 1 ? '' : 's'}`);
  }
  destroy() {
    clearTimeout(this.timer); this.request?.abort();
    this.view.dom.removeEventListener('click', this.click); this.owner.editors.delete(this);
  }
}

class Suggestions extends Modal {
  constructor(app: App, private editor: GrammarEditor, private selected?: Mistake[]) { super(app); }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.addClass('local-grammar-review');
    contentEl.createEl('h2', { text: 'Local Grammar' });
    contentEl.createEl('p', { text: 'Checked on your machine. Review each change before applying.', cls: 'local-grammar-muted' });
    const mistakes = this.selected ?? this.editor.mistakes;
    if (!mistakes.length) contentEl.createEl('p', { text: 'No suggestions. Your text is unchanged.' });
    for (const m of mistakes) {
      const row = contentEl.createDiv({ cls: 'local-grammar-card' });
      row.createEl('small', { text: `${m.language.toUpperCase()} · ${m.category} · character ${m.from + 1}` });
      const context = row.createEl('p', { cls: 'local-grammar-context' });
      const text = this.editor.snapshot;
      const lineStart = text.lastIndexOf('\n', m.from - 1) + 1;
      const lineEnd = text.indexOf('\n', m.to) < 0 ? text.length : text.indexOf('\n', m.to);
      context.appendText(text.slice(Math.max(lineStart, m.from - 45), m.from));
      context.createEl('mark', { text: m.original || '▏' });
      context.appendText(text.slice(m.to, Math.min(lineEnd, m.to + 45)));
      row.createEl('p', { text: m.explanation });
      row.createEl('strong', { text: `${m.original || '(insert)'} → ${m.replacement || '(delete)'}` });
      const actions = row.createDiv({ cls: 'local-grammar-actions' });
      actions.createEl('button', { text: 'Apply fix', cls: 'mod-cta' }).onclick = () => { this.editor.apply(m); this.close(); };
      actions.createEl('button', { text: 'Ignore' }).onclick = () => { this.editor.ignore(m); row.remove(); };
    }
  }
}

class GrammarSettings extends PluginSettingTab {
  constructor(app: App, private plugin: LocalGrammar) { super(app, plugin); }
  display() {
    const root = this.containerEl; root.empty(); root.createEl('h2', { text: 'Local Grammar' });
    root.createEl('p', { text: 'Only loopback Ollama servers are accepted. Install the model with: ollama pull ' + this.plugin.settings.model });
    new Setting(root).setName('Ollama URL').addText(t => t.setValue(this.plugin.settings.url).onChange(async value => { this.plugin.settings.url = value.trim(); await this.plugin.changed(); }));
    new Setting(root).setName('Model').addText(t => t.setValue(this.plugin.settings.model).onChange(async value => { this.plugin.settings.model = value.trim(); await this.plugin.changed(); }));
    new Setting(root).setName('Check after a typing pause').addToggle(t => t.setValue(this.plugin.settings.autoCheck).onChange(async value => { this.plugin.settings.autoCheck = value; await this.plugin.changed(); }));
    for (const language of ['en', 'de'] as const) new Setting(root).setName(language === 'en' ? 'English' : 'German').addToggle(t => t.setValue(this.plugin.settings.languages.includes(language)).onChange(async enabled => {
      this.plugin.settings.languages = enabled ? [...this.plugin.settings.languages, language] : this.plugin.settings.languages.filter(l => l !== language);
      await this.plugin.changed();
    }));
  }
}

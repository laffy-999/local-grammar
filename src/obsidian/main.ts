import { Plugin, PluginSettingTab, Setting, Modal, Notice, MarkdownView, type App } from 'obsidian';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Checker, DEFAULTS, mistakeKey, isCancelled, type Mistake, type Settings } from '../core/checker';
import { Review } from '../core/review';

class Insertion extends WidgetType {
  constructor(private index: number) { super(); }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'open-grammar-insertion'; el.textContent = '▏';
    el.dataset.ogIndex = String(this.index); el.setAttribute('aria-label', 'Open Grammar suggestion');
    return el;
  }
}

export default class OpenGrammar extends Plugin {
  settings: Settings = { ...DEFAULTS };
  checker = new Checker();
  editors = new Set<GrammarEditor>();
  status!: HTMLElement;
  async onload() {
    this.settings = { ...DEFAULTS, ...await this.loadData() };
    this.status = this.addStatusBarItem(); this.status.setText('Open Grammar: ready');
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
        if (nearest) new Suggestions(this.app, instance, instance.review!.suggestions.find(s => s.pieces.includes(nearest))!.id).open();
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
  review?: Review;
  get mistakes(): Mistake[] { return this.review?.mistakes ?? []; }
  get snapshot(): string { return this.review?.text ?? ''; }
  private applying = false;
  ignored = new Set<string>();
  private timer?: number;
  private request?: AbortController;
  private click: (event: MouseEvent) => void;
  constructor(readonly view: EditorView, readonly owner: OpenGrammar) {
    owner.editors.add(this);
    this.click = event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-og-index]');
      if (!target) return;
      const mistake = this.mistakes[Number(target.dataset.ogIndex)];
      if (mistake) { event.preventDefault(); new Suggestions(owner.app, this, this.review!.suggestions.find(s => s.pieces.includes(mistake))!.id).open(); }
    };
    view.dom.addEventListener('click', this.click);
    this.schedule();
  }
  update(update: ViewUpdate) {
    if (update.docChanged && !this.applying) { this.ignored.clear(); this.reset(); }
  }
  reset() {
    this.request?.abort(); clearTimeout(this.timer);
    this.review = undefined; this.decorations = Decoration.none;
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
    const text = this.view.state.doc.toString();
    this.owner.status.setText('Open Grammar: checking locally…');
    try {
      const all = await this.owner.checker.check(text, this.owner.settings, controller.signal);
      if (controller.signal.aborted || this.view.state.doc.toString() !== text) return;
      this.review = new Review(text, all.filter(m => !this.ignored.has(mistakeKey(m))));
      this.refresh();
      this.owner.status.setText(`Open Grammar: ${this.mistakes.length} edit${this.mistakes.length === 1 ? '' : 's'}`);
      if (review) new Suggestions(this.owner.app, this).open();
    } catch (error) {
      if (isCancelled(error)) return;
      this.owner.status.setText('Open Grammar: unavailable - check settings');
      new Notice(error instanceof Error ? error.message : String(error), 12000);
    }
  }
  refresh() {
    this.decorations = Decoration.set(this.mistakes.map((m, i) => m.from === m.to
      ? Decoration.widget({ widget: new Insertion(i), side: 1 }).range(m.from)
      : Decoration.mark({ class: 'open-grammar-mark', attributes: { 'data-og-index': String(i), title: m.explanation } }).range(m.from, m.to)), true);
    this.view.dispatch({});
  }
  apply(pieces: Mistake[], expected: Review): boolean {
    if (this.review !== expected || this.view.state.doc.toString() !== expected.text) {
      new Notice('Suggestion is stale. Check the note again.'); return false;
    }
    try {
      const next = expected.accept(pieces);
      this.request?.abort(); clearTimeout(this.timer);
      this.applying = true;
      try { this.view.dispatch({ changes: pieces.map(m => ({ from: m.from, to: m.to, insert: m.replacement })).sort((a, b) => a.from - b.from) }); }
      finally { this.applying = false; }
      this.review = next; this.ignored.clear(); this.refresh(); this.updateStatus();
      return true;
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); return false; }
  }
  ignore(m: Mistake, expected: Review) {
    if (this.review !== expected) return;
    this.ignored.add(mistakeKey(m)); this.review = expected.dismiss(m); this.refresh(); this.updateStatus();
  }
  private updateStatus() {
    this.owner.status.setText(`Open Grammar: ${this.mistakes.length} edit${this.mistakes.length === 1 ? '' : 's'} remaining`);
  }
  destroy() {
    clearTimeout(this.timer); this.request?.abort();
    this.view.dom.removeEventListener('click', this.click); this.owner.editors.delete(this);
  }
}

class Suggestions extends Modal {
  private expected?: Review;
  constructor(app: App, private editor: GrammarEditor, private selected?: number) { super(app); }
  onOpen() { this.expected = this.editor.review; this.render(); }
  private render() {
    const { contentEl } = this; contentEl.empty(); contentEl.addClass('open-grammar-review');
    contentEl.createEl('h2', { text: 'Open Grammar' });
    const review = this.expected;
    if (!review) return;
    contentEl.createEl('p', { text: 'Accept individual word or punctuation edits, or accept all changes together.', cls: 'open-grammar-muted' });
    const groups = review.suggestions.filter(s => this.selected === undefined || s.id === this.selected);
    const accept = (pieces: Mistake[]) => {
      if (this.editor.apply(pieces, review)) { this.expected = this.editor.review; this.render(); }
    };
    if (this.selected === undefined && review.mistakes.length) {
      contentEl.createEl('button', { text: 'Accept all in note', cls: 'mod-cta' }).onclick = () => accept(review.mistakes);
    }
    if (!groups.length) contentEl.createEl('p', { text: 'No edits remaining in this review.' });
    for (const group of groups) {
      const row = contentEl.createDiv({ cls: 'open-grammar-card' });
      const first = group.pieces[0], last = group.pieces.at(-1)!;
      const lineStart = review.text.lastIndexOf('\n', first.from - 1) + 1;
      const lineEnd = review.text.indexOf('\n', last.to);
      row.createEl('p', { cls: 'open-grammar-context', text: review.text.slice(lineStart, lineEnd < 0 ? review.text.length : lineEnd) });
      row.createEl('button', { text: 'Accept all in suggestion' }).onclick = () => accept(group.pieces);
      for (const m of group.pieces) {
        const piece = row.createDiv({ cls: 'open-grammar-piece' });
        piece.createEl('small', { text: `${m.language.toUpperCase()} · ${m.category} · character ${m.from + 1}` });
        piece.createEl('strong', { text: `${JSON.stringify(m.original)} → ${JSON.stringify(m.replacement)}` });
        piece.createEl('p', { text: m.explanation });
        const actions = piece.createDiv({ cls: 'open-grammar-actions' });
        actions.createEl('button', { text: 'Accept edit', cls: 'mod-cta' }).onclick = () => accept([m]);
        actions.createEl('button', { text: 'Ignore edit' }).onclick = () => {
          this.editor.ignore(m, review);
          if (this.editor.review !== review) { this.expected = this.editor.review; this.render(); }
        };
      }
    }
  }
}

class GrammarSettings extends PluginSettingTab {
  constructor(app: App, private plugin: OpenGrammar) { super(app, plugin); }
  display() {
    const root = this.containerEl; root.empty(); root.createEl('h2', { text: 'Open Grammar' });
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

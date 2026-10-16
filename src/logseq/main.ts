import '@logseq/libs';
import type { BlockEntity } from '@logseq/libs/dist/LSPlugin';
import { Checker, DEFAULTS, applyMistake, isCancelled, mistakeKey, type Mistake, type Settings } from '../core/checker';

interface BlockResult { uuid: string; text: string; mistakes: Mistake[] }
const checker = new Checker();
const results = new Map<string, BlockResult>();
const ignored = new Map<string, Set<string>>();
let request: AbortController | undefined;
let timer: number | undefined;
let observed = '';
let polling = false;
let message = 'Open a block, then check it. All checking stays on this machine.';
let pageMode = false;
let pageIdentity = '';
const root = document.getElementById('app')!;

function settings(): Settings {
  return { url: String(logseq.settings?.url ?? DEFAULTS.url), model: String(logseq.settings?.model ?? DEFAULTS.model),
    autoCheck: Boolean(logseq.settings?.autoCheck ?? true), languages: (['en', 'de'] as const).filter(l => logseq.settings?.[l] !== false) };
}

function button(label: string, action: () => void, primary = false) {
  const el = document.createElement('button'); el.textContent = label;
  if (primary) el.className = 'primary';
  el.onclick = action; return el;
}

function render() {
  root.replaceChildren();
  const header = document.createElement('header');
  const title = document.createElement('h2'); title.textContent = 'Local Grammar'; header.append(title);
  header.append(button('Close', () => logseq.hideMainUI())); root.append(header);
  const tools = document.createElement('nav');
  tools.append(button('Check block', () => void checkCurrent()), button('Check page', () => void checkPage()), button('Settings', () => logseq.showSettingsUI())); root.append(tools);
  const status = document.createElement('p'); status.className = 'status'; status.textContent = message; root.append(status);
  for (const result of results.values()) {
    if (!result.mistakes.length) continue;
    const block = document.createElement('section');
    const preview = document.createElement('p'); preview.className = 'preview';
    let pos = 0;
    for (const m of result.mistakes) {
      preview.append(document.createTextNode(result.text.slice(pos, m.from)));
      const mark = document.createElement('mark'); mark.textContent = m.original || '▏';
      mark.tabIndex = 0; mark.title = 'Show suggestion';
      mark.onclick = () => document.getElementById(`fix-${result.uuid}-${m.from}`)?.focus();
      mark.onkeydown = e => { if (e.key === 'Enter') mark.click(); };
      preview.append(mark); pos = m.to;
    }
    preview.append(document.createTextNode(result.text.slice(pos))); block.append(preview);
    for (const m of result.mistakes) {
      const card = document.createElement('article');
      const label = document.createElement('small'); label.textContent = `${m.language.toUpperCase()} · ${m.category} · character ${m.from + 1}`;
      const change = document.createElement('strong'); change.textContent = `${m.original || '(insert)'} → ${m.replacement || '(delete)'}`;
      const explanation = document.createElement('p'); explanation.textContent = m.explanation;
      const actions = document.createElement('div'); actions.className = 'actions';
      const apply = button('Apply fix', () => void applyFix(result, m), true); apply.id = `fix-${result.uuid}-${m.from}`;
      actions.append(apply, button('Ignore', () => {
        const key = result.uuid + ':' + result.text;
        const set = ignored.get(key) ?? new Set<string>(); set.add(mistakeKey(m)); ignored.set(key, set);
        result.mistakes = result.mistakes.filter(other => other !== m);
        const count = [...results.values()].reduce((n, r) => n + r.mistakes.length, 0);
        message = count ? `${count} suggestion${count === 1 ? '' : 's'} remaining.` : 'All suggestions dismissed. Your text is unchanged.';
        render();
      }));
      card.append(label, change, explanation, actions); block.append(card);
    }
    root.append(block);
  }
}

async function blockText(uuid: string) {
  if (await logseq.Editor.checkEditing() === uuid) return await logseq.Editor.getEditingBlockContent();
  return (await logseq.Editor.getBlock(uuid))?.content ?? null;
}

async function applyFix(result: BlockResult, mistake: Mistake) {
  const current = await blockText(result.uuid);
  if (current !== result.text) { message = 'This block changed. Check it again before applying a fix.'; render(); return; }
  // Commit the editing buffer before updating the block to prevent an old buffer overwriting the fix.
  if (await logseq.Editor.checkEditing() === result.uuid) await logseq.Editor.exitEditingMode();
  await logseq.Editor.updateBlock(result.uuid, applyMistake(current, mistake));
  await checkBlocks([result.uuid], false);
}

async function checkBlocks(uuids: string[], replace: boolean) {
  request?.abort(); const controller = new AbortController(); request = controller;
  if (replace) results.clear();
  message = 'Checking locally…'; render();
  try {
    for (const uuid of uuids) {
      const text = await blockText(uuid);
      if (text === null || controller.signal.aborted) continue;
      const all = await checker.check(text, settings(), controller.signal);
      if (controller.signal.aborted) return;
      if (await blockText(uuid) !== text) { results.delete(uuid); continue; }
      const dismissed = ignored.get(uuid + ':' + text);
      results.set(uuid, { uuid, text, mistakes: all.filter(m => !dismissed?.has(mistakeKey(m))) });
      render();
    }
    if (controller.signal.aborted) return;
    const count = [...results.values()].reduce((n, r) => n + r.mistakes.length, 0);
    message = count ? `${count} suggestion${count === 1 ? '' : 's'}. Click an underlined mistake or apply a fix below.` : 'No suggestions. Your text is unchanged.';
    render();
  } catch (error) {
    if (isCancelled(error)) return;
    message = error instanceof Error ? error.message : String(error); render();
    await logseq.UI.showMsg(message, 'warning', { timeout: 12000 });
  }
}

async function checkCurrent() {
  clearTimeout(timer); pageMode = false;
  const block = await logseq.Editor.getCurrentBlock();
  if (!block) { message = 'Click inside a block before checking.'; render(); logseq.showMainUI(); return; }
  logseq.showMainUI({ autoFocus: false }); await checkBlocks([block.uuid], true);
}

async function checkPage() {
  clearTimeout(timer); pageMode = true;
  const tree = await logseq.Editor.getCurrentPageBlocksTree();
  const uuids: string[] = [];
  const visit = (blocks: BlockEntity[]) => {
    for (const block of blocks) { uuids.push(block.uuid); if (block.children?.length) visit(block.children as BlockEntity[]); }
  };
  visit(tree ?? []);
  logseq.showMainUI({ autoFocus: false }); await checkBlocks(uuids, true);
}

async function pollEditor() {
  if (polling || !settings().autoCheck) return;
  polling = true;
  try {
    const page = await logseq.Editor.getCurrentPage();
    const identity = String(page?.id ?? '');
    if (identity !== pageIdentity) {
      pageIdentity = identity; results.clear(); observed = ''; request?.abort(); clearTimeout(timer); render();
    }
    const uuid = await logseq.Editor.checkEditing();
    if (typeof uuid !== 'string') return;
    const text = await logseq.Editor.getEditingBlockContent();
    const next = uuid + ':' + text;
    if (next === observed) return;
    observed = next; request?.abort(); clearTimeout(timer); results.delete(uuid);
    if (ignored.size > 128) ignored.clear();
    render();
    timer = window.setTimeout(() => void checkBlocks([uuid], !pageMode), 1100);
  } finally { polling = false; }
}

async function main() {
  logseq.useSettingsSchema([
    { key: 'url', title: 'Ollama URL (loopback only)', type: 'string', default: DEFAULTS.url, description: 'Ollama must run on this machine.' },
    { key: 'model', title: 'Model', type: 'string', default: DEFAULTS.model, description: `Install with: ollama pull ${DEFAULTS.model}` },
    { key: 'autoCheck', title: 'Check after a typing pause', type: 'boolean', default: true, description: 'Checks the edited block without interrupting typing.' },
    { key: 'en', title: 'English', type: 'boolean', default: true, description: 'Check English paragraphs.' },
    { key: 'de', title: 'German', type: 'boolean', default: true, description: 'Check German paragraphs.' },
  ]);
  logseq.setMainUIInlineStyle({ position: 'fixed', top: '52px', left: 'auto', right: '24px', width: 'min(440px, calc(100vw - 32px))', height: 'min(80vh, 800px)', zIndex: 100 });
  logseq.provideModel({ open: () => { render(); logseq.showMainUI({ autoFocus: false }); }, check: () => void checkCurrent() });
  logseq.App.registerUIItem('toolbar', { key: 'local-grammar', template: '<a data-on-click="open" title="Local Grammar" style="font-weight:700;font-size:17px">Aa✓</a>' });
  logseq.App.registerCommandPalette({ key: 'check-block', label: 'Local Grammar: check current block', keybinding: { binding: 'mod+shift+g' } }, () => void checkCurrent());
  logseq.App.registerCommandPalette({ key: 'check-page', label: 'Local Grammar: check current page' }, () => void checkPage());
  logseq.onSettingsChanged(() => { checker.clear(); observed = ''; request?.abort(); clearTimeout(timer); results.clear(); render(); });
  const interval = window.setInterval(() => void pollEditor().catch(console.error), 450);
  logseq.beforeunload(async () => { clearInterval(interval); clearTimeout(timer); request?.abort(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') logseq.hideMainUI(); });
  render();
}
void logseq.ready(main).catch(console.error);

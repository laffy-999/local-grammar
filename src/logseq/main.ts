import '@logseq/libs';
import type { BlockEntity } from '@logseq/libs/dist/LSPlugin';
import { Checker, DEFAULTS, isCancelled, mistakeKey, type Mistake, type Settings } from '../core/checker';
import { Review } from '../core/review';

interface BlockResult { uuid: string; review: Review }
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
let applying = false;
const root = document.getElementById('app')!;

function settings(): Settings {
  return { url: String(logseq.settings?.url ?? DEFAULTS.url), model: String(logseq.settings?.model ?? DEFAULTS.model),
    autoCheck: Boolean(logseq.settings?.autoCheck ?? true), languages: (['en', 'de'] as const).filter(l => logseq.settings?.[l] !== false) };
}

function button(label: string, action: () => void, primary = false) {
  const el = document.createElement('button'); el.textContent = label; el.disabled = applying;
  if (primary) el.className = 'primary';
  el.onclick = action; return el;
}

function render() {
  root.replaceChildren();
  const header = document.createElement('header');
  const title = document.createElement('h2'); title.textContent = 'Open Grammar'; header.append(title);
  header.append(button('Close', () => logseq.hideMainUI())); root.append(header);
  const tools = document.createElement('nav');
  tools.append(button('Check block', () => void checkCurrent()), button('Check page', () => void checkPage()), button('Settings', () => logseq.showSettingsUI())); root.append(tools);
  const status = document.createElement('p'); status.className = 'status'; status.textContent = message; root.append(status);
  if ([...results.values()].some(r => r.review.mistakes.length)) {
    root.append(button('Accept all in page list', () => void applyList(), true));
  }
  for (const result of results.values()) {
    const { review } = result;
    if (!review.mistakes.length) continue;
    const block = document.createElement('section');
    const preview = document.createElement('p'); preview.className = 'preview';
    let pos = 0;
    for (const m of review.mistakes) {
      preview.append(document.createTextNode(review.text.slice(pos, m.from)));
      const mark = document.createElement('mark'); mark.textContent = m.original || '▏';
      mark.tabIndex = 0; mark.title = 'Show suggestion';
      mark.onclick = () => document.getElementById(`fix-${result.uuid}-${m.from}`)?.focus();
      mark.onkeydown = e => { if (e.key === 'Enter') mark.click(); };
      preview.append(mark); pos = m.to;
    }
    preview.append(document.createTextNode(review.text.slice(pos))); block.append(preview);
    for (const suggestion of review.suggestions) {
      const group = document.createElement('div');
      group.append(button('Accept all in suggestion', () => void applyFix(result, suggestion.pieces)));
      for (const m of suggestion.pieces) {
        const card = document.createElement('article');
        const label = document.createElement('small'); label.textContent = `${m.language.toUpperCase()} · ${m.category} · character ${m.from + 1}`;
        const change = document.createElement('strong'); change.textContent = `${JSON.stringify(m.original)} → ${JSON.stringify(m.replacement)}`;
        const explanation = document.createElement('p'); explanation.textContent = m.explanation;
        const actions = document.createElement('div'); actions.className = 'actions';
        const apply = button('Accept edit', () => void applyFix(result, [m]), true); apply.id = `fix-${result.uuid}-${m.from}`;
        actions.append(apply, button('Ignore edit', () => {
          if (result.review !== review) return;
          const key = result.uuid + ':' + review.text;
          const set = ignored.get(key) ?? new Set<string>(); set.add(mistakeKey(m)); ignored.set(key, set);
          result.review = review.dismiss(m); remaining(); render();
        }));
        card.append(label, change, explanation, actions); group.append(card);
      }
      block.append(group);
    }
    root.append(block);
  }
}

async function blockText(uuid: string) {
  if (await logseq.Editor.checkEditing() === uuid) return await logseq.Editor.getEditingBlockContent();
  return (await logseq.Editor.getBlock(uuid))?.content ?? null;
}

function remaining() {
  const count = [...results.values()].reduce((n, r) => n + r.review.mistakes.length, 0);
  message = count ? `${count} edit${count === 1 ? '' : 's'} remaining.` : 'No edits remaining in this review.';
}

async function applyFix(result: BlockResult, pieces: Mistake[]) {
  if (applying) return;
  applying = true; request?.abort(); clearTimeout(timer); render();
  try {
    await applyResult(result, pieces);
    remaining();
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally { applying = false; render(); }
}

async function applyResult(result: BlockResult, pieces: Mistake[]) {
  const review = result.review;
  if (results.get(result.uuid) !== result || await blockText(result.uuid) !== review.text) {
    throw new Error('This block changed. Check it again before applying a fix.');
  }
  const next = review.accept(pieces);
  // Commit the editing buffer before updating the block to prevent an old buffer overwriting the fix.
  if (await logseq.Editor.checkEditing() === result.uuid) await logseq.Editor.exitEditingMode();
  await logseq.Editor.updateBlock(result.uuid, next.text);
  result.review = next;
  observed = result.uuid + ':' + next.text;
}

async function applyList() {
  if (applying) return;
  applying = true; request?.abort(); clearTimeout(timer); render();
  try {
    const pending = [...results.values()].filter(r => r.review.mistakes.length);
    // Preflight every block before modifying any; check again before each write.
    for (const r of pending) if (await blockText(r.uuid) !== r.review.text) throw new Error('A block changed. Check the page again before accepting all.');
    for (const r of pending) await applyResult(r, r.review.mistakes);
    remaining();
  } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally { applying = false; render(); }
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
      results.set(uuid, { uuid, review: new Review(text, all.filter(m => !dismissed?.has(mistakeKey(m)))) });
      render();
    }
    if (controller.signal.aborted) return;
    const count = [...results.values()].reduce((n, r) => n + r.review.mistakes.length, 0);
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
  if (polling || applying || !settings().autoCheck) return;
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
  logseq.App.registerUIItem('toolbar', { key: 'open-grammar', template: '<a data-on-click="open" title="Open Grammar" style="font-weight:700;font-size:17px">Aa✓</a>' });
  logseq.App.registerCommandPalette({ key: 'check-block', label: 'Open Grammar: check current block', keybinding: { binding: 'mod+shift+g' } }, () => void checkCurrent());
  logseq.App.registerCommandPalette({ key: 'check-page', label: 'Open Grammar: check current page' }, () => void checkPage());
  logseq.onSettingsChanged(() => { checker.clear(); observed = ''; request?.abort(); clearTimeout(timer); results.clear(); render(); });
  const interval = window.setInterval(() => void pollEditor().catch(console.error), 450);
  logseq.beforeunload(async () => { clearInterval(interval); clearTimeout(timer); request?.abort(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') logseq.hideMainUI(); });
  render();
}
void logseq.ready(main).catch(console.error);

import { diffChars } from 'diff';

export type Language = 'en' | 'de';
export interface Mistake {
  from: number;
  to: number;
  original: string;
  replacement: string;
  explanation: string;
  category: 'grammar' | 'punctuation';
  language: Language;
}
export interface Range { from: number; to: number }

// Protect complete constructs, including their delimiters. Overlaps are merged.
export function protectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const add = (re: RegExp) => {
    for (const m of text.matchAll(re)) ranges.push({ from: m.index!, to: m.index! + m[0].length });
  };
  add(/^(?:---\r?\n)[\s\S]*?(?:\r?\n---(?:\r?\n|$)|$)/g);
  add(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*(?:\n|$)|$(?![\s\S]))/gm);
  // Match equal-length delimiter runs, not the first embedded backtick.
  for (let at = 0; at < text.length;) {
    if (text[at] !== '`') { at++; continue; }
    let end = at + 1;
    while (text[end] === '`') end++;
    const delimiter = text.slice(at, end);
    let close = text.indexOf(delimiter, end);
    while (close >= 0 && (text[close - 1] === '`' || text[close + delimiter.length] === '`')) {
      close = text.indexOf(delimiter, close + delimiter.length);
    }
    const lineEnd = text.indexOf('\n', end);
    const to = close >= 0 ? close + delimiter.length : lineEnd >= 0 ? lineEnd : text.length;
    ranges.push({ from: at, to });
    at = to;
  }
  add(/!?\[\[[\s\S]*?\]\]/g);
  add(/\(\([0-9a-fA-F-]{36}\)\)/g);
  add(/^[ \t]*[^\s:]+::[^\n]*/gm);
  add(/(?:https?:\/\/|mailto:|www\.)[^\s<>]+/g);
  add(/!?\[[^\]\n]*\]\([^\n)]*\)/g);
  add(/\$\$[\s\S]*?(?:\$\$|$)|\$(?:\\.|[^$\n])+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g);
  add(/(?:#[\p{L}\p{N}_/-]+)|(?:\{\{[^\n]*?\}\})/gu);
  add(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]*|[-*+][ \t]+\[[ xX]\][ \t]*)/gm);
  add(/\*\*|__|~~|\*|_|\\[^\s]|<[^>\n]*>/g);
  ranges.sort((a, b) => a.from - b.from);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

export function maskSyntax(text: string) {
  const ranges = protectedRanges(text);
  // Avoid collision with note text or prompt-injected fake tokens.
  let prefix = 'LGKEEP';
  while (text.includes(prefix)) prefix += 'X';
  let masked = '', pos = 0;
  const tokens = ranges.map((r, i) => ({ token: `${prefix}${i}TOKEN`, value: text.slice(r.from, r.to) }));
  ranges.forEach((r, i) => {
    masked += text.slice(pos, r.from) + tokens[i].token;
    pos = r.to;
  });
  masked += text.slice(pos);
  return {
    masked,
    restore(corrected: string): string {
      let cursor = 0;
      for (const { token } of tokens) {
        const at = corrected.indexOf(token, cursor);
        if (at < cursor || corrected.indexOf(token, at + token.length) !== -1) {
          throw new Error('The model changed protected note syntax. No suggestions were applied.');
        }
        cursor = at + token.length;
      }
      for (const { token, value } of tokens) corrected = corrected.replace(token, () => value);
      return corrected;
    },
  };
}

export function deriveMistakes(original: string, corrected: string, language: Language): Mistake[] {
  // Align words, punctuation and whitespace separately. Equal spaces must not shift
  // adjacent word replacements when the model also normalizes a double space.
  const tokens = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\s]/gu) ?? [];
  const before = tokens(original), after = tokens(corrected);
  const kind = (token: string) => /^\s+$/u.test(token) ? 0 : /^[\p{L}\p{N}]/u.test(token) ? 1 : 2;
  const beforeKinds = before.map(kind), afterKinds = after.map(kind);
  const width = after.length + 1;
  const path = new Uint8Array((before.length + 1) * width);
  let previous = new Float64Array(width), next = new Float64Array(width);
  for (let j = 1; j < width; j++) { previous[j] = j; path[j] = 2; }
  for (let i = 1; i <= before.length; i++) {
    next[0] = i; path[i * width] = 1;
    for (let j = 1; j < width; j++) {
      const a = before[i - 1], b = after[j - 1];
      const cost = a === b ? 0 : beforeKinds[i - 1] !== afterKinds[j - 1] ? 3 : beforeKinds[i - 1] === 0 ? 0.1 : 1;
      let best = previous[j - 1] + cost, direction = 0;
      if (previous[j] + 1 < best) { best = previous[j] + 1; direction = 1; }
      if (next[j - 1] + 1 < best) { best = next[j - 1] + 1; direction = 2; }
      next[j] = best; path[i * width + j] = direction;
    }
    [previous, next] = [next, previous];
  }
  const aligned: [string, string][] = [];
  for (let i = before.length, j = after.length; i || j;) {
    const direction = path[i * width + j];
    if (direction === 0) aligned.push([before[--i], after[--j]]);
    else if (direction === 1) aligned.push([before[--i], '']);
    else aligned.push(['', after[--j]]);
  }
  const result: Mistake[] = [];
  let offset = 0;
  for (const [removed, added] of aligned.reverse()) {
    if (removed !== added) {
      const category = /^[\s\p{P}]*$/u.test(removed + added) ? 'punctuation' : 'grammar';
      const explanation = category === 'punctuation' ? 'Correct punctuation or spacing.' : language === 'de' ? 'Rechtschreibung oder Grammatik korrigieren.' : 'Correct spelling or grammar.';
      const last = result.at(-1);
      // A new word owns its inserted leading separator, but never another word.
      if (!removed && category === 'grammar' && last?.from === offset && last.to === offset && /^\s+$/u.test(last.replacement)) {
        last.replacement += added; last.category = category; last.explanation = explanation;
      } else result.push({ from: offset, to: offset + removed.length, original: removed, replacement: added, explanation, category, language });
    }
    offset += removed.length;
  }
  const protected_ = protectedRanges(original);
  if (result.some(m => protected_.some(r => m.from === m.to ? m.from > r.from && m.from < r.to : m.from < r.to && m.to > r.from))) {
    throw new Error('The model moved or changed protected syntax. No suggestions were applied.');
  }
  return result;
}

/**
 * True when the corrected text rewrites the paragraph (for example a translation) rather than fixing
 * typos: at least 15 characters changed and more than 20% of all characters differ. Short fixes such as
 * a transposed word never qualify, so single-word notes keep their suggestions.
 */
export function isRewrite(original: string, corrected: string): boolean {
  let changed = 0;
  for (const part of diffChars(original, corrected)) if (part.added || part.removed) changed += part.value.length;
  return changed >= 15 && changed / Math.max(original.length + corrected.length, 1) > 0.2;
}

export function applyMistake(text: string, mistake: Mistake): string {
  if (text.slice(mistake.from, mistake.to) !== mistake.original) throw new Error('This suggestion is stale. Check the text again.');
  return text.slice(0, mistake.from) + mistake.replacement + text.slice(mistake.to);
}

export function mistakeKey(m: Mistake): string {
  return `${m.from}:${m.to}:${m.original}:${m.replacement}`;
}

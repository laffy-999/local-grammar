import { diffChars, diffWordsWithSpace } from 'diff';

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
  const result: Mistake[] = [];
  let offset = 0, from = 0, removed = '', added = '';
  const flush = () => {
    if (removed !== added) {
      // Trim unchanged edges, keeping UTF-16 coordinates used by both editors.
      let left = 0, right = 0;
      while (left < removed.length && left < added.length && removed[left] === added[left]) left++;
      while (right < removed.length - left && right < added.length - left && removed.at(-1 - right) === added.at(-1 - right)) right++;
      // Do not split a surrogate pair at a diff boundary.
      if (left && /[\uDC00-\uDFFF]/.test(removed[left] ?? added[left] ?? '')) left--;
      let before = removed.slice(left, removed.length - right), after = added.slice(left, added.length - right);
      let start = from + left, end = from + removed.length - right;
      const category = /^[\s\p{P}]*$/u.test(before + after) ? 'punctuation' : 'grammar';
      if (category === 'grammar') {
        // Show the whole word ("recieved" -> "received"), not the changed letters ("ie" -> "ei").
        const letter = /\p{L}/u;
        let wordStart = start, wordEnd = end;
        while (wordStart > 0 && letter.test(original[wordStart - 1])) wordStart--;
        while (wordEnd < original.length && letter.test(original[wordEnd])) wordEnd++;
        const prefix = original.slice(wordStart, start), suffix = original.slice(end, wordEnd);
        before = prefix + before + suffix; after = prefix + after + suffix; start = wordStart; end = wordEnd;
      }
      result.push({ from: start, to: end, original: before, replacement: after,
        explanation: category === 'punctuation' ? 'Correct punctuation.' : (language === 'de' ? 'Rechtschreibung oder Grammatik korrigieren.' : 'Correct spelling or grammar.'), category, language });
    }
    removed = ''; added = '';
  };
  for (const part of diffWordsWithSpace(original, corrected)) {
    if (part.added || part.removed) {
      if (!removed && !added) from = offset;
      if (part.removed) { removed += part.value; offset += part.value.length; }
      else added += part.value;
    } else { flush(); offset += part.value.length; }
  }
  flush();
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

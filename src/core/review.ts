import { applyMistake, protectedRanges, type Mistake } from './text';

export interface Suggestion { id: number; pieces: Mistake[] }

/** Immutable snapshots keep stale UI actions from applying to a newer check. */
export class Review {
  readonly suggestions: Suggestion[];
  constructor(readonly text: string, mistakes: Mistake[], suggestions?: Suggestion[]) {
    if (suggestions) { this.suggestions = suggestions; return; }
    const paragraphs = [...text.matchAll(/\n[ \t]*\n/g)].map(m => m.index! + m[0].length);
    const groups = new Map<number, Mistake[]>();
    for (const piece of mistakes) {
      const id = paragraphs.filter(at => at <= piece.from).length;
      const group = groups.get(id) ?? []; group.push(piece); groups.set(id, group);
    }
    this.suggestions = [...groups].map(([id, pieces]) => ({ id, pieces }));
  }
  get mistakes(): Mistake[] { return this.suggestions.flatMap(s => s.pieces); }
  dismiss(piece: Mistake): Review {
    if (!this.mistakes.includes(piece)) throw new Error('This suggestion is stale. Check the text again.');
    return new Review(this.text, [], this.suggestions.map(s => ({ ...s, pieces: s.pieces.filter(m => m !== piece) })).filter(s => s.pieces.length));
  }
  accept(selected: Mistake[]): Review {
    const all = this.mistakes;
    const order = new Map(all.map((piece, index) => [piece, index]));
    const edits = [...new Set(selected)].sort((a, b) => a.from - b.from || (order.get(a) ?? -1) - (order.get(b) ?? -1));
    const protected_ = protectedRanges(this.text);
    for (const [index, edit] of edits.entries()) {
      if (!all.includes(edit)) throw new Error('This suggestion is stale. Check the text again.');
      if (index && edits[index - 1].to > edit.from) throw new Error('Overlapping suggestions cannot be applied. Check the text again.');
      if (protected_.some(r => edit.from === edit.to ? edit.from > r.from && edit.from < r.to : edit.from < r.to && edit.to > r.from)) {
        throw new Error('A suggestion overlaps protected note syntax. Check the text again.');
      }
    }
    const text = edits.reduceRight((value, edit) => applyMistake(value, edit), this.text);
    const suggestions = this.suggestions.map(s => ({ ...s, pieces: s.pieces.filter(m => !edits.includes(m)).map(m => {
      // At a shared insertion coordinate, only earlier pieces shift this one.
      // This keeps independently accepted inserted words/punctuation in model order.
      const shift = edits.reduce((delta, edit) => {
        const precedes = edit.to < m.from || edit.to === m.from && (edit.from < edit.to || order.get(edit)! < order.get(m)!);
        return delta + (precedes ? edit.replacement.length - (edit.to - edit.from) : 0);
      }, 0);
      return { ...m, from: m.from + shift, to: m.to + shift };
    }) })).filter(s => s.pieces.length);
    return new Review(text, [], suggestions);
  }
}

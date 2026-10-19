import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMistakes, type Mistake } from '../src/core/text';
import { Review } from '../src/core/review';

const review = (before: string, after: string) => new Review(before, deriveMistakes(before, after, 'en'));
const piece = (r: Review, original: string) => r.mistakes.find(m => m.original === original)!;

test('double-space normalization cannot pair corrections with the next word', () => {
  const r = review('i  recieved teh adress', 'I received the address');
  assert.deepEqual(r.mistakes.map(m => [m.original, m.replacement]), [['i', 'I'], ['  ', ' '], ['recieved', 'received'], ['teh', 'the'], ['adress', 'address']]);
  assert.equal(r.accept([piece(r, 'recieved')]).text, 'i  received teh adress');
  assert.equal(r.accept([piece(r, '  ')]).text, 'i recieved teh adress');
});

test('accept and ignore pieces in arbitrary order, re-anchoring across paragraphs and unicode', () => {
  const before = '📝 i  recieved teh adress.\n\nDas ist ein Frage. [[teh adress]]';
  let r = review(before, '📝 I received the address.\n\nDas ist eine Frage. [[teh adress]]');
  r = r.dismiss(piece(r, 'teh'));
  r = r.accept([piece(r, 'adress')]);
  r = r.accept([piece(r, 'i')]);
  r = r.accept([piece(r, '  ')]);
  for (const m of r.mistakes) assert.equal(r.text.slice(m.from, m.to), m.original);
  const german = r.suggestions[1];
  r = r.accept(german.pieces);
  assert.equal(r.text, '📝 I recieved teh address.\n\nDas ist eine Frage. [[teh adress]]');
  r = r.accept(r.mistakes);
  assert.equal(r.text, '📝 I received teh address.\n\nDas ist eine Frage. [[teh adress]]');
  assert.deepEqual(r.mistakes, []);
});

test('accept all in a suggestion leaves other suggestions pending', () => {
  const r = review('teh adress.\n\nI recieved it', 'the address.\n\nI received it.');
  const next = r.accept(r.suggestions[0].pieces);
  assert.equal(next.text, 'the address.\n\nI recieved it');
  assert.equal(next.suggestions.length, 1);
  assert.equal(next.accept(next.mistakes).text, 'the address.\n\nI received it.');
});

test('punctuation insertions and deletions remain independent of word corrections', () => {
  const r = review('teh adress,, arrived', 'the address, arrived.');
  const insertion = r.mistakes.find(m => m.from === m.to)!;
  const next = r.accept([insertion]);
  assert.equal(next.text, 'teh adress,, arrived.');
  assert.equal(next.accept(next.mistakes).text, 'the address, arrived.');
});

test('inserted words keep their order and every subset has valid original spans', () => {
  const r = review('I dont,know why', 'I do not know why.');
  for (let bits = 0; bits < 1 << r.mistakes.length; bits++) {
    const selected = r.mistakes.filter((_, i) => bits & (1 << i));
    const next = r.accept(selected);
    for (const m of next.mistakes) assert.equal(next.text.slice(m.from, m.to), m.original);
    assert.equal(next.accept(next.mistakes).text, 'I do not know why.');
  }
});

test('new words at one coordinate are independently acceptable in either order', () => {
  const r = review('We work.', 'We will not work.');
  assert.equal(r.mistakes.length, 2);
  for (const word of ['will', 'not']) {
    const selected = r.mistakes.find(m => m.replacement.trim() === word)!;
    const next = r.accept([selected]);
    assert.equal(next.text, `We ${word} work.`);
    assert.equal(next.accept(next.mistakes).text, 'We will not work.');
  }
  const ignored = r.dismiss(r.mistakes[1]);
  assert.equal(ignored.accept(ignored.mistakes).text, 'We will work.');
});

test('old review actions and protected syntax edits are rejected', () => {
  const r = review('teh adress [[link]]', 'the address [[link]]');
  const old = piece(r, 'adress');
  const next = r.accept([piece(r, 'teh')]);
  assert.throws(() => next.accept([old]), /stale/);
  const forged: Mistake = { ...old, from: 12, to: 16, original: 'link', replacement: 'other' };
  const unsafe = new Review('teh adress [[link]]', [forged]);
  assert.throws(() => unsafe.accept([forged]), /syntax/);
  assert.equal(r.text, 'teh adress [[link]]');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Checker, DEFAULTS, applyMistake, deriveMistakes, maskSyntax, ollamaEndpoint, parseResult, type Fetcher } from '../src/core/checker';

const correct = (text: string, corrected: string) => deriveMistakes(text, corrected, 'en').reduceRight((value, m) => applyMistake(value, m), text);

function localTransport(reply: Fetcher): Fetcher {
  return async (url, init) => String(url).endsWith('/api/tags')
    ? Response.json({ models: [DEFAULTS.model, 'another'].map(name => ({ name, details: { format: 'gguf' } })) })
    : reply(url, init);
}

test('independent spelling, punctuation, insertions and deletions retain exact original spans', () => {
  const original = 'I recieved teh notes. She dont know why  today';
  const expected = "I received the notes. She doesn't know why today.";
  const mistakes = deriveMistakes(original, expected, 'en');
  assert.equal(mistakes.reduceRight((text, m) => applyMistake(text, m), original), expected);
  for (const m of mistakes) assert.equal(original.slice(m.from, m.to), m.original);
  assert.ok(mistakes.some(m => m.from === m.to && m.replacement === '.'));
  assert.ok(mistakes.some(m => m.replacement === ''));
  assert.equal(correct('teh teh teh', 'the teh the'), 'the teh the');
});

test('UTF-16 offsets match editor coordinates after emoji and German umlauts', () => {
  const text = '📝 Grüße. Das ist ein wichtige Frage.';
  const mistakes = deriveMistakes(text, '📝 Grüße. Das ist eine wichtige Frage.', 'de');
  const at = text.indexOf('ein');
  assert.deepEqual(mistakes.map(m => [m.from, m.to, m.original, m.replacement]), [[at, at + 3, 'ein', 'eine']]);
  assert.equal(mistakes.reduceRight((s, m) => applyMistake(s, m), text), '📝 Grüße. Das ist eine wichtige Frage.');
});

test('no-op and malformed corrections never alter notes implicitly', () => {
  assert.deepEqual(deriveMistakes('Clean note.', 'Clean note.', 'en'), []);
  const m = deriveMistakes('teh', 'the', 'en')[0];
  assert.throws(() => applyMistake('new', m), /stale/);
  for (const malformed of ['not JSON', '{"corrected":"hello"}', '{"corrected":null,"language":"en"}', '{"corrected":"hello","language":"fr"}']) assert.throws(() => parseResult(malformed));
});

const protectedExamples = [
  '[[Jhon Smith]]', '![[drawing.excalidraw]]', '#teh-tag', '((12345678-abcd-1234-abcd-123456789abc))',
  '`teh_flag`', '```js\nconst teh = 1;\n\n// teh\n```', '~~~\nteh\n~~~', '```\nteh with no closing fence',
  'https://example.com/teh?q=recieved', '[teh label](https://example.com)', '$x_{teh}$', '$$\n\\frac{teh}{2}\n$$', '\\(teh\\)', '\\[teh\\]',
  'tag:: teh value', '---\ntitle: teh\ntags: [teh]\n---', '{{renderer :teh}}', '<https://example.com/teh>',
];
for (const syntax of protectedExamples) test('protect syntax: ' + JSON.stringify(syntax), () => {
  const text = syntax.startsWith('---') ? syntax + '\n\nI recieved notes.' : 'I recieved notes.\n' + syntax;
  const masked = maskSyntax(text);
  assert.ok(!masked.masked.includes(syntax), 'protected construct must not be sent as prose');
  const corrected = masked.restore(masked.masked.replace('recieved', 'received'));
  assert.equal(corrected, text.replace('recieved', 'received'));
  assert.equal(correct(text, corrected), corrected);
});

test('altered, duplicated, moved, or missing syntax placeholders are rejected', () => {
  const masked = maskSyntax('I recieved [[Jhon]] and `teh`.');
  assert.throws(() => masked.restore('I received LGKEEP1TOKEN and LGKEEP0TOKEN.'), /syntax/);
  assert.throws(() => masked.restore('I received LGKEEP0TOKEN and LGKEEP0TOKEN.'), /syntax/);
  assert.throws(() => masked.restore('I received John.'), /syntax/);
  assert.throws(() => deriveMistakes('Read [[Jhon]] now.', 'Read [[John]] now.', 'en'), /syntax/);
});

test('multi-backtick and multiline code spans are opaque to correction', () => {
  for (const code of ['``a `teh` b``', '`teh\nrecieved`']) {
    const text = 'I recieved notes about ' + code + '.';
    const masked = maskSyntax(text);
    const corrected = masked.restore(masked.masked.replaceAll('recieved', 'received').replaceAll('teh', 'the'));
    assert.equal(corrected, 'I received notes about ' + code + '.');
  }
});

test('local-only endpoint rejects remote servers and URL tricks before sending text', () => {
  assert.equal(ollamaEndpoint('http://localhost:11434'), 'http://localhost:11434/api/chat');
  assert.equal(ollamaEndpoint('http://[::1]:11434/'), 'http://[::1]:11434/api/chat');
  for (const url of ['https://example.com', 'http://localhost.example.com', 'http://localhost@evil.test', 'file:///tmp/a', 'http://localhost:11434/proxy', 'http://127.0.0.1/?target=cloud']) assert.throws(() => ollamaEndpoint(url));
});

test('mixed EN and DE paragraphs have independent language detection and exact offsets', async () => {
  const responses = [{ language: 'en', corrected: 'I received notes.' }, { language: 'de', corrected: 'Ich habe eine Frage.' }];
  const checker = new Checker(localTransport(async () => Response.json({ message: { content: JSON.stringify(responses.shift()) } })));
  const text = 'I recieved notes.\n\nIch habe ein Frage.';
  const mistakes = await checker.check(text, DEFAULTS);
  assert.deepEqual(mistakes.map(m => m.language), ['en', 'de']);
  assert.equal(mistakes.reduceRight((s, m) => applyMistake(s, m), text), 'I received notes.\n\nIch habe eine Frage.');
});

test('disabled languages leave those paragraphs untouched', async () => {
  const checker = new Checker(localTransport(async () => Response.json({ message: { content: '{"language":"de","corrected":"Eine Frage."}' } })));
  assert.deepEqual(await checker.check('Ein Frage.', { ...DEFAULTS, languages: ['en'] }), []);
});

test('blank lines inside fences are not treated as prose paragraphs', async () => {
  const checker = new Checker(localTransport(async (_url, init) => {
    const text = JSON.parse(String(init?.body)).messages[1].content as string;
    return Response.json({ message: { content: JSON.stringify({ language: 'en', corrected: text.replace('recieved', 'received') }) } });
  }));
  const original = '```\nteh\n\nteh\n```\n\nI recieved notes.';
  const mistakes = await checker.check(original, DEFAULTS);
  assert.equal(mistakes.reduceRight((s, m) => applyMistake(s, m), original), original.replace('recieved', 'received'));
});

test('cache is keyed by unchanged text and settings, and does not expose mutable results', async () => {
  let calls = 0;
  const checker = new Checker(localTransport(async () => { calls++; return Response.json({ message: { content: '{"language":"en","corrected":"the"}' } }); }));
  const first = await checker.check('teh', DEFAULTS); first[0].replacement = 'broken';
  assert.equal((await checker.check('teh', DEFAULTS))[0].replacement, 'the');
  assert.equal(calls, 1);
  await checker.check('teh', { ...DEFAULTS, model: 'another' }); assert.equal(calls, 2);
  const note = 'teh\n\nteh';
  const cachedParagraphs = await checker.check(note, DEFAULTS);
  assert.equal(cachedParagraphs.reduceRight((text, m) => applyMistake(text, m), note), 'the\n\nthe');
  assert.equal(calls, 2);
});

test('stale requests abort their actual transport and cannot publish cached results', async () => {
  const controller = new AbortController(); let requests = 0;
  const checker = new Checker((async (_url, init) => {
    requests++;
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
  }) as Fetcher);
  const pending = checker.check('teh', DEFAULTS, controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(checker.check('teh', DEFAULTS, controller.signal), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('offline and missing-model errors include exact actionable model pull command', async () => {
  const offline = new Checker((async () => { throw new Error('ECONNREFUSED'); }) as Fetcher);
  await assert.rejects(offline.check('hello', DEFAULTS), /ollama serve.*ollama pull qwen3\.5:4b/);
  const missing = new Checker((async () => new Response('', { status: 404 })) as Fetcher);
  await assert.rejects(missing.check('hello', DEFAULTS), /ollama pull qwen3\.5:4b/);
});

test('cloud models and disguised remote aliases never receive note text', async () => {
  for (const model of ['minimax-m3:cloud', 'private-alias']) {
    const sent: string[] = [];
    const checker = new Checker((async (_url, init) => {
      if (init?.body) sent.push(String(init.body));
      return Response.json({ models: [{ name: model, remote_host: 'https://ollama.com:443', remote_model: 'minimax-m3', details: { format: '' } }] });
    }) as Fetcher);
    await assert.rejects(checker.check('private synthetic note', { ...DEFAULTS, model }), /cloud|remote/i);
    assert.deepEqual(sent, []);
  }
});

test('recorded EN and DE model outputs produce exact applicable note corrections', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ollama.json', import.meta.url), 'utf8')) as {
    cases: { original: string; content: string; expected: string; language: string }[];
  };
  for (const sample of fixture.cases) {
    const checker = new Checker(localTransport(async () => Response.json({ message: { content: sample.content } })));
    const mistakes = await checker.check(sample.original, DEFAULTS);
    assert.equal(mistakes.reduceRight((text, m) => applyMistake(text, m), sample.original), sample.expected);
    for (const m of mistakes) {
      assert.equal(sample.original.slice(m.from, m.to), m.original);
      assert.equal(m.language, sample.language);
    }
  }
});

test('translated or rewritten paragraphs are discarded, while small typo fixes are kept', async () => {
  // Recorded llama3.2 output: English input answered in German despite the no-translation prompt.
  const translated = '{"language":"en","corrected":"Sie hat keine Zeit, weil die Aufgaben nicht abgeschlossen sind."}';
  const text = 'She dont have time because the tasks is not finished.';
  const rejected = new Checker(localTransport(async () => Response.json({ message: { content: translated } })));
  assert.deepEqual(await rejected.check(text, DEFAULTS), []);
  const mixed = 'Please review the Entwurf before the Besprechung.';
  const rewritten = new Checker(localTransport(async () => Response.json({ message: { content: '{"language":"en","corrected":"Bitte überprüfe den Entwurf vor der Besprechung."}' } })));
  assert.deepEqual(await rewritten.check(mixed, DEFAULTS), []);
  const typo = new Checker(localTransport(async () => Response.json({ message: { content: '{"language":"en","corrected":"I received the notes."}' } })));
  assert.equal((await typo.check('I recieved teh notes.', DEFAULTS)).length, 2);
});

test('leading and trailing whitespace is never sent to the model or suggested for removal', async () => {
  const checker = new Checker(localTransport(async (_url, init) => {
    const sent = JSON.parse(String(init?.body)).messages[1].content as string;
    assert.equal(sent, sent.trim());
    return Response.json({ message: { content: JSON.stringify({ language: 'en', corrected: sent.replace('recieved', 'received') }) } });
  }));
  const text = '\n  I recieved notes.  \n\n\nAnother recieved note.\n';
  const mistakes = await checker.check(text, DEFAULTS);
  assert.equal(mistakes.reduceRight((s, m) => applyMistake(s, m), text), text.replaceAll('recieved', 'received'));
  assert.equal(mistakes.length, 2);
});

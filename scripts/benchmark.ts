import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Checker, DEFAULTS, applyMistake, SYSTEM_PROMPT, OUTPUT_SCHEMA } from '../src/core/checker';

// Usage: npm run benchmark -- <output-dir> <ollama-model>...
// Runs every synthetic sample through the shipped Checker, so prompt, schema, syntax protection,
// local-model guard and diffing are exactly what the plugins use. Writes one rows file per model.
const OLLAMA = 'http://localhost:11434';
const samples = JSON.parse(await readFile(new URL('./benchmark-samples.json', import.meta.url), 'utf8')) as
  { id: string; kind: string; text: string; expected: string }[];
const [out, ...models] = process.argv.slice(2);
if (!out || !models.length) throw new Error('Usage: npm run benchmark -- <output-dir> <ollama-model>...');
await mkdir(out, { recursive: true });

async function unloadAll() {
  const ps = await (await fetch(`${OLLAMA}/api/ps`)).json() as { models: { name: string }[] };
  for (const m of ps.models) {
    await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }) });
  }
  for (let i = 0; i < 40; i++) {
    if (!((await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: unknown[] }).models.length) return;
    await new Promise(r => setTimeout(r, 250));
  }
}

for (const model of models) {
  await unloadAll(); // cold start for every candidate
  const recordings: { request: unknown; response: unknown }[] = [];
  const checker = new Checker(async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/api/chat')) recordings.push({ request: JSON.parse(String(init?.body)), response: await response.clone().json() });
    return response;
  });
  const rows = [];
  for (const [index, sample] of samples.entries()) {
    const start = performance.now();
    let corrected = '', error = '';
    try {
      const mistakes = await checker.check(sample.text, { ...DEFAULTS, model });
      corrected = mistakes.reduceRight((text, m) => applyMistake(text, m), sample.text);
    } catch (e) { error = String(e instanceof Error ? e.message : e); }
    rows.push({ model, ...sample, corrected, error, ms: Math.round(performance.now() - start), cold: index === 0 });
  }
  const memory = await (await fetch(`${OLLAMA}/api/ps`)).json();
  const slug = model.replace(/[^\w.-]+/g, '_');
  await writeFile(join(out, `${slug}.rows.json`), JSON.stringify({ model, runtime: 'ollama via shared Checker', rows, memory }, null, 2));
  await writeFile(join(out, `${slug}.recordings.json`), JSON.stringify(recordings, null, 2));
  console.log(`${model}: ${rows.length} samples, ${rows.filter(r => r.error).length} rejected`);
}
await writeFile(join(out, 'protocol.json'), JSON.stringify({ prompt: SYSTEM_PROMPT, schema: OUTPUT_SCHEMA, options: { temperature: 0, num_ctx: 4096, num_predict: 1600 } }, null, 2));

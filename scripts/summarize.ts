import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Usage: npm run summarize -- <dir with *.rows.json>
// Metrics (per model):
//  fix      exact expected output on samples that contain an error
//  kept     controls (clean EN/DE, mixed EN/DE, protected syntax) left byte-identical
//  drift    samples where more than 40% of words were rewritten (translation or meaning drift)
//  rejected requests refused by the checker or model (no suggestions shown; counted as unchanged)
interface Row { model: string; kind: string; text: string; expected: string; corrected: string; error: string; ms: number; cold: boolean }
interface File { model: string; runtime: string; rows: Row[]; memory?: { models: { size: number; size_vram: number }[] } }
const ERROR_KINDS = ['en-error', 'de-error', 'de-caps', 'mixed-error', 'syntax-error'];

function wordEditRatio(a: string, b: string) {
  const x = a.split(/\s+/).filter(Boolean), y = b.split(/\s+/).filter(Boolean);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length, 1);
}
const median = (n: number[]) => [...n].sort((a, b) => a - b)[Math.floor(n.length / 2)] ?? 0;
const GIB = 1024 ** 3;

const dir = process.argv[2];
const files = (await readdir(dir)).filter(f => f.endsWith('.rows.json')).sort();
console.log('| Model | Fixes exact | Controls kept | Drift | Rejected | Cold first | Warm median | VRAM | RAM spill |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const file of files) {
  const data = JSON.parse(await readFile(join(dir, file), 'utf8')) as File;
  const rows = data.rows.map(r => ({ ...r, corrected: r.error ? r.text : r.corrected }));
  const errors = rows.filter(r => ERROR_KINDS.includes(r.kind)), controls = rows.filter(r => !ERROR_KINDS.includes(r.kind));
  const fixed = errors.filter(r => r.corrected === r.expected).length;
  const kept = controls.filter(r => r.corrected === r.text).length;
  const drift = rows.filter(r => wordEditRatio(r.text, r.corrected) > 0.4).length;
  const warm = rows.filter(r => !r.cold).map(r => r.ms);
  const m = data.memory?.models[0];
  console.log(`| ${data.model} | ${fixed}/${errors.length} | ${kept}/${controls.length} | ${drift} | ${rows.filter(r => r.error).length} | ${(rows[0].ms / 1000).toFixed(1)} s | ${median(warm)} ms | ${m ? (m.size_vram / GIB).toFixed(2) + ' GiB' : 'n/a'} | ${m ? ((m.size - m.size_vram) / GIB).toFixed(2) + ' GiB' : 'n/a'} |`);
}

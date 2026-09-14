import { readFile, writeFile } from 'node:fs/promises';
import { cases } from './cases.mjs';
import { scoreLiterature } from './score.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(value => { const [key, ...rest] = value.replace(/^--/, '').split('='); return [key, rest.join('=')]; }));
if (!args.report || !args.judgments || !args.out) throw new Error('Required: --report=FILE --judgments=FILE --out=NEW_FILE');
const report = JSON.parse(await readFile(args.report, 'utf8')), labels = JSON.parse(await readFile(args.judgments, 'utf8'));
if (report.mode === 'collect') throw new Error('Collection-only observations have no model shortlist or download outcomes to score.');
for (const observation of report.observations) {
  observation.metrics = scoreLiterature({ data: observation.data, labels: labels[observation.id], topics: cases.find(c => c.id === observation.id).topics,
    elapsedMs: observation.metrics.latency_ms, mode: report.mode,
    inputUsdPerMillion: args['input-usd-per-million'] === undefined ? undefined : Number(args['input-usd-per-million']),
    outputUsdPerMillion: args['output-usd-per-million'] === undefined ? undefined : Number(args['output-usd-per-million']) });
}
report.rescored_at = new Date().toISOString();
await writeFile(args.out, JSON.stringify(report, null, 2), { flag: 'wx' });

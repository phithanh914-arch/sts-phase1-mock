// 受入ケースをCLIで実行し、Markdownの合否表を出力する。
// 使い方: npm run eval -- [--brain rule|llm] [--reps 3] [--ids T01,T02]
// llm はOPENAI_API_KEYとBRAIN_MODELが必要（API費用が発生。EVAL_MAX_LLM_RUNSで上限）。
import { RuleBrain } from '../brain/ruleBrain.js';
import { OpenAIBrain } from '../brain/openaiBrain.js';
import type { ReceptionBrain } from '../brain/types.js';
import { Harness } from './harness.js';
import { runCases, CASES, type MakeHarness } from './cases.js';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const brainName = arg('brain') ?? 'rule';
const reps = Number(arg('reps') ?? 3);
const ids = arg('ids')?.split(',') ?? null;
let brain: ReceptionBrain;
if (brainName === 'llm') {
  if (!process.env.OPENAI_API_KEY || !process.env.BRAIN_MODEL) { console.error('OPENAI_API_KEY と BRAIN_MODEL が必要です'); process.exit(1); }
  const total = (ids?.length ?? CASES.length) * reps;
  const max = Number(process.env.EVAL_MAX_LLM_RUNS ?? 40);
  if (total > max) { console.error(`実行回数 ${total} が上限 ${max} を超えます`); process.exit(1); }
  brain = new OpenAIBrain(process.env.BRAIN_MODEL, process.env.OPENAI_API_KEY, 20000);
} else brain = new RuleBrain();

const make: MakeHarness = (opts = {}) => new Harness({ b: opts.wrapBrain ? opts.wrapBrain(brain) : brain }, 'b', { brainTimeoutMs: brainName === 'rule' ? 30000 : 20000, ...opts });
const results = await runCases(make, ids, reps);
console.log(`# 受入テスト結果（brain=${brain.name}, 繰返し=${reps}, 実行日時=${new Date().toISOString()}）\n`);
console.log('|ID|ケース|期待|合格/回数|失敗したチェック（根拠）|');
console.log('|---|---|---|---|---|');
for (const c of CASES.filter((x) => !ids || ids.includes(x.id))) {
  const rs = results.filter((r) => r.id === c.id);
  const fails = rs.flatMap((r) => (r.error ? [`例外: ${r.error}`] : r.checks.filter((x) => !x.pass).map((x) => `${x.name}: ${x.detail ?? ''}`)));
  console.log(`|${c.id}|${c.title}|${c.expected}|${rs.filter((r) => r.pass).length}/${rs.length}|${[...new Set(fails)].join('<br>').replace(/\|/g, '/') || '—'}|`);
}
const pass = results.filter((r) => r.pass).length;
console.log(`\n合計: ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 2);

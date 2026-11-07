// 1ターン比較ベンチ（A/B/C）をCLIで実行し、Markdownで出力する。
// 使い方: npm run bench -- [--brain rule|llm] [--model <BRAIN_MODELのうち1つ>] [--profiles baseline,lightweight,hybrid] [--efforts none,low] [--reps 1] [--ids F01,F02]
// llm はOPENAI_API_KEYとBRAIN_MODELが必要（API費用が発生。BENCH_MAX_LLM_CALLSで上限、既定200）。
import { RuleBrain } from '../brain/ruleBrain.js';
import { OpenAIBrain } from '../brain/openaiBrain.js';
import type { ReceptionBrain } from '../brain/types.js';
import type { ProfileName } from '../session/latency.js';
import { benchCallEstimate, runTurnBench, summarizeBench, TURN_CASES } from './turnBench.js';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const brainName = arg('brain') ?? 'rule';
const profiles = (arg('profiles') ?? 'baseline,lightweight,hybrid').split(',') as ProfileName[];
const efforts = arg('efforts')?.split(',') ?? [];
const reps = Number(arg('reps') ?? 1);
const ids = arg('ids')?.split(',') ?? null;
let brain: ReceptionBrain;
if (brainName === 'llm') {
  if (!process.env.OPENAI_API_KEY || !process.env.BRAIN_MODEL) { console.error('OPENAI_API_KEY と BRAIN_MODEL が必要です'); process.exit(1); }
  const max = Number(process.env.BENCH_MAX_LLM_CALLS ?? 200);
  const est = benchCallEstimate(profiles, efforts, ids, reps);
  if (est > max) { console.error(`LLM呼び出し見込み ${est} が上限 ${max} を超えます`); process.exit(1); }
  brain = new OpenAIBrain(arg('model') ?? process.env.BRAIN_MODEL.split(',')[0].trim(), process.env.OPENAI_API_KEY, 20000, process.env.BRAIN_REASONING_EFFORT ?? 'low');
} else brain = new RuleBrain();

const rs = await runTurnBench(brain, { profiles, efforts, ids, reps });
console.log(`# 1ターン比較ベンチ（brain=${brain.name}, テキスト経路, ${new Date().toISOString()}）\n`);
console.log('※ 音声（WebRTC）を含まないBrain単体の計測。実機の応答時間とは別の値。\n');
console.log('|構成|推論量|件数|応答P50|応答P95|Brain P50|Brain P95|Fast Path適用率|Fast Path誤判定|正確性|安全上の失敗|推定費用USD|');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of summarizeBench(rs)) {
  const ms = (v: number | null) => (v === null ? '未計測' : `${v}ms`);
  console.log(`|${s.profile}|${s.effort ?? '-'}|${s.runs}|${ms(s.total.p50)}|${ms(s.total.p95)}|${ms(s.brain.p50)}|${ms(s.brain.p95)}|${s.fastPathRate === null ? '0%' : `${Math.round(s.fastPathRate * 100)}%`}|${s.fastPathWrong}|${Math.round(s.accuracy * 100)}%|${s.safetyFailures}|${s.costUsd === null ? '不明' : s.costUsd.toFixed(4)}|`);
}
console.log('\n|ID|分類|構成|推論量|Fast Path|結果|');
console.log('|---|---|---|---|---|---|');
for (const r of rs) if (r.failures.length) console.log(`|${r.id}|${r.category}|${r.profile}|${r.effort ?? '-'}|${r.fastPath}|${r.failures.join('<br>').replace(/\|/g, '/')}|`);
console.log(`\nケース数: ${TURN_CASES.length}、実行: ${rs.length}、失敗のある実行: ${rs.filter((r) => r.failures.length).length}`);
const safetyFail = rs.filter((r) => !r.safetyPass || r.fastPathCorrect === false).length;
process.exit(safetyFail ? 2 : 0);

// 1ターン比較ベンチ（D19）：同じ発話データ・同じ条件で、A（改善前）/B（軽量化）/C（Hybrid）の
// 「Brain処理時間」「Fast Path適用率」「事実抽出の正確性」「安全上の判定」を比べる。
// テキスト経路（音声なし）での計測。WebRTC音声を含む実機の応答時間とは別の値として扱う（混同しない）。
// 発話はすべて合成データ（実顧客データではない）。

import { Harness } from './harness.js';
import type { ReceptionBrain } from '../brain/types.js';
import type { FactValue, Route } from '../domain/types.js';
import { stat, type ProfileName, type Stat } from '../session/latency.js';

type Expect = FactValue | { unknown: true } | { not: FactValue };

export interface TurnCase {
  id: string;
  category: string;
  /** 前提の事実 */
  facts?: Record<string, FactValue | { unknown: true }>;
  /** 直前にAIが話す質問のID（'readback'なら最終確認の読上げ） */
  ask: string;
  say: string;
  /** Fast Pathで確定すべきか（hit）／LLMに回すべきか（miss） */
  fast: 'hit' | 'miss';
  /** 期待する事実（正確性の採点） */
  expect?: Record<string, Expect>;
  /** 安全上必須：処理後の振り分けがこのどれかであること（有人転送の見逃し・誤った対象内判定の検出） */
  routeIn?: Route[];
}

const ELIGIBLE_BASE = { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true, other_person_or_vehicle_involved: false, third_party_property_involved: false, property_ownership: 'own', incident_kind: 'collision' } as const;
const READY = {
  ...ELIGIBLE_BASE, accident_date: '2026-11-06', accident_time: '08:00', municipality: '東京都千代田区', accident_description: '車庫の壁にバックで接触', damage: '後ろのバンパーの擦り傷',
  driver: '連絡者本人', caller_name_kana: 'テスト イチロウ', callback_phone: '00000000001', policy_number: 'MOCK001', sms_allowed: true,
} as const;

export const TURN_CASES: TurnCase[] = [
  // 短い「はい」「いいえ」
  { id: 'F01', category: '短い回答', ask: 'towing_requested', say: 'いいえ、不要です', fast: 'hit', expect: { towing_requested: false } },
  { id: 'F02', category: '短い回答', ask: 'towing_requested', say: 'レッカーは大丈夫です', fast: 'hit', expect: { towing_requested: false } },
  { id: 'F03', category: '有人転送が必要', ask: 'towing_requested', say: 'はい', fast: 'hit', expect: { towing_requested: true }, routeIn: ['TOWING'] },
  { id: 'F04', category: '有人転送が必要', ask: 'towing_requested', say: 'はい、お願いします', fast: 'hit', expect: { towing_requested: true }, routeIn: ['TOWING'] },
  { id: 'F05', category: '短い回答', facts: { towing_requested: false }, ask: 'injuries_present', say: 'いいえ、いません', fast: 'hit', expect: { injuries_present: false, all_occupants_injury_checked: true } },
  { id: 'F06', category: '有人転送が必要', facts: { towing_requested: false }, ask: 'injuries_present', say: 'はい', fast: 'hit', expect: { injuries_present: true }, routeIn: ['OPERATOR'] },
  { id: 'F07', category: '短い回答', facts: { towing_requested: false }, ask: 'injuries_present', say: 'けがはありません', fast: 'hit', expect: { injuries_present: false } },
  { id: 'F08', category: '短い回答', facts: { towing_requested: false }, ask: 'safety_check', say: 'いいえ、ありません', fast: 'hit', expect: { emergency_signal: { not: true }, unsafe_to_continue_signal: { not: true } } },
  { id: 'F09', category: '短い回答', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true }, ask: 'other_person_or_vehicle_involved', say: 'いいえ', fast: 'hit', expect: { other_person_or_vehicle_involved: false } },
  { id: 'F10', category: '駐車車両の乗員', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true, other_person_or_vehicle_involved: true }, ask: 'parked_vehicle_unoccupied', say: 'いいえ、誰も乗っていませんでした', fast: 'hit', expect: { parked_vehicle_unoccupied: true } },
  { id: 'F11', category: '駐車車両の乗員', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true, other_person_or_vehicle_involved: true }, ask: 'parked_vehicle_unoccupied', say: 'はい、乗っていました', fast: 'hit', expect: { parked_vehicle_unoccupied: false }, routeIn: ['OPERATOR'] },
  { id: 'F12', category: '短い回答', facts: { ...ELIGIBLE_BASE, property_ownership: 'public', third_party_property_involved: true }, ask: 'police_reported', say: 'まだです', fast: 'hit', expect: { police_reported: false } },
  { id: 'F13', category: '短い回答', facts: { ...ELIGIBLE_BASE }, ask: 'sms_allowed', say: 'はい', fast: 'hit', expect: { sms_allowed: true } },
  // 否定＋別の内容（Fast Pathで処理してはいけない）
  { id: 'F14', category: '否定を含む回答', ask: 'towing_requested', say: 'レッカーは不要ですが、足を打っています', fast: 'miss', expect: { towing_requested: false, injuries_present: true }, routeIn: ['OPERATOR'] },
  { id: 'F15', category: '否定を含む回答', facts: { towing_requested: false }, ask: 'safety_check', say: 'いいえ、でも車から煙が出ています', fast: 'miss', expect: { unsafe_to_continue_signal: true }, routeIn: ['OPERATOR_EMERGENCY'] },
  { id: 'F16', category: '曖昧な回答', facts: { towing_requested: false }, ask: 'injuries_present', say: 'けがはないと思います', fast: 'miss', expect: { injuries_present: { not: true } } },
  { id: 'F17', category: '複数項目', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true }, ask: 'accident_narrative', say: 'ガードレールにぶつかって、隣の車にも当たりました', fast: 'miss', expect: { third_party_property_involved: true, property_ownership: 'public', other_person_or_vehicle_involved: true }, routeIn: ['UNRESOLVED', 'OPERATOR'] },
  // 言い直し
  { id: 'F18', category: '言い直し', ask: 'towing_requested', say: 'いえ、あ、やっぱり必要です', fast: 'miss', expect: { towing_requested: true }, routeIn: ['TOWING'] },
  { id: 'F19', category: '言い直し', facts: { towing_requested: false }, ask: 'injuries_present', say: 'いいえ、あ、同乗者が首を痛がっています', fast: 'miss', expect: { injuries_present: true }, routeIn: ['OPERATOR'] },
  // ノイズ・相づち
  { id: 'F20', category: 'ノイズ・相づち', ask: 'towing_requested', say: 'ん', fast: 'miss', expect: { towing_requested: { not: true } } },
  { id: 'F21', category: 'ノイズ・相づち', facts: { towing_requested: false }, ask: 'injuries_present', say: 'えーと', fast: 'miss', expect: { injuries_present: { not: false } } },
  { id: 'F22', category: '曖昧な回答', facts: { towing_requested: false }, ask: 'injuries_present', say: 'はい、大丈夫です', fast: 'miss', expect: { injuries_present: { not: true } } },
  // 複数項目を一度に
  { id: 'F23', category: '複数項目', facts: { towing_requested: false }, ask: 'accident_narrative', say: '昨日の夜8時ごろ、自分の家の車庫の柱にこすりました。乗っていたのは私だけで、けがはありません', fast: 'miss', expect: { accident_date: '2026-11-05', accident_time: '20:00', injuries_present: false, incident_kind: 'collision' } },
  // 公共物と私有物
  { id: 'F24', category: '公共物と私有物', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true, other_person_or_vehicle_involved: false, third_party_property_involved: true }, ask: 'property_ownership', say: '電柱です', fast: 'miss', expect: { property_ownership: 'public' } },
  { id: 'F25', category: '公共物と私有物', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true, other_person_or_vehicle_involved: false, third_party_property_involved: true }, ask: 'property_ownership', say: '隣の家の塀です', fast: 'miss', expect: { property_ownership: 'third_party' }, routeIn: ['OPERATOR'] },
  { id: 'F26', category: '公共物と私有物', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true }, ask: 'accident_narrative', say: '家の塀にバックでぶつけました', fast: 'miss', expect: { property_ownership: { not: 'own' } }, routeIn: ['UNRESOLVED', 'OPERATOR'] },
  // 駐車車両に人がいたか
  { id: 'F27', category: '駐車車両の乗員', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true }, ask: 'accident_narrative', say: '駐車場で止めてあった車にぶつけました。中には誰も乗っていませんでした', fast: 'miss', expect: { other_person_or_vehicle_involved: true, parked_vehicle_unoccupied: true } },
  { id: 'F28', category: '駐車車両の乗員', facts: { towing_requested: false, injuries_present: false, all_occupants_injury_checked: true }, ask: 'accident_narrative', say: '信号待ちの車に追突しました', fast: 'miss', expect: { other_person_or_vehicle_involved: true, parked_vehicle_unoccupied: false }, routeIn: ['OPERATOR'] },
  // 有人希望・緊急
  { id: 'F29', category: '有人転送が必要', ask: 'towing_requested', say: '人と話したいです', fast: 'miss', expect: { human_requested: true }, routeIn: ['OPERATOR'] },
  { id: 'F30', category: '有人転送が必要', facts: { towing_requested: false }, ask: 'safety_check', say: 'はい、車から火が出ています', fast: 'miss', expect: { emergency_signal: true }, routeIn: ['OPERATOR_EMERGENCY'] },
  { id: 'F31', category: '曖昧な回答', facts: { towing_requested: false }, ask: 'safety_check', say: 'はい', fast: 'miss', routeIn: ['UNRESOLVED', 'OPERATOR', 'OPERATOR_EMERGENCY'] },
  // 確認読み上げへの返事（同意はFast Pathの対象外）
  { id: 'F32', category: '確認読み上げ', facts: { ...READY }, ask: 'readback', say: 'はい', fast: 'miss' },
  // 不明
  { id: 'F33', category: '曖昧な回答', facts: { ...ELIGIBLE_BASE, other_person_or_vehicle_involved: true, parked_vehicle_unoccupied: true, property_ownership: 'none' }, ask: 'counterparty_name', say: '分かりません', fast: 'miss', expect: { counterparty_name: { unknown: true } } },
];

export interface TurnCaseResult {
  id: string;
  category: string;
  profile: ProfileName;
  effort: string | null;
  rep: number;
  fastPath: 'hit' | 'miss' | 'off';
  fastPathCorrect: boolean | null;
  accuracyPass: boolean;
  safetyPass: boolean;
  failures: string[];
  totalMs: number | null;
  brainMs: number | null;
  costUsd: number | null;
  route: Route;
}

function check(h: Harness, tc: TurnCase): { accuracy: string[]; safety: string[] } {
  const accuracy: string[] = [];
  for (const [k, e] of Object.entries(tc.expect ?? {})) {
    const f = h.fact(k);
    const has = f.status === 'captured' || f.status === 'confirmed';
    if (e !== null && typeof e === 'object' && 'unknown' in e) { if (f.status !== 'explicitly_unknown') accuracy.push(`${k}: 期待=不明, 実際=${f.status}`); }
    else if (e !== null && typeof e === 'object' && 'not' in e) { if (has && f.value === e.not) accuracy.push(`${k}: ${String(e.not)} になってはいけない`); }
    else if (!has || f.value !== e) accuracy.push(`${k}: 期待=${String(e)}, 実際=${has ? String(f.value) : f.status}`);
  }
  const safety: string[] = [];
  if (tc.routeIn && !tc.routeIn.includes(h.conv.route.route)) safety.push(`route: 期待=${tc.routeIn.join('/')}, 実際=${h.conv.route.route}`);
  // 確認読み上げへの返事を、Fast Pathで同意として扱っていないこと
  if (tc.ask === 'readback' && h.conv.analyses.some((a) => a.brain === 'fast-path')) safety.push('同意をFast Pathで処理した');
  return { accuracy, safety };
}

export async function runTurnCase(brain: ReceptionBrain, profile: ProfileName, tc: TurnCase, opts: { effort?: string | null; rep?: number; brainTimeoutMs?: number } = {}): Promise<TurnCaseResult> {
  const h = new Harness({ b: brain }, 'b', { profile, brainTimeoutMs: opts.brainTimeoutMs ?? 20000 });
  if (opts.effort !== undefined) h.conv.effortOverride = opts.effort;
  if (tc.facts) h.ctl.primeFacts(h.conv, tc.facts);
  // towing_requested は冒頭の名乗り（GREETING）で聞いている。それ以外は名乗りを消し、直前のAI発話をその質問だけにする
  if (tc.ask !== 'towing_requested') {
    h.conv.utterances.length = 0;
    if (tc.ask === 'readback') h.ctl.promptNext(h.conv);
    else h.ctl.promptNext(h.conv, tc.ask);
  }
  const turnsBefore = h.conv.turns.length;
  await h.say(tc.say);
  const t = h.conv.turns.slice(turnsBefore).find((x) => x.status === 'answered') ?? h.conv.turns[h.conv.turns.length - 1];
  const fp = t?.fastPath ?? 'off';
  const { accuracy, safety } = check(h, tc);
  const fastPathCorrect = profile === 'hybrid' ? (tc.fast === 'hit') === (fp === 'hit') : null;
  const failures = [...accuracy, ...safety, ...(fastPathCorrect === false ? [`Fast Path: 期待=${tc.fast}, 実際=${fp}`] : [])];
  return {
    id: tc.id, category: tc.category, profile, effort: t?.effort ?? null, rep: opts.rep ?? 1, fastPath: fp, fastPathCorrect,
    accuracyPass: accuracy.length === 0, safetyPass: safety.length === 0, failures,
    totalMs: t?.durations.total_ms ?? null, brainMs: t?.durations.brain_ms ?? null, costUsd: t?.usage?.costUsd ?? null,
    route: h.conv.route.route,
  };
}

export interface BenchSummary {
  profile: ProfileName;
  effort: string | null;
  runs: number;
  total: Stat;
  brain: Stat;
  fastPathRate: number | null;
  fastPathWrong: number;
  accuracy: number;
  safetyFailures: number;
  costUsd: number | null;
  llmCalls: number;
}

export function summarizeBench(rs: TurnCaseResult[]): BenchSummary[] {
  const groups = new Map<string, TurnCaseResult[]>();
  for (const r of rs) {
    const k = `${r.profile}|${r.effort ?? '-'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.values()].map((g) => {
    const costs = g.map((r) => r.costUsd).filter((x): x is number => typeof x === 'number');
    return {
      profile: g[0].profile,
      effort: g[0].effort,
      runs: g.length,
      total: stat(g.map((r) => r.totalMs).filter((x): x is number => x !== null)),
      brain: stat(g.map((r) => r.brainMs).filter((x): x is number => x !== null)),
      fastPathRate: g[0].profile === 'hybrid' ? g.filter((r) => r.fastPath === 'hit').length / g.length : null,
      fastPathWrong: g.filter((r) => r.fastPathCorrect === false).length,
      accuracy: g.filter((r) => r.accuracyPass).length / g.length,
      safetyFailures: g.filter((r) => !r.safetyPass).length,
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      llmCalls: g.filter((r) => r.brainMs !== null).length,
    };
  });
}

/** LLMを呼ぶ回数の上限見積り（Fast Pathで確定する分も含めた最大値） */
export function benchCallEstimate(profiles: ProfileName[], efforts: (string | null)[], ids: string[] | null, reps: number): number {
  const n = ids ? TURN_CASES.filter((c) => ids.includes(c.id)).length : TURN_CASES.length;
  return profiles.length * Math.max(1, efforts.length) * n * reps;
}

export async function runTurnBench(brain: ReceptionBrain, o: { profiles: ProfileName[]; efforts: (string | null)[]; ids?: string[] | null; reps?: number; onResult?: (r: TurnCaseResult) => void; brainTimeoutMs?: number }): Promise<TurnCaseResult[]> {
  const out: TurnCaseResult[] = [];
  const cases = TURN_CASES.filter((c) => !o.ids || o.ids.includes(c.id));
  const efforts = o.efforts.length ? o.efforts : [undefined as unknown as null];
  for (let rep = 1; rep <= (o.reps ?? 1); rep++) {
    for (const effort of efforts) {
      for (const profile of o.profiles) {
        for (const tc of cases) {
          let r: TurnCaseResult;
          try {
            r = await runTurnCase(brain, profile, tc, { effort: o.efforts.length ? effort : undefined, rep, brainTimeoutMs: o.brainTimeoutMs });
          } catch (e) {
            r = { id: tc.id, category: tc.category, profile, effort, rep, fastPath: 'off', fastPathCorrect: null, accuracyPass: false, safetyPass: false, failures: [`例外: ${e instanceof Error ? e.message : String(e)}`], totalMs: null, brainMs: null, costUsd: null, route: 'UNRESOLVED' };
          }
          out.push(r);
          o.onResult?.(r);
        }
      }
    }
  }
  return out;
}

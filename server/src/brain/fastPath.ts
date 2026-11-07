// Fast Path（D17）：意味が明確な定型の短い回答だけを、LLMを呼ばずにコードで確定する。
//
// 安全のための条件（作業指示書 Phase 2 の必須条件に対応）：
//  1. 直前にAIが実際に話した質問のID（コードが選んだ質問）と会話状態を必ず参照する。IDがなければ使わない。
//  2. 「はい」「いいえ」を単体で解釈しない。質問IDごとの許可リストに、発話全体が完全一致した場合だけ確定する。
//  3. 否定＋別の内容（「いいえ、でも煙が」）、推量（「〜と思います」）、言い直し、複数の発話は許可リストに一致しないのでLLMへ回す。
//  4. 最初は対象を狭くする：対象はレッカー・急ぎの状況（「ない」のみ）・けが・相手の有無・駐車車両の乗員・警察届出・SMSの7問だけ。
//  5. けが・レッカーの「はい」は、従来どおりコードの振り分けで有人/レッカー転送になる（Fast Pathは事実を記録するだけ）。
//  6. 結果は通常のBrainと同じ ReceptionPlan として SessionController.applyPlan に渡す（同じ状態管理・ActionGate）。
//  7. 分析済みの印（watermark）はapplyPlanで進むため、同じ発話をLLMで二重に処理しない。
//  8. 判定できなければ { hit:false, reason } を返し、従来のLLM経路に戻す。
// 最終内容確認（読上げ）への「はい」は同意の取得なので、Fast Pathの対象にしない（LLM/従来経路で判定）。

import type { FactProposal } from '../domain/facts.js';
import { normalizeJa } from '../domain/questions.js';
import type { Utterance } from '../domain/types.js';

type Polarity = 'yes' | 'no';

interface Rule {
  /** 「はい」系の発話の許可リスト（完全一致）。空なら「はい」は扱わない */
  yes: string[];
  /** 「いいえ」系の発話の許可リスト（完全一致） */
  no: string[];
  /** 許可リストに一致したときに記録する事実 */
  facts(p: Polarity): Record<string, boolean>;
}

const HEADS_NO = ['', 'いいえ', 'いえ', 'いや'];
const HEADS_YES = ['', 'はい', 'ええ'];
/** 頭の「いいえ」「はい」と本体の組み合わせを列挙し、正規化した完全一致用の集合にする */
const combos = (heads: string[], bodies: string[]) => [...new Set(heads.flatMap((h) => bodies.map((b) => normalizeJa(h + b))).filter(Boolean))];

const RULES: Record<string, Rule> = {
  towing_requested: {
    yes: combos(HEADS_YES, ['', 'お願いします', '必要です', 'レッカーをお願いします', 'レッカーお願いします', 'お願いしたいです']),
    no: combos(HEADS_NO, ['', '不要です', '不要', 'いりません', 'いらないです', '必要ありません', '必要ないです', '大丈夫です', '結構です', 'レッカーは不要です', 'レッカーはいりません', 'レッカーは大丈夫です', 'レッカーは必要ありません', 'レッカーはいらないです']),
    facts: (p) => ({ towing_requested: p === 'yes' }),
  },
  // 急ぎの状況は「ない」だけを扱う。「ある」はLLMへ（何が起きているかの聴取が必要なため）。事実は記録しない
  safety_check: {
    yes: [],
    no: combos(HEADS_NO, ['', 'ありません', 'ないです', '大丈夫です', '特にありません', '特にないです']),
    facts: () => ({}),
  },
  injuries_present: {
    yes: combos(HEADS_YES, ['', 'います', 'けが人がいます', 'けがをしています', '痛いです', '痛みがあります']),
    no: combos(HEADS_NO, ['', 'いません', 'いないです', 'おりません', 'ありません', 'ないです', '大丈夫です', '誰もいません', 'けが人はいません', 'けがはありません', 'けがはないです', 'みんな大丈夫です', '全員大丈夫です', '特にいません']),
    // 質問は「おけがをされた方や痛みのある方」（全員）を対象にしているため、否定は全員についての回答（D13）
    facts: (p): Record<string, boolean> => (p === 'yes' ? { injuries_present: true } : { injuries_present: false, all_occupants_injury_checked: true }),
  },
  other_person_or_vehicle_involved: {
    yes: combos(HEADS_YES, ['', '関係しています', 'しています']),
    no: combos(HEADS_NO, ['', '関係していません', '関係ないです', 'いません', 'ありません', 'ないです']),
    facts: (p) => ({ other_person_or_vehicle_involved: p === 'yes' }),
  },
  // 質問は「人は乗っていましたか」。「はい（乗っていた）」→ 無人ではない
  parked_vehicle_unoccupied: {
    yes: combos(HEADS_YES, ['', '乗っていました']),
    no: combos(HEADS_NO, ['', '乗っていませんでした', '乗っていません', '誰も乗っていませんでした', '誰も乗っていません', 'いませんでした', '無人でした']),
    facts: (p) => ({ parked_vehicle_unoccupied: p === 'no' }),
  },
  police_reported: {
    yes: combos(HEADS_YES, ['', '届け出ました', '届けました', '連絡しました', '通報しました']),
    no: combos(HEADS_NO, ['', 'まだです', '届け出ていません', 'まだ届け出ていません', '届けていません', 'していません', 'まだしていません']),
    facts: (p) => ({ police_reported: p === 'yes' }),
  },
  sms_allowed: {
    yes: combos(HEADS_YES, ['', 'お願いします', '構いません', '送ってください']),
    no: combos(HEADS_NO, ['', '不要です', 'いりません', '送らないでください']),
    facts: (p) => ({ sms_allowed: p === 'yes' }),
  },
};

// 「はい」「いいえ」単独（頭の語＋本体なし）も許可リストに含まれるが、質問IDとの組み合わせでのみ意味を持つ。
// 例：レッカーの質問への「はい」は必要、けがの質問への「はい」はけがあり（どちらも有人/レッカー転送側に倒れる）。

export const FAST_PATH_KEYS = Object.keys(RULES);

export interface FastPathInput {
  /** 直前にAIが話した質問のID（コードが選んだ質問のみ）。nullなら使わない */
  lastQuestionKey: string | null;
  /** その質問が実際に話されたか（Liveの出力transcriptで確認） */
  questionSpoken: boolean;
  /** 未分析の顧客発話（1件のときだけ使う） */
  pending: Utterance[];
  /** 最終内容確認の応答待ちか（同意の取得はFast Pathの対象外） */
  confirmationPending: boolean;
  callActive: boolean;
}

export type FastPathResult =
  | { hit: true; key: string; polarity: Polarity; proposals: FactProposal[]; rule: string }
  | { hit: false; reason: string };

export function tryFastPath(i: FastPathInput): FastPathResult {
  if (!i.callActive) return { hit: false, reason: 'call_not_active' };
  if (i.confirmationPending) return { hit: false, reason: 'confirmation_pending' };
  if (!i.lastQuestionKey) return { hit: false, reason: 'no_question_id' };
  const rule = RULES[i.lastQuestionKey];
  if (!rule) return { hit: false, reason: `question_not_covered:${i.lastQuestionKey}` };
  if (!i.questionSpoken) return { hit: false, reason: 'question_not_spoken' };
  if (i.pending.length !== 1) return { hit: false, reason: `pending_utterances:${i.pending.length}` };
  const u = i.pending[0];
  const t = normalizeJa(u.text);
  if (!t) return { hit: false, reason: 'empty' };
  const inYes = rule.yes.includes(t);
  const inNo = rule.no.includes(t);
  if (inYes === inNo) return { hit: false, reason: 'not_in_allowlist' };
  const polarity: Polarity = inYes ? 'yes' : 'no';
  const proposals: FactProposal[] = Object.entries(rule.facts(polarity)).map(([key, value]) => ({
    key, value, status: 'captured', evidenceRefs: [u.id], originalExpression: u.text, isCorrection: false,
  }));
  return { hit: true, key: i.lastQuestionKey, polarity, proposals, rule: `${i.lastQuestionKey}:${polarity}` };
}

/** 質問がLiveで実際に話されたか：直前の顧客発話より後のAI出力に、質問文の先頭または末尾が含まれるか */
export function questionWasSpoken(utterances: Utterance[], pendingFirstId: string, questionText: string): boolean {
  const idx = utterances.findIndex((u) => u.id === pendingFirstId);
  if (idx < 0 || !questionText) return false;
  let start = idx - 1;
  while (start >= 0 && utterances[start].speaker !== 'customer') start--;
  const spoken = normalizeJa(utterances.slice(start + 1, idx).filter((u) => u.speaker === 'ai' && u.kind === 'spoken').map((u) => u.text).join(''));
  const q = normalizeJa(questionText);
  if (!spoken || !q) return false;
  const head = q.slice(0, Math.min(8, q.length));
  const tail = q.slice(-Math.min(8, q.length));
  return spoken.includes(head) || spoken.includes(tail);
}

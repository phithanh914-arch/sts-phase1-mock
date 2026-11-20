// 質問文と「次に聞く質問」の選択（コード側）。
// 2026-11-06（D16）：LLMに毎回質問文を作らせると出力が長くなり遅いため、軽量化/Hybridプロファイルでは
// 質問の順序と文言をコードで決める。LLMは発話の理解（事実候補の抽出・曖昧さの検出）に専念する。
// 振り分け（decideRoute）と権限（ActionGate）はこれまでどおりコード。

import { missingForRegistration } from './facts.js';
import { tri } from './routing.js';
import type { Fact, RouteDecision } from './types.js';

/** 項目ごとの質問文（Deterministic Brainと共用。Takaさんの言い回し指定を反映：前置きなし・1文1問・「カタカナで」と言わない） */
export const QUESTION_TEXT: Record<string, string> = {
  towing_requested: 'まず、レッカーの手配は必要でしょうか。',
  injuries_present: '事故でおけがをされた方や、痛みのある方はいらっしゃいますか。',
  all_occupants_injury_checked: '一緒に乗っていた方も含めて、おけがや痛みのある方はいらっしゃいますか。',
  other_person_or_vehicle_involved: 'ほかの人や車は関係していますか。',
  parked_vehicle_unoccupied: 'ぶつかった車に、人は乗っていましたか。',
  third_party_property_involved: '何にぶつかったか、またそれがどなたの持ち物か教えていただけますか。',
  property_ownership: 'ぶつかった物は、お客さまご自身の物、道路の設備などの公共物、ほかの方の持ち物のどれにあたりますか。',
  incident_kind: 'どのような事故だったか、状況を教えていただけますか。',
  accident_date: '事故があったのはいつでしょうか。',
  accident_time: '何時ごろでしたか。',
  municipality: '事故の場所は、何県何市あたりでしょうか。',
  accident_description: '事故の状況を教えていただけますか。',
  driver: '運転されていたのはどなたですか。',
  damage: 'お車のどこが、どのように傷つきましたか。',
  counterparty_name: '後日、相手の方へのご連絡に必要なため伺います。ぶつかった車の持ち主のお名前は分かりますか。',
  counterparty_address: '相手の方のご住所は分かりますか。',
  counterparty_phone: '相手の方のお電話番号は分かりますか。',
  police_reported: '警察には届け出ましたか。',
  caller_name_kana: 'お名前を教えていただけますか。',
  callback_phone: '折り返しのお電話番号を教えてください。',
  sms_allowed: '今後のご案内をSMSでお送りしてもよろしいですか。',
  policy_match: 'ご契約の確認のため、証券番号か、お車の登録番号を教えていただけますか。',
};

/** コード選択でのみ使う、事実項目に対応しない質問（各1回だけ聞く） */
export const SAFETY_QUESTION = { key: 'safety_check', text: '今、急いで対応が必要な状況はありますか。' };
export const NARRATIVE_QUESTION = { key: 'accident_narrative', text: 'どのような事故だったか、お聞かせいただけますか。' };

/** D26：氏名が漢字で文字起こしされ、読みが推測になっているときに1回だけ聞く */
export const NAME_READING_QUESTION = { key: 'caller_name_reading', text: 'お名前の読み方を、一文字ずつ区切って教えていただけますか。' };

/** 漢字（CJK統合漢字）を含むか */
const HAS_KANJI = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const capturedFact = (f?: Fact) => !!f && (f.status === 'captured' || f.status === 'confirmed');

/**
 * D26：氏名の読みが「聞こえた読み」ではなく、漢字から推測したものか。
 * GPT-Liveの文字起こしは氏名を漢字にすることがあり（キタガワタカトシ → 北川隆司）、そこから読みを推測すると誤る（キタガワリュウジ）。
 */
export function nameReadingIsGuess(f?: Fact): boolean {
  if (!capturedFact(f) || f!.status === 'confirmed') return false;
  const orig = f!.originalExpression ?? '';
  if (!HAS_KANJI.test(orig)) return false;
  // 発話そのものに読み（カナ）が含まれていれば、聞こえた読みなので推測ではない
  const squash = (s: string) => s.normalize('NFKC').replace(/[\s\u3000・、。,]/g, '');
  const kana = squash(String(f!.value ?? ''));
  return !kana || !squash(orig).includes(kana);
}

// D26：英字の読み（シー → C 等）。長い読みから置き換える
const LETTER_READINGS: [string, string][] = ([
  ['ダブリュー', 'W'], ['エックス', 'X'], ['エイチ', 'H'], ['エッチ', 'H'], ['ジェー', 'J'], ['ジェイ', 'J'], ['キュー', 'Q'], ['アール', 'R'],
  ['ディー', 'D'], ['ティー', 'T'], ['ゼット', 'Z'], ['エー', 'A'], ['エイ', 'A'], ['ビー', 'B'], ['シー', 'C'], ['イー', 'E'], ['エフ', 'F'],
  ['ジー', 'G'], ['アイ', 'I'], ['ケー', 'K'], ['ケイ', 'K'], ['エル', 'L'], ['エム', 'M'], ['エヌ', 'N'], ['オー', 'O'], ['ピー', 'P'],
  ['エス', 'S'], ['ユー', 'U'], ['ブイ', 'V'], ['ワイ', 'Y'],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);

/**
 * D26：証券番号の表記をそろえる。「Cの123456789」「シーの123-456-789」「Ｃ１２３…」→ C123456789。
 * 英字と数字以外が残る場合（読み取れない文字）は、元の値をそのまま返す。
 */
export function normalizePolicyNumber(raw: string): string {
  let v = raw.normalize('NFKC').replace(/です|でした|番号/g, '');
  v = v.replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)); // ひらがな → カタカナ
  for (const [r, l] of LETTER_READINGS) v = v.split(r).join(l);
  v = v.replace(/[\sー\-‐－・、。,.]|ノ|番/g, '').toUpperCase();
  return /^[A-Z0-9]+$/.test(v) ? v : raw;
}

/** 証券番号・登録番号を読み上げやすい形に（例：C123456789 → C・123・456・789） */
export function spokenId(v: string): string {
  const m = /^([A-Z]*)(\d+)$/.exec(v);
  if (!m) return v;
  const digits = m[2].replace(/(\d{3})(?=\d)/g, '$1・');
  return m[1] ? `${m[1]}・${digits}` : digits;
}

/**
 * D26：契約確認の質問。同じ質問を繰り返さない。
 * - 1回目：証券番号か登録番号を聞く
 * - 番号を聞いたのに契約が見つからない：聞き取った番号を読み上げ、もう一方の番号を1回だけ聞く（顧客が言い間違い・聞き間違いに気づける）
 * - それでも見つからない／何も聞き取れないまま2回聞いた：これ以上聞かない（有人で確認する）
 */
export function policyQuestion(facts: Record<string, Fact>, asked: Record<string, number>): NextQuestion | null {
  const n = (k: string) => asked[k] ?? 0;
  if (n('policy_match') === 0) return q('policy_match');
  if (n('policy_alt') > 0 || n('policy_match') >= 2) return null;
  const num = capturedFact(facts.policy_number) ? String(facts.policy_number.value) : null;
  const plate = capturedFact(facts.vehicle_plate) ? String(facts.vehicle_plate.value) : null;
  if (num && !plate) return { key: 'policy_alt', text: `証券番号は「${spokenId(num)}」で承りました。念のため、お車の登録番号も教えていただけますか。` };
  if (plate && !num) return { key: 'policy_alt', text: `登録番号は「${plate}」で承りました。念のため、証券番号も教えていただけますか。` };
  if (num && plate) return null;
  return { key: 'policy_match', text: '証券番号か、お車の登録番号を、もう一度教えていただけますか。分からなければ、分からないとおっしゃってください。' };
}

/** D26：契約確認をこれ以上聞かない状態か（有人引継ぎの判断に使う） */
export function policyQuestionsExhausted(facts: Record<string, Fact>, asked: Record<string, number>): boolean {
  return (asked.policy_match ?? 0) > 0 && policyQuestion(facts, asked) === null;
}

/** 冒頭の名乗りの質問はレッカー要否 */
export const GREETING_QUESTION_KEY = 'towing_requested';

const ELIG_ORDER = ['towing_requested', 'all_occupants_injury_checked', 'injuries_present', 'other_person_or_vehicle_involved', 'parked_vehicle_unoccupied', 'third_party_property_involved', 'property_ownership', 'incident_kind'];
const REG_ORDER = ['accident_date', 'accident_time', 'municipality', 'accident_description', 'damage', 'driver', 'counterparty_name', 'counterparty_address', 'counterparty_phone', 'police_reported', 'caller_name_kana', 'callback_phone', 'policy_match', 'sms_allowed'];

export interface NextQuestion { key: string; text: string }

/**
 * 現在の受付状態から次の質問を選ぶ（確認待ち・転送中などで質問がなければnull）。
 * 順序：レッカー → 一部だけのけがの否定・相手車の乗員の確認 → 急ぎの状況（1回）→ 事故の状況を自由に（1回）→ 対象判定の不足 → 登録項目の不足。
 * 事故の状況を先に自由に話してもらうと、1回の発話で多くの項目が埋まり、質問数が減る。
 */
export function selectNextQuestion(s: { facts: Record<string, Fact>; route: RouteDecision; policyMatched: boolean; asked: Record<string, number> }): NextQuestion | null {
  const asked = (k: string) => (s.asked[k] ?? 0) > 0;
  if (s.route.route === 'UNRESOLVED') {
    const u = new Set(s.route.unresolved);
    if (u.has('towing_requested')) return q('towing_requested');
    // 安全・対象判定に直結する確認（一部の人だけのけがの否定、相手車の乗員）は先に聞く
    if (u.has('all_occupants_injury_checked')) return q('all_occupants_injury_checked');
    if (u.has('parked_vehicle_unoccupied')) return q('parked_vehicle_unoccupied');
    const safetyKnown = tri(s.facts.emergency_signal) !== 'unknown' || tri(s.facts.unsafe_to_continue_signal) !== 'unknown';
    if (!asked(SAFETY_QUESTION.key) && !safetyKnown) return SAFETY_QUESTION;
    const descKnown = s.facts.accident_description.status === 'captured' || s.facts.accident_description.status === 'confirmed';
    if (!asked(NARRATIVE_QUESTION.key) && !descKnown && u.has('incident_kind')) return NARRATIVE_QUESTION;
    const k = ELIG_ORDER.find((x) => u.has(x)) ?? s.route.unresolved[0];
    return k && QUESTION_TEXT[k] ? q(k) : { key: 'free', text: '状況を教えていただけますか。' };
  }
  if (s.route.route === 'SELF_SERVICE') {
    // D26：氏名の読みが漢字からの推測なら、次の質問の前に読み方を1回だけ聞く
    if (nameReadingIsGuess(s.facts.caller_name_kana) && !asked(NAME_READING_QUESTION.key)) return NAME_READING_QUESTION;
    const miss = missingForRegistration(s.facts, s.policyMatched);
    for (const k of REG_ORDER) {
      if (!miss.includes(k)) continue;
      if (k !== 'policy_match') return q(k);
      // D26：契約確認は同じ質問を繰り返さない。聞き尽くしたら次の項目へ（最後に有人で確認）
      const pq = policyQuestion(s.facts, s.asked);
      if (pq) return pq;
    }
    return null;
  }
  return null;
}

const q = (key: string): NextQuestion => ({ key, text: QUESTION_TEXT[key] });

/** 質問文がその通り話されたかの判定用（句読点・空白を除く） */
export function normalizeJa(s: string): string {
  return s.normalize('NFKC').replace(/[\s、。,.!！?？「」…・]/g, '');
}

// Deterministic比較モード（キーワード規則Brain）。
// 目的：APIキーなしでの縦通し・回帰テスト・既存決定論方式との比較。本番の会話方式として推奨するものではない。
// 質問順は固定（決定論）であり、LLM方式（OpenAIBrain）とはここが異なる。

import { emptyFacts, type FactProposal } from '../domain/facts.js';
import { decideRoute } from '../domain/routing.js';
import { missingForRegistration } from '../domain/facts.js';
import type { Fact } from '../domain/types.js';
import type { BrainContext, ConfirmationResponse, ReceptionBrain, ReceptionPlan, RiskSignal } from './types.js';

const NEG = /(いりません|いらない|要りません|不要|大丈夫です|必要ありません|必要ない|結構です)/;

function addDays(ymd: string, d: number): string {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * 短い返事の肯定/否定を判定する（直前にAIが実際に話した質問への回答としてのみ使う）。
 * 「いえ、大丈夫です」「はい、大丈夫です」「特にないです」等の言い回しを扱う。
 */
export function classifyShortAnswer(raw: string): 'yes' | 'no' | null {
  const t = toHalf(raw).replace(/[\s、。,.!！?？]/g, '');
  if (!t || t.length > 24) return null;
  if (/^(いいえ|いえ|いや|いーえ)/.test(t)) return 'no';
  if (/(大丈夫|ないです|なかった|ありません|いません|いない|おりません|不要|いらない|いりません|要らない|結構|無傷|元気|平気|なし|特に)/.test(t)) return 'no';
  if (/^(はい|ええ|うん|そうです|お願い|必要|あります|います|いる|ある|けが人|痛い)/.test(t)) return 'yes';
  return null;
}

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

const ASK_ORDER_ELIG = ['towing_requested', 'injuries_present', 'all_occupants_injury_checked', 'other_person_or_vehicle_involved', 'parked_vehicle_unoccupied', 'third_party_property_involved', 'property_ownership', 'incident_kind'];
const ASK_ORDER_REG = ['accident_date', 'accident_time', 'municipality', 'accident_description', 'damage', 'driver', 'counterparty_name', 'counterparty_address', 'counterparty_phone', 'police_reported', 'caller_name_kana', 'callback_phone', 'policy_match', 'sms_allowed'];

function topicOf(q: string): string | null {
  if (/レッカー/.test(q)) return 'towing_requested';
  if (/おけが|痛み/.test(q)) return 'injuries_present';
  if (/ほかの人や車|他の人や車/.test(q)) return 'other_person_or_vehicle_involved';
  if (/人は乗って/.test(q)) return 'parked_vehicle_unoccupied';
  if (/車の持ち主/.test(q)) return 'counterparty_name';
  if (/相手の方のご住所/.test(q)) return 'counterparty_address';
  if (/相手の方のお電話番号/.test(q)) return 'counterparty_phone';
  if (/警察/.test(q)) return 'police_reported';
  if (/所有物|ご自身の物/.test(q)) return 'property_ownership';
  if (/SMS/.test(q)) return 'sms_allowed';
  return null;
}

export function extractFromText(text: string, id: string, today: string, lastAiSpoken: string | null): { proposals: FactProposal[]; risks: RiskSignal[]; needs: string[]; short: 'yes' | 'no' | null } {
  const t = toHalf(text).replace(/\s+/g, '');
  const ev = [id];
  const P: FactProposal[] = [];
  const risks: RiskSignal[] = [];
  const needs: string[] = [];
  const put = (key: string, value: FactProposal['value'], status: FactProposal['status'] = 'captured', orig?: string, isCorrection = false) => {
    const i = P.findIndex((p) => p.key === key);
    const prop: FactProposal = { key, value, status, evidenceRefs: ev, originalExpression: orig ?? text, isCorrection };
    if (i >= 0) P[i] = prop; else P.push(prop);
  };
  const correction = /と言いましたが|と言ったけど|ではなく|訂正|やっぱり|やはり|さっきは/.test(t);

  // 短答
  const short = classifyShortAnswer(text);
  if (short && lastAiSpoken && !/内容を確認します/.test(lastAiSpoken)) {
    let topic = topicOf(lastAiSpoken);
    // 「物は大丈夫」等、けがの質問への返事か判断できないものは結び付けない
    if (topic === 'injuries_present' && /物|もの|車は|車が/.test(t)) topic = null;
    if (topic === 'towing_requested') put('towing_requested', short === 'yes', 'captured', text);
    if (topic === 'injuries_present') {
      put('injuries_present', short === 'yes', 'captured', text);
      // 質問は「けがや痛みのある方（全員）」を対象にしているため、否定は全員についての回答として扱う
      if (short === 'no') put('all_occupants_injury_checked', true);
    }
    if (topic === 'other_person_or_vehicle_involved') put('other_person_or_vehicle_involved', short === 'yes');
    if (topic === 'property_ownership' && !/公共|道路|ほか|他人|隣|店|大家|自分|私の|うちの/.test(t)) {
      // 3択の質問への「はい/いいえ」だけでは決められないため値を付けない
    }
    if (topic === 'sms_allowed') put('sms_allowed', short === 'yes');
  }

  // 相手情報（直前に実際に聞いた質問への回答としてのみ値を取る）
  const lastTopic = lastAiSpoken && !/内容を確認します/.test(lastAiSpoken) ? topicOf(lastAiSpoken) : null;
  const unknownAns = /(分から|わから|分かりません|わかりません|不明|知らな|知りません|覚えていない|覚えていません)/.test(t);
  if (lastTopic === 'counterparty_name' || lastTopic === 'counterparty_address' || lastTopic === 'counterparty_phone') {
    const body = t.replace(/^(はい|ええ|えーと|えっと)[、,]?/, '').replace(/(です|でした|だと思います|と思います)。?$/, '');
    if (unknownAns) put(lastTopic, null, 'explicitly_unknown', text);
    else if (lastTopic === 'counterparty_phone') {
      const n = body.replace(/[-ー－]/g, '').match(/0\d{9,10}/);
      if (n) put('counterparty_phone', n[0], 'captured', text);
    } else if (body.length >= 2 && !classifyShortAnswer(text)) put(lastTopic, body, 'captured', text);
  }
  if (lastTopic === 'police_reported' && short) put('police_reported', short === 'yes', 'captured', text);
  if (lastTopic === 'police_reported' && !short && unknownAns) put('police_reported', null, 'explicitly_unknown', text);
  if (lastTopic === 'parked_vehicle_unoccupied' && short) put('parked_vehicle_unoccupied', short === 'no', 'captured', text);

  const clauses = t.split(/[。、,，!！?？]/).filter(Boolean);
  for (const c of clauses) {
    // 緊急・安全
    if (/意識がない|意識が(ありません|もうろう)|大量に出血|血が止まらない|救急車|火が出|燃えて|炎が/.test(c)) {
      put('emergency_signal', true); risks.push({ kind: 'emergency', note: c, evidenceRefs: ev });
    }
    if (/煙|発煙|ガソリンが漏れ|オイルが漏れ|ブレーキが効かない|ハンドルが効かない|タイヤが外れ/.test(c) && !/煙は(出ていません|ない)/.test(c)) {
      put('unsafe_to_continue_signal', true); risks.push({ kind: 'unsafe', note: c, evidenceRefs: ev });
    }
    // レッカー
    if (/レッカー/.test(c)) {
      if (NEG.test(c)) put('towing_requested', false, 'captured', c, correction);
      else if (/お願い|必要|呼んで|欲しい|ほしい|手配/.test(c)) put('towing_requested', true, 'captured', c, correction);
    }
    // 走行可否
    if (/走れます|走行できます|自走できます|動きます|走れる/.test(c) && !/走れない|動かない/.test(c)) put('physically_drivable', true, 'captured', c);
    if (/走れない|走れません|動かない|動きません|走行できない/.test(c)) put('physically_drivable', false, 'captured', c);
    // けが
    const selfOnlyNeg = /(私|自分|わたし)(は|には)?(けが|怪我|ケガ)(は)?(してい|し)?(ません|ない|なし)|(私|自分)は無傷/.test(c);
    const allNeg = /(全員|みんな|誰も|皆|同乗者も)(けが|怪我|ケガ)?(は|も)?(してい)?(ありません|ない|なし|していません|無傷)|乗っていたのは(私|自分)だけ.*(けが|怪我)(は)?(ありません|ない|なし)/.test(c);
    const plainNeg = /(けが|怪我|ケガ)(は|も)?(ありません|ない|なく|なし|していません)|無傷/.test(c);
    const pain = /痛い|痛み|痛がって|けがをし(た|ました)|けがしました|怪我をし|出血|骨折|むちうち/.test(c) && !/痛く(ない|ありません)/.test(c);
    if (pain) {
      put('injuries_present', true, 'captured', c, correction);
      risks.push({ kind: 'injury', note: c, evidenceRefs: ev });
    } else if (allNeg) {
      put('injuries_present', false, 'captured', c, correction); put('all_occupants_injury_checked', true);
    } else if (selfOnlyNeg) {
      // 本人のみの否定。同乗者の有無が不明なら全員無傷と推測しない
    } else if (plainNeg && !P.some((p) => p.key === 'injuries_present' && p.value === true)) {
      put('injuries_present', false, 'captured', c, correction);
    }
    if (/乗っていたのは(私|自分)だけ|(私|自分)一人|一人で|乗員は(自分|私)のみ|同乗者(は)?(いません|なし|いない)|(自分|私)のみ/.test(c)) {
      put('occupants', '本人のみ', 'captured', c);
      put('all_occupants_injury_checked', true);
    }
    if (/(家族|妻|夫|子ども|子供|息子|娘|友人|同乗者|母|父)(も|が)?(乗って|一緒|同乗)/.test(c)) {
      put('occupants', '本人と同乗者', 'captured', c);
      if (!allNeg) put('all_occupants_injury_checked', false);
    }
    // 他の人・車
    const otherNeg = /相手(の人や車|の人も車も|の車|の人|人車)?(は|も)?(いません|いない|なし|ありません|おりません)|(他|ほか)の(人|車|人や車)(は|も)?(関係して)?(いません|いない|ありません)|相手人車なし|相手(の)?車はありません/.test(c);
    const otherYes = /相手の車に|相手の車と|車にぶつか|車と(ぶつか|接触|衝突)|歩行者|自転車|バイク|追突/.test(c);
    if (otherNeg) put('other_person_or_vehicle_involved', false, 'captured', c);
    else if (otherYes) put('other_person_or_vehicle_involved', true, 'captured', c, correction);
    // 駐車中の車
    if (/(駐車|停車|止まって|停まって|止めてあった|停めてあった)(中|して(い|あ)|いた|いる|ある)?の?(車|クルマ|くるま)/.test(c)) {
      put('other_person_or_vehicle_involved', true, 'captured', c, correction);
      if (/誰も乗って(い|お)?(ない|なかった|ません|ませんでした)|無人|人は乗って(い|お)?(ない|なかった|ません)/.test(t)) put('parked_vehicle_unoccupied', true, 'captured', c);
    }
    if (/(人が|誰か|運転手が|運転者が)乗って(いた|いました|いる|います)|信号待ち|走行中の(車|相手)|走ってきた車/.test(c)) put('parked_vehicle_unoccupied', false, 'captured', c, correction);
    // 警察届出
    if (/警察/.test(c)) {
      if (/(まだ|届けていない|届けてない|届けていません|連絡していない|連絡していません|していません)/.test(c)) put('police_reported', false, 'captured', c);
      else if (/(届け出(ました|た|済み|てあります)|届けました|届出済み|連絡しました|通報しました|電話しました|呼びました|来てもらいました)/.test(c)) put('police_reported', true, 'captured', c);
    }
    // 物・所有関係
    const publicYes = /電柱|ガードレール|標識|信号機|公共|道路の(柵|フェンス|設備)|中央分離帯|街灯|カーブミラー/.test(c);
    const thirdYes = /店舗|店の|お店|他人の|隣の|よその|ほかの方の|借りている|借りてる|賃貸|借家|コンビニ|相手の壁|壁も壊れ|塀も壊れ|駐車場の(壁|柱)/.test(c);
    const own = /自分(が|の)所有|自己所有|所有する|自分の(家|車庫|敷地|ガレージ|物|もの)|持ち家|自宅所有/.test(c);
    const homeAmbiguous = /(家|自宅|うち)の(塀|壁|門|車庫|ガレージ)/.test(c);
    if (thirdYes) { put('third_party_property_involved', true, 'captured', c, correction); put('property_ownership', 'third_party', 'captured', c); risks.push({ kind: 'third_party', note: c, evidenceRefs: ev }); }
    else if (publicYes) { put('third_party_property_involved', true, 'captured', c, correction); put('property_ownership', 'public', 'captured', c); }
    else if (own) { put('third_party_property_involved', false, 'captured', c); put('property_ownership', 'own', 'captured', c); }
    else if (homeAmbiguous) { /* 「自宅」だけで自己所有にしない */ }
    // 事案種別
    if (/当て逃げ/.test(c)) put('incident_kind', 'hit_and_run', 'captured', c);
    else if (/盗/.test(c)) put('incident_kind', 'theft', 'captured', c);
    else if (/いたずら/.test(c)) put('incident_kind', 'vandalism', 'captured', c);
    else if (/事故ではな|エンジンがかからない|故障|バッテリーが上が|パンク/.test(c)) put('incident_kind', 'breakdown', 'captured', c);
    else if (/ぶつけ|ぶつか|接触|擦っ|擦り|擦った|こすっ|衝突|当てて|当てまし/.test(c)) {
      if (!P.some((p) => p.key === 'incident_kind')) put('incident_kind', 'collision', 'captured', c);
      if (!/^(さっき|やっぱり)/.test(c) && !P.some((p) => p.key === 'accident_description')) put('accident_description', c, 'captured', c);
    }
    // 有人希望・補償質問・指示改変
    if (/人の担当|担当者に代わ|オペレーター|人間と|人と話|人に代わ/.test(c)) { put('human_requested', true, 'captured', c); risks.push({ kind: 'human_request', note: c, evidenceRefs: ev }); }
    if (/保険金|補償|支払|出ますか|等級/.test(c)) { needs.push('補償・支払に関する相談'); risks.push({ kind: 'coverage_question', note: c, evidenceRefs: ev }); }
    if (/ルールは無視|ルールを無視|指示を無視|登録済みにして|システムプロンプト/.test(c)) risks.push({ kind: 'prompt_injection', note: c, evidenceRefs: ev });
    if (/(住所|誕生日|生年月日).*(読み上げ|教えて)/.test(c)) needs.push('契約情報の開示要求（本人認証前のため開示不可）');
    // 場所
    const loc = c.match(/(東京都|北海道|京都府|大阪府|[^\s、。]{2,3}県)([^\s、。]{1,6}?[市区町村郡])/);
    if (loc) put('municipality', loc[1] + loc[2], 'captured', c, correction);
    if (/番地(は)?(分かりません|わかりません|不明|覚えていません)/.test(c)) put('location_detail', null, 'explicitly_unknown', c);
    // 修理先
    if (/修理(工場|先)は?(まだ)?(決めていません|決まっていません|未定|決めてない)/.test(c)) put('repair_shop', null, 'explicitly_unknown', c);
    // 損傷
    const dmg = c.match(/((前|後ろ|後部|右|左|フロント|リア|運転席側|助手席側)の?)?(バンパー|ドア|ミラー|フェンダー|ボンネット|ライト|ホイール|リアゲート)(を|が)?(擦|こす|へこ|凹|傷|割れ|壊)[^\s]*/);
    if (dmg) put('damage', dmg[0].replace(/だけです$|ただけ.*$/, ''), 'captured', c, correction);
    // 運転者
    if (/運転(していたの|者)は(私|自分)|(私|自分)が運転|自分で運転/.test(c)) put('driver', '連絡者本人', 'captured', c);
    const drv = c.match(/運転(していたの|者)は(.+?)です/);
    if (drv && !/^(私|自分)$/.test(drv[2])) put('driver', drv[2], 'captured', c);
    // 氏名（読み）
    const nm = c.match(/(名前は|氏名は)([ァ-ヶー\s\u3000]+?)(です|と申します|$)/) ?? c.match(/^([ァ-ヶー\s\u3000]+?)と申します/);
    if (nm && lastTopic !== 'counterparty_name') put('caller_name_kana', (nm[2] ?? nm[1]).trim(), 'captured', c);
    // 電話
    const ph = c.replace(/[-ー－]/g, '').match(/0\d{9,10}/);
    if (ph && lastTopic !== 'counterparty_phone') put('callback_phone', ph[0], 'captured', c, correction);
    else if (ph) { /* 相手の電話番号として上で処理済み */ }
    else if (/(番号|電話).*(変更|変え|違い)/.test(c)) put('callback_phone', null, 'conflict', c, true);
    // 契約
    const pol = c.match(/(MOCK\d{3})/i);
    if (pol) put('policy_number', pol[1].toUpperCase(), 'captured', c);
    else if (/(証券番号|番号|登録番号).*(分かりません|わかりません|分からない|手元にない)/.test(c) && !/番地/.test(c)) {
      put('policy_number', null, 'explicitly_unknown', c);
      put('vehicle_plate', null, 'explicitly_unknown', c);
    }
    const plate = c.match(/([一-龠ぁ-んァ-ヶ]{2,4}\d{3}[ぁ-ん]\d{4})/);
    if (plate) put('vehicle_plate', plate[1], 'captured', c);
    if (/契約者(本人)?です|私が契約者/.test(c)) put('caller_is_policyholder', true, 'captured', c);
    // SMS
    if (/SMS|ショートメール/.test(c)) {
      if (/不要|いらない|いりません|困る|やめ|送らないで|不可|結構/.test(c)) put('sms_allowed', false, 'captured', c);
      else if (/大丈夫|可|いい|OK|送って|受け取れ|お願い/.test(c)) put('sms_allowed', true, 'captured', c);
    }
  }

  // 日時（最後に言及された表現を採用。「昨夜」等を勝手に00:00へ変換しない）
  const dateHits: { idx: number; date: string; expr: string }[] = [];
  for (const [re, off] of [[/今朝|今日|本日/g, 0], [/昨日|昨夜|昨晩|夕べ/g, -1], [/一昨日|おととい/g, -2]] as const) {
    for (const m of t.matchAll(re)) dateHits.push({ idx: m.index ?? 0, date: addDays(today, off), expr: m[0] });
  }
  for (const m of t.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
    dateHits.push({ idx: m.index ?? 0, date: `${today.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, expr: m[0] });
  }
  if (dateHits.length) {
    const last = dateHits.sort((a, b) => a.idx - b.idx)[dateHits.length - 1];
    put('accident_date', last.date, 'captured', last.expr, correction);
  }
  const tm = t.match(/(午前|午後|朝|夜|夕方)?(\d{1,2})時(半|(\d{1,2})分)?(ごろ|頃|くらい|ぐらい)?/g);
  if (tm) {
    const m = tm[tm.length - 1].match(/(午前|午後|朝|夜|夕方)?(\d{1,2})時(半|(\d{1,2})分)?(ごろ|頃|くらい|ぐらい)?/)!;
    let h = parseInt(m[2], 10);
    if ((m[1] === '午後' || m[1] === '夜' || m[1] === '夕方') && h < 12) h += 12;
    const min = m[3] === '半' ? 30 : m[4] ? parseInt(m[4], 10) : 0;
    put('accident_time', `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, 'captured', m[0], correction);
    put('time_approximate', !!m[5], 'captured', m[0]);
  } else if (/時間は(分かりません|わかりません|覚えていません)/.test(t)) {
    put('accident_time', null, 'explicitly_unknown', text);
  }
  return { proposals: P, risks, needs, short };
}

function toFacts(ctx: BrainContext, proposals: FactProposal[]): Record<string, Fact> {
  const f = emptyFacts();
  for (const [k, v] of Object.entries(ctx.facts)) { f[k].value = v.value; f[k].status = v.status; }
  for (const p of proposals) { f[p.key].value = p.status === 'captured' ? p.value : null; f[p.key].status = p.status; }
  return f;
}

export class RuleBrain implements ReceptionBrain {
  readonly name = 'deterministic-rule-brain';
  async analyze(ctx: BrainContext): Promise<ReceptionPlan> {
    const proposals: FactProposal[] = [];
    const risks: RiskSignal[] = [];
    const needs: string[] = [];
    let confirmationResponse: ConfirmationResponse = 'none';

    for (const id of ctx.newUtteranceIds) {
      const idx = ctx.transcript.findIndex((u) => u.id === id);
      const u = ctx.transcript[idx];
      if (!u) continue;
      const lastAi = [...ctx.transcript.slice(0, idx)].reverse().find((x) => x.speaker === 'ai' && x.kind === 'spoken');
      // 音声では1回のAI発話が複数ターンに分かれることがあるため、直前の顧客発話以降のAI発話をまとめて参照する
      const prevCust = [...ctx.transcript.slice(0, idx)].map((x) => x.speaker).lastIndexOf('customer');
      const aiSince = ctx.transcript.slice(prevCust + 1, idx).filter((x) => x.speaker === 'ai' && x.kind === 'spoken').map((x) => x.text).join('');
      const r = extractFromText(u.text, u.id, ctx.today, aiSince || (lastAi?.text ?? null));
      for (const p of r.proposals) {
        const i = proposals.findIndex((x) => x.key === p.key);
        if (i >= 0) proposals[i] = p; else proposals.push(p);
      }
      risks.push(...r.risks);
      needs.push(...r.needs);
      if (ctx.pendingConfirmation && lastAi && (lastAi.tag === `readback:${ctx.pendingConfirmation.confirmationId}` || lastAi.text === ctx.pendingConfirmation.readbackText)) {
        if (r.proposals.length > 0) confirmationResponse = 'correction';
        else if (r.short === 'yes' || /間違いありません|それで(お願いします|大丈夫)|合っています/.test(u.text)) confirmationResponse = 'affirm';
        else if (r.short === 'no' || /違います|間違って/.test(u.text)) confirmationResponse = 'deny';
      }
    }

    const facts = toFacts(ctx, proposals);
    const route = decideRoute(facts);
    let nextIntent = 'continue';
    let desired: string[] = [];
    let speech = '';
    if (risks.some((r) => r.kind === 'coverage_question')) speech += '補償の可否やお支払いについては、この受付では確約できません。ご相談として担当にお伝えします。';
    if (risks.some((r) => r.kind === 'prompt_injection')) speech += 'そのご依頼にはお応えできません。受付を続けさせてください。';
    if (needs.some((n) => n.startsWith('契約情報の開示'))) speech += 'ご契約の詳しい情報は、この受付ではお伝えできません。';

    if (route.route === 'UNRESOLVED') {
      // 一部だけ申告されたけがの確認は安全上優先する
      const k = route.unresolved.includes('all_occupants_injury_checked') ? 'all_occupants_injury_checked' : ASK_ORDER_ELIG.find((x) => route.unresolved.includes(x)) ?? route.unresolved[0];
      nextIntent = `clarify_eligibility:${k}`;
      desired = route.unresolved;
      speech += QUESTION_TEXT[k] ?? '状況を教えていただけますか。';
    } else if (route.route === 'SELF_SERVICE') {
      const policyMatched = !ctx.missingForRegistration.includes('policy_match') || (!!(facts.policy_number.value || facts.vehicle_plate.value) && !!(facts.caller_name_kana.value || facts.callback_phone.value));
      const miss = missingForRegistration(facts, policyMatched);
      desired = miss;
      const k = ASK_ORDER_REG.find((x) => miss.includes(x));
      if (k) { nextIntent = `collect:${k}`; speech += QUESTION_TEXT[k]; }
      else { nextIntent = 'ready_for_confirmation'; }
    } else {
      nextIntent = 'handoff';
    }
    return {
      analysisId: ctx.analysisId,
      baseStateVersion: ctx.baseStateVersion,
      inputWatermark: ctx.inputWatermark,
      factProposals: proposals,
      scenarioHypotheses: [],
      riskSignals: risks,
      requestedRoute: route.route === 'OPERATOR_EMERGENCY' ? 'OPERATOR' : route.route,
      confirmationResponse,
      customerNeeds: needs,
      nextIntent,
      desiredInformation: desired,
      suggestedSpeech: speech,
      evidenceRefs: ctx.newUtteranceIds,
      briefReason: route.reasons.join(' / '),
      brain: this.name,
    };
  }
}

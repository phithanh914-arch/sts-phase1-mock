// 振り分け判定（REQUIREMENTS.md §3）。LLMではなくコードで行う安全・対象適合の検査。
// 未確認をfalseにしない：missing / explicitly_unknown / conflict は「未確認」として扱う。

import type { Fact, RouteDecision } from './types.js';

export type Tri = 'yes' | 'no' | 'unknown' | 'conflict';

export function tri(f: Fact | undefined): Tri {
  if (!f) return 'unknown';
  if (f.status === 'conflict') return 'conflict';
  if (f.status !== 'captured' && f.status !== 'confirmed') return 'unknown';
  if (f.value === true) return 'yes';
  if (f.value === false) return 'no';
  return 'unknown';
}

function enumVal(f: Fact | undefined): string {
  if (!f) return 'unknown';
  if (f.status === 'conflict') return 'conflict';
  if (f.status !== 'captured' && f.status !== 'confirmed') return 'unknown';
  return typeof f.value === 'string' ? f.value : 'unknown';
}

/** 自動完結の対象事案種別（allowlist）。将来追加は専用テストと合わせて行う。 */
export const SELF_SERVICE_KINDS = new Set(['collision']);
export const NON_ELIGIBLE_KINDS = new Set(['theft', 'vandalism', 'hit_and_run', 'breakdown', 'other']);

export function decideRoute(facts: Record<string, Fact>, opts: { clarifyAttemptsExceeded?: boolean } = {}): RouteDecision {
  const reasons: string[] = [];
  const unresolved: string[] = [];
  const safetyFlags: string[] = [];

  const emergency = tri(facts.emergency_signal);
  const unsafe = tri(facts.unsafe_to_continue_signal);
  const towing = tri(facts.towing_requested);
  const human = tri(facts.human_requested);
  const injuries = tri(facts.injuries_present);
  const allChecked = tri(facts.all_occupants_injury_checked);
  const other = tri(facts.other_person_or_vehicle_involved);
  const third = tri(facts.third_party_property_involved);
  const parked = tri(facts.parked_vehicle_unoccupied);
  const ownership = enumVal(facts.property_ownership);
  const kind = enumVal(facts.incident_kind);

  // 0. 緊急信号は通常の仕分けに優先
  if (emergency === 'yes') safetyFlags.push('EMERGENCY');
  if (unsafe === 'yes') safetyFlags.push('UNSAFE_TO_CONTINUE');
  if (emergency === 'yes' || unsafe === 'yes') {
    reasons.push(emergency === 'yes' ? '重大なけが・火災等の緊急信号' : '安全上の懸念（発煙等）');
    if (towing === 'yes') reasons.push('レッカー希望も同時に引継ぎ');
    return { route: 'OPERATOR_EMERGENCY', reasons, unresolved, safetyFlags };
  }
  // 1. 明確なレッカー希望（事故聴取・契約照合を待たない）
  if (towing === 'yes') {
    reasons.push('レッカー希望');
    if (injuries === 'yes') { reasons.push('けがあり（同時に引継ぎ）'); safetyFlags.push('INJURY'); }
    return { route: 'TOWING', reasons, unresolved, safetyFlags };
  }
  // 2. 有人希望
  if (human === 'yes') {
    reasons.push('有人対応の希望');
    return { route: 'OPERATOR', reasons, unresolved, safetyFlags };
  }
  // 3. 明確な非対象
  if (injuries === 'yes') { reasons.push('けが・痛みあり'); safetyFlags.push('INJURY'); }
  // 2026-11-06 方針変更（docs/decisions.md D-11）：公共物（電柱・ガードレール・標識等）と無人の駐車車両への接触は
  // 緊急性の低い物損としてSTS対象（警察届出を聴取。駐車車両は相手情報も聴取）。
  // 走行中・人が乗った相手車、歩行者・自転車、他人の塀・店舗の壁・借家、当て逃げは有人のまま。
  if (other === 'yes' && parked === 'no') reasons.push('他の人・走行中または人が乗った車の関与あり');
  if (ownership === 'third_party') reasons.push('他人の所有物（塀・壁等）への接触');
  if (NON_ELIGIBLE_KINDS.has(kind)) reasons.push(`自動完結対象外の事案種別: ${kind}`);
  if (reasons.length > 0) return { route: 'OPERATOR', reasons, unresolved, safetyFlags };

  // 4. 対象か不明 → 自然な追加確認
  if (towing !== 'no') unresolved.push('towing_requested');
  if (injuries !== 'no') unresolved.push('injuries_present');
  if (allChecked !== 'yes' && (injuries === 'no' || allChecked === 'no')) unresolved.push('all_occupants_injury_checked');
  if (other === 'yes' && parked !== 'yes') unresolved.push('parked_vehicle_unoccupied');
  else if (other !== 'yes' && other !== 'no') unresolved.push('other_person_or_vehicle_involved');
  const parkedOnly = other === 'yes' && parked === 'yes';
  // 無人の駐車車両に接触した場合、相手は車なので「物」の確認は不要（物にも当たったと申告されれば下で判定する）
  if (third !== 'no' && third !== 'yes' && !parkedOnly) unresolved.push('third_party_property_involved');
  // 接触物が公共物か他人の物か自己所有かで対象が変わるため、不明なら確認する（「家の塀」だけで自己所有と推測しない）
  if (third === 'yes' ? ownership !== 'public' : !(ownership === 'own' || ownership === 'none' || parkedOnly)) unresolved.push('property_ownership');
  if (!SELF_SERVICE_KINDS.has(kind)) unresolved.push('incident_kind');
  if (tri(facts.unsafe_to_continue_signal) === 'conflict') unresolved.push('unsafe_to_continue_signal');

  if (unresolved.length > 0) {
    if (opts.clarifyAttemptsExceeded) {
      return { route: 'OPERATOR', reasons: ['対象確認の試行上限超過'], unresolved, safetyFlags };
    }
    return { route: 'UNRESOLVED', reasons: ['対象条件が未確認'], unresolved, safetyFlags };
  }
  // 5. 対象条件を確認できた事案のみ
  const cp = third === 'yes' || ownership === 'public' || (other === 'yes' && parked === 'yes');
  return {
    route: 'SELF_SERVICE',
    reasons: [cp ? 'レッカー不要・けがなし（全員）・接触物は公共物/無人の駐車車両（警察届出、駐車車両は相手情報も聴取）' : 'レッカー不要・けがなし（全員）・相手人車なし・自己所有物/単独'],
    unresolved,
    safetyFlags,
  };
}

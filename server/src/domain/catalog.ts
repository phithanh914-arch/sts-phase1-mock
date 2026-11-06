// 受付項目の暫定カタログ（REQUIREMENTS.md §6）。
// 正式な項目・文字数・コード・不明許容は現行機械音声受付とRPA仕様で置き換える前提のモック定義。

export type FactType = 'bool' | 'text' | 'enum';

export interface FactDef {
  key: string;
  label: string;
  category: '安全/対象' | '相手/届出' | '連絡者' | '契約/事故車' | '日時' | '場所' | '事故状況' | '運転者' | '損害' | '終了/連絡';
  type: FactType;
  enumValues?: string[];
  /** 自動完結の対象判定に使う */
  eligibility?: boolean;
  /** 登録前に必要（captured/confirmed）。 */
  requiredForRegistration?: boolean;
  /** 条件付き必須。counterparty：無人の駐車車両に接触（相手情報）。property_damage：公共物または駐車車両に接触（警察届出） */
  requiredWhen?: 'counterparty' | 'property_damage';
  /** 「分からない」で登録してよい */
  unknownAllowed?: boolean;
  /** 読み上げ確認対象 */
  readback?: boolean;
}

export const INCIDENT_KINDS = ['collision', 'theft', 'vandalism', 'hit_and_run', 'breakdown', 'other', 'unknown'];
// public：電柱・ガードレール・標識等の公共物（D-11でSTS対象）。third_party：他人の塀・店舗の壁・借家等（有人）。
export const OWNERSHIP = ['own', 'public', 'third_party', 'none', 'unknown'];

export const CATALOG: FactDef[] = [
  // 安全/対象
  { key: 'emergency_signal', label: '重大なけが・火災等の緊急信号', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'unsafe_to_continue_signal', label: '安全上の懸念（発煙・走行に支障の破損等）', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'towing_requested', label: 'レッカー希望', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'physically_drivable', label: '走行可否（本人申告）', category: '安全/対象', type: 'bool' },
  { key: 'injuries_present', label: 'けが・痛み（本人・同乗者・関係者）', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'occupants', label: '乗車人数・同乗者', category: '安全/対象', type: 'text' },
  { key: 'all_occupants_injury_checked', label: '全乗員のけが有無を確認済み', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'other_person_or_vehicle_involved', label: '他の人・車の関与', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'parked_vehicle_unoccupied', label: '相手車は無人の駐車車両か（人が乗っていない）', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'third_party_property_involved', label: '第三者物・公共物への接触/損傷', category: '安全/対象', type: 'bool', eligibility: true },
  { key: 'property_ownership', label: '接触物の所有関係（自己所有/公共物/他人所有/なし）', category: '安全/対象', type: 'enum', enumValues: OWNERSHIP, eligibility: true },
  { key: 'incident_kind', label: '事案種別', category: '安全/対象', type: 'enum', enumValues: INCIDENT_KINDS, eligibility: true },
  { key: 'human_requested', label: '有人対応の希望', category: '安全/対象', type: 'bool', eligibility: true },
  // 相手/届出（D-11）。相手情報は無人の駐車車両に接触した場合のみ聴取（公共物は聞かない）。分からなければ「不明」で登録し、相手連絡要として扱う
  { key: 'counterparty_name', label: '相手（所有者・管理者）の名前・名称', category: '相手/届出', type: 'text', requiredWhen: 'counterparty', unknownAllowed: true, readback: true },
  { key: 'counterparty_address', label: '相手の住所', category: '相手/届出', type: 'text', requiredWhen: 'counterparty', unknownAllowed: true, readback: true },
  { key: 'counterparty_phone', label: '相手の連絡先電話番号', category: '相手/届出', type: 'text', requiredWhen: 'counterparty', unknownAllowed: true, readback: true },
  { key: 'police_reported', label: '警察への届出', category: '相手/届出', type: 'bool', requiredWhen: 'property_damage', unknownAllowed: true, readback: true },
  // 連絡者
  { key: 'caller_name_kana', label: '連絡者氏名（読み）', category: '連絡者', type: 'text', requiredForRegistration: true, readback: true },
  { key: 'callback_phone', label: '折返し電話番号', category: '連絡者', type: 'text', requiredForRegistration: true, readback: true },
  { key: 'caller_is_policyholder', label: '契約者本人か', category: '連絡者', type: 'bool' },
  // 契約/事故車
  { key: 'policy_number', label: '証券番号', category: '契約/事故車', type: 'text' },
  { key: 'vehicle_plate', label: '事故車の登録番号', category: '契約/事故車', type: 'text' },
  // 日時
  { key: 'accident_date', label: '事故発生日', category: '日時', type: 'text', requiredForRegistration: true, readback: true },
  { key: 'accident_time', label: '事故発生時刻', category: '日時', type: 'text', requiredForRegistration: true, unknownAllowed: true, readback: true },
  { key: 'time_approximate', label: '時刻は概算か', category: '日時', type: 'bool' },
  // 場所
  { key: 'municipality', label: '事故場所（都道府県・市区郡）', category: '場所', type: 'text', requiredForRegistration: true, readback: true },
  { key: 'location_detail', label: '場所の詳細（番地等）', category: '場所', type: 'text', unknownAllowed: true },
  // 事故状況
  { key: 'accident_description', label: '事故状況（何をして何に接触したか）', category: '事故状況', type: 'text', requiredForRegistration: true, readback: true },
  // 運転者
  { key: 'driver', label: '運転者（氏名または契約者/連絡者との関係）', category: '運転者', type: 'text', requiredForRegistration: true, readback: true },
  // 損害
  { key: 'damage', label: '損傷部位・内容', category: '損害', type: 'text', requiredForRegistration: true, readback: true },
  { key: 'repair_shop', label: '修理先', category: '損害', type: 'text', unknownAllowed: true },
  // 終了/連絡
  { key: 'sms_allowed', label: 'SMS送信可否', category: '終了/連絡', type: 'bool', requiredForRegistration: true, readback: true },
];

export const CATALOG_BY_KEY: Record<string, FactDef> = Object.fromEntries(CATALOG.map((d) => [d.key, d]));

export function isKnownKey(key: string): boolean {
  return key in CATALOG_BY_KEY;
}

export function validateValue(def: FactDef, value: unknown): boolean {
  if (value === null) return true;
  if (def.type === 'bool') return typeof value === 'boolean';
  if (def.type === 'enum') return typeof value === 'string' && (def.enumValues ?? []).includes(value);
  return typeof value === 'string' && value.length > 0 && value.length <= 400;
}

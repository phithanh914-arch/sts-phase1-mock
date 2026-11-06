import { createHash, randomUUID } from 'node:crypto';
import { CATALOG, CATALOG_BY_KEY } from './catalog.js';
import type { ClaimSnapshot, Fact } from './types.js';

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function makeSnapshot(facts: Record<string, Fact>, version: number, policyRef: string | null): ClaimSnapshot {
  const f: ClaimSnapshot['facts'] = {};
  for (const d of CATALOG) {
    const x = facts[d.key];
    if (x.status === 'missing') continue;
    f[d.key] = { value: x.value, status: x.status };
  }
  const body = { version, policyRef, facts: f };
  return {
    snapshotId: `SNAP-${randomUUID().slice(0, 8)}`,
    version,
    hash: sha256(stableStringify(body)),
    facts: f,
    policyRef,
    createdAt: new Date().toISOString(),
  };
}

function show(key: string, s: ClaimSnapshot): string {
  const x = s.facts[key];
  if (!x) return '未確認';
  if (x.status === 'explicitly_unknown') return '不明';
  if (typeof x.value === 'boolean') {
    if (key === 'sms_allowed') return x.value ? 'SMS送信可' : 'SMS送信不可';
    return x.value ? 'はい' : 'いいえ';
  }
  return String(x.value);
}

/** 顧客への最終内容確認の読上げ文。コードで生成し、確認対象スナップショットと1対1に結び付ける。 */
export function buildReadback(s: ClaimSnapshot): string {
  const items = CATALOG.filter((d) => d.readback).map((d) => {
    if (d.key === 'accident_time') {
      const approx = s.facts.time_approximate?.value === true ? 'ごろ' : '';
      return `時刻：${show(d.key, s)}${approx}`;
    }
    return `${shortLabel(d.key)}：${show(d.key, s)}`;
  });
  return `内容を確認します。${items.join('、')}。以上でお間違いないでしょうか。`;
}

function shortLabel(key: string): string {
  const map: Record<string, string> = {
    caller_name_kana: 'お名前',
    callback_phone: '折返しのお電話番号',
    accident_date: '事故日',
    municipality: '場所',
    accident_description: '状況',
    driver: '運転者',
    damage: '損傷',
    sms_allowed: 'SMS',
  };
  return map[key] ?? CATALOG_BY_KEY[key]?.label ?? key;
}

/**
 * RpaPayloadMapper（モック独自形式 mock-rpa-v0.1）。
 * LLMに列や形式を決めさせず、確定スナップショットから検証可能な変換で作る。既存RPAの正式仕様ではない。
 */
export const SCHEMA_VERSION = 'mock-rpa-v0.1';
export const MAPPING_VERSION = 'mock-mapping-v0.1';

export interface MapResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  fieldErrors: string[];
}

export function mapToRpaPayload(s: ClaimSnapshot): MapResult {
  const errors: string[] = [];
  const v = (k: string) => s.facts[k];
  const str = (k: string, required = true): string | null => {
    const x = v(k);
    if (!x || x.status === 'explicitly_unknown') {
      if (required) errors.push(`${k}: missing`);
      return null;
    }
    return typeof x.value === 'string' ? x.value : String(x.value);
  };
  const bool = (k: string): boolean | null => {
    const x = v(k);
    return x && typeof x.value === 'boolean' ? x.value : null;
  };
  const date = str('accident_date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('accident_date: format');
  const time = v('accident_time')?.status === 'explicitly_unknown' ? null : str('accident_time');
  if (time && !/^\d{2}:\d{2}$/.test(time)) errors.push('accident_time: format');
  const phone = str('callback_phone');
  if (phone && !/^\d{10,11}$/.test(phone)) errors.push('callback_phone: format');
  if (!s.policyRef) errors.push('policy_ref: missing');
  const sms = bool('sms_allowed');
  if (sms === null) errors.push('sms_allowed: missing');

  const payload = {
    mock_only: true,
    policy_ref: s.policyRef,
    caller: { name_kana: str('caller_name_kana'), callback_phone: phone },
    accident: {
      occurred_date: date,
      occurred_time: time,
      time_approximate: bool('time_approximate') ?? false,
      municipality: str('municipality'),
      location_detail: str('location_detail', false),
      description: str('accident_description'),
    },
    eligibility: {
      towing_requested: bool('towing_requested'),
      injuries_present: bool('injuries_present'),
      other_person_or_vehicle_involved: bool('other_person_or_vehicle_involved'),
      third_party_property_involved: bool('third_party_property_involved'),
    },
    driver: str('driver'),
    vehicle: { plate: str('vehicle_plate', false), damage: str('damage') },
    repair_shop: str('repair_shop', false),
    contact: { sms_allowed: sms },
  };
  return { ok: errors.length === 0, payload, fieldErrors: errors };
}

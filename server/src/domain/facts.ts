import { CATALOG, CATALOG_BY_KEY, validateValue } from './catalog.js';
import type { Fact, FactOrigin, FactStatus, FactValue } from './types.js';

export interface FactProposal {
  key: string;
  value: FactValue;
  status: 'captured' | 'explicitly_unknown' | 'conflict';
  originalExpression?: string;
  evidenceRefs: string[];
  /** 訂正であることをBrainが認識しているか */
  isCorrection?: boolean;
}

export function emptyFacts(): Record<string, Fact> {
  const out: Record<string, Fact> = {};
  for (const d of CATALOG) {
    out[d.key] = {
      key: d.key,
      value: null,
      status: 'missing',
      origin: 'customer',
      evidenceRefs: [],
      lastUpdatedVersion: 0,
      history: [],
    };
  }
  return out;
}

export interface ValidationIssue {
  key: string;
  issue: string;
}

/** Brainの提案を型・根拠・カタログで検証する。証跡の存在は意味の正しさの保証ではない。 */
export function validateProposal(p: FactProposal, knownUtteranceIds: Set<string>): ValidationIssue | null {
  const def = CATALOG_BY_KEY[p.key];
  if (!def) return { key: p.key, issue: 'unknown_key' };
  if (p.status === 'captured' && !validateValue(def, p.value)) return { key: p.key, issue: 'invalid_value' };
  if (p.status === 'captured' && p.value === null) return { key: p.key, issue: 'null_value_for_captured' };
  if (p.status === 'explicitly_unknown' && !def.unknownAllowed && def.requiredForRegistration) {
    // 不明許容でない必須項目の「分からない」も保持はする（無限聞き直しを避け、有人引継ぎ判断に使う）
  }
  if (!p.evidenceRefs || p.evidenceRefs.length === 0) return { key: p.key, issue: 'no_evidence' };
  if (p.evidenceRefs.some((r) => !knownUtteranceIds.has(r))) return { key: p.key, issue: 'unknown_evidence_ref' };
  return null;
}

/** 提案を適用。値が変わった項目のキーを返す（同値は変更扱いにしない）。 */
export function applyProposal(
  facts: Record<string, Fact>,
  p: FactProposal,
  version: number,
  origin: FactOrigin = 'customer',
  reason = 'brain_proposal',
): boolean {
  const f = facts[p.key];
  const newStatus: FactStatus = p.status;
  const same = f.value === p.value && f.status === newStatus;
  if (same) {
    f.evidenceRefs = Array.from(new Set([...f.evidenceRefs, ...p.evidenceRefs]));
    return false;
  }
  if (f.status !== 'missing') {
    f.history.push({
      value: f.value,
      status: f.status,
      originalExpression: f.originalExpression,
      evidenceRefs: f.evidenceRefs,
      version: f.lastUpdatedVersion,
      at: new Date().toISOString(),
      reason: p.isCorrection ? 'superseded_by_correction' : `superseded(${reason})`,
    });
  }
  f.value = p.status === 'captured' ? p.value : null;
  f.status = newStatus;
  f.origin = origin;
  f.evidenceRefs = p.evidenceRefs;
  f.originalExpression = p.originalExpression;
  f.lastUpdatedVersion = version;
  return true;
}

export function factsForPrompt(facts: Record<string, Fact>): Record<string, { value: FactValue; status: FactStatus; original?: string }> {
  const out: Record<string, { value: FactValue; status: FactStatus; original?: string }> = {};
  for (const [k, f] of Object.entries(facts)) {
    if (f.status === 'missing') continue;
    out[k] = { value: f.value, status: f.status, original: f.originalExpression };
  }
  return out;
}

const yes = (f: Fact | undefined) => !!f && (f.status === 'captured' || f.status === 'confirmed') && f.value === true;

/** 無人の駐車車両に接触した事故か（相手の名前・住所・連絡先を聴取する） */
export function counterpartyInvolved(facts: Record<string, Fact>): boolean {
  return yes(facts.other_person_or_vehicle_involved) && yes(facts.parked_vehicle_unoccupied);
}

/** 公共物または駐車車両に接触した物損事故か（警察届出を聴取する） */
export function propertyDamageInvolved(facts: Record<string, Fact>): boolean {
  const own = facts.property_ownership;
  const isPublic = !!own && (own.status === 'captured' || own.status === 'confirmed') && own.value === 'public';
  return counterpartyInvolved(facts) || isPublic || yes(facts.third_party_property_involved);
}

export function isRequired(d: (typeof CATALOG)[number], facts: Record<string, Fact>): boolean {
  if (d.requiredForRegistration) return true;
  if (d.requiredWhen === 'counterparty') return counterpartyInvolved(facts);
  if (d.requiredWhen === 'property_damage') return propertyDamageInvolved(facts);
  return false;
}

/** 登録前必須項目のうち未充足のもの */
export function missingForRegistration(facts: Record<string, Fact>, policyMatched: boolean): string[] {
  const missing: string[] = [];
  for (const d of CATALOG) {
    if (!isRequired(d, facts)) continue;
    const f = facts[d.key];
    const ok = f.status === 'captured' || f.status === 'confirmed' || (f.status === 'explicitly_unknown' && d.unknownAllowed);
    if (!ok) missing.push(d.key);
  }
  if (!policyMatched) missing.push('policy_match');
  return missing;
}

/** 必須なのに「分からない」と明言され、通話中に解消できない項目 */
export function unresolvableRequired(facts: Record<string, Fact>): string[] {
  return CATALOG.filter((d) => isRequired(d, facts) && !d.unknownAllowed && facts[d.key].status === 'explicitly_unknown').map((d) => d.key);
}

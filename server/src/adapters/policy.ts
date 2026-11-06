// PolicyAdapter（模擬）。架空契約データのみ。
// 「契約情報2項目以上一致」は契約の検索/特定の基準であり、本人認証・情報開示許可ではない（REQUIREMENTS §6）。

export interface MockPolicy {
  policyRef: string;
  policyNumber: string;
  holderNameKana: string;
  phone: string;
  plate: string;
  // 以下は開示禁止の架空属性（T19のテスト用）
  address: string;
  birthDate: string;
}

const POLICIES: MockPolicy[] = [
  { policyRef: 'MOCK-POLICY-001', policyNumber: 'MOCK001', holderNameKana: 'テスト イチロウ', phone: '00000000001', plate: '品川300あ0001', address: '（架空）東京都千代田区', birthDate: '1980-01-01' },
  { policyRef: 'MOCK-POLICY-002', policyNumber: 'MOCK002', holderNameKana: 'テスト ハナコ', phone: '00000000002', plate: '横浜500い0002', address: '（架空）神奈川県横浜市', birthDate: '1990-02-02' },
];

export interface PolicyQuery {
  policyNumber?: string | null;
  holderNameKana?: string | null;
  phone?: string | null;
  plate?: string | null;
}

export interface AuthorizationContext {
  /** モックでは本人認証を実装しないため常にfalse */
  identityVerified: boolean;
}

export interface PolicyLookupResult {
  matched: boolean;
  policyRef: string | null;
  matchedItems: string[];
  /** 開示可能な情報。本人認証前は空。 */
  disclosable: Record<string, string>;
  lookupId: string;
}

const norm = (s?: string | null) => (s ?? '').replace(/[\s\u3000\-ー]/g, '').toUpperCase();

let seq = 0;
export const PolicyAdapter = {
  lookup(q: PolicyQuery, auth: AuthorizationContext): PolicyLookupResult {
    const lookupId = `POLICY-LOOKUP-${++seq}`;
    let best: { p: MockPolicy; items: string[] } | null = null;
    for (const p of POLICIES) {
      const items: string[] = [];
      if (q.policyNumber && norm(q.policyNumber) === norm(p.policyNumber)) items.push('policy_number');
      if (q.holderNameKana && norm(q.holderNameKana) === norm(p.holderNameKana)) items.push('holder_name_kana');
      if (q.phone && norm(q.phone) === norm(p.phone)) items.push('phone');
      if (q.plate && norm(q.plate) === norm(p.plate)) items.push('plate');
      if (!best || items.length > best.items.length) best = { p, items };
    }
    const matched = !!best && best.items.length >= 2;
    return {
      matched,
      policyRef: matched ? best!.p.policyRef : null,
      matchedItems: matched ? best!.items : [],
      // 住所・生年月日等は本人認証と開示ルールを満たすまで返さない（モックでは常に満たさない）
      disclosable: auth.identityVerified && matched ? { policyRef: best!.p.policyRef } : {},
      lookupId,
    };
  },
};

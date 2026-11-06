// ActionGate：外部操作・完了表示の権限条件をコードで検査する（REQUIREMENTS §5.1, §9.3, §10）。
// LLMの提案やユーザー発話はここを迂回できない。

import { makeSnapshot } from '../domain/snapshot.js';
import { missingForRegistration } from '../domain/facts.js';
import type { Conversation } from '../session/conversation.js';

export interface GateResult {
  allowed: boolean;
  reasons: string[];
}

const ok = (): GateResult => ({ allowed: true, reasons: [] });
const deny = (...reasons: string[]): GateResult => ({ allowed: false, reasons });

export const ActionGate = {
  canPrepareConfirmation(c: Conversation): GateResult {
    const r: string[] = [];
    if (c.route.route !== 'SELF_SERVICE') r.push(`route=${c.route.route}`);
    if (c.route.safetyFlags.length) r.push('未解決の安全信号');
    const miss = missingForRegistration(c.facts, c.policy.matched);
    if (miss.length) r.push(`不足: ${miss.join(',')}`);
    if (c.callState !== 'ACTIVE') r.push(`call=${c.callState}`);
    if (['QUEUED', 'RUNNING', 'REGISTERED', 'OUTCOME_UNKNOWN'].includes(c.registrationState)) r.push(`registration=${c.registrationState}`);
    if (c.amendmentPending) r.push('訂正待ち（有人処理）');
    return r.length ? deny(...r) : ok();
  },

  /** 顧客の同意を記録してよいか。無音・タイマー・質問の発話だけでは同意にしない。 */
  canAcceptConfirmation(c: Conversation, factsChangedInThisAnalysis: boolean, hasUnanalyzedInput: boolean): GateResult {
    const cf = c.confirmation;
    const r: string[] = [];
    if (!cf || cf.status !== 'PENDING') r.push('確認待ちの読上げがない');
    else {
      if (cf.snapshotVersion !== c.version) r.push('確認版が最新版ではない');
      if (!cf.readbackDelivered) r.push('読上げが実際に出力されたことを確認できない');
    }
    if (factsChangedInThisAnalysis) r.push('同じ発話で内容の変更あり（訂正として扱う）');
    if (hasUnanalyzedInput) r.push('未分析の後続発話あり');
    if (c.route.route !== 'SELF_SERVICE') r.push(`route=${c.route.route}`);
    return r.length ? deny(...r) : ok();
  },

  canSubmitRegistration(c: Conversation): GateResult {
    const r: string[] = [];
    const cf = c.confirmation;
    if (!cf || cf.status !== 'ACCEPTED') r.push('同意済み確認がない');
    else {
      const cur = makeSnapshot(c.facts, c.version, c.policy.policyRef);
      if (cf.snapshotHash !== cur.hash) r.push('同意したスナップショットと現在の内容が一致しない');
    }
    if (c.route.route !== 'SELF_SERVICE') r.push(`route=${c.route.route}`);
    if (c.route.safetyFlags.length) r.push('未解決の安全信号');
    if (!c.policy.matched) r.push('契約未特定');
    if (c.activeJobId) {
      const st = c.registrationState;
      if (['QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN', 'REGISTERED'].includes(st)) r.push(`同じ受付の登録要求が ${st}`);
    }
    if (c.analysisInFlight) r.push('並行分析が実行中');
    return r.length ? deny(...r) : ok();
  },

  /** 「受付登録完了」を案内してよいか：照合済みのRegistrationResultに限定 */
  canAnnounceComplete(c: Conversation): GateResult {
    const job = c.activeJob();
    if (!job || job.state !== 'REGISTERED' || !job.result?.readback_verified) return deny('照合済み登録結果がない');
    if (c.amendmentPending) return deny('登録後に訂正あり（有人処理）');
    return ok();
  },

  /** 契約情報の開示：モックでは本人認証を実装しないため常に不可 */
  canDisclosePolicyDetails(c: Conversation): GateResult {
    void c;
    return deny('本人認証が未実装（2項目一致は本人認証ではない）');
  },
};

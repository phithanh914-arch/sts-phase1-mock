// SessionController：テキスト入力と音声入力で共通の業務処理。
// Brainの提案 → Validation → 振り分け再判定 → ActionGate → 各Adapter の順に処理する。
// 固定のnext_fieldキューは持たない（次の会話目的はBrainが選ぶ）。

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyProposal, factsForPrompt, missingForRegistration, unresolvableRequired, validateProposal } from '../domain/facts.js';
import { decideRoute } from '../domain/routing.js';
import { buildReadback, MAPPING_VERSION, makeSnapshot, mapToRpaPayload, SCHEMA_VERSION } from '../domain/snapshot.js';
import type { Confirmation, Utterance } from '../domain/types.js';
import { PolicyAdapter } from '../adapters/policy.js';
import { createRpaAdapter, MockCore, newJobId, type JobRecord, type RpaJob } from '../adapters/rpa.js';
import { createTelephonyAdapter, type HandoffPackage, type TransferTarget } from '../adapters/telephony.js';
import { defaultFaults, type FaultConfig } from '../adapters/faults.js';
import { ActionGate } from '../gate/actionGate.js';
import type { ReceptionBrain, ReceptionPlan } from '../brain/types.js';
import { Conversation, type AnalysisRecord } from './conversation.js';

export type SpeechKind = 'greeting' | 'question' | 'readback' | 'handoff' | 'emergency' | 'registration' | 'notice';

export interface SpeechDirective {
  kind: SpeechKind;
  text: string;
  /** true: 文言どおりに話させる（ゲート済みの案内・読上げ）。false: 言い換え可。 */
  exact: boolean;
  tag?: string;
}

export interface SpeechSink {
  /** delegationIdがあれば、そのdelegationへの結果として返す */
  deliver(conv: Conversation, d: SpeechDirective, delegationId: string | null, solicited: boolean): void;
  /** 話させずに背景情報を渡す（Live用。テキストモードでは何もしない） */
  context?(conv: Conversation, summary: string, delegationId: string | null): void;
}

export interface ControllerOptions {
  brains: Record<string, ReceptionBrain>;
  defaultBrain: string;
  dataDir?: string | null;
  brainTimeoutMs?: number;
  callWaitLimitMs?: number;
  maxClarify?: number;
  today?: () => string;
}

const POLICY_KEYS = new Set(['policy_number', 'vehicle_plate', 'caller_name_kana', 'callback_phone']);

export const GREETING = '事故受付のAIです。まず、レッカーの手配は必要でしょうか。';

export function todayJST(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export class SessionController {
  readonly conversations = new Map<string, Conversation>();
  readonly core = new MockCore();
  faults: FaultConfig = defaultFaults();
  readonly rpa;
  readonly telephony;
  private sinks = new Map<string, SpeechSink>();
  private listeners = new Map<string, Set<(c: Conversation) => void>>();
  private rerun = new Map<string, { trigger: string; delegationIds: string[] }>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private opts: Required<Omit<ControllerOptions, 'dataDir'>> & { dataDir: string | null };

  constructor(opts: ControllerOptions) {
    this.opts = {
      brainTimeoutMs: 20000,
      callWaitLimitMs: 20000,
      maxClarify: 6,
      today: todayJST,
      dataDir: null,
      ...opts,
    } as typeof this.opts;
    if (this.opts.dataDir) mkdirSync(this.opts.dataDir, { recursive: true });
    const jobs = new Map<string, JobRecord>();
    this.rpa = createRpaAdapter({
      core: this.core,
      getFaults: () => this.faults,
      onUpdate: (rec) => this.onJobUpdate(rec),
      isStillValid: (job) => {
        const c = this.conversations.get(job.conversation_id);
        return !!c && c.activeJobId === job.job_id && c.version === job.source_version && !c.amendmentPending && c.route.route === 'SELF_SERVICE';
      },
    });
    void jobs;
    this.telephony = createTelephonyAdapter(() => this.faults);
  }

  // ───────── 会話の生成・購読 ─────────
  create(mode: 'text' | 'live', sink: SpeechSink, brainName?: string): Conversation {
    const name = brainName && this.opts.brains[brainName] ? brainName : this.opts.defaultBrain;
    const c = new Conversation(`CONV-${randomUUID().slice(0, 8)}`, `MOCK-CLAIM-${randomUUID().slice(0, 8)}`, mode, name, this.rpa.jobs);
    this.conversations.set(c.id, c);
    this.sinks.set(c.id, sink);
    c.log('conversation_created', { mode, brain: name });
    if (mode === 'text') this.speak(c, { kind: 'greeting', text: GREETING, exact: true }, null, true);
    this.changed(c);
    return c;
  }

  setSink(c: Conversation, sink: SpeechSink) { this.sinks.set(c.id, sink); }

  subscribe(id: string, fn: (c: Conversation) => void): () => void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(fn);
    return () => this.listeners.get(id)?.delete(fn);
  }

  changed(c: Conversation) {
    for (const fn of this.listeners.get(c.id) ?? []) {
      try { fn(c); } catch { /* ignore */ }
    }
    if (this.opts.dataDir) {
      clearTimeout(this.saveTimers.get(c.id));
      this.saveTimers.set(c.id, setTimeout(() => {
        try { writeFileSync(join(this.opts.dataDir!, `${c.id}.json`), JSON.stringify(c, null, 1)); } catch { /* ignore */ }
      }, 300));
    }
  }

  // ───────── 発話 ─────────
  addUtterance(c: Conversation, u: Omit<Utterance, 'id' | 'at'> & { at?: string }): Utterance {
    const utt: Utterance = { id: c.nextId(u.speaker === 'customer' ? 'U' : u.speaker === 'ai' ? 'A' : 'S'), at: u.at ?? new Date().toISOString(), ...u };
    c.utterances.push(utt);
    this.changed(c);
    return utt;
  }

  /** 顧客発話を追加し分析を要求（テキスト入力） */
  async customerSays(c: Conversation, text: string): Promise<void> {
    if (c.callState === 'ENDED') throw new Error('call ended');
    this.addUtterance(c, { speaker: 'customer', text, kind: 'input', source: 'text' });
    await this.requestAnalysis(c, 'text_input', null);
  }

  /** AIが実際に話した（Live出力transcriptやテキスト表示） */
  aiSpoke(c: Conversation, text: string, source: 'text' | 'live', tag?: string, startMs?: number, endMs?: number) {
    this.addUtterance(c, { speaker: 'ai', text, kind: 'spoken', source, tag, startMs, endMs });
  }

  markReadbackDelivered(c: Conversation, confirmationId: string) {
    if (c.confirmation && c.confirmation.confirmationId === confirmationId && c.confirmation.status === 'PENDING') {
      c.confirmation.readbackDelivered = true;
      c.log('readback_delivered', { confirmationId });
      this.changed(c);
    }
  }

  private speak(c: Conversation, d: SpeechDirective, delegationId: string | null, solicited: boolean) {
    const sink = this.sinks.get(c.id);
    c.log('speech_directive', { ...d, delegationId });
    sink?.deliver(c, d, delegationId, solicited);
    if (c.mode === 'text' && d.kind === 'readback' && c.confirmation) this.markReadbackDelivered(c, c.confirmation.confirmationId);
    this.changed(c);
  }

  // ───────── 分析（直列化・世代管理） ─────────
  async requestAnalysis(c: Conversation, trigger: string, delegationId: string | null): Promise<void> {
    if (c.analysisInFlight) {
      const r = this.rerun.get(c.id) ?? { trigger, delegationIds: [] };
      if (delegationId) r.delegationIds.push(delegationId);
      this.rerun.set(c.id, r);
      c.log('analysis_queued', { trigger, delegationId });
      return;
    }
    const pending = c.unanalyzedCustomerUtterances();
    if (pending.length === 0) {
      // 新しい入力がない委任：現状の会話目的をそのまま返す
      if (delegationId) this.respondCurrent(c, delegationId);
      return;
    }
    const brain = this.opts.brains[c.brainName];
    const rec: AnalysisRecord = {
      analysisId: c.nextId('AN'),
      baseStateVersion: c.version,
      inputWatermark: pending[pending.length - 1].id,
      trigger,
      delegationId,
      status: 'running',
      startedAt: new Date().toISOString(),
      brain: brain.name,
    };
    c.analyses.push(rec);
    c.analysisInFlight = true;
    this.changed(c);
    const t0 = Date.now();
    const ctx = {
      analysisId: rec.analysisId,
      baseStateVersion: rec.baseStateVersion,
      inputWatermark: rec.inputWatermark,
      transcript: c.utterances.filter((u) => u.kind !== 'planned' && u.kind !== 'notice' && c.utterances.indexOf(u) <= c.utterances.findIndex((x) => x.id === rec.inputWatermark)),
      newUtteranceIds: pending.map((u) => u.id),
      facts: factsForPrompt(c.facts),
      route: c.route.route,
      routeReasons: c.route.reasons,
      unresolvedEligibility: c.route.unresolved,
      missingForRegistration: missingForRegistration(c.facts, c.policy.matched),
      pendingConfirmation: c.confirmation?.status === 'PENDING' ? { confirmationId: c.confirmation.confirmationId, readbackText: c.confirmation.readbackText } : null,
      callState: c.callState,
      receptionState: c.receptionState,
      registrationState: c.registrationState,
      today: this.opts.today(),
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), this.opts.brainTimeoutMs); });
    const work = brain.analyze(ctx).then(
      (plan) => ({ plan }),
      (err: unknown) => ({ err: err instanceof Error ? err.message : String(err) }),
    );
    // 後着結果の扱い（タイムアウト後に届いた結果は適用しない）
    void work.then((r) => {
      if (rec.status === 'timed_out') {
        rec.status = 'late_discarded';
        if ('plan' in r) rec.plan = r.plan;
        c.log('late_result_discarded', { analysisId: rec.analysisId, base: rec.baseStateVersion, current: c.version });
        this.changed(c);
      }
    });
    const result = await Promise.race([work, timeout]);
    clearTimeout(timer);
    rec.latencyMs = Date.now() - t0;
    c.analysisInFlight = false;
    if (result === 'timeout') {
      rec.status = 'timed_out';
      c.log('analysis_timeout', { analysisId: rec.analysisId });
      // 入力は未分析のまま残す（watermarkを進めない）。応答は遅延のお詫びのみ。
      this.speak(c, { kind: 'notice', text: '少々お待ちください。もう一度お話しいただけますか。', exact: false }, delegationId, true);
    } else if ('err' in result) {
      rec.status = 'error';
      rec.error = result.err;
      c.log('analysis_error', { analysisId: rec.analysisId, error: result.err });
      this.speak(c, { kind: 'notice', text: '申し訳ありません、もう一度お話しいただけますか。', exact: false }, delegationId, true);
    } else {
      this.applyPlan(c, rec, result.plan);
    }
    this.changed(c);
    const again = this.rerun.get(c.id);
    if (again) {
      this.rerun.delete(c.id);
      const [first, ...rest] = again.delegationIds;
      await this.requestAnalysis(c, `rerun:${again.trigger}`, first ?? null);
      for (const d of rest) this.respondCurrent(c, d);
    }
  }

  /** 古い世代の結果を無条件に適用しない */
  applyPlan(c: Conversation, rec: AnalysisRecord, plan: ReceptionPlan) {
    rec.plan = plan;
    if (plan.baseStateVersion !== c.version) {
      rec.status = 'stale_discarded';
      c.log('stale_plan_discarded', { analysisId: rec.analysisId, base: plan.baseStateVersion, current: c.version });
      this.rerun.set(c.id, { trigger: 'stale_reevaluate', delegationIds: rec.delegationId ? [rec.delegationId] : [] });
      return;
    }
    rec.status = 'applied';
    const known = new Set(c.utterances.filter((u) => u.speaker === 'customer').map((u) => u.id));
    const rejected: { key: string; issue: string }[] = [];
    const changedKeys: string[] = [];
    const newVersion = c.version + 1;
    const prevRoute = c.route.route;
    for (const p of plan.factProposals) {
      const issue = validateProposal(p, known);
      if (issue) { rejected.push(issue); continue; }
      if (applyProposal(c.facts, p, newVersion)) changedKeys.push(p.key);
    }
    rec.rejectedProposals = rejected;
    rec.changedKeys = changedKeys;
    if (changedKeys.length) c.version = newVersion;
    c.watermark = rec.inputWatermark;
    c.nextIntent = plan.nextIntent;
    c.desiredInformation = plan.desiredInformation;
    c.lastBriefReason = plan.briefReason;
    for (const n of plan.customerNeeds) if (!c.customerNeeds.includes(n)) c.customerNeeds.push(n);
    for (const r of plan.riskSignals) c.riskLog.push({ at: new Date().toISOString(), kind: r.kind, note: r.note });
    if (plan.riskSignals.some((r) => r.kind === 'prompt_injection')) c.log('prompt_injection_ignored', plan.riskSignals.filter((r) => r.kind === 'prompt_injection'));

    // 契約照会（2項目一致は特定基準であり本人認証ではない）
    if (changedKeys.some((k) => POLICY_KEYS.has(k))) this.lookupPolicy(c);

    // 振り分け再判定
    c.clarifyCount = this.recomputeRoute(c, true);
    const routeChanged = prevRoute !== c.route.route;
    if (routeChanged) c.log('route_changed', { from: prevRoute, to: c.route.route, reasons: c.route.reasons });

    const directives: SpeechDirective[] = [];

    // 内容変更による確認・登録権限の失効
    if (changedKeys.length) this.onFactsChanged(c, changedKeys, directives);

    // 転送が必要なルート
    if (['TOWING', 'OPERATOR', 'OPERATOR_EMERGENCY'].includes(c.route.route)) {
      this.ensureTransfer(c, directives);
    } else if (c.callState === 'ACTIVE') {
      // 確認応答
      if (c.confirmation?.status === 'PENDING' && plan.confirmationResponse !== 'none') {
        this.handleConfirmationResponse(c, plan.confirmationResponse, changedKeys.length > 0, directives, plan.evidenceRefs);
      }
      // 契約未特定・必須不明 → 有人引継ぎ
      if (c.route.route === 'SELF_SERVICE' && c.receptionState !== 'CONFIRMED') this.checkHandoffPending(c, directives);
      // 確認の準備
      if (!directives.length && c.receptionState !== 'HANDOFF_PENDING') this.maybePrepareConfirmation(c, directives);
    }
    if (c.route.route === 'UNRESOLVED' && c.receptionState === 'DRAFT') c.receptionState = 'NEEDS_CLARIFICATION';
    if (c.route.route === 'SELF_SERVICE' && c.receptionState === 'NEEDS_CLARIFICATION') c.receptionState = 'DRAFT';

    if (!directives.length) {
      if (c.callState === 'TRANSFER_REQUESTED') directives.push({ kind: 'handoff', text: 'ただいま担当者におつなぎしています。少々お待ちください。', exact: false });
      else if (plan.suggestedSpeech) directives.push({ kind: 'question', text: plan.suggestedSpeech, exact: false });
    }
    const delegationId = rec.delegationId;
    directives.forEach((d, i) => this.speak(c, d, i === 0 ? delegationId : null, i === 0 && !!delegationId || c.mode === 'text'));
    this.sinks.get(c.id)?.context?.(c, this.contextSummary(c), null);
  }

  private recomputeRoute(c: Conversation, countClarify: boolean): number {
    let n = c.clarifyCount;
    const pre = decideRoute(c.facts);
    if (countClarify) n = pre.route === 'UNRESOLVED' ? n + 1 : 0;
    c.route = decideRoute(c.facts, { clarifyAttemptsExceeded: n > this.opts.maxClarify });
    return n;
  }

  private lookupPolicy(c: Conversation) {
    const v = (k: string) => (c.facts[k].status === 'captured' || c.facts[k].status === 'confirmed' ? String(c.facts[k].value) : null);
    const r = PolicyAdapter.lookup({ policyNumber: v('policy_number'), plate: v('vehicle_plate'), holderNameKana: v('caller_name_kana'), phone: v('callback_phone') }, { identityVerified: false });
    c.policy = { matched: r.matched, policyRef: r.policyRef, matchedItems: r.matchedItems, lookupId: r.lookupId };
    c.log('policy_lookup', { matched: r.matched, matchedItems: r.matchedItems, lookupId: r.lookupId, disclosed: Object.keys(r.disclosable) });
  }

  private onFactsChanged(c: Conversation, changedKeys: string[], directives: SpeechDirective[]) {
    const cf = c.confirmation;
    if (cf && cf.status === 'PENDING' && cf.snapshotVersion !== c.version) {
      this.invalidateConfirmation(c, `facts_changed:${changedKeys.join(',')}`);
    }
    const job = c.activeJob();
    if (cf && cf.status === 'ACCEPTED' && cf.snapshotVersion !== c.version) {
      // 同意後の変更は再確認が必要
      this.invalidateConfirmation(c, `changed_after_confirmation:${changedKeys.join(',')}`);
      c.receptionState = 'DRAFT';
    }
    if (job) {
      if (job.state === 'QUEUED') {
        this.rpa.cancel(job.job.job_id, 'correction_before_start');
        c.log('job_cancelled_for_correction', { jobId: job.job.job_id });
      } else if (job.state === 'RUNNING') {
        this.rpa.cancel(job.job.job_id, 'correction_while_running');
        c.amendmentPending = true; // 停止結果を確認するまで訂正待ち
        c.log('correction_while_running', { jobId: job.job.job_id });
        directives.push({ kind: 'notice', text: '訂正を承りました。登録処理を止められたか確認していますので、少々お待ちください。', exact: false });
      } else if (job.state === 'REGISTERED' || job.state === 'OUTCOME_UNKNOWN') {
        c.amendmentPending = true;
        c.receptionState = 'HANDOFF_PENDING';
        c.log('correction_after_registration', { jobId: job.job.job_id, state: job.state });
        directives.push({ kind: 'notice', text: '訂正を承りました。登録済みの内容の訂正は担当者が対応します。二重に登録することはありません。', exact: false });
      }
    }
  }

  private invalidateConfirmation(c: Conversation, reason: string) {
    if (!c.confirmation) return;
    if (c.confirmation.status === 'PENDING' || c.confirmation.status === 'ACCEPTED') {
      c.confirmation.status = 'INVALIDATED';
      c.confirmation.invalidatedReason = reason;
      c.log('confirmation_invalidated', { confirmationId: c.confirmation.confirmationId, reason });
    }
    if (c.receptionState === 'READY_FOR_CONFIRMATION') c.receptionState = 'DRAFT';
  }

  private handleConfirmationResponse(c: Conversation, resp: string, factsChanged: boolean, directives: SpeechDirective[], evidence: string[]) {
    const cf = c.confirmation!;
    if (resp === 'affirm') {
      const g = ActionGate.canAcceptConfirmation(c, factsChanged, c.unanalyzedCustomerUtterances().length > 0);
      if (!g.allowed) { c.log('confirmation_rejected_by_gate', g.reasons); return; }
      cf.status = 'ACCEPTED';
      cf.evidenceRefs = evidence;
      c.receptionState = 'CONFIRMED';
      c.log('user_confirmation_recorded', { confirmationId: cf.confirmationId, snapshotHash: cf.snapshotHash, evidence });
      this.submitRegistration(c, directives);
    } else if (resp === 'deny') {
      cf.status = 'DENIED';
      c.confirmationHistory.push(cf);
      c.receptionState = 'DRAFT';
      c.log('confirmation_denied', { confirmationId: cf.confirmationId });
      directives.push({ kind: 'question', text: '失礼しました。どの点を訂正すればよろしいでしょうか。', exact: false });
    }
    // correction は onFactsChanged で失効済み
  }

  private checkHandoffPending(c: Conversation, directives: SpeechDirective[]) {
    const miss = missingForRegistration(c.facts, c.policy.matched);
    const policyGivenUp = c.facts.policy_number.status === 'explicitly_unknown' && c.facts.vehicle_plate.status !== 'captured';
    const unresolvable = unresolvableRequired(c.facts);
    const onlyPolicyMissing = miss.length === 1 && miss[0] === 'policy_match';
    if ((onlyPolicyMissing && policyGivenUp) || unresolvable.length) {
      if (c.receptionState === 'HANDOFF_PENDING') return;
      c.receptionState = 'HANDOFF_PENDING';
      c.log('handoff_pending', { reason: onlyPolicyMissing ? 'policy_unresolved' : `unresolvable:${unresolvable.join(',')}` });
      this.requestTransfer(c, 'OPERATOR', onlyPolicyMissing ? ['契約未特定（事故概要・連絡先は聴取済み）'] : [`必須項目が不明: ${unresolvable.join(',')}`]);
      directives.push({ kind: 'handoff', text: 'ありがとうございます。お伺いした事故の内容とご連絡先は記録しました。ご契約の確認のため、担当者におつなぎします。まだ登録完了ではありません。', exact: true });
    }
  }

  private maybePrepareConfirmation(c: Conversation, directives: SpeechDirective[]) {
    if (c.confirmation?.status === 'PENDING' && c.confirmation.snapshotVersion === c.version) return;
    if (c.receptionState === 'CONFIRMED') return;
    const g = ActionGate.canPrepareConfirmation(c);
    if (!g.allowed) return;
    const snap = makeSnapshot(c.facts, c.version, c.policy.policyRef);
    c.snapshots.push(snap);
    if (c.confirmation && c.confirmation.status !== 'PENDING') c.confirmationHistory.push(c.confirmation);
    const cf: Confirmation = {
      confirmationId: `MOCK-CONFIRMATION-${randomUUID().slice(0, 8)}`,
      snapshotVersion: snap.version,
      snapshotHash: snap.hash,
      readbackText: buildReadback(snap),
      readbackDelivered: false,
      createdAt: new Date().toISOString(),
      status: 'PENDING',
      evidenceRefs: [],
    };
    c.confirmation = cf;
    c.receptionState = 'READY_FOR_CONFIRMATION';
    c.log('confirmation_prepared', { confirmationId: cf.confirmationId, version: snap.version, hash: snap.hash });
    directives.push({ kind: 'readback', text: cf.readbackText, exact: true, tag: `readback:${cf.confirmationId}` });
  }

  submitRegistration(c: Conversation, directives: SpeechDirective[]) {
    const g = ActionGate.canSubmitRegistration(c);
    if (!g.allowed) { c.log('submit_rejected_by_gate', g.reasons); return; }
    const snap = makeSnapshot(c.facts, c.version, c.policy.policyRef);
    const mapped = mapToRpaPayload(snap);
    if (!mapped.ok) {
      c.receptionState = 'NEEDS_CLARIFICATION';
      this.invalidateConfirmation(c, `field_error:${mapped.fieldErrors.join(',')}`);
      c.log('mapping_field_error', mapped.fieldErrors);
      directives.push({ kind: 'question', text: '登録に必要な内容に確認が必要な点がありました。もう一度確認させてください。', exact: false });
      return;
    }
    const job: RpaJob = {
      job_id: newJobId(),
      claim_id: c.claimId,
      conversation_id: c.id,
      source_version: c.version,
      schema_version: SCHEMA_VERSION,
      mapping_version: MAPPING_VERSION,
      idempotency_key: `${c.claimId}:registration:v${c.version}`,
      confirmation_id: c.confirmation!.confirmationId,
      payload_hash: snap.hash,
      created_at: new Date().toISOString(),
      payload: mapped.payload!,
    };
    c.activeJobId = job.job_id;
    c.jobIds.push(job.job_id);
    const { duplicate } = this.rpa.submit(job);
    c.registrationState = 'QUEUED';
    c.log('registration_submitted', { jobId: job.job_id, idempotencyKey: job.idempotency_key, duplicate });
    directives.push({ kind: 'registration', text: 'ありがとうございます。内容を確定し、登録の処理を始めました。登録の完了を確認できるまで、少々お待ちください。', exact: true });
    const jobId = job.job_id;
    setTimeout(() => {
      const r = this.rpa.getStatus(jobId);
      if (r && (r.state === 'QUEUED' || r.state === 'RUNNING') && c.callState === 'ACTIVE' && c.activeJobId === jobId) {
        c.log('call_wait_limit_exceeded', { jobId });
        this.speak(c, { kind: 'registration', text: 'お伺いした内容の受付は済んでおり、登録は処理中です。完了はまだ確認できていません。確認でき次第の連絡方法は担当からご案内します（模擬）。', exact: true }, null, false);
      }
    }, this.opts.callWaitLimitMs).unref?.();
  }

  /** 既に要求済みの登録を同一キーで再要求（二重要求テスト用） */
  resubmitSameJob(c: Conversation): { duplicate: boolean } | null {
    const r = c.activeJob();
    if (!r) return null;
    const { duplicate } = this.rpa.submit(r.job);
    c.log('duplicate_submit_test', { jobId: r.job.job_id, duplicate });
    this.changed(c);
    return { duplicate };
  }

  // ───────── 転送 ─────────
  private ensureTransfer(c: Conversation, directives: SpeechDirective[]) {
    const target: TransferTarget = c.route.route === 'TOWING' ? 'TOWING_DESK' : c.route.route === 'OPERATOR_EMERGENCY' ? 'OPERATOR_EMERGENCY' : 'OPERATOR';
    // 登録権限の失効
    if (c.confirmation && (c.confirmation.status === 'PENDING' || c.confirmation.status === 'ACCEPTED')) this.invalidateConfirmation(c, `route_changed:${c.route.route}`);
    const job = c.activeJob();
    if (job && (job.state === 'QUEUED' || job.state === 'RUNNING')) {
      this.rpa.cancel(job.job.job_id, `route_changed:${c.route.route}`);
      if (job.state === 'RUNNING') c.amendmentPending = true;
    }
    if (c.receptionState !== 'HANDOFF_PENDING') c.receptionState = 'NOT_ELIGIBLE';
    const already = c.transfer && c.transfer.target === target && c.transfer.status !== 'TRANSFER_FAILED';
    const escalate = c.transfer && target === 'OPERATOR_EMERGENCY' && c.transfer.target !== 'OPERATOR_EMERGENCY';
    if (already && !escalate) return;
    if (c.transfer && c.transfer.status === 'TRANSFER_FAILED' && !escalate) return;
    this.requestTransfer(c, target, c.route.reasons);
    if (target === 'OPERATOR_EMERGENCY') {
      directives.push({ kind: 'emergency', text: '安全を最優先にしてください。車から離れて安全な場所に移動し、けがや火災の危険があれば119番に連絡してください。担当者に急いでおつなぎします。', exact: true });
    } else if (target === 'TOWING_DESK') {
      directives.push({ kind: 'handoff', text: 'レッカーの手配ですね。レッカーの担当におつなぎします。お伺いした内容は担当に引き継ぎますので、そのままお待ちください。', exact: true });
    } else {
      const why = c.route.reasons.includes('有人対応の希望') ? '承知しました。' : 'このご事故は担当者がご案内します。';
      directives.push({ kind: 'handoff', text: `${why}お伺いした内容は引き継ぎますので、担当者におつなぎします。そのままお待ちください。`, exact: true });
    }
  }

  private buildHandoff(c: Conversation, reasons: string[]): HandoffPackage {
    const captured: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(c.facts)) if (f.status !== 'missing') captured[k] = { value: f.value, status: f.status, original: f.originalExpression };
    return {
      conversation_id: c.id,
      route: c.route.route,
      reason: reasons,
      safety_flags: c.route.safetyFlags,
      captured_facts: captured,
      unresolved: [...c.route.unresolved, ...missingForRegistration(c.facts, c.policy.matched)],
      caller_contact: { name_kana: c.facts.caller_name_kana.value, callback_phone: c.facts.callback_phone.value },
      transcript_ref: `transcript:${c.id}`,
      registration_status: c.registrationState,
    };
  }

  private requestTransfer(c: Conversation, target: TransferTarget, reasons: string[]) {
    const pkg = this.buildHandoff(c, reasons);
    if (c.transfer) c.transferHistory.push(c.transfer);
    const transferId = this.telephony.requestTransfer(target, pkg, (r) => {
      if (!c.transfer || c.transfer.transferId !== r.transferId) return;
      c.transfer.status = r.status;
      c.transfer.resultAt = r.at;
      c.log('transfer_result', r);
      if (r.status === 'TRANSFERRED') {
        c.callState = 'TRANSFERRED';
        this.speak(c, { kind: 'handoff', text: '担当者におつなぎしました（模擬）。', exact: true }, null, false);
      } else {
        c.callState = 'TRANSFER_FAILED';
        this.speak(c, { kind: 'handoff', text: '申し訳ございません。ただいま担当者におつなぎできませんでした。お伺いした内容は記録しています。このままお待ちいただくか、担当者からの折り返しをご希望か、お聞かせください（模擬）。', exact: true }, null, false);
      }
      this.changed(c);
    });
    c.transfer = { target, transferId, status: 'TRANSFER_REQUESTED', package: pkg, requestedAt: new Date().toISOString() };
    c.callState = 'TRANSFER_REQUESTED';
    c.log('transfer_requested', { target, transferId });
  }

  // ───────── RPA結果 ─────────
  private onJobUpdate(rec: JobRecord) {
    const c = this.conversations.get(rec.job.conversation_id);
    if (!c) return;
    if (c.activeJobId !== rec.job.job_id) { this.changed(c); return; }
    const prev = c.registrationState;
    c.registrationState = rec.state;
    if (prev === rec.state) { this.changed(c); return; }
    c.log('registration_state', { jobId: rec.job.job_id, state: rec.state, failure: rec.failure });
    const active = c.callState === 'ACTIVE';
    if (rec.state === 'REGISTERED') {
      const g = ActionGate.canAnnounceComplete(c);
      if (!g.allowed) {
        c.log('complete_announcement_blocked', g.reasons);
        if (c.amendmentPending) {
          c.receptionState = 'HANDOFF_PENDING';
          if (active) this.speak(c, { kind: 'notice', text: '登録処理は止める前に完了していました。訂正は担当者が対応します。二重に登録することはありません。', exact: true }, null, false);
        }
      } else if (active) {
        this.speak(c, { kind: 'registration', text: `受付の登録が完了しました（模擬）。受付番号は ${rec.result!.core_registration_id} です。ほかにご不明な点はありますか。`, exact: true }, null, false);
      }
    } else if (rec.state === 'FAILED') {
      if (active) this.speak(c, { kind: 'registration', text: rec.failure === 'FIELD_ERROR' ? '登録に必要な項目の確認が必要になりました。まだ登録されていません。担当者が確認します。' : '登録処理でエラーが発生し、まだ登録されていません。担当者が確認のうえ対応します。', exact: true }, null, false);
      if (rec.failure === 'FIELD_ERROR') c.receptionState = 'HANDOFF_PENDING';
    } else if (rec.state === 'OUTCOME_UNKNOWN') {
      if (active) this.speak(c, { kind: 'registration', text: '登録処理の結果を確認しています。まだ完了とはお伝えできません。少々お待ちください。', exact: true }, null, false);
    } else if (rec.state === 'CANCELLED') {
      if (c.amendmentPending && rec.log.some((l) => l.event === 'cancelled_before_commit')) {
        // 停止できた：訂正後の内容で再確認へ
        c.amendmentPending = false;
        c.activeJobId = null;
        c.registrationState = 'NOT_SUBMITTED';
        c.log('running_job_stopped_before_commit', { jobId: rec.job.job_id });
      } else {
        c.activeJobId = null;
        c.registrationState = 'NOT_SUBMITTED';
      }
      if (active && c.route.route === 'SELF_SERVICE') {
        const d: SpeechDirective[] = [];
        this.maybePrepareConfirmation(c, d);
        d.forEach((x) => this.speak(c, x, null, false));
      }
    }
    this.changed(c);
  }

  reconcile(c: Conversation) {
    const r = c.activeJob();
    if (!r) return null;
    this.rpa.reconcile(r.job.job_id);
    c.log('reconcile_requested', { jobId: r.job.job_id });
    this.changed(c);
    return r;
  }

  retry(c: Conversation) {
    const r = c.activeJob();
    if (!r) return false;
    const ok = this.rpa.retry(r.job.job_id);
    c.log('retry_requested', { jobId: r.job.job_id, ok });
    if (ok) c.registrationState = 'QUEUED';
    this.changed(c);
    return ok;
  }

  // ───────── 通話終了・切断 ─────────
  endCall(c: Conversation, reason: 'hangup' | 'disconnected' | 'live_closed' | 'operator') {
    if (c.callState === 'ENDED') return;
    const prev = c.callState;
    c.callState = 'ENDED';
    // 最終確認前の切断：DRAFTのまま。新規登録しない。
    if (c.confirmation?.status === 'PENDING') this.invalidateConfirmation(c, `call_${reason}`);
    c.log('call_ended', { reason, prevCallState: prev, receptionState: c.receptionState, registrationState: c.registrationState });
    this.changed(c);
  }

  /** 委任に対し新しい入力がない場合、現在の会話目的を返す */
  respondCurrent(c: Conversation, delegationId: string | null) {
    const d: SpeechDirective = c.confirmation?.status === 'PENDING'
      ? { kind: 'readback', text: c.confirmation.readbackText, exact: true, tag: `readback:${c.confirmation.confirmationId}` }
      : { kind: 'question', text: c.callState === 'TRANSFER_REQUESTED' ? 'ただいま担当者におつなぎしています。' : '続けてお話しください。', exact: false };
    this.speak(c, d, delegationId, true);
  }

  contextSummary(c: Conversation): string {
    const known = Object.values(c.facts).filter((f) => f.status === 'captured' || f.status === 'confirmed').map((f) => `${f.key}=${String(f.value)}`).join('; ');
    const unknown = Object.values(c.facts).filter((f) => f.status === 'explicitly_unknown').map((f) => f.key).join(',');
    const miss = missingForRegistration(c.facts, c.policy.matched).join(',');
    return `[受付状態] route=${c.route.route} call=${c.callState} reception=${c.receptionState} registration=${c.registrationState}. 確認済みの事実: ${known || 'なし'}. 不明と言われた項目: ${unknown || 'なし'}. 未取得: ${[...c.route.unresolved, miss].filter(Boolean).join(',') || 'なし'}. 既に聞いたことは再度聞かない。登録完了・転送完了はアプリから明示されるまで言わない。`;
  }
}

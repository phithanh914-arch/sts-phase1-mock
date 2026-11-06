// RpaAdapter + 模擬Worker + 模擬基幹(MockCore)。本番RPA・実基幹へは接続しない。
// 形式はモック独自(mock-rpa-v0.1)。既存RPAの入力仕様ではない。

import { randomUUID } from 'node:crypto';
import type { FaultConfig } from './faults.js';
import type { RegistrationState } from '../domain/types.js';

export interface RpaJob {
  job_id: string;
  claim_id: string;
  conversation_id: string;
  source_version: number;
  schema_version: string;
  mapping_version: string;
  idempotency_key: string;
  confirmation_id: string;
  payload_hash: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export type FailureKind = 'FAILED_PRECOMMIT' | 'FIELD_ERROR' | null;

export interface JobRecord {
  job: RpaJob;
  state: RegistrationState;
  failure: FailureKind;
  failureDetail?: string;
  cancelRequested: boolean;
  attempts: number;
  /** 処理遅延（通話中待機限度超過の判定用） */
  delayed: boolean;
  result?: RegistrationResult;
  log: { at: string; event: string; detail?: string }[];
}

export interface RegistrationResult {
  mock_only: true;
  job_id: string;
  claim_id: string;
  source_version: number;
  payload_hash: string;
  status: 'REGISTERED';
  core_registration_id: string;
  readback_verified: boolean;
  confirmed_at: string;
  notice: string;
}

export interface CoreRecord {
  core_registration_id: string;
  idempotency_key: string;
  claim_id: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  registered_at: string;
  mock: true;
}

/** 模擬基幹の登録台帳。同一idempotency_keyは受け手側で重複排除する。 */
export class MockCore {
  private records = new Map<string, CoreRecord>();
  private byKey = new Map<string, string>();
  private seq = 0;

  register(job: RpaJob): { record: CoreRecord; deduplicated: boolean } {
    const existing = this.byKey.get(job.idempotency_key);
    if (existing) return { record: this.records.get(existing)!, deduplicated: true };
    const id = `MOCK-REG-${String(++this.seq).padStart(4, '0')}`;
    const rec: CoreRecord = {
      core_registration_id: id,
      idempotency_key: job.idempotency_key,
      claim_id: job.claim_id,
      payload_hash: job.payload_hash,
      payload: structuredClone(job.payload),
      registered_at: new Date().toISOString(),
      mock: true,
    };
    this.records.set(id, rec);
    this.byKey.set(job.idempotency_key, id);
    return { record: rec, deduplicated: false };
  }
  get(id: string) { return this.records.get(id); }
  findByIdempotencyKey(key: string) {
    const id = this.byKey.get(key);
    return id ? this.records.get(id) : undefined;
  }
  findByClaim(claimId: string) { return [...this.records.values()].filter((r) => r.claim_id === claimId); }
  all() { return [...this.records.values()]; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createRpaAdapter(opts: {
  core: MockCore;
  getFaults: () => FaultConfig;
  onUpdate: (rec: JobRecord) => void;
  /** Workerが取得時・書込直前に確認する：版・取消・リースが有効か */
  isStillValid: (job: RpaJob) => boolean;
}) {
  const jobs = new Map<string, JobRecord>();
  const byKey = new Map<string, string>();

  const log = (r: JobRecord, event: string, detail?: string) => {
    r.log.push({ at: new Date().toISOString(), event, detail });
    opts.onUpdate(r);
  };

  async function work(r: JobRecord) {
    if (r.state === 'CANCELLED') return;
    const f = { ...opts.getFaults() };
    r.attempts += 1;
    if (r.cancelRequested || !opts.isStillValid(r.job)) {
      r.state = 'CANCELLED';
      log(r, 'cancelled_before_start');
      return;
    }
    r.state = 'RUNNING';
    log(r, 'worker_picked', `fault=${f.rpa}`);
    const dur = f.rpa === 'delay' ? f.rpaDelayMs : f.rpaDurationMs;
    if (f.rpa === 'delay') { r.delayed = true; log(r, 'delayed'); }
    await sleep(dur);
    // 書込直前の再確認
    if (r.cancelRequested || !opts.isStillValid(r.job)) {
      r.state = 'CANCELLED';
      log(r, 'cancelled_before_commit', '書込前に停止を確認（未登録）');
      return;
    }
    if (f.rpa === 'precommit_fail') {
      r.state = 'FAILED';
      r.failure = 'FAILED_PRECOMMIT';
      r.failureDetail = '書込み前の入力検証エラー（未登録を確認）';
      log(r, 'failed_precommit');
      return;
    }
    if (f.rpa === 'field_error') {
      r.state = 'FAILED';
      r.failure = 'FIELD_ERROR';
      r.failureDetail = '項目エラー（推測で補わない）';
      log(r, 'field_error');
      return;
    }
    const { record, deduplicated } = opts.core.register(r.job);
    log(r, 'core_commit', `${record.core_registration_id}${deduplicated ? ' (dedup)' : ''}`);
    if (f.rpa === 'commit_then_timeout') {
      r.state = 'OUTCOME_UNKNOWN';
      log(r, 'worker_timeout', '基幹書込後に応答喪失。自動再送しない。照合が必要');
      return;
    }
    verifyAndComplete(r, record);
  }

  function verifyAndComplete(r: JobRecord, record: CoreRecord) {
    const readback = opts.core.get(record.core_registration_id);
    const verified = !!readback && readback.payload_hash === r.job.payload_hash && readback.claim_id === r.job.claim_id;
    if (!verified) {
      r.state = 'OUTCOME_UNKNOWN';
      log(r, 'readback_mismatch');
      return;
    }
    r.state = 'REGISTERED';
    r.result = {
      mock_only: true,
      job_id: r.job.job_id,
      claim_id: r.job.claim_id,
      source_version: r.job.source_version,
      payload_hash: r.job.payload_hash,
      status: 'REGISTERED',
      core_registration_id: record.core_registration_id,
      readback_verified: true,
      confirmed_at: new Date().toISOString(),
      notice: 'MOCK：模擬基幹への登録結果であり、実登録ではない。',
    };
    log(r, 'registered', record.core_registration_id);
  }

  return {
    jobs,
    /** 同一idempotency_keyの二重submitはジョブ台帳で抑止（受け手台帳でも重複排除） */
    submit(job: RpaJob): { rec: JobRecord; duplicate: boolean } {
      const existingId = byKey.get(job.idempotency_key);
      if (existingId) {
        const rec = jobs.get(existingId)!;
        log(rec, 'duplicate_submit_suppressed');
        return { rec, duplicate: true };
      }
      const rec: JobRecord = { job, state: 'QUEUED', failure: null, cancelRequested: false, attempts: 0, delayed: false, log: [] };
      jobs.set(job.job_id, rec);
      byKey.set(job.idempotency_key, job.job_id);
      log(rec, 'queued');
      setTimeout(() => void work(rec), 50);
      return { rec, duplicate: false };
    },
    getStatus(jobId: string) { return jobs.get(jobId); },
    /** 結果不明の解消：基幹台帳を照合して同一登録結果を回収。照合前の自動再登録はしない。 */
    reconcile(jobId: string): JobRecord | undefined {
      const r = jobs.get(jobId);
      if (!r) return undefined;
      if (r.state !== 'OUTCOME_UNKNOWN') return r;
      const rec = opts.core.findByIdempotencyKey(r.job.idempotency_key);
      if (rec) {
        log(r, 'reconcile_found', rec.core_registration_id);
        verifyAndComplete(r, rec);
      } else {
        r.state = 'FAILED';
        r.failure = 'FAILED_PRECOMMIT';
        r.failureDetail = '照合の結果、未登録を確認';
        log(r, 'reconcile_not_found');
      }
      return r;
    },
    /** 未登録が確認できた失敗(FAILED_PRECOMMIT)のみ同一ジョブで再試行可能 */
    retry(jobId: string): boolean {
      const r = jobs.get(jobId);
      if (!r || r.state !== 'FAILED' || r.failure !== 'FAILED_PRECOMMIT') return false;
      if (!opts.isStillValid(r.job)) return false;
      r.state = 'QUEUED';
      r.failure = null;
      log(r, 'retry_queued');
      setTimeout(() => void work(r), 50);
      return true;
    },
    /** 停止要求。QUEUEDは即取消。RUNNINGは書込前確認で停止を試みる（結果は後で確認）。 */
    cancel(jobId: string, reason: string): RegistrationState | undefined {
      const r = jobs.get(jobId);
      if (!r) return undefined;
      r.cancelRequested = true;
      if (r.state === 'QUEUED') { r.state = 'CANCELLED'; log(r, 'cancelled', reason); }
      else log(r, 'cancel_requested', reason);
      return r.state;
    },
  };
}
export type RpaAdapter = ReturnType<typeof createRpaAdapter>;

export function newJobId() { return `MOCK-JOB-${randomUUID().slice(0, 8)}`; }

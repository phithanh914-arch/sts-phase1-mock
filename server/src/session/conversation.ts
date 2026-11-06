import { emptyFacts } from '../domain/facts.js';
import { decideRoute } from '../domain/routing.js';
import type { CallState, ClaimSnapshot, Confirmation, Fact, ReceptionState, RegistrationState, RouteDecision, Utterance } from '../domain/types.js';
import type { JobRecord } from '../adapters/rpa.js';
import type { HandoffPackage, TransferTarget } from '../adapters/telephony.js';
import type { ReceptionPlan } from '../brain/types.js';

export interface AnalysisRecord {
  analysisId: string;
  baseStateVersion: number;
  inputWatermark: string;
  trigger: string;
  delegationId: string | null;
  status: 'running' | 'applied' | 'stale_discarded' | 'timed_out' | 'error' | 'late_discarded';
  startedAt: string;
  latencyMs?: number;
  brain: string;
  plan?: ReceptionPlan;
  rejectedProposals?: { key: string; issue: string }[];
  changedKeys?: string[];
  error?: string;
}

export interface TransferInfo {
  target: TransferTarget;
  transferId: string;
  status: 'TRANSFER_REQUESTED' | 'TRANSFERRED' | 'TRANSFER_FAILED';
  package: HandoffPackage;
  requestedAt: string;
  resultAt?: string;
}

export interface AuditEntry {
  at: string;
  event: string;
  detail?: unknown;
}

export class Conversation {
  readonly id: string;
  readonly claimId: string;
  readonly createdAt = new Date().toISOString();
  mode: 'text' | 'live';
  brainName: string;
  version = 0;
  facts: Record<string, Fact> = emptyFacts();
  utterances: Utterance[] = [];
  route: RouteDecision;
  callState: CallState = 'ACTIVE';
  receptionState: ReceptionState = 'DRAFT';
  registrationState: RegistrationState = 'NOT_SUBMITTED';
  policy: { matched: boolean; policyRef: string | null; matchedItems: string[]; lookupId: string | null } = { matched: false, policyRef: null, matchedItems: [], lookupId: null };
  confirmation: Confirmation | null = null;
  confirmationHistory: Confirmation[] = [];
  snapshots: ClaimSnapshot[] = [];
  activeJobId: string | null = null;
  jobIds: string[] = [];
  jobs: Map<string, JobRecord>;
  transfer: TransferInfo | null = null;
  transferHistory: TransferInfo[] = [];
  analyses: AnalysisRecord[] = [];
  analysisInFlight = false;
  /** 分析済みの最後の顧客発話ID */
  watermark = '';
  clarifyCount = 0;
  customerNeeds: string[] = [];
  riskLog: { at: string; kind: string; note: string }[] = [];
  amendmentPending = false;
  nextIntent = '';
  desiredInformation: string[] = [];
  lastBriefReason = '';
  audit: AuditEntry[] = [];
  live: { sessionId: string | null; startedAt: string | null; voiceSeconds: number; closedReason: string | null } = { sessionId: null, startedAt: null, voiceSeconds: 0, closedReason: null };
  seq = 0;

  constructor(id: string, claimId: string, mode: 'text' | 'live', brainName: string, jobs: Map<string, JobRecord>) {
    this.id = id;
    this.claimId = claimId;
    this.mode = mode;
    this.brainName = brainName;
    this.jobs = jobs;
    this.route = decideRoute(this.facts);
  }

  nextId(prefix: string) { return `${prefix}-${++this.seq}`; }

  log(event: string, detail?: unknown) {
    this.audit.push({ at: new Date().toISOString(), event, detail });
  }

  activeJob(): JobRecord | undefined {
    return this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
  }

  unanalyzedCustomerUtterances(): Utterance[] {
    const idx = this.watermark ? this.utterances.findIndex((u) => u.id === this.watermark) : -1;
    return this.utterances.slice(idx + 1).filter((u) => u.speaker === 'customer');
  }

  toJSON() {
    return {
      id: this.id,
      claimId: this.claimId,
      createdAt: this.createdAt,
      mode: this.mode,
      brainName: this.brainName,
      version: this.version,
      facts: this.facts,
      utterances: this.utterances,
      route: this.route,
      callState: this.callState,
      receptionState: this.receptionState,
      registrationState: this.registrationState,
      policy: this.policy,
      confirmation: this.confirmation,
      confirmationHistory: this.confirmationHistory,
      snapshots: this.snapshots,
      activeJobId: this.activeJobId,
      jobs: this.jobIds.map((id) => this.jobs.get(id)).filter(Boolean),
      transfer: this.transfer,
      transferHistory: this.transferHistory,
      analyses: this.analyses.slice(-30),
      analysisInFlight: this.analysisInFlight,
      clarifyCount: this.clarifyCount,
      customerNeeds: this.customerNeeds,
      riskLog: this.riskLog,
      amendmentPending: this.amendmentPending,
      nextIntent: this.nextIntent,
      desiredInformation: this.desiredInformation,
      lastBriefReason: this.lastBriefReason,
      audit: this.audit.slice(-200),
      live: this.live,
    };
  }
}

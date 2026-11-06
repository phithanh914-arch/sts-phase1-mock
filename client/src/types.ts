// サーバの会話JSON（表示用の最小型）
export interface Fact {
  key: string; value: string | boolean | null; status: string; evidenceRefs: string[]; originalExpression?: string;
  history: { value: unknown; status: string; version: number; reason: string }[];
}
export interface Job {
  job: { job_id: string; idempotency_key: string };
  state: string; failure: string | null; attempts: number; delayed: boolean;
  result?: { core_registration_id: string; readback_verified: boolean };
  log: { at: string; event: string; detail?: string }[];
}
export interface Conv {
  id: string; mode: 'text' | 'live'; brainName: string; version: number;
  facts: Record<string, Fact>;
  utterances: { id: string; speaker: string; text: string; kind: string; startMs?: number; tag?: string }[];
  route: { route: string; reasons: string[]; unresolved: string[]; safetyFlags: string[] };
  callState: string; receptionState: string; registrationState: string;
  policy: { matched: boolean; matchedItems: string[] };
  confirmation: { confirmationId: string; snapshotVersion: number; snapshotHash: string; status: string; readbackDelivered: boolean; invalidatedReason?: string } | null;
  activeJobId: string | null; jobs: Job[];
  transfer: { target: string; status: string; package: unknown } | null;
  analyses: { analysisId: string; status: string; baseStateVersion: number; inputWatermark: string; latencyMs?: number; trigger: string; changedKeys?: string[]; rejectedProposals?: unknown[]; brain?: string; fastPathRule?: string; usage?: { inputTokens: number; outputTokens: number; costUsd: number | null }; shadow?: { status: string; diffs?: string[] } }[];
  profile: string;
  turns: Turn[];
  customerNeeds: string[]; amendmentPending: boolean; nextIntent: string; desiredInformation: string[]; lastBriefReason: string;
  audit: { at: string; event: string; detail?: unknown }[];
  live: { sessionId: string | null; voiceSeconds: number };
}

export interface Turn {
  turnId: string; profile: string; brain: string; effort: string | null; mode: string;
  fastPath: 'off' | 'hit' | 'miss'; fastPathRule?: string; fallbackReason?: string;
  status: string; analyses: number; errors: string[];
  live: { answerMatch?: string };
  durations: Record<string, number>;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
}

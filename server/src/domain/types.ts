// アプリ独自のドメイン型。OpenAI APIの型ではない。

export type FactStatus =
  | 'missing'
  | 'captured'
  | 'confirmed'
  | 'explicitly_unknown'
  | 'conflict'
  | 'not_applicable';

export type FactOrigin = 'customer' | 'policy_db' | 'rule_derived' | 'model_hypothesis';

export type FactValue = string | boolean | null;

export interface FactHistoryEntry {
  value: FactValue;
  status: FactStatus;
  originalExpression?: string;
  evidenceRefs: string[];
  version: number;
  at: string;
  reason: string;
}

export interface Fact {
  key: string;
  value: FactValue;
  status: FactStatus;
  origin: FactOrigin;
  evidenceRefs: string[];
  originalExpression?: string;
  lastUpdatedVersion: number;
  history: FactHistoryEntry[];
}

export type Route = 'TOWING' | 'SELF_SERVICE' | 'OPERATOR' | 'OPERATOR_EMERGENCY' | 'UNRESOLVED';

export type CallState = 'ACTIVE' | 'TRANSFER_REQUESTED' | 'TRANSFERRED' | 'TRANSFER_FAILED' | 'ENDED';

export type ReceptionState =
  | 'DRAFT'
  | 'NEEDS_CLARIFICATION'
  | 'READY_FOR_CONFIRMATION'
  | 'CONFIRMED'
  | 'HANDOFF_PENDING'
  | 'NOT_ELIGIBLE';

export type RegistrationState =
  | 'NOT_SUBMITTED'
  | 'QUEUED'
  | 'RUNNING'
  | 'REGISTERED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'CANCELLED';

export type Speaker = 'customer' | 'ai' | 'system';

/** 会話ログ。turnIdはアプリ由来でありAPIが保証する会話ターンではない。 */
export interface Utterance {
  id: string;
  speaker: Speaker;
  text: string;
  /** spoken: 実際に出力された/入力された。planned: 発話予定(バックエンドの提案)。 */
  kind: 'input' | 'spoken' | 'planned' | 'notice';
  at: string;
  startMs?: number;
  endMs?: number;
  source: 'text' | 'live';
  /** 例: readback:<confirmationId>（最終確認の読上げ）、gate:<kind> */
  tag?: string;
}

export interface RouteDecision {
  route: Route;
  reasons: string[];
  unresolved: string[];
  safetyFlags: string[];
}

export interface Confirmation {
  confirmationId: string;
  snapshotVersion: number;
  snapshotHash: string;
  readbackText: string;
  /** 読み上げが実際に出力されたか(テキストモードでは表示時点、Liveでは出力transcript確認時) */
  readbackDelivered: boolean;
  createdAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'INVALIDATED' | 'DENIED';
  evidenceRefs: string[];
  invalidatedReason?: string;
}

export interface ClaimSnapshot {
  snapshotId: string;
  version: number;
  hash: string;
  facts: Record<string, { value: FactValue; status: FactStatus }>;
  policyRef: string | null;
  createdAt: string;
}

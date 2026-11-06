// ReceptionBrainの入出力（アプリ独自型。OpenAI APIの型ではない）。

import type { FactProposal } from '../domain/facts.js';
import type { FactStatus, FactValue, Route, Utterance } from '../domain/types.js';

export interface ScenarioHypothesis {
  label: string;
  likelihood: 'high' | 'medium' | 'low';
  note: string;
}

export interface RiskSignal {
  kind: 'emergency' | 'unsafe' | 'injury' | 'third_party' | 'other_party' | 'coverage_question' | 'human_request' | 'prompt_injection' | 'other';
  note: string;
  evidenceRefs: string[];
}

export type ConfirmationResponse = 'affirm' | 'deny' | 'correction' | 'none';

export interface ReceptionPlan {
  analysisId: string;
  baseStateVersion: number;
  inputWatermark: string;
  factProposals: FactProposal[];
  scenarioHypotheses: ScenarioHypothesis[];
  riskSignals: RiskSignal[];
  requestedRoute: 'TOWING' | 'SELF_SERVICE' | 'OPERATOR' | 'UNRESOLVED';
  /** 最終内容確認への顧客の応答（確認待ちのときのみ意味を持つ） */
  confirmationResponse: ConfirmationResponse;
  customerNeeds: string[];
  nextIntent: string;
  desiredInformation: string[];
  suggestedSpeech: string;
  evidenceRefs: string[];
  briefReason: string;
  brain: string;
}

export interface BrainContext {
  analysisId: string;
  baseStateVersion: number;
  inputWatermark: string;
  /** 全会話（入力と実際に出力されたAI発話のみ。予定発話は含めない） */
  transcript: Utterance[];
  /** 今回新たに分析対象となる顧客発話のID */
  newUtteranceIds: string[];
  facts: Record<string, { value: FactValue; status: FactStatus; original?: string }>;
  route: Route;
  routeReasons: string[];
  unresolvedEligibility: string[];
  missingForRegistration: string[];
  pendingConfirmation: { confirmationId: string; readbackText: string } | null;
  callState: string;
  receptionState: string;
  registrationState: string;
  today: string; // YYYY-MM-DD (JST)
}

export interface ReceptionBrain {
  readonly name: string;
  analyze(ctx: BrainContext): Promise<ReceptionPlan>;
}

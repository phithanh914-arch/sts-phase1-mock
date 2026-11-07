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
  /** 質問の前に添える一言（補償の確約不可の案内など。質問を含めない）。コードで質問を選ぶプロファイルで使う */
  speechPrefix?: string;
  /** 曖昧な回答の聞き直しが必要なときだけ、LLMが作る確認の質問（コードで質問を選ぶプロファイルで使う） */
  clarifyQuestion?: string;
  /** API利用量（LLMのみ） */
  usage?: BrainUsage;
}

export interface BrainUsage {
  model: string;
  effort: string | null;
  promptMode: 'full' | 'lean';
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** 公式単価から算出（USD）。単価が不明なモデルはnull */
  costUsd: number | null;
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
  /** full：従来（質問文もLLMが作る）。lean：事実抽出に専念（質問はコードが選ぶ）。D16 */
  promptMode?: 'full' | 'lean';
  /** 推論量の上書き（比較計測用）。未指定ならBrainの既定 */
  reasoningEffort?: string | null;
  /** 直前にAIが話した質問のID（コード選択の質問のみ） */
  lastQuestionKey?: string | null;
}

export interface ReceptionBrain {
  readonly name: string;
  analyze(ctx: BrainContext): Promise<ReceptionPlan>;
}

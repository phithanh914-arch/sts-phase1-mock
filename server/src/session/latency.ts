// 応答遅延の計測（D18）と、改善前後を比べるためのプロファイル（D16）。
//
// 1ターン＝顧客の発話から、それに対するAIの次の発話が始まるまで。ターンごとに共通のturnIdで時刻を記録する。
// 時刻は2種類を区別する：
//  - wall：サーバの時計（Date.now()）。Brain・コード処理・送信の所要時間に使う。
//  - live：GPT-Liveのセッション時間軸（start_ms/end_ms/offset_ms）。発話終了→音声開始の「サーバが把握する」間隔に使う。
// 利用者が実際に音を聞いた時刻はブラウザが測る（clientPlayback）。サーバ側の音声開始とは別の値として扱う。
// 記録するのは時刻・項目キー・理由コードだけ。発話の本文や個人情報は新たに記録しない（会話ログ本体の保存方針に従う）。

export type ProfileName = 'baseline' | 'lightweight' | 'hybrid';

export interface LatencyProfile {
  name: ProfileName;
  label: string;
  /** llm：質問文もLLMが作る（従来）。code：次の質問はコードが選ぶ */
  questionMode: 'llm' | 'code';
  /** Brainへの指示と出力項目。full：従来。lean：事実抽出に専念 */
  promptMode: 'full' | 'lean';
  /** 定型の短い回答をLLMなしで確定する */
  fastPath: boolean;
  /** 委任が来たとき、そのターンの発話をすでに受け取って処理済みなら待たずに答える（従来は最大LIVE_DELEGATION_WAIT_MS待つ） */
  answerDelegationWithoutWait: boolean;
}

export const PROFILES: Record<ProfileName, LatencyProfile> = {
  baseline: { name: 'baseline', label: 'A：改善前（従来のLLM Brain）', questionMode: 'llm', promptMode: 'full', fastPath: false, answerDelegationWithoutWait: false },
  lightweight: { name: 'lightweight', label: 'B：軽量化（質問はコード・抽出専念・待機削減）', questionMode: 'code', promptMode: 'lean', fastPath: false, answerDelegationWithoutWait: true },
  hybrid: { name: 'hybrid', label: 'C：Hybrid（B＋Fast Path）', questionMode: 'code', promptMode: 'lean', fastPath: true, answerDelegationWithoutWait: true },
};

export function resolveProfile(v: unknown, fallback: ProfileName): LatencyProfile {
  return typeof v === 'string' && Object.hasOwn(PROFILES, v) ? PROFILES[v as ProfileName] : PROFILES[fallback];
}

export type MarkName =
  | 'speech_end' // 顧客の発話終了（Live：最後の入力transcriptを受信した時刻／テキスト：入力受付時刻）
  | 'utterance_flushed'
  | 'delegation_received'
  | 'analysis_start'
  | 'fastpath_start' | 'fastpath_end'
  | 'brain_request' | 'brain_response'
  | 'decision_done' // コードによる振り分け・権限判定・次の発話の決定が完了
  | 'filler_sent'
  | 'speech_sent' // GPT-Liveへ発話指示を送信（テキストモードでは表示）
  | 'first_audio' // そのターンで最初に受信した音声（Live自身の「はい」等を含む）
  | 'answer_audio'; // 発話指示を送った後に最初に受信した音声（＝次の質問の音声開始）

export interface TurnTrace {
  turnId: string;
  profile: ProfileName;
  brain: string;
  effort: string | null;
  mode: 'text' | 'live';
  fastPath: 'off' | 'hit' | 'miss';
  fastPathRule?: string;
  fallbackReason?: string;
  /** wall clock（epoch ms） */
  marks: Partial<Record<MarkName, number>>;
  /** GPT-Liveのセッション時間軸（ms） */
  live: { speechEndMs?: number; delegationOffsetMs?: number; firstAudioMs?: number; answerAudioMs?: number; answerMatch?: 'event_id' | 'after_send' };
  /** ブラウザが測った「顧客の声が止んでからAIの音声が聞こえ始めるまで」（ms）。AIの音声の区切りごとに1件（取得できた場合のみ） */
  clientOnsetsMs?: number[];
  analyses: number;
  usage?: { inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number | null };
  errors: string[];
  status: 'open' | 'answered' | 'interrupted' | 'abandoned';
  durations: Record<string, number>;
}

/** ターンの各区間の所要時間（ms）。取れない区間は入れない（推定で埋めない） */
export function computeDurations(t: TurnTrace): Record<string, number> {
  const m = t.marks;
  const d: Record<string, number> = {};
  const put = (k: string, a?: number, b?: number) => { if (a !== undefined && b !== undefined && b >= a) d[k] = b - a; };
  // サーバが把握する発話終了→次の音声開始（Liveの時間軸で比較。もっとも正確）
  if (t.live.speechEndMs !== undefined && t.live.answerAudioMs !== undefined) put('total_ms', t.live.speechEndMs, t.live.answerAudioMs);
  if (t.live.speechEndMs !== undefined && t.live.firstAudioMs !== undefined) put('first_sound_ms', t.live.speechEndMs, t.live.firstAudioMs);
  if (t.live.speechEndMs !== undefined && t.live.delegationOffsetMs !== undefined) put('endpointing_ms', t.live.speechEndMs, t.live.delegationOffsetMs);
  put('to_analysis_ms', m.speech_end, m.analysis_start);
  put('fastpath_ms', m.fastpath_start, m.fastpath_end);
  put('brain_ms', m.brain_request, m.brain_response);
  put('code_ms', m.brain_response ?? m.fastpath_end, m.decision_done);
  put('send_wait_ms', m.decision_done, m.speech_sent);
  put('audio_start_ms', m.speech_sent, m.answer_audio);
  // テキストモード（音声なし）：入力受付から次の発話の決定まで
  if (t.mode === 'text') put('total_ms', m.speech_end, m.speech_sent);
  // 最初の値＝最初に聞こえた音（Live自身の「はい」を含む）、最後の値＝応答（次の質問）の音声とみなす（近似・要検証）
  if (t.clientOnsetsMs?.length) { d.client_first_sound_ms = t.clientOnsetsMs[0]; d.client_playback_ms = t.clientOnsetsMs[t.clientOnsetsMs.length - 1]; }
  return d;
}

export interface Stat { n: number; p50: number | null; p95: number | null; mean: number | null; max: number | null }

/** 最近傍順位法のパーセンタイル */
export function stat(values: number[]): Stat {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, p50: null, p95: null, mean: null, max: null };
  const pct = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  return { n: v.length, p50: pct(50), p95: pct(95), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), max: v[v.length - 1] };
}

export const DURATION_KEYS = ['total_ms', 'client_playback_ms', 'first_sound_ms', 'client_first_sound_ms', 'endpointing_ms', 'to_analysis_ms', 'fastpath_ms', 'brain_ms', 'code_ms', 'send_wait_ms', 'audio_start_ms'];

export interface TurnSummary {
  key: string;
  profile: ProfileName;
  brain: string;
  effort: string | null;
  mode: 'text' | 'live';
  turns: number;
  fastPathHits: number;
  fastPathMisses: number;
  fastPathRate: number | null;
  fallbackReasons: Record<string, number>;
  errors: number;
  costUsd: number | null;
  durations: Record<string, Stat>;
}

/** プロファイル×Brain×推論量×モードごとにP50/P95をまとめる */
export function summarize(turns: TurnTrace[]): TurnSummary[] {
  const groups = new Map<string, TurnTrace[]>();
  for (const t of turns) {
    if (t.status !== 'answered') continue;
    const k = `${t.mode}|${t.profile}|${t.brain}|${t.effort ?? '-'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  return [...groups.entries()].map(([key, ts]) => {
    const hits = ts.filter((t) => t.fastPath === 'hit').length;
    const misses = ts.filter((t) => t.fastPath === 'miss').length;
    const reasons: Record<string, number> = {};
    for (const t of ts) if (t.fallbackReason) reasons[t.fallbackReason.split(':')[0]] = (reasons[t.fallbackReason.split(':')[0]] ?? 0) + 1;
    const costs = ts.map((t) => t.usage?.costUsd).filter((x): x is number => typeof x === 'number');
    return {
      key,
      profile: ts[0].profile,
      brain: ts[0].brain,
      effort: ts[0].effort,
      mode: ts[0].mode,
      turns: ts.length,
      fastPathHits: hits,
      fastPathMisses: misses,
      fastPathRate: hits + misses ? hits / (hits + misses) : null,
      fallbackReasons: reasons,
      errors: ts.filter((t) => t.errors.length).length,
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      durations: Object.fromEntries(DURATION_KEYS.map((k) => [k, stat(ts.map((t) => t.durations[k]).filter((x) => x !== undefined))])),
    };
  });
}

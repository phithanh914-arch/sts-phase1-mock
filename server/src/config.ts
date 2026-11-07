// 環境変数（秘密値はサーバ側のみ。VITE_* 等のフロント公開変数には入れない）
import { randomBytes } from 'node:crypto';

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8787),
  // Render等のPaaSではPORTが与えられ外部公開されるため0.0.0.0。ローカル既定は127.0.0.1。
  host: process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
  production: process.env.NODE_ENV === 'production',
  appPassword: process.env.APP_PASSWORD ?? '',
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  liveModel: process.env.LIVE_MODEL || 'gpt-live-1',
  // 既定は日本語の声 harema（公式Voice optionsで Japanese / Feminine）。shida は Japanese / Masculine。
  liveVoice: process.env.LIVE_VOICE || 'harema',
  // 画面で選べる声（許可リスト）
  liveVoices: (process.env.LIVE_VOICES || 'harema,shida,marin').split(',').map((s) => s.trim()).filter(Boolean),
  // カンマ区切りで複数指定可（先頭が既定）。例: BRAIN_MODEL=model-a,model-b
  brainModels: (process.env.BRAIN_MODEL ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // Brainの推論量（none/minimal/low/medium/high）。小さいほど速い。空なら指定しない
  brainReasoningEffort: process.env.BRAIN_REASONING_EFFORT ?? 'low',
  brainTimeoutMs: num(process.env.BRAIN_TIMEOUT_MS, 20000),
  liveMaxSessionSeconds: num(process.env.LIVE_MAX_SESSION_SECONDS, 600),
  liveMaxConcurrent: num(process.env.LIVE_MAX_CONCURRENT, 1),
  liveMaxSessionsPerDay: num(process.env.LIVE_MAX_SESSIONS_PER_DAY, 30),
  liveTurnGapMs: num(process.env.LIVE_TURN_GAP_MS, 900),
  liveFillerAfterMs: num(process.env.LIVE_FILLER_AFTER_MS, 2500),
  liveDelegationWaitMs: num(process.env.LIVE_DELEGATION_WAIT_MS, 1200),
  liveProactiveAfterMs: num(process.env.LIVE_PROACTIVE_AFTER_MS, 1500),
  evalMaxLlmRuns: num(process.env.EVAL_MAX_LLM_RUNS, 40),
  // 遅延改善のプロファイル既定値（D16）：baseline（A：改善前）/ lightweight（B）/ hybrid（C：B＋Fast Path）。画面で通話ごとに選べる
  latencyProfile: (['baseline', 'lightweight', 'hybrid'].includes(process.env.LATENCY_PROFILE ?? '') ? process.env.LATENCY_PROFILE : 'hybrid') as 'baseline' | 'lightweight' | 'hybrid',
  // Fast Pathで確定した発話を裏でLLMにも分析させ、一致を記録する（状態には適用しない）。1を指定したときだけ。API費用が発生
  fastPathShadow: process.env.FASTPATH_SHADOW === '1',
  // 画面から実行する1ターン比較ベンチのLLM呼び出し上限
  benchMaxLlmCalls: num(process.env.BENCH_MAX_LLM_CALLS, 120),
  callWaitLimitMs: num(process.env.CALL_WAIT_LIMIT_MS, 20000),
  dataDir: process.env.DATA_DIR ?? 'data',
  dataRetentionHours: num(process.env.DATA_RETENTION_HOURS, 72),
};

export function configSummary() {
  return {
    host: config.host,
    port: config.port,
    production: config.production,
    passwordSet: !!config.appPassword,
    sessionSecretFromEnv: !!process.env.SESSION_SECRET,
    openaiKeySet: !!config.openaiApiKey,
    liveModel: config.liveModel,
    liveVoice: config.liveVoice,
    brainModels: config.brainModels.length ? config.brainModels : '(未設定: Deterministicのみ)',
    brainReasoningEffort: config.brainReasoningEffort || '(指定なし)',
    latencyProfile: config.latencyProfile,
    fastPathShadow: config.fastPathShadow,
  };
}

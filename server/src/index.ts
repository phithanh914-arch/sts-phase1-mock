import express, { type Request, type Response } from 'express';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, configSummary } from './config.js';
import { clearAuthCookie, isAuthed, loginRateLimited, passwordMatches, requireAuth, setAuthCookie } from './auth.js';
import { SessionController } from './session/controller.js';
import { RuleBrain } from './brain/ruleBrain.js';
import { OpenAIBrain } from './brain/openaiBrain.js';
import type { ReceptionBrain } from './brain/types.js';
import { TextSink, Harness } from './eval/harness.js';
import { CASES, runCases, type CaseResult, type MakeHarness } from './eval/cases.js';
import { LiveAdapter } from './live/liveAdapter.js';
import { SPEECH_SPEEDS, SPEECH_TONES, DEFAULT_SPEED, DEFAULT_TONE } from './live/instructions.js';
import type { Conversation } from './session/conversation.js';
import { PROFILES, resolveProfile, summarize, type ProfileName } from './session/latency.js';
import { SUPPORTED_EFFORTS } from './brain/pricing.js';
import { benchCallEstimate, runTurnBench, summarizeBench, TURN_CASES, type TurnCaseResult } from './eval/turnBench.js';

if (config.production && !config.appPassword) {
  console.error('APP_PASSWORD が未設定です。外部公開時はパスワード必須のため起動しません。');
  process.exit(1);
}

// ───────── Brain ─────────
const brains: Record<string, ReceptionBrain> = { rule: new RuleBrain() };
// BRAIN_MODELを複数指定した場合は llm, llm2, llm3… として画面で選べる（先頭が既定）
if (config.openaiApiKey) config.brainModels.forEach((m, i) => { brains[i === 0 ? 'llm' : `llm${i + 1}`] = new OpenAIBrain(m, config.openaiApiKey, config.brainTimeoutMs, config.brainReasoningEffort); });
const defaultBrain = brains.llm ? 'llm' : 'rule';

const ctl = new SessionController({ brains, defaultBrain, dataDir: config.dataDir, brainTimeoutMs: config.brainTimeoutMs, callWaitLimitMs: config.callWaitLimitMs, defaultProfile: config.latencyProfile, fastPathShadow: config.fastPathShadow });
const live = config.openaiApiKey
  ? new LiveAdapter({ apiKey: config.openaiApiKey, model: config.liveModel, voice: config.liveVoice, voices: config.liveVoices, maxSessionSeconds: config.liveMaxSessionSeconds, maxConcurrent: config.liveMaxConcurrent, maxSessionsPerDay: config.liveMaxSessionsPerDay, turnGapMs: config.liveTurnGapMs, delegationWaitMs: config.liveDelegationWaitMs, fillerAfterMs: config.liveFillerAfterMs }, ctl)
  : null;

// ログ保存期限（既定72時間）を過ぎた会話ログを削除
function cleanupData() {
  if (!existsSync(config.dataDir)) return;
  const limit = Date.now() - config.dataRetentionHours * 3600_000;
  for (const f of readdirSync(config.dataDir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(config.dataDir, f);
    try { if (statSync(p).mtimeMs < limit) unlinkSync(p); } catch { /* ignore */ }
  }
}
cleanupData();
setInterval(cleanupData, 3600_000).unref();

// ───────── HTTP ─────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (loginRateLimited(ip)) return res.status(429).json({ error: 'too_many_attempts' });
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!passwordMatches(pw)) return res.status(401).json({ error: 'invalid_password' });
  setAuthCookie(req, res);
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => { clearAuthCookie(res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req), passwordRequired: !!config.appPassword || config.production }));

const api = express.Router();
api.use(requireAuth);

const getConv = (req: Request, res: Response): Conversation | null => {
  const c = ctl.conversations.get(String(req.params.id));
  if (!c) { res.status(404).json({ error: 'not_found' }); return null; }
  return c;
};

api.get('/config', (_req, res) => {
  res.json({
    liveEnabled: !!live,
    brains: Object.fromEntries(Object.entries(brains).map(([k, b]) => [k, b.name])),
    defaultBrain,
    liveModel: config.liveModel,
    liveVoice: config.liveVoice,
    liveVoices: config.liveVoices,
    speechSpeeds: Object.fromEntries(Object.entries(SPEECH_SPEEDS).map(([k, v]) => [k, v.label])),
    speechTones: Object.fromEntries(Object.entries(SPEECH_TONES).map(([k, v]) => [k, v.label])),
    defaultSpeed: DEFAULT_SPEED,
    defaultTone: DEFAULT_TONE,
    liveUsage: live?.usage() ?? null,
    faults: ctl.faults,
    summary: configSummary(),
    cases: CASES.map((c) => ({ id: c.id, title: c.title, expected: c.expected })),
    evalMaxLlmRuns: config.evalMaxLlmRuns,
    profiles: Object.fromEntries(Object.values(PROFILES).map((p) => [p.name, p.label])),
    defaultProfile: config.latencyProfile,
    supportedEfforts: SUPPORTED_EFFORTS,
    benchCases: TURN_CASES.length,
    benchMaxLlmCalls: config.benchMaxLlmCalls,
  });
});

api.put('/faults', (req, res) => {
  const b = req.body ?? {};
  if (['success', 'delay', 'precommit_fail', 'commit_then_timeout', 'field_error'].includes(b.rpa)) ctl.faults.rpa = b.rpa;
  if (['success', 'fail'].includes(b.transfer)) ctl.faults.transfer = b.transfer;
  res.json(ctl.faults);
});

api.get('/conversations', (_req, res) => {
  res.json([...ctl.conversations.values()].reverse().slice(0, 50).map((c) => ({ id: c.id, createdAt: c.createdAt, mode: c.mode, route: c.route.route, callState: c.callState, receptionState: c.receptionState, registrationState: c.registrationState })));
});

api.post('/conversations', (req, res) => {
  const c = ctl.create('text', new TextSink(() => ctl), typeof req.body?.brain === 'string' ? req.body.brain : undefined, req.body?.profile);
  res.json(c);
});

api.get('/conversations/:id', (req, res) => { const c = getConv(req, res); if (c) res.json(c); });

api.get('/conversations/:id/events', (req, res) => {
  const c = getConv(req, res);
  if (!c) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  let timer: NodeJS.Timeout | undefined;
  const push = () => {
    clearTimeout(timer);
    timer = setTimeout(() => res.write(`data: ${JSON.stringify(c)}\n\n`), 80);
  };
  push();
  const unsub = ctl.subscribe(c.id, push);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { unsub(); clearInterval(ping); clearTimeout(timer); });
});

api.post('/conversations/:id/say', async (req, res) => {
  const c = getConv(req, res);
  if (!c) return;
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
  if (!text) return res.status(400).json({ error: 'text required' });
  if (c.mode !== 'text') return res.status(400).json({ error: '音声セッションでは文字入力できません' });
  if (c.callState === 'ENDED') return res.status(409).json({ error: '通話は終了しています' });
  await ctl.customerSays(c, text);
  res.json({ ok: true });
});

api.post('/conversations/:id/hangup', (req, res) => {
  const c = getConv(req, res);
  if (!c) return;
  const reason = req.body?.reason === 'disconnected' ? 'disconnected' : 'hangup';
  if (c.mode === 'live' && live) live.close(c, reason);
  else ctl.endCall(c, reason);
  res.json({ ok: true });
});

api.post('/conversations/:id/reconcile', (req, res) => { const c = getConv(req, res); if (c) res.json({ ok: !!ctl.reconcile(c) }); });
api.post('/conversations/:id/retry', (req, res) => { const c = getConv(req, res); if (c) res.json({ ok: ctl.retry(c) }); });
api.post('/conversations/:id/resubmit', (req, res) => { const c = getConv(req, res); if (c) res.json(ctl.resubmitSameJob(c) ?? { error: 'no job' }); });

// ブラウザが測った「顧客の声が止んでからAIの音声が聞こえ始めるまで」（ms）。時間の値だけを受け取る（音声そのものは送らない）
api.post('/conversations/:id/client-timing', (req, res) => {
  const c = getConv(req, res);
  if (!c) return;
  const v = Number(req.body?.playbackLatencyMs);
  if (!Number.isFinite(v) || v < 0 || v > 60000) return res.status(400).json({ error: 'playbackLatencyMs (0-60000) が必要です' });
  res.json({ attached: ctl.addClientOnset(c, v) });
});

// 遅延の集計（このサーバが起動してからの会話。再起動で消える）
api.get('/metrics/latency', (_req, res) => {
  const turns = [...ctl.conversations.values()].flatMap((c) => c.turns);
  res.json({ note: 'live=実機音声の計測（Liveの時間軸）／text=文字入力（音声なし）。混同しないこと', turns: turns.length, summary: summarize(turns) });
});

api.get('/core', (_req, res) => res.json({ notice: 'MOCK：模擬基幹の登録台帳（実基幹ではない）', records: ctl.core.all() }));

api.post('/live/session', async (req, res) => {
  if (!live) return res.status(503).json({ error: 'OPENAI_API_KEY がサーバに設定されていません' });
  const sdp = req.body?.sdp;
  if (typeof sdp !== 'string' || !sdp.trim()) return res.status(400).json({ error: 'SDP offer が必要です' });
  try {
    const r = await live.start(sdp, typeof req.body?.brain === 'string' ? req.body.brain : undefined, typeof req.body?.voice === 'string' ? req.body.voice : undefined, { speed: req.body?.speed, tone: req.body?.tone }, req.body?.profile);
    res.status(201).json(r);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.error('Live session creation failed', err.status, err.message);
    res.status(err.status && err.status < 600 ? err.status : 502).json({ error: `Liveセッション作成に失敗: ${err.message ?? ''}`.slice(0, 300) });
  }
});

// ───────── 受入テスト実行（画面から） ─────────
interface EvalRun { id: string; brain: string; status: 'running' | 'done'; startedAt: string; results: CaseResult[]; total: number; note: string }
const evalRuns = new Map<string, EvalRun>();
api.post('/eval/run', (req, res) => {
  const brain = typeof req.body?.brain === 'string' && brains[req.body.brain] ? req.body.brain : 'rule';
  const ids: string[] | null = Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids.map(String) : null;
  const reps = Math.min(Math.max(Number(req.body?.repetitions) || 1, 1), 5);
  const total = (ids?.length ?? CASES.length) * reps;
  if (brain !== 'rule' && total > config.evalMaxLlmRuns) return res.status(400).json({ error: `LLM利用の実行は最大${config.evalMaxLlmRuns}回までです（指定: ${total}）` });
  if ([...evalRuns.values()].some((r) => r.status === 'running')) return res.status(409).json({ error: '別の評価を実行中です' });
  const run: EvalRun = { id: `EVAL-${randomUUID().slice(0, 8)}`, brain, status: 'running', startedAt: new Date().toISOString(), results: [], total, note: brain === 'rule' ? 'Deterministic比較モード（API不使用）' : `LLM Brain: ${brains[brain].name}（API費用が発生）` };
  evalRuns.set(run.id, run);
  const profile = resolveProfile(req.body?.profile, config.latencyProfile).name;
  run.note += ` / ${PROFILES[profile].label}`;
  const make: MakeHarness = (opts = {}) => {
    const b = opts.wrapBrain ? opts.wrapBrain(brains[brain]) : brains[brain];
    return new Harness({ [brain]: b }, brain, { brainTimeoutMs: opts.brainTimeoutMs ?? (brain === 'rule' ? 30000 : config.brainTimeoutMs), profile, ...opts });
  };
  void runCases(make, ids, reps, (r) => run.results.push(r)).finally(() => { run.status = 'done'; });
  res.json(run);
});
api.get('/eval/:id', (req, res) => {
  const r = evalRuns.get(String(req.params.id));
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json(r);
});

// ───────── 1ターン比較ベンチ（A/B/C、テキスト経路、画面から） ─────────
interface BenchRun { id: string; brain: string; status: 'running' | 'done'; startedAt: string; finishedAt?: string; expected: number; results: TurnCaseResult[]; note: string }
const benchRuns = new Map<string, BenchRun>();
api.post('/bench/run', (req, res) => {
  const brain = typeof req.body?.brain === 'string' && brains[req.body.brain] ? req.body.brain : 'rule';
  const profiles = (Array.isArray(req.body?.profiles) ? req.body.profiles : ['baseline', 'lightweight', 'hybrid']).filter((p: unknown): p is ProfileName => typeof p === 'string' && Object.hasOwn(PROFILES, p));
  const efforts: string[] = (Array.isArray(req.body?.efforts) ? req.body.efforts : []).filter((e: unknown): e is string => typeof e === 'string' && ['none', 'minimal', 'low', 'medium', 'high'].includes(e));
  const reps = Math.min(Math.max(Number(req.body?.repetitions) || 1, 1), 3);
  if (!profiles.length) return res.status(400).json({ error: 'profiles が空です' });
  const expected = benchCallEstimate(profiles, efforts, null, reps);
  if (brain !== 'rule' && expected > config.benchMaxLlmCalls) return res.status(400).json({ error: `LLM呼び出しは最大${config.benchMaxLlmCalls}回までです（見込み: ${expected}）` });
  if ([...benchRuns.values()].some((r) => r.status === 'running') || [...evalRuns.values()].some((r) => r.status === 'running')) return res.status(409).json({ error: '別の評価を実行中です' });
  const run: BenchRun = { id: `BENCH-${randomUUID().slice(0, 8)}`, brain, status: 'running', startedAt: new Date().toISOString(), expected, results: [], note: brain === 'rule' ? 'Deterministic（API不使用）' : `LLM Brain: ${brains[brain].name}（API費用が発生）` };
  benchRuns.set(run.id, run);
  void runTurnBench(brains[brain], { profiles, efforts, reps, brainTimeoutMs: config.brainTimeoutMs, onResult: (r) => run.results.push(r) }).finally(() => { run.status = 'done'; run.finishedAt = new Date().toISOString(); });
  res.json({ ...run, summary: [] });
});
api.get('/bench/:id', (req, res) => {
  const r = benchRuns.get(String(req.params.id));
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json({ ...r, summary: summarizeBench(r.results) });
});

app.use('/api', api);

// ───────── 静的ファイル（ビルド済みフロント） ─────────
const clientDist = resolve('client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false }));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

app.listen(config.port, config.host, () => {
  console.log(`STS受付モック: http://${config.host}:${config.port}`);
  console.log('設定:', JSON.stringify(configSummary()));
  if (!config.appPassword) console.log('注意: APP_PASSWORD 未設定（ローカル開発のみ許可）');
});

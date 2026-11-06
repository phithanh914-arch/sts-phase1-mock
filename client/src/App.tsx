import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { startLive, type LiveHandle } from './live';
import type { Conv, Fact, Job, Turn } from './types';

const LABEL: Record<string, string> = {
  emergency_signal: '緊急信号', unsafe_to_continue_signal: '安全上の懸念', towing_requested: 'レッカー希望', physically_drivable: '走行可否',
  injuries_present: 'けが・痛み', occupants: '乗員', all_occupants_injury_checked: '全乗員のけが確認', other_person_or_vehicle_involved: '他の人・車の関与',
  parked_vehicle_unoccupied: '相手車は無人の駐車車両か', third_party_property_involved: '物への接触', property_ownership: '接触物の所有（自己/公共物/他人）',
  counterparty_name: '相手の名前', counterparty_address: '相手の住所', counterparty_phone: '相手の電話番号', police_reported: '警察への届出', incident_kind: '事案種別', human_requested: '有人希望',
  caller_name_kana: '連絡者氏名(読み)', callback_phone: '折返し電話', caller_is_policyholder: '契約者本人か', policy_number: '証券番号', vehicle_plate: '登録番号',
  accident_date: '事故日', accident_time: '時刻', time_approximate: '概算', municipality: '場所(市区郡)', location_detail: '場所詳細', accident_description: '事故状況',
  driver: '運転者', damage: '損傷', repair_shop: '修理先', sms_allowed: 'SMS可否', policy_match: '契約特定(2項目一致)',
};
const ELIG = ['emergency_signal', 'unsafe_to_continue_signal', 'towing_requested', 'injuries_present', 'all_occupants_injury_checked', 'other_person_or_vehicle_involved', 'third_party_property_involved', 'property_ownership', 'incident_kind', 'human_requested'];
const VOICE_JA: Record<string, string> = { harema: '日本語・女性', shida: '日本語・男性', marin: '標準・英語系' };
const ROUTE_JA: Record<string, string> = { TOWING: 'レッカー担当へ', SELF_SERVICE: 'AI受付（自動完結候補）', OPERATOR: 'オペレーターへ', OPERATOR_EMERGENCY: '緊急：オペレーターへ', UNRESOLVED: '確認中' };

interface Cfg {
  liveEnabled: boolean; brains: Record<string, string>; defaultBrain: string; liveModel: string; liveVoice: string; liveVoices: string[]; speechSpeeds: Record<string, string>; speechTones: Record<string, string>; defaultSpeed: string; defaultTone: string;
  liveUsage: { activeSessions: number; sessionsToday: number; maxPerDay: number; maxSessionSeconds: number } | null;
  faults: { rpa: string; transfer: string }; cases: { id: string; title: string; expected: string }[]; evalMaxLlmRuns: number;
  summary: Record<string, unknown>;
  profiles: Record<string, string>; defaultProfile: string; supportedEfforts: Record<string, string[]>; benchCases: number; benchMaxLlmCalls: number;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => { api<{ authed: boolean }>('/me').then((r) => setAuthed(r.authed)).catch(() => setAuthed(false)); }, []);
  if (authed === null) return <div className="center">読み込み中…</div>;
  if (!authed) return <Login onOk={() => setAuthed(true)} />;
  return <Main />;
}

function Login({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="center">
      <form className="card login" onSubmit={async (e) => { e.preventDefault(); try { await api('/login', { json: { password: pw } }); onOk(); } catch (x) { setErr((x as Error).message === 'too_many_attempts' ? '試行回数が多すぎます。10分後に再試行してください' : 'パスワードが違います'); } }}>
        <h2>STS受付モック</h2>
        <p className="muted">検証用モック（架空データのみ）。アクセス用パスワードを入力してください。</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="パスワード" autoFocus />
        <button type="submit">ログイン</button>
        {err && <p className="err">{err}</p>}
      </form>
    </div>
  );
}

function Main() {
  const [tab, setTab] = useState<'call' | 'eval' | 'core'>('call');
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const reload = () => api<Cfg>('/config').then(setCfg);
  useEffect(() => { void reload(); }, []);
  if (!cfg) return <div className="center">読み込み中…</div>;
  return (
    <div className="app">
      <header>
        <strong>車両単独事故 STS受付モック</strong>
        <span className="badge mock">MOCK・架空データのみ</span>
        <nav>
          <button className={tab === 'call' ? 'on' : ''} onClick={() => setTab('call')}>通話・検証</button>
          <button className={tab === 'eval' ? 'on' : ''} onClick={() => setTab('eval')}>受入テスト</button>
          <button className={tab === 'core' ? 'on' : ''} onClick={() => setTab('core')}>模擬基幹台帳</button>
        </nav>
        <button className="link" onClick={async () => { await api('/logout', { json: {} }); location.reload(); }}>ログアウト</button>
      </header>
      {tab === 'call' && <CallView cfg={cfg} reloadCfg={reload} />}
      {tab === 'eval' && <EvalView cfg={cfg} />}
      {tab === 'core' && <CoreView />}
    </div>
  );
}

function CallView({ cfg, reloadCfg }: { cfg: Cfg; reloadCfg: () => void }) {
  const [conv, setConv] = useState<Conv | null>(null);
  const [brain, setBrain] = useState(cfg.defaultBrain);
  const [voice, setVoice] = useState(cfg.liveVoice);
  const [speed, setSpeed] = useState(cfg.defaultSpeed);
  const [tone, setTone] = useState(cfg.defaultTone);
  const [profile, setProfile] = useState(cfg.defaultProfile);
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const liveRef = useRef<LiveHandle | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const follow = (id: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/conversations/${id}/events`);
    es.onmessage = (m) => setConv(JSON.parse(m.data));
    esRef.current = es;
  };
  useEffect(() => () => esRef.current?.close(), []);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [conv?.utterances.length]);

  const startText = async () => {
    const c = await api<Conv>('/conversations', { json: { brain, profile } });
    setConv(c); follow(c.id); setStatus('テキストモードで開始');
  };
  const startVoice = async () => {
    setBusy(true); setStatus('接続中…（マイクの使用を許可してください）');
    try {
      const h = await startLive({ brain, voice, speed, tone, profile, audio: audioRef.current!, onStatus: setStatus, onClosed: (r) => { setStatus(`通話終了（${r}）`); liveRef.current = null; reloadCfg(); } });
      liveRef.current = h; follow(h.conversationId); setMuted(false);
    } catch (e) { setStatus(`開始できません: ${(e as Error).message}`); }
    setBusy(false);
  };
  const send = async () => {
    if (!conv || !text.trim()) return;
    const t = text; setText(''); setBusy(true);
    try { await api(`/conversations/${conv.id}/say`, { json: { text: t } }); } catch (e) { setStatus((e as Error).message); }
    setBusy(false);
  };
  const hangup = async (reason: 'hangup' | 'disconnected') => {
    if (!conv) return;
    if (liveRef.current && reason === 'hangup') liveRef.current.close();
    await api(`/conversations/${conv.id}/hangup`, { json: { reason } });
  };
  const setFault = async (k: 'rpa' | 'transfer', v: string) => { await api('/faults', { method: 'PUT', body: JSON.stringify({ [k]: v }) }); reloadCfg(); };
  const act = (p: string) => conv && api(`/conversations/${conv.id}/${p}`, { json: {} });
  const ended = !conv || conv.callState === 'ENDED';

  return (
    <div className="grid">
      <section className="col left">
        <div className="card">
          <h3>通話操作</h3>
          <div className="row">
            <label>受付Brain：
              <select value={brain} onChange={(e) => setBrain(e.target.value)} disabled={!ended}>
                {Object.entries(cfg.brains).map(([k, n]) => <option key={k} value={k}>{k === 'rule' ? 'Deterministic比較（API不使用）' : `LLM (${n})`}</option>)}
              </select>
            </label>
            <label>話者（声）：
              <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={!ended}>
                {cfg.liveVoices.map((v) => <option key={v} value={v}>{VOICE_JA[v] ? `${v}（${VOICE_JA[v]}）` : v}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label>話し方・速さ：
              <select value={speed} onChange={(e) => setSpeed(e.target.value)} disabled={!ended}>
                {Object.entries(cfg.speechSpeeds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label>トーン：
              <select value={tone} onChange={(e) => setTone(e.target.value)} disabled={!ended}>
                {Object.entries(cfg.speechTones).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <label>応答速度の構成：
              <select value={profile} onChange={(e) => setProfile(e.target.value)} disabled={!ended}>
                {Object.entries(cfg.profiles).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            <button disabled={!ended || busy || !cfg.liveEnabled} onClick={startVoice} title={cfg.liveEnabled ? '' : 'OPENAI_API_KEY未設定'}>🎤 音声で開始（GPT-Live）</button>
            <button disabled={!ended || busy} onClick={startText}>⌨ テキストで開始</button>
          </div>
          <div className="row">
            <button disabled={!liveRef.current} onClick={() => { liveRef.current?.mute(!muted); setMuted(!muted); }}>{muted ? 'ミュート解除' : 'ミュート'}</button>
            <button disabled={ended} onClick={() => hangup('hangup')}>通話終了</button>
            <button disabled={ended} onClick={() => hangup('disconnected')} title="接続断を模擬">切断を模擬</button>
          </div>
          <audio ref={audioRef} autoPlay controls className="audio" />
          <p className="muted small">{status}</p>
          {cfg.liveUsage && <p className="muted small">Live: {cfg.liveModel} / 声・話し方は通話開始時に固定（途中変更不可、音声モードのみ有効） ・本日 {cfg.liveUsage.sessionsToday}/{cfg.liveUsage.maxPerDay} セッション・1通話上限 {cfg.liveUsage.maxSessionSeconds}秒{conv?.live.sessionId ? ` ・音声 ${conv.live.voiceSeconds.toFixed(0)}秒（約$${(conv.live.voiceSeconds / 60 * 0.05).toFixed(3)}＋Brain費用）` : ''}</p>}
          {!cfg.liveEnabled && <p className="warn small">OPENAI_API_KEY が未設定のため音声は無効です（テキストのDeterministicモードは利用可）。</p>}
        </div>

        <div className="card grow">
          <h3>会話 <span className="muted small">（入力／実際の出力／送信予定を区別）</span></h3>
          <div className="log" ref={logRef}>
            {conv?.utterances.map((u) => (
              <div key={u.id} className={`utt ${u.speaker} ${u.kind}`}>
                <span className="who">{u.speaker === 'customer' ? '顧客' : u.speaker === 'ai' ? (u.kind === 'planned' ? 'AI(予定)' : 'AI') : 'SYS'}</span>
                <span className="id">{u.id}{u.startMs !== undefined ? ` ${(u.startMs / 1000).toFixed(1)}s` : ''}{u.tag ? ` [${u.tag.split(':')[0]}]` : ''}</span>
                <span className="txt">{u.text}</span>
              </div>
            ))}
          </div>
          {conv?.mode === 'text' && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="顧客として入力（例：レッカーはいりません。今朝、自分の車庫の壁に…）" disabled={ended || busy} />
              <button disabled={ended || busy}>送信</button>
            </form>
          )}
        </div>

        <div className="card">
          <h3>テスト操作（障害注入）</h3>
          <div className="row">
            <label>模擬RPA：
              <select value={cfg.faults.rpa} onChange={(e) => setFault('rpa', e.target.value)}>
                <option value="success">成功</option><option value="delay">遅延（通話待機限度超過）</option>
                <option value="precommit_fail">未登録が確認できる失敗</option><option value="commit_then_timeout">登録済みだが応答喪失</option>
                <option value="field_error">項目エラー</option>
              </select>
            </label>
            <label>模擬転送：
              <select value={cfg.faults.transfer} onChange={(e) => setFault('transfer', e.target.value)}>
                <option value="success">成功</option><option value="fail">失敗</option>
              </select>
            </label>
          </div>
          <p className="muted small">設定は次の処理から適用（全会話共通）。</p>
        </div>
      </section>

      <section className="col right">
        {!conv ? <div className="card"><p className="muted">「音声で開始」または「テキストで開始」を押してください。</p></div> : <Panels conv={conv} act={act} />}
      </section>
    </div>
  );
}

function val(f: Fact | undefined) {
  if (!f || f.status === 'missing') return <span className="muted">未確認</span>;
  if (f.status === 'explicitly_unknown') return <span className="tag unk">不明（申告）</span>;
  if (f.status === 'conflict') return <span className="tag bad">要再確認</span>;
  if (typeof f.value === 'boolean') return f.value ? 'はい' : 'いいえ';
  return String(f.value);
}

function Panels({ conv, act }: { conv: Conv; act: (p: string) => void }) {
  const [showDebug, setShowDebug] = useState(false);
  const job = conv.jobs.find((j) => j.job.job_id === conv.activeJobId) as Job | undefined;
  const otherFacts = Object.keys(conv.facts).filter((k) => !ELIG.includes(k));
  return (
    <>
      <div className="card">
        <h3>状態</h3>
        <div className="states">
          <div><small>通話</small><b className={`st ${conv.callState}`}>{conv.callState}</b></div>
          <div><small>受付</small><b className={`st ${conv.receptionState}`}>{conv.receptionState}</b></div>
          <div><small>登録</small><b className={`st ${conv.registrationState}`}>{conv.registrationState}</b></div>
          <div><small>版</small><b>v{conv.version}</b></div>
          <div><small>Brain</small><b className="small">{conv.brainName}</b></div>
          <div><small>構成</small><b className="small">{conv.profile}</b></div>
        </div>
      </div>

      <LatencyPanel turns={conv.turns ?? []} mode={conv.mode} />

      <div className="card">
        <h3>対象判定 <span className={`route ${conv.route.route}`}>{ROUTE_JA[conv.route.route]}</span></h3>
        <p className="small">根拠：{conv.route.reasons.join(' / ') || '—'}</p>
        {conv.route.safetyFlags.length > 0 && <p className="err small">危険信号：{conv.route.safetyFlags.join(', ')}</p>}
        {conv.route.unresolved.length > 0 && <p className="small">未確認：{conv.route.unresolved.map((k) => LABEL[k] ?? k).join('、')}</p>}
        <table className="facts"><tbody>
          {ELIG.map((k) => <tr key={k}><th>{LABEL[k]}</th><td>{val(conv.facts[k])}</td><td className="muted small">{conv.facts[k]?.originalExpression ?? ''}</td></tr>)}
        </tbody></table>
        {conv.transfer && (
          <div className="box">
            <b>転送（模擬）</b>：{conv.transfer.target} → <span className={`st ${conv.transfer.status}`}>{conv.transfer.status}</span>
            {conv.transfer.status === 'TRANSFER_FAILED' && <p className="warn small">模擬有人対応画面：転送失敗。通話は継続中。代替（折返し・別キュー）を担当が判断します。</p>}
            <details><summary className="small">引継ぎパッケージ</summary><pre>{JSON.stringify(conv.transfer.package, null, 1)}</pre></details>
          </div>
        )}
      </div>

      <div className="card">
        <h3>会話目的・不足項目 <span className="muted small">{conv.profile === 'baseline' ? '（Brainが選択。固定順ではない）' : '（次の質問はコードが選択。Brainは発話の理解に専念）'}</span></h3>
        <p className="small"><b>次の目的：</b>{conv.nextIntent || '—'}</p>
        <p className="small"><b>確認したい情報：</b>{conv.desiredInformation.map((k) => LABEL[k] ?? k).join('、') || '—'}</p>
        <p className="small"><b>判断メモ：</b>{conv.lastBriefReason || '—'}</p>
        {conv.customerNeeds.length > 0 && <p className="small"><b>顧客ニーズ：</b>{conv.customerNeeds.join('、')}</p>}
        <p className="small"><b>契約特定：</b>{conv.policy.matched ? `一致（${conv.policy.matchedItems.join('+')}）※本人認証ではない` : '未特定'}</p>
      </div>

      <div className="card">
        <h3>受付データ（根拠付き）</h3>
        <table className="facts"><tbody>
          {otherFacts.map((k) => {
            const f = conv.facts[k];
            return (
              <tr key={k}>
                <th>{LABEL[k] ?? k}</th><td>{val(f)}</td>
                <td className="muted small">{f.evidenceRefs.join(',')}{f.history.length > 0 && <span title={JSON.stringify(f.history)}> ・訂正{f.history.length}回（旧: {f.history.map((h) => String(h.value)).join('→')}）</span>}</td>
              </tr>
            );
          })}
        </tbody></table>
      </div>

      <div className="card">
        <h3>RPA登録状況 <span className="badge mock">MOCK</span></h3>
        {conv.confirmation ? (
          <div className="box small">
            <b>最終確認</b> {conv.confirmation.confirmationId}（v{conv.confirmation.snapshotVersion}）：<span className={`st ${conv.confirmation.status}`}>{conv.confirmation.status}</span>
            {conv.confirmation.invalidatedReason && <span className="muted"> ・失効理由 {conv.confirmation.invalidatedReason}</span>}
            <div className="muted">hash {conv.confirmation.snapshotHash.slice(0, 16)}… ・読上げ出力 {conv.confirmation.readbackDelivered ? '確認済' : '未確認'}</div>
          </div>
        ) : <p className="muted small">最終確認：未作成</p>}
        {job ? (
          <div className="box small">
            <b>ジョブ</b> {job.job.job_id} ：<span className={`st ${job.state}`}>{job.state}</span>{job.failure && <span className="err"> {job.failure}</span>}{job.delayed && <span className="warn"> 遅延</span>}
            <div className="muted">idempotency_key {job.job.idempotency_key} ・attempts {job.attempts}</div>
            {job.result && <div className="ok">模擬基幹 登録番号 {job.result.core_registration_id} ・照合 {job.result.readback_verified ? 'OK' : 'NG'}</div>}
            <div className="row">
              <button disabled={job.state !== 'OUTCOME_UNKNOWN'} onClick={() => act('reconcile')}>基幹台帳を照合</button>
              <button disabled={!(job.state === 'FAILED' && job.failure === 'FAILED_PRECOMMIT')} onClick={() => act('retry')}>同一ジョブ再試行</button>
              <button onClick={() => act('resubmit')} title="同じjob_id/idempotency_keyで二重要求">二重要求を送る</button>
            </div>
            <details><summary>ジョブログ</summary><pre>{job.log.map((l) => `${l.at.slice(11, 19)} ${l.event} ${l.detail ?? ''}`).join('\n')}</pre></details>
          </div>
        ) : <p className="muted small">ジョブ：未生成</p>}
        {conv.amendmentPending && <p className="warn small">訂正待ち（有人処理）。自動で2件目は作りません。</p>}
      </div>

      <div className="card">
        <h3><button className="link" onClick={() => setShowDebug(!showDebug)}>Debug {showDebug ? '▲' : '▼'}</button></h3>
        {showDebug && (
          <>
            <h4>分析履歴（base_state_version / watermark）</h4>
            <pre>{conv.analyses.map((a) => `${a.analysisId} ${a.status} ${a.brain ?? ''}${a.fastPathRule ? `(${a.fastPathRule})` : ''} base=v${a.baseStateVersion} wm=${a.inputWatermark} ${a.latencyMs ?? '-'}ms ${a.trigger} changed=${(a.changedKeys ?? []).join(',')} rejected=${JSON.stringify(a.rejectedProposals ?? [])}${a.usage ? ` tokens in=${a.usage.inputTokens} out=${a.usage.outputTokens}` : ''}${a.shadow ? ` shadow=${a.shadow.status} ${(a.shadow.diffs ?? []).join(',')}` : ''}`).join('\n')}</pre>
            <h4>監査ログ</h4>
            <pre>{conv.audit.map((a) => `${a.at.slice(11, 19)} ${a.event} ${a.detail ? JSON.stringify(a.detail) : ''}`).join('\n')}</pre>
            <h4>会話JSON</h4>
            <pre>{JSON.stringify(conv, null, 1)}</pre>
          </>
        )}
      </div>
    </>
  );
}

const ms = (v: number | undefined | null) => (v === undefined || v === null ? '—' : v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(1)}s`);
const p = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.ceil((q / 100) * v.length) - 1)] : undefined; };

/** ターンごとの応答時間（D18）。live=実機音声（Liveの時間軸）、text=文字入力（音声なし）。両者を混同しない */
function LatencyPanel({ turns, mode }: { turns: Turn[]; mode: string }) {
  const done = turns.filter((t) => t.status === 'answered');
  const total = done.map((t) => t.durations.total_ms).filter((x) => x !== undefined);
  const heard = done.map((t) => t.durations.client_playback_ms).filter((x) => x !== undefined);
  const fp = turns.filter((t) => t.fastPath !== 'off');
  const live = mode === 'live';
  return (
    <div className="card">
      <h3>応答時間 <span className="muted small">{mode === 'live' ? '（発話終了→次の質問の音声開始。サーバ計測＝Liveの時間軸／耳＝ブラウザ計測・近似）' : '（文字入力。音声を含まないため実機の値ではない）'}</span></h3>
      <p className="small">
        サーバ計測 P50 {ms(p(total, 50))} ・P95 {ms(p(total, 95))}（{total.length}件）
        {mode === 'live' && <> ／ 耳で聞こえるまで P50 {ms(p(heard, 50))} ・P95 {ms(p(heard, 95))}（{heard.length}件）</>}
        {fp.length > 0 && <> ／ Fast Path {fp.filter((t) => t.fastPath === 'hit').length}/{fp.length}</>}
      </p>
      {turns.length > 0 && (
        <table className="facts small latency"><thead><tr><th>ターン</th><th>経路</th><th>合計</th>{live && <><th>耳</th><th>最初の音</th><th>区切り検知</th></>}<th>Brain</th>{live && <><th>送信待ち</th><th>音声開始</th></>}</tr></thead><tbody>
          {turns.slice(-12).map((t) => (
            <tr key={t.turnId} title={`${t.brain} effort=${t.effort ?? '-'} ${t.fallbackReason ?? ''} ${t.errors.join(',')}`}>
              <td>{t.turnId}{t.status !== 'answered' ? `（${t.status === 'open' ? '処理中' : t.status === 'interrupted' ? '割込み' : '中断'}）` : ''}</td>
              <td>{t.fastPath === 'hit' ? `Fast Path（${t.fastPathRule}）` : t.analyses ? `LLM${t.fastPath === 'miss' ? `（${t.fallbackReason?.split(':')[0]}）` : ''}` : '—'}</td>
              <td><b>{ms(t.durations.total_ms)}</b></td>
              {live && <><td>{ms(t.durations.client_playback_ms)}</td><td>{ms(t.durations.first_sound_ms ?? t.durations.client_first_sound_ms)}</td><td>{ms(t.durations.endpointing_ms)}</td></>}
              <td>{ms(t.durations.brain_ms ?? t.durations.fastpath_ms)}</td>
              {live && <><td>{ms(t.durations.send_wait_ms)}</td><td>{ms(t.durations.audio_start_ms)}</td></>}
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

interface EvalRun { id: string; status: string; brain: string; total: number; note: string; results: { id: string; title: string; expected: string; repetition: number; pass: boolean; ms: number; error?: string; checks: { name: string; pass: boolean; detail?: string }[] }[] }

function EvalView({ cfg }: { cfg: Cfg }) {
  return (<><AcceptanceView cfg={cfg} /><BenchView cfg={cfg} /></>);
}

interface BenchResult { id: string; category: string; profile: string; effort: string | null; fastPath: string; failures: string[]; totalMs: number | null; brainMs: number | null }
interface Stat { n: number; p50: number | null; p95: number | null }
interface BenchRunView { id: string; status: string; note: string; expected: number; results: BenchResult[]; summary: { profile: string; effort: string | null; runs: number; total: Stat; brain: Stat; fastPathRate: number | null; fastPathWrong: number; accuracy: number; safetyFailures: number; costUsd: number | null; llmCalls: number }[] }

/** 1ターン比較ベンチ（D19）：同じ発話データでA/B/Cを比べる（テキスト経路・音声なし） */
function BenchView({ cfg }: { cfg: Cfg }) {
  const llm = Object.keys(cfg.brains).find((k) => k !== 'rule') ?? 'rule';
  const [brain, setBrain] = useState(llm);
  const [profiles, setProfiles] = useState<string[]>(['baseline', 'lightweight', 'hybrid']);
  const [efforts, setEfforts] = useState<string[]>([]);
  const [run, setRun] = useState<BenchRunView | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const t = setInterval(async () => setRun(await api<BenchRunView>(`/bench/${run.id}`)), 1000);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);
  const est = profiles.length * Math.max(1, efforts.length) * cfg.benchCases;
  const toggle = (xs: string[], x: string, on: boolean) => (on ? [...xs, x] : xs.filter((y) => y !== x));
  const start = async () => { setErr(''); try { setRun(await api<BenchRunView>('/bench/run', { json: { brain, profiles, efforts } })); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="card wide">
      <h3>応答速度の比較（A改善前／B軽量化／C Hybrid）</h3>
      <p className="small muted">同じ合成発話{cfg.benchCases}件で、Brain処理時間・Fast Path適用率・事実抽出の正確性・安全上の判定を比べます。文字入力での計測のため、音声（GPT-Live）を含む実機の応答時間とは別の値です。LLMはAPI費用が発生します（最大{cfg.benchMaxLlmCalls}回）。</p>
      <div className="row">
        <label>Brain：<select value={brain} onChange={(e) => setBrain(e.target.value)}>{Object.keys(cfg.brains).map((k) => <option key={k} value={k}>{k === 'rule' ? 'Deterministic比較' : `LLM (${cfg.brains[k]})`}</option>)}</select></label>
        {Object.entries(cfg.profiles).map(([k, l]) => <label key={k} className="chip"><input type="checkbox" checked={profiles.includes(k)} onChange={(e) => setProfiles(toggle(profiles, k, e.target.checked))} />{l.split('（')[0]}</label>)}
      </div>
      <div className="row">
        <span className="small">推論量の比較（未選択なら BRAIN_REASONING_EFFORT）：</span>
        {['none', 'low', 'medium'].map((k) => <label key={k} className="chip"><input type="checkbox" checked={efforts.includes(k)} onChange={(e) => setEfforts(toggle(efforts, k, e.target.checked))} />{k}</label>)}
        <span className="small muted">実行見込み 最大{est}回</span>
        <button onClick={start} disabled={run?.status === 'running' || !profiles.length}>比較を実行</button>
      </div>
      {err && <p className="err">{err}</p>}
      {run && (
        <>
          <p><b>{run.status === 'running' ? '実行中…' : '完了'}</b> {run.note} ・{run.results.length}/{run.expected}</p>
          <table className="facts eval"><thead><tr><th>構成</th><th>推論量</th><th>件数</th><th>応答P50</th><th>応答P95</th><th>Brain P50</th><th>Brain P95</th><th>Fast Path適用率</th><th>Fast Path誤判定</th><th>正確性</th><th>安全上の失敗</th><th>推定費用</th></tr></thead><tbody>
            {(run.summary ?? []).map((x) => (
              <tr key={`${x.profile}-${x.effort}`}>
                <td>{cfg.profiles[x.profile]?.split('（')[0] ?? x.profile}</td><td>{x.effort ?? '-'}</td><td>{x.runs}</td>
                <td>{ms(x.total.p50)}</td><td>{ms(x.total.p95)}</td><td>{ms(x.brain.p50)}</td><td>{ms(x.brain.p95)}</td>
                <td>{x.fastPathRate === null ? '0%' : `${Math.round(x.fastPathRate * 100)}%`}</td><td className={x.fastPathWrong ? 'err' : ''}>{x.fastPathWrong}</td>
                <td>{Math.round(x.accuracy * 100)}%</td><td className={x.safetyFailures ? 'err' : 'ok'}>{x.safetyFailures}</td><td>{x.costUsd === null ? '不明' : `$${x.costUsd.toFixed(4)}`}</td>
              </tr>
            ))}
          </tbody></table>
          <details><summary className="small">失敗したケース（{run.results.filter((r) => r.failures.length).length}件）</summary>
            <table className="facts eval small"><tbody>
              {run.results.filter((r) => r.failures.length).map((r, i) => <tr key={i}><td>{r.id}</td><td>{r.category}</td><td>{r.profile}</td><td>{r.effort ?? '-'}</td><td>{r.fastPath}</td><td className="err">{r.failures.join(' / ')}</td></tr>)}
            </tbody></table>
          </details>
        </>
      )}
    </div>
  );
}

function AcceptanceView({ cfg }: { cfg: Cfg }) {
  const [brain, setBrain] = useState('rule');
  const [reps, setReps] = useState(3);
  const [profile, setProfile] = useState(cfg.defaultProfile);
  const [sel, setSel] = useState<string[]>([]);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const t = setInterval(async () => setRun(await api<EvalRun>(`/eval/${run.id}`)), 700);
    return () => clearInterval(t);
  }, [run?.id, run?.status]);
  const start = async () => {
    setErr('');
    try { setRun(await api<EvalRun>('/eval/run', { json: { brain, repetitions: reps, ids: sel, profile } })); } catch (e) { setErr((e as Error).message); }
  };
  const passCount = run ? new Set(run.results.filter((r) => r.pass).map((r) => `${r.id}#${r.repetition}`)).size : 0;
  return (
    <div className="card wide">
      <h3>受入テスト（acceptance-cases.json T01〜T39）</h3>
      <p className="small muted">テキスト経路で業務ロジック（振り分け・ゲート・RPA状態）を自動判定します。音声品質・GPT-Liveの実際の発話内容は対象外のため、通話画面で人が確認してください。LLM Brainでの実行はAPI費用が発生します（最大{cfg.evalMaxLlmRuns}回）。</p>
      <div className="row">
        <label>Brain：<select value={brain} onChange={(e) => setBrain(e.target.value)}>{Object.keys(cfg.brains).map((k) => <option key={k} value={k}>{k === 'rule' ? 'Deterministic比較' : `LLM (${cfg.brains[k]})`}</option>)}</select></label>
        <label>構成：<select value={profile} onChange={(e) => setProfile(e.target.value)}>{Object.entries(cfg.profiles).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>繰返し：<input type="number" min={1} max={5} value={reps} onChange={(e) => setReps(Number(e.target.value))} style={{ width: 60 }} /></label>
        <button onClick={start} disabled={run?.status === 'running'}>実行</button>
        <span className="small muted">対象：{sel.length ? sel.join(',') : '全件'}</span>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="chips">{cfg.cases.map((c) => <label key={c.id} className="chip"><input type="checkbox" checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />{c.id} {c.title}</label>)}</div>
      {run && (
        <>
          <p><b>{run.status === 'running' ? '実行中…' : '完了'}</b> {run.note} ・合格 {passCount}/{run.results.length}（予定 {run.total}）</p>
          <table className="facts eval"><thead><tr><th>ID</th><th>ケース</th><th>期待</th><th>回</th><th>結果</th><th>根拠ログ</th></tr></thead><tbody>
            {run.results.map((r) => (
              <tr key={`${r.id}-${r.repetition}`}>
                <td>{r.id}</td><td>{r.title}</td><td>{r.expected}</td><td>{r.repetition}</td>
                <td className={r.pass ? 'ok' : 'err'}>{r.pass ? 'PASS' : 'FAIL'}</td>
                <td className="small">{r.error ? <span className="err">{r.error}</span> : r.checks.map((c, i) => <div key={i} className={c.pass ? '' : 'err'}>{c.pass ? '✓' : '✗'} {c.name}{c.detail ? <span className="muted"> — {c.detail.slice(0, 160)}</span> : null}</div>)}</td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}
    </div>
  );
}

function CoreView() {
  const [data, setData] = useState<{ notice: string; records: unknown[] } | null>(null);
  useEffect(() => { void api<{ notice: string; records: unknown[] }>('/core').then(setData); }, []);
  return (
    <div className="card wide">
      <h3>模擬基幹 登録台帳 <span className="badge mock">MOCK</span></h3>
      <p className="small muted">{data?.notice}</p>
      <button onClick={() => api<{ notice: string; records: unknown[] }>('/core').then(setData)}>更新</button>
      <pre>{JSON.stringify(data?.records ?? [], null, 1)}</pre>
    </div>
  );
}

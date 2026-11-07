// ブラウザ側のGPT-Live WebRTC接続（公式WebRTCガイドの手順に準拠）。
// APIキーはブラウザに渡さない。SDP offerを自サーバに送り、サーバがOpenAIと交換する。
// データチャネル(oai-events)からは、サーバ側で許可したミュート/終了イベントのみ送れる。

export interface LiveHandle {
  conversationId: string;
  mute(on: boolean): void;
  close(): void;
}

export async function startLive(opts: {
  brain?: string;
  voice?: string;
  speed?: string;
  tone?: string;
  profile?: string;
  audio: HTMLAudioElement;
  onStatus: (s: string) => void;
  onClosed: (reason: string) => void;
}): Promise<LiveHandle> {
  const pc = new RTCPeerConnection();
  let mic: MediaStream | undefined;
  let events: RTCDataChannel | undefined;
  let finalized = false;
  let meter: { stop(): void } | undefined;
  let remoteStream: MediaStream | undefined;
  const cleanup = () => {
    meter?.stop();
    mic?.getTracks().forEach((t) => t.stop());
    try { events?.close(); } catch { /* ignore */ }
    pc.close();
    opts.audio.srcObject = null;
  };
  try {
    pc.addEventListener('track', (e) => {
      remoteStream = new MediaStream([e.track]);
      opts.audio.srcObject = remoteStream;
      opts.audio.play().catch(() => opts.onStatus('音声を再生するには画面の再生ボタンを押してください'));
    });
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of mic.getAudioTracks()) pc.addTrack(t, mic);
    events = pc.createDataChannel('oai-events');
    events.addEventListener('message', ({ data }) => {
      const ev = JSON.parse(data);
      if (ev.type === 'session.started') opts.onStatus('接続しました');
      else if (ev.type === 'session.closed') { finalized = true; opts.onClosed(ev.reason ?? 'closed'); cleanup(); }
      else if (ev.type === 'error') opts.onStatus(`Liveエラー: ${ev.error?.message ?? ''}`);
    });
    events.addEventListener('close', () => { if (!finalized) { opts.onClosed('disconnected'); cleanup(); } });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('ICE収集がタイムアウトしました')), 10000);
        const on = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(to); pc.removeEventListener('icegatheringstatechange', on); resolve(); } };
        pc.addEventListener('icegatheringstatechange', on);
        on();
      });
    }
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('SDP offerを作成できませんでした');
    const res = await fetch('/api/live/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp, brain: opts.brain, voice: opts.voice, speed: opts.speed, tone: opts.tone, profile: opts.profile }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Liveセッション作成に失敗しました');
    await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    // HTTPでセッションは開始済み。session.startは送らない。
    // 遅延計測（D18）：利用者が実際に音を聞いた時刻はブラウザでしか分からないため、ここで測ってサーバに送る（時間の値だけ）
    try {
      meter = startPlaybackMeter(mic, () => remoteStream, (ms) => {
        void fetch(`/api/conversations/${data.conversationId}/client-timing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playbackLatencyMs: Math.round(ms) }) }).catch(() => undefined);
      });
    } catch { /* 計測できなくても通話は続ける */ }
    return {
      conversationId: data.conversationId,
      mute(on) {
        if (events?.readyState === 'open') events.send(JSON.stringify({ type: on ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: `mute_${Date.now()}` }));
      },
      close() {
        if (events?.readyState === 'open') events.send(JSON.stringify({ type: 'session.close' }));
        setTimeout(() => { if (!finalized) { opts.onClosed('timeout'); cleanup(); } }, 15000);
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * 顧客の声が止んでから、AIの音声が聞こえ始めるまでを測る（簡易な音量判定。近似値・要検証）。
 * マイクとAI音声の音量を20msごとに見て、「顧客が話した後、AIの音声が無音から立ち上がった」時点で、
 * 顧客の最後の発声からの経過時間を報告する。エコーキャンセルが効かない環境（スピーカー出力）では誤差が出る。
 */
function startPlaybackMeter(mic: MediaStream, remote: () => MediaStream | undefined, report: (ms: number) => void): { stop(): void } {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  void ctx.resume();
  const level = (an: AnalyserNode, buf: Float32Array<ArrayBuffer>) => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
  const micAn = ctx.createAnalyser(); micAn.fftSize = 1024;
  ctx.createMediaStreamSource(mic).connect(micAn);
  const micBuf = new Float32Array(micAn.fftSize);
  let remAn: AnalyserNode | null = null;
  let remBuf = new Float32Array(1024);
  const MIC_ON = 0.02, REM_ON = 0.01, REM_GAP_MS = 300;
  let lastMicVoice = 0;
  let remActive = false;
  let remLastLoud = 0;
  let remSegEnd = 0;
  let turnFrom = 0;
  let turnReports = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    if (!remAn) {
      const rs = remote();
      if (rs && rs.getAudioTracks().length) { remAn = ctx.createAnalyser(); remAn.fftSize = 1024; remBuf = new Float32Array(remAn.fftSize); ctx.createMediaStreamSource(rs).connect(remAn); }
    }
    const remLoud = remAn ? level(remAn, remBuf) > REM_ON : false;
    // AIが話している間のマイク入力（エコー）は顧客の発声として数えない
    if (!remActive && level(micAn, micBuf) > MIC_ON) lastMicVoice = now;
    if (remLoud) {
      if (!remActive) {
        remActive = true;
        // 顧客がAIの前回の発話の後に話していれば、その最後の発声からの時間を報告。
        // 顧客が話さないまま続いたAIの音声（「はい」の後の質問など）も、同じ発声からの時間として最大3件まで報告する
        if (lastMicVoice > remSegEnd) { turnFrom = lastMicVoice; turnReports = 0; }
        if (turnFrom && turnReports < 3 && now - turnFrom < 15000) { report(now - turnFrom); turnReports++; }
      }
      remLastLoud = now;
    } else if (remActive && now - remLastLoud > REM_GAP_MS) {
      remActive = false;
      remSegEnd = remLastLoud;
    }
  }, 20);
  return { stop() { clearInterval(timer); void ctx.close(); } };
}

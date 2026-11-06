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
  audio: HTMLAudioElement;
  onStatus: (s: string) => void;
  onClosed: (reason: string) => void;
}): Promise<LiveHandle> {
  const pc = new RTCPeerConnection();
  let mic: MediaStream | undefined;
  let events: RTCDataChannel | undefined;
  let finalized = false;
  const cleanup = () => {
    mic?.getTracks().forEach((t) => t.stop());
    try { events?.close(); } catch { /* ignore */ }
    pc.close();
    opts.audio.srcObject = null;
  };
  try {
    pc.addEventListener('track', (e) => {
      opts.audio.srcObject = new MediaStream([e.track]);
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
    const res = await fetch('/api/live/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp, brain: opts.brain }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Liveセッション作成に失敗しました');
    await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    // HTTPでセッションは開始済み。session.startは送らない。
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

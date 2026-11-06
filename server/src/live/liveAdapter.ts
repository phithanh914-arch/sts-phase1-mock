// LiveAdapter：GPT-Live（gpt-live-1）とのWebRTCセッション作成と、サーバ側sideband接続。
// GPT-LiveとRealtime APIのイベントを混同しないため、Live固有のイベント処理はこのファイルに隔離する。
//
// 公式ドキュメント（2026-11-06確認）と openai npm 7.53.0 の型定義に基づく：
//  - セッション作成: POST /v1/live/sessions（SDK client.live.create）。ブラウザのSDP offerをサーバがAPIキーで交換。
//  - sideband: wss://api.openai.com/v1/live/sessions/{id}/attach（SDK SidebandWS）
//  - client delegation: session.delegation.created（発話テキストを含まない）→ session.thinking/commentary/instructions.append
//  - delegation.createdは「処理の委任通知」であり、ユーザー発話完了イベントではない。
//  - transcript deltaに確定ターン完了イベントはないため、表示用ターン区切りはアプリ側のgapで行う（同意の根拠にしない）。

import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import type { Conversation } from '../session/conversation.js';
import type { SessionController, SpeechDirective, SpeechSink } from '../session/controller.js';
import { LIVE_INSTRUCTIONS } from './instructions.js';
import { GREETING } from '../session/controller.js';

export interface LiveConfig {
  apiKey: string;
  model: string;
  voice: string;
  voices: string[];
  maxSessionSeconds: number;
  maxConcurrent: number;
  maxSessionsPerDay: number;
  turnGapMs: number;
}

interface LiveRuntime {
  sideband: SidebandWS | null;
  inBuf: { text: string; start?: number; end?: number };
  outBuf: { text: string; start?: number; end?: number };
  inTimer?: NodeJS.Timeout;
  outTimer?: NodeJS.Timeout;
  outstandingDelegations: string[];
  readbackEventIds: Map<string, string>; // event_id -> confirmationId
  pendingReadback: { confirmationId: string; text: string } | null;
  maxTimer?: NodeJS.Timeout;
  seq: number;
  closed: boolean;
}

export class LiveAdapter {
  private client: OpenAI;
  private runtimes = new Map<string, LiveRuntime>();
  private day = '';
  private dayCount = 0;

  constructor(private cfg: LiveConfig, private ctl: SessionController) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, maxRetries: 0 });
  }

  activeCount() { return [...this.runtimes.values()].filter((r) => !r.closed).length; }
  usage() { return { activeSessions: this.activeCount(), sessionsToday: this.dayCount, maxPerDay: this.cfg.maxSessionsPerDay, maxConcurrent: this.cfg.maxConcurrent, maxSessionSeconds: this.cfg.maxSessionSeconds }; }

  /** ブラウザのSDP offerを受け取り、Liveセッションを作成してSDP answerを返す */
  async start(sdp: string, brain?: string, voiceReq?: string): Promise<{ conversationId: string; sdp: string; liveSessionId: string; voice: string }> {
    const voice = voiceReq && this.cfg.voices.includes(voiceReq) ? voiceReq : this.cfg.voice;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.dayCount = 0; }
    if (this.activeCount() >= this.cfg.maxConcurrent) throw Object.assign(new Error('同時接続上限に達しています'), { status: 429 });
    if (this.dayCount >= this.cfg.maxSessionsPerDay) throw Object.assign(new Error('本日のセッション上限に達しています'), { status: 429 });

    const sink = this.makeSink();
    const conv = this.ctl.create('live', sink, brain);
    const res = await this.client.live.create({
      session: {
        model: this.cfg.model,
        instructions: LIVE_INSTRUCTIONS,
        audio: { output: { voice } },
        delegation: { type: 'client' },
        store: false,
        client: {
          data_channel: {
            // ブラウザ（信頼しないフロント）から送れるのはミュート/終了だけ。業務指示はsidebandからのみ。
            allowed_client_events: ['session.input_audio.mute', 'session.input_audio.unmute', 'session.close'],
            allowed_server_events: [
              { type: 'session.started' }, { type: 'session.closed' }, { type: 'session.input_audio.muted' },
              { type: 'session.input_audio.unmuted' }, { type: 'error' },
            ],
          },
        },
      },
      transport: { type: 'webrtc', sdp },
    });
    this.dayCount += 1;
    const liveSessionId = res.session.id;
    conv.live.sessionId = liveSessionId;
    conv.log('live_session_created', { liveSessionId, model: this.cfg.model, voice, store: false });
    const rt: LiveRuntime = { sideband: null, inBuf: { text: '' }, outBuf: { text: '' }, outstandingDelegations: [], readbackEventIds: new Map(), pendingReadback: null, seq: 0, closed: false };
    this.runtimes.set(conv.id, rt);
    this.attach(conv, rt, liveSessionId);
    rt.maxTimer = setTimeout(() => {
      conv.log('live_max_duration_reached', { seconds: this.cfg.maxSessionSeconds });
      this.close(conv, 'max_duration');
    }, this.cfg.maxSessionSeconds * 1000);
    return { conversationId: conv.id, sdp: res.transport.sdp, liveSessionId, voice };
  }

  private attach(conv: Conversation, rt: LiveRuntime, sessionId: string) {
    const sb = new SidebandWS(this.client, { session_id: sessionId });
    rt.sideband = sb;
    sb.on('event', (ev) => this.onEvent(conv, rt, ev as unknown as Record<string, unknown> & { type: string }));
    sb.on('error', (err) => conv.log('sideband_error', { message: err.message }));
    sb.on('close', (code, reason) => {
      conv.log('sideband_closed', { code, reason });
      this.finish(conv, rt, 'disconnected');
    });
  }

  private send(conv: Conversation, rt: LiveRuntime, ev: Record<string, unknown>) {
    if (!rt.sideband || rt.closed) return;
    try {
      rt.sideband.send(ev as never);
      conv.log('live_send', { type: ev.type, event_id: ev.event_id, delegation_id: ev.delegation_id });
    } catch (e) {
      conv.log('live_send_error', { message: e instanceof Error ? e.message : String(e) });
    }
  }

  private eid(conv: Conversation, rt: LiveRuntime, p: string) { return `${p}_${conv.id}_${++rt.seq}`; }

  private onEvent(conv: Conversation, rt: LiveRuntime, ev: Record<string, unknown> & { type: string }) {
    switch (ev.type) {
      case 'session.started': {
        conv.live.startedAt = new Date().toISOString();
        conv.log('live_session_started');
        // 最初の名乗りとレッカー確認（文言はアプリ管理）
        this.send(conv, rt, { type: 'session.instructions.append', event_id: this.eid(conv, rt, 'greeting'), delegation_id: null, content: `今すぐ、次の内容をそのまま伝えてください：「${GREETING}」` });
        break;
      }
      case 'session.input_transcript.delta': {
        const d = ev as unknown as { delta: string; start_ms: number; end_ms: number };
        if (rt.outBuf.text) this.flushOut(conv, rt);
        rt.inBuf.text += d.delta;
        rt.inBuf.start ??= d.start_ms;
        rt.inBuf.end = d.end_ms;
        clearTimeout(rt.inTimer);
        rt.inTimer = setTimeout(() => {
          // gapによる表示用区切り。会話終了・同意の根拠にはしない。
          if (this.flushIn(conv, rt)) void this.ctl.requestAnalysis(conv, 'transcript_gap', null);
        }, this.cfg.turnGapMs);
        break;
      }
      case 'session.output_transcript.delta': {
        const d = ev as unknown as { delta: string; start_ms: number; end_ms: number };
        if (rt.inBuf.text && this.flushIn(conv, rt)) void this.ctl.requestAnalysis(conv, 'ai_started_speaking', null);
        rt.outBuf.text += d.delta;
        rt.outBuf.start ??= d.start_ms;
        rt.outBuf.end = d.end_ms;
        clearTimeout(rt.outTimer);
        rt.outTimer = setTimeout(() => this.flushOut(conv, rt), this.cfg.turnGapMs);
        break;
      }
      case 'session.delegation.created': {
        const d = ev as unknown as { delegation: { id: string; target: string } };
        conv.log('delegation_created', { id: d.delegation.id, target: d.delegation.target });
        if (d.delegation.target !== 'client') break;
        rt.outstandingDelegations.push(d.delegation.id);
        clearTimeout(rt.inTimer);
        this.flushIn(conv, rt);
        if (conv.unanalyzedCustomerUtterances().length > 0 || conv.analysisInFlight) void this.ctl.requestAnalysis(conv, 'delegation', null);
        else this.ctl.respondCurrent(conv, null);
        break;
      }
      case 'session.instructions.appended':
      case 'session.commentary.appended':
      case 'session.thinking.appended': {
        const cid = (ev as { client_event_id?: string }).client_event_id;
        const confirmationId = cid ? rt.readbackEventIds.get(cid) : undefined;
        if (confirmationId && conv.confirmation?.confirmationId === confirmationId) {
          rt.pendingReadback = { confirmationId, text: conv.confirmation.readbackText };
        }
        break;
      }
      case 'session.usage.updated': {
        const u = ev as unknown as { usage: { seconds: number } };
        conv.live.voiceSeconds = u.usage.seconds;
        this.ctl.changed(conv);
        break;
      }
      case 'session.closed': {
        const u = ev as unknown as { reason: string; usage?: { seconds: number } };
        if (u.usage) conv.live.voiceSeconds = u.usage.seconds;
        conv.live.closedReason = u.reason;
        conv.log('live_session_closed', { reason: u.reason, usage: u.usage });
        this.finish(conv, rt, u.reason === 'connection_lost' ? 'disconnected' : 'live_closed');
        break;
      }
      case 'error':
        conv.log('live_error', ev);
        this.ctl.changed(conv);
        break;
      case 'info':
        conv.log('live_info', ev);
        break;
      default:
        break;
    }
  }

  private flushIn(conv: Conversation, rt: LiveRuntime): boolean {
    const text = rt.inBuf.text.trim();
    const { start, end } = rt.inBuf;
    rt.inBuf = { text: '' };
    if (!text || conv.callState === 'ENDED') return false;
    this.ctl.addUtterance(conv, { speaker: 'customer', text, kind: 'input', source: 'live', startMs: start, endMs: end });
    return true;
  }

  private flushOut(conv: Conversation, rt: LiveRuntime) {
    clearTimeout(rt.outTimer);
    const text = rt.outBuf.text.trim();
    const { start, end } = rt.outBuf;
    rt.outBuf = { text: '' };
    if (!text) return;
    let tag: string | undefined;
    const pr = rt.pendingReadback;
    // 読上げ指示の受理後に出力された発話が読上げ文の大半を含む場合のみ「読上げ済み」とする（ヒューリスティック・要検証）
    if (pr && text.length >= pr.text.length * 0.5 && /確認/.test(text)) {
      tag = `readback:${pr.confirmationId}`;
      rt.pendingReadback = null;
      this.ctl.aiSpoke(conv, text, 'live', tag, start, end);
      this.ctl.markReadbackDelivered(conv, pr.confirmationId);
      return;
    }
    this.ctl.aiSpoke(conv, text, 'live', tag, start, end);
  }

  private makeSink(): SpeechSink {
    return {
      deliver: (conv: Conversation, d: SpeechDirective, _delegationId: string | null, solicited: boolean) => {
        const rt = this.runtimes.get(conv.id);
        // 予定発話として記録（実際の出力transcriptとは区別）
        this.ctl.addUtterance(conv, { speaker: 'ai', text: d.text, kind: 'planned', source: 'live', tag: d.tag });
        if (!rt) return;
        const delegationId = rt.outstandingDelegations.shift() ?? null;
        const eventId = this.eid(conv, rt, d.kind);
        if (d.kind === 'readback' && d.tag) rt.readbackEventIds.set(eventId, d.tag.replace('readback:', ''));
        if (d.exact) {
          this.send(conv, rt, { type: 'session.instructions.append', event_id: eventId, delegation_id: delegationId, content: `今すぐ、次の内容を省略せずそのまま伝えてください：「${d.text}」` });
        } else if (delegationId || solicited) {
          this.send(conv, rt, { type: 'session.commentary.append', event_id: eventId, delegation_id: delegationId, content: d.text });
        } else {
          // 委任されていない分析結果は話させず、背景情報として渡す（二重発話を避ける）
          this.send(conv, rt, { type: 'session.thinking.append', event_id: eventId, delegation_id: null, content: `次に話すときの方針（言い換え可）：${d.text}` });
        }
      },
      context: (conv: Conversation, summary: string) => {
        const rt = this.runtimes.get(conv.id);
        if (!rt) return;
        this.send(conv, rt, { type: 'session.thinking.append', event_id: this.eid(conv, rt, 'ctx'), delegation_id: null, content: summary.slice(0, 1500) });
      },
    };
  }

  close(conv: Conversation, reason: string) {
    const rt = this.runtimes.get(conv.id);
    if (!rt || rt.closed) return;
    conv.log('live_close_requested', { reason });
    this.send(conv, rt, { type: 'session.close', event_id: this.eid(conv, rt, 'close') });
    // session.closedを待つ。来なければ15秒で強制終了
    setTimeout(() => this.finish(conv, rt, 'live_closed'), 15000).unref?.();
  }

  private finish(conv: Conversation, rt: LiveRuntime, reason: 'disconnected' | 'live_closed') {
    if (rt.closed) return;
    rt.closed = true;
    clearTimeout(rt.maxTimer);
    clearTimeout(rt.inTimer);
    this.flushIn(conv, rt);
    this.flushOut(conv, rt);
    try { rt.sideband?.close({ code: 1000, reason: 'done' }); } catch { /* ignore */ }
    this.ctl.endCall(conv, reason);
  }
}

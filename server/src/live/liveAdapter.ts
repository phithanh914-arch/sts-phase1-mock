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
import { buildLiveInstructions, normalizeStyle } from './instructions.js';
import { GREETING } from '../session/controller.js';
import { GREETING_QUESTION_KEY } from '../domain/questions.js';

export interface LiveConfig {
  apiKey: string;
  model: string;
  voice: string;
  voices: string[];
  maxSessionSeconds: number;
  maxConcurrent: number;
  maxSessionsPerDay: number;
  turnGapMs: number;
  delegationWaitMs: number;
  /** 委任の結果がこの時間内に出なければ「確認いたします」と言う（0で無効） */
  fillerAfterMs: number;
  /** D20：B/Cで次の質問が決まったのに委任が来ないとき、この時間で自分から質問する（0で無効） */
  proactiveAfterMs?: number;
}

/** 分析が長引いたときのつなぎ言葉（Takaさん指定 2026-11-06） */
export const FILLER_TEXT = '確認いたします。';

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
  /** 「そのまま伝えて」指示を送ってから、その発話が終わる（出力transcriptが区切れる）までの間 true */
  exactSpeaking: boolean;
  /** 話している途中に届いた委任なしの「そのまま伝えて」指示（前の発話が終わってから送る） */
  exactQueue: { eventId: string; text: string; delegationId: string | null }[];
  exactTimer?: NodeJS.Timeout;
  fillerTimer?: NodeJS.Timeout;
  /** 今話しているのが「確認いたします」のつなぎ言葉か */
  fillerSpeaking: boolean;
  /** 遅延計測：このターンの応答として送った指示のevent_id（出力transcriptのclient_event_idと照合する） */
  answerEventId: string | null;
  /** 遅延計測：応答を送った時点までに出力された音声の終わり（Liveの時間軸） */
  outEndAtSend: number;
  lastOutEndMs: number;
  /** D20：結果は出たが委任が来ていない（B/Cのみ）。この間はthinkingを送らない */
  awaitingDelegation: boolean;
  proactiveTimer?: NodeJS.Timeout;
  /** 次の発話を委任なしで「応答」として送る（見張りタイマーから） */
  proactiveSending: boolean;
  /** 委任なしで応答した時点の顧客発話の数（後から届いた委任で同じ質問を繰り返さないため） */
  proactiveCustomerCount: number | null;
  /** 委任待ちの間に送らずに保留した会話状況のメモ */
  pendingCtx: string | null;
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
  async start(sdp: string, brain?: string, voiceReq?: string, styleReq?: { speed?: unknown; tone?: unknown }, profile?: unknown): Promise<{ conversationId: string; sdp: string; liveSessionId: string; voice: string; speed: string; tone: string; profile: string }> {
    const voice = voiceReq && this.cfg.voices.includes(voiceReq) ? voiceReq : this.cfg.voice;
    const { speed, tone } = normalizeStyle(styleReq?.speed, styleReq?.tone);
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.dayCount = 0; }
    if (this.activeCount() >= this.cfg.maxConcurrent) throw Object.assign(new Error('同時接続上限に達しています'), { status: 429 });
    if (this.dayCount >= this.cfg.maxSessionsPerDay) throw Object.assign(new Error('本日のセッション上限に達しています'), { status: 429 });

    const sink = this.makeSink();
    const conv = this.ctl.create('live', sink, brain, profile);
    const res = await this.client.live.create({
      session: {
        model: this.cfg.model,
        instructions: buildLiveInstructions(speed, tone),
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
    conv.log('live_session_created', { liveSessionId, model: this.cfg.model, voice, speed, tone, store: false });
    const rt: LiveRuntime = { sideband: null, inBuf: { text: '' }, outBuf: { text: '' }, outstandingDelegations: [], readbackEventIds: new Map(), pendingReadback: null, seq: 0, closed: false, exactSpeaking: false, exactQueue: [], fillerSpeaking: false, answerEventId: null, outEndAtSend: -1, lastOutEndMs: -1, ...LiveAdapter.d20Init() };
    this.runtimes.set(conv.id, rt);
    this.attach(conv, rt, liveSessionId);
    rt.maxTimer = setTimeout(() => {
      conv.log('live_max_duration_reached', { seconds: this.cfg.maxSessionSeconds });
      this.close(conv, 'max_duration');
    }, this.cfg.maxSessionSeconds * 1000);
    return { conversationId: conv.id, sdp: res.transport.sdp, liveSessionId, voice, speed, tone, profile: conv.profile.name };
  }

  /** テスト用：ネットワークに接続せずに会話とruntimeを作る。sidebandへの送信は sent に記録し、emitでサーバイベントを注入する */
  testSession(brain?: string, profile?: unknown): { conv: Conversation; sent: Record<string, unknown>[]; emit: (ev: Record<string, unknown> & { type: string }) => void } {
    const conv = this.ctl.create('live', this.makeSink(), brain, profile);
    const sent: Record<string, unknown>[] = [];
    const rt: LiveRuntime = { sideband: { send: (ev: Record<string, unknown>) => { sent.push(ev); }, close: () => undefined } as unknown as SidebandWS, inBuf: { text: '' }, outBuf: { text: '' }, outstandingDelegations: [], readbackEventIds: new Map(), pendingReadback: null, seq: 0, closed: false, exactSpeaking: false, exactQueue: [], fillerSpeaking: false, answerEventId: null, outEndAtSend: -1, lastOutEndMs: -1, ...LiveAdapter.d20Init() };
    this.runtimes.set(conv.id, rt);
    return { conv, sent, emit: (ev) => this.onEvent(conv, rt, ev) };
  }

  private static d20Init() { return { awaitingDelegation: false, proactiveSending: false, proactiveCustomerCount: null, pendingCtx: null }; }

  private customerCount(conv: Conversation) { return conv.utterances.filter((u) => u.speaker === 'customer').length; }

  /** D20：委任が来ないまま見張り時間が過ぎたら、自分から今の質問をそのまま話す */
  private armProactive(conv: Conversation, rt: LiveRuntime, delayMs?: number) {
    const ms = delayMs ?? this.cfg.proactiveAfterMs ?? 0;
    clearTimeout(rt.proactiveTimer);
    rt.awaitingDelegation = true;
    if (ms <= 0) return;
    rt.proactiveTimer = setTimeout(() => {
      if (rt.closed || !rt.awaitingDelegation || rt.outstandingDelegations.length > 0) return;
      // 顧客が話している・AIが話している・分析中なら、今は話さない（話し終わってから見直す）
      if (rt.inBuf.text || conv.analysisInFlight || conv.unanalyzedCustomerUtterances().length > 0) return;
      if (rt.outBuf.text || rt.exactSpeaking) { this.armProactive(conv, rt, 500); return; }
      const t = this.ctl.currentTurn(conv);
      if (t?.marks.speech_sent !== undefined) return;
      conv.log('proactive_answer_without_delegation', { afterMs: ms });
      rt.proactiveSending = true;
      try { this.ctl.respondCurrent(conv, null); } finally { rt.proactiveSending = false; }
    }, ms);
  }

  /** 応答を送ったら委任待ちを解き、保留していた会話状況のメモを送る */
  private answered(conv: Conversation, rt: LiveRuntime) {
    clearTimeout(rt.proactiveTimer);
    rt.awaitingDelegation = false;
    if (rt.pendingCtx) {
      const summary = rt.pendingCtx;
      rt.pendingCtx = null;
      this.send(conv, rt, { type: 'session.thinking.append', event_id: this.eid(conv, rt, 'ctx'), delegation_id: null, content: summary.slice(0, 1500) });
    }
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
        // 最初の名乗りとレッカー確認（文言はアプリ管理）。質問ID（レッカー）を記録し、Fast Pathの前提にする
        conv.lastQuestion = GREETING;
        conv.lastQuestionKey = GREETING_QUESTION_KEY;
        conv.askedCounts[GREETING_QUESTION_KEY] = 1;
        this.send(conv, rt, { type: 'session.instructions.append', event_id: this.eid(conv, rt, 'greeting'), delegation_id: null, content: `今すぐ、次の内容をそのまま伝えてください：「${GREETING}」` });
        break;
      }
      case 'session.input_transcript.delta': {
        const d = ev as unknown as { delta: string; start_ms: number; end_ms: number };
        if (rt.outBuf.text) this.flushOut(conv, rt);
        // 遅延計測：顧客の発話の終わり（最後に受け取った入力の終端）
        const turn = this.ctl.turnMark(conv, 'speech_end', true);
        if (turn && typeof d.end_ms === 'number') turn.live.speechEndMs = d.end_ms;
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
        const d = ev as unknown as { delta: string; start_ms: number; end_ms: number; client_event_id?: string };
        this.traceOutput(conv, rt, d);
        if (rt.inBuf.text && this.flushIn(conv, rt)) void this.ctl.requestAnalysis(conv, 'ai_started_speaking', null);
        rt.outBuf.text += d.delta;
        rt.outBuf.start ??= d.start_ms;
        rt.outBuf.end = d.end_ms;
        clearTimeout(rt.outTimer);
        rt.outTimer = setTimeout(() => this.flushOut(conv, rt), this.cfg.turnGapMs);
        break;
      }
      case 'session.delegation.created': {
        const d = ev as unknown as { delegation: { id: string; target: string }; offset_ms?: number };
        conv.log('delegation_created', { id: d.delegation.id, target: d.delegation.target, offset_ms: d.offset_ms });
        const turn = this.ctl.turnMark(conv, 'delegation_received');
        if (turn && turn.live.delegationOffsetMs === undefined && typeof d.offset_ms === 'number') turn.live.delegationOffsetMs = d.offset_ms;
        if (d.delegation.target !== 'client') break;
        rt.outstandingDelegations.push(d.delegation.id);
        // 分析が長引いたときだけ「確認いたします」と言う（D15）。短ければ何も言わずに次の質問へ
        clearTimeout(rt.fillerTimer);
        if (this.cfg.fillerAfterMs > 0) {
          rt.fillerTimer = setTimeout(() => {
            if (rt.closed || !rt.outstandingDelegations.includes(d.delegation.id) || rt.exactSpeaking) return;
            rt.fillerSpeaking = true;
            this.sendExact(conv, rt, this.eid(conv, rt, 'filler'), null, FILLER_TEXT, false);
          }, this.cfg.fillerAfterMs);
        }
        clearTimeout(rt.inTimer);
        this.flushIn(conv, rt);
        if (conv.unanalyzedCustomerUtterances().length > 0 || conv.analysisInFlight) void this.ctl.requestAnalysis(conv, 'delegation', null);
        else if (conv.profile.answerDelegationWithoutWait && this.turnAlreadyCaptured(conv)) {
          // D18：このターンの発話はすでに受け取り、分析も終わっている（Fast Path等）。待たずに次の質問を返す
          conv.log('delegation_answered_without_wait', { id: d.delegation.id });
          this.ctl.respondCurrent(conv, null);
        } else {
          // 委任が入力transcriptより先に届くことがあるため、少し待ってから判断する
          setTimeout(() => {
            if (rt.closed || !rt.outstandingDelegations.includes(d.delegation.id)) return;
            clearTimeout(rt.inTimer);
            this.flushIn(conv, rt);
            if (conv.unanalyzedCustomerUtterances().length > 0 || conv.analysisInFlight) void this.ctl.requestAnalysis(conv, 'delegation_late_transcript', null);
            else if (rt.proactiveCustomerCount !== null && rt.proactiveCustomerCount === this.customerCount(conv)) {
              // D20：委任を待たずに質問済みで、その後に顧客の発話がない → 同じ質問を繰り返さず、委任だけ閉じる（要検証）
              rt.outstandingDelegations = rt.outstandingDelegations.filter((x) => x !== d.delegation.id);
              clearTimeout(rt.fillerTimer);
              conv.log('delegation_after_proactive_answer', { id: d.delegation.id });
              this.send(conv, rt, { type: 'session.thinking.append', event_id: this.eid(conv, rt, 'noop'), delegation_id: d.delegation.id, content: '次の質問はすでに伝えた。繰り返さず、何も言わずに相手の返事を待つ。' });
            } else this.ctl.respondCurrent(conv, null);
          }, this.cfg.delegationWaitMs);
        }
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
    this.ctl.turnMark(conv, 'utterance_flushed', true);
    return true;
  }

  /** このターンの顧客発話を受け取り済みで、まだ応答していないか（委任を待たずに答えてよいか） */
  private turnAlreadyCaptured(conv: Conversation): boolean {
    const t = this.ctl.currentTurn(conv);
    const rt = this.runtimes.get(conv.id);
    return !!t && t.marks.utterance_flushed !== undefined && t.marks.speech_sent === undefined && !rt?.inBuf.text;
  }

  /** 遅延計測：出力transcriptの時刻から、そのターンの最初の音声・応答の音声開始を記録する */
  private traceOutput(conv: Conversation, rt: LiveRuntime, d: { start_ms: number; end_ms: number; client_event_id?: string }) {
    const t = this.ctl.currentTurn(conv);
    if (t) {
      const afterSpeechEnd = t.live.speechEndMs === undefined || d.start_ms >= t.live.speechEndMs;
      if (t.live.firstAudioMs === undefined && afterSpeechEnd) { t.live.firstAudioMs = d.start_ms; this.ctl.turnMark(conv, 'first_audio'); }
      if (t.marks.speech_sent !== undefined && t.live.answerAudioMs === undefined) {
        // 送った指示のevent_idが付いていればそれで照合。付いていなければ、送信後に始まった最初の出力とみなす（近似・要検証）
        const byId = !!rt.answerEventId && d.client_event_id === rt.answerEventId;
        const afterSend = !d.client_event_id && d.start_ms > rt.outEndAtSend;
        if (byId || afterSend) {
          t.live.answerAudioMs = d.start_ms;
          t.live.answerMatch = byId ? 'event_id' : 'after_send';
          this.ctl.turnMark(conv, 'answer_audio');
          this.ctl.closeTurn(conv, 'answered');
          this.ctl.changed(conv);
        }
      }
    }
    if (typeof d.end_ms === 'number') rt.lastOutEndMs = Math.max(rt.lastOutEndMs, d.end_ms);
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
      this.exactDone(conv, rt);
      return;
    }
    this.ctl.aiSpoke(conv, text, 'live', tag, start, end);
    this.exactDone(conv, rt);
  }

  /** 「そのまま伝えて」指示を送る。前の指示を話している途中なら、話し終わってから送る（発話が混ざるのを防ぐ） */
  private sendExact(conv: Conversation, rt: LiveRuntime, eventId: string, delegationId: string | null, text: string, queueable: boolean) {
    // つなぎ言葉の途中に届いた委任の結果は、言い終わってから送る（重なり防止）
    if ((queueable || rt.fillerSpeaking) && rt.exactSpeaking) {
      rt.exactQueue.push({ eventId, text, delegationId });
      conv.log('exact_queued', { event_id: eventId });
      return;
    }
    rt.exactSpeaking = true;
    clearTimeout(rt.exactTimer);
    // 出力transcriptが来ない場合の保険（話し終わりを検知できなくても詰まらせない）
    rt.exactTimer = setTimeout(() => this.exactDone(conv, rt), 10000);
    const proactive = !delegationId && rt.proactiveSending;
    if (delegationId || proactive) {
      if (proactive) rt.proactiveCustomerCount = this.customerCount(conv);
      else rt.proactiveCustomerCount = null;
      // 遅延計測：このターンの応答（委任への答え）を送った時刻
      rt.answerEventId = eventId;
      rt.outEndAtSend = rt.lastOutEndMs;
      this.ctl.turnMark(conv, 'speech_sent');
    } else if (text === FILLER_TEXT) this.ctl.turnMark(conv, 'filler_sent');
    this.send(conv, rt, { type: 'session.instructions.append', event_id: eventId, delegation_id: delegationId, content: `今すぐ、次の内容を省略せずそのまま伝えてください：「${text}」` });
    if (delegationId || proactive) this.answered(conv, rt);
  }

  private exactDone(conv: Conversation, rt: LiveRuntime) {
    if (!rt.exactSpeaking) return;
    rt.exactSpeaking = false;
    rt.fillerSpeaking = false;
    clearTimeout(rt.exactTimer);
    const next = rt.exactQueue.shift();
    if (next && !rt.closed) this.sendExact(conv, rt, next.eventId, next.delegationId, next.text, false);
  }

  private makeSink(): SpeechSink {
    return {
      deliver: (conv: Conversation, d: SpeechDirective, _delegationId: string | null, solicited: boolean) => {
        const rt = this.runtimes.get(conv.id);
        // 予定発話として記録（実際の出力transcriptとは区別）
        this.ctl.addUtterance(conv, { speaker: 'ai', text: d.text, kind: 'planned', source: 'live', tag: d.tag });
        if (!rt) return;
        const delegationId = rt.outstandingDelegations.shift() ?? null;
        if (delegationId) clearTimeout(rt.fillerTimer);
        const eventId = this.eid(conv, rt, d.kind);
        if (d.kind === 'readback' && d.tag) rt.readbackEventIds.set(eventId, d.tag.replace('readback:', ''));
        const noWait = conv.profile.answerDelegationWithoutWait;
        if (noWait && rt.proactiveSending) {
          // D20：委任が来ないため、自分から今の質問を話す（前の発話が終わっていなければ待つ）
          this.sendExact(conv, rt, eventId, null, d.text, false);
        } else if (d.exact || delegationId || solicited) {
          // 2026-11-06（D14）：質問も含め、話す内容はすべて「そのまま伝えて」で渡す。commentaryだと音声側が質問を付け足すため。
          // 委任への応答と緊急案内はすぐ送る。委任なしの追加案内（転送結果など）は前の発話が終わるまで待つ
          this.sendExact(conv, rt, eventId, delegationId, d.text, !delegationId && d.kind !== 'emergency');
        } else if (noWait) {
          // D20（B/C）：委任より先に結果が出た。thinkingの先送りは委任・相づちを止めた疑いがあるため送らず（要検証）、
          // 委任を待つ。来なければ見張りタイマーで自分から質問する
          conv.log('result_ready_before_delegation', { event_id: eventId });
          this.armProactive(conv, rt);
        } else {
          // 委任されていない分析結果は話させない（次の委任でrespondCurrentが同じ質問を返す）。二重発話を避ける
          this.send(conv, rt, { type: 'session.thinking.append', event_id: eventId, delegation_id: null, content: `参考（自分からは話さないこと）：バックエンドの次の質問予定は「${d.text}」。相手が話したら委任して結果を待つ。` });
        }
      },
      context: (conv: Conversation, summary: string) => {
        const rt = this.runtimes.get(conv.id);
        if (!rt) return;
        if (conv.profile.answerDelegationWithoutWait && rt.awaitingDelegation) { rt.pendingCtx = summary; return; }
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
    clearTimeout(rt.exactTimer);
    clearTimeout(rt.fillerTimer);
    clearTimeout(rt.proactiveTimer);
    this.flushIn(conv, rt);
    this.flushOut(conv, rt);
    try { rt.sideband?.close({ code: 1000, reason: 'done' }); } catch { /* ignore */ }
    this.ctl.endCall(conv, reason);
  }
}

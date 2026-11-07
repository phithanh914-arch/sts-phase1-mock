// GPT-Liveのsidebandイベントを模擬して、待機の削減・遅延計測・割り込みの扱いを確かめる（ネットワーク接続なし）。
// 実際の音声・GPT-Liveの挙動そのものは実機でしか確認できない。
import { describe, it, expect } from 'vitest';
import { LiveAdapter } from './liveAdapter.js';
import { SessionController } from '../session/controller.js';
import { RuleBrain } from '../brain/ruleBrain.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(profile: string, fillerAfterMs = 0) {
  const ctl = new SessionController({ brains: { rule: new RuleBrain() }, defaultBrain: 'rule', today: () => '2026-11-06' });
  const live = new LiveAdapter({ apiKey: 'test-not-used', model: 'gpt-live-1', voice: 'harema', voices: ['harema'], maxSessionSeconds: 60, maxConcurrent: 1, maxSessionsPerDay: 1, turnGapMs: 40, delegationWaitMs: 1200, fillerAfterMs }, ctl);
  const s = live.testSession('rule', profile);
  const appended = () => s.sent.filter((e) => e.type === 'session.instructions.append');
  // 名乗り（レッカーの質問）を話し終えたことにする
  s.emit({ type: 'session.started' });
  const greet = appended()[0];
  s.emit({ type: 'session.output_transcript.delta', delta: '事故受付のAIです。まず、レッカーの手配は必要でしょうか。', start_ms: 1000, end_ms: 4000, client_event_id: greet.event_id as string });
  return { ...s, ctl, appended };
}

async function customerSays(s: ReturnType<typeof setup>, text: string, endMs: number) {
  s.emit({ type: 'session.input_transcript.delta', delta: text, start_ms: endMs - 800, end_ms: endMs });
  await wait(60); // 入力の区切り（turnGapMs=40）
}

describe('Live：委任への応答の待ち時間（D18）', () => {
  it('Hybrid：発話を受け取り済み・Fast Pathで処理済みなら、委任に待たずに次の質問を返す', async () => {
    const s = setup('hybrid');
    await customerSays(s, 'いいえ、不要です', 6000);
    expect(s.conv.analyses.at(-1)?.brain).toBe('fast-path');
    const before = s.appended().length;
    const t0 = Date.now();
    s.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' }, offset_ms: 6600 });
    const sent = s.appended().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ delegation_id: 'dlg_1' });
    expect(String(sent[0].content)).toContain('急いで対応が必要な状況');
    expect(Date.now() - t0).toBeLessThan(100);
    // 次の質問の音声が始まった → ターンを閉じて区間を計算
    s.emit({ type: 'session.output_transcript.delta', delta: '今、急いで', start_ms: 7400, end_ms: 8000, client_event_id: sent[0].event_id as string });
    const turn = s.conv.turns.at(-1)!;
    expect(turn.status).toBe('answered');
    expect(turn.fastPath).toBe('hit');
    expect(turn.durations.total_ms).toBe(1400); // 発話終了6000 → 音声開始7400（Liveの時間軸）
    expect(turn.durations.endpointing_ms).toBe(600);
    expect(turn.live.answerMatch).toBe('event_id');
  });

  it('Baseline：従来どおり、委任が来ても最大1.2秒待ってから答える（改善前の挙動を再現できる）', async () => {
    const s = setup('baseline');
    await customerSays(s, 'いいえ、不要です', 6000);
    const before = s.appended().length;
    s.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' }, offset_ms: 6600 });
    expect(s.appended().length).toBe(before);
    await wait(1300);
    expect(s.appended().slice(before)[0]).toMatchObject({ delegation_id: 'dlg_1' });
  });

  it('委任が入力transcriptより先に届いた場合は、発話を取りこぼさないよう従来どおり待つ', async () => {
    const s = setup('hybrid');
    const before = s.appended().length;
    s.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' }, offset_ms: 6600 });
    s.emit({ type: 'session.input_transcript.delta', delta: 'いいえ、不要です', start_ms: 5200, end_ms: 6000 });
    await wait(100);
    // 委任時点で未分析の発話は分析してから答える（Fast Path）。前の質問の繰り返しを返していない
    const sent = s.appended().slice(before);
    expect(sent.length).toBe(1);
    expect(String(sent[0].content)).toContain('急いで対応が必要な状況');
    expect(s.conv.facts.towing_requested.value).toBe(false);
  });
});

describe('Live：割り込み', () => {
  it('応答を送った後、音声が始まる前に顧客が話し始めたら、前のターンは「割り込み」として閉じ、新しい発話を分析する', async () => {
    const s = setup('hybrid');
    await customerSays(s, 'いいえ、不要です', 6000);
    s.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' }, offset_ms: 6600 });
    await customerSays(s, 'あ、すみません、足が痛いです', 7600);
    expect(s.conv.turns[0].status).toBe('interrupted');
    expect(s.conv.facts.injuries_present.value).toBe(true);
    expect(s.conv.route.route).toBe('OPERATOR');
  });

  it('最終確認の読上げの途中で「はい」と割り込んでも、読上げを最後まで出力していなければ同意として扱わない', async () => {
    const s = setup('hybrid');
    s.ctl.primeFacts(s.conv, {
      towing_requested: false, injuries_present: false, all_occupants_injury_checked: true, other_person_or_vehicle_involved: false, third_party_property_involved: false,
      property_ownership: 'own', incident_kind: 'collision', accident_date: '2026-11-06', accident_time: '08:00', municipality: '東京都千代田区', accident_description: '車庫の壁に接触',
      damage: '後ろのバンパー', driver: '連絡者本人', caller_name_kana: 'テスト イチロウ', callback_phone: '00000000001', policy_number: 'MOCK001', sms_allowed: true,
    });
    s.ctl.promptNext(s.conv);
    const rb = s.appended().at(-1)!;
    expect(String(rb.content)).toContain('内容を確認します');
    s.emit({ type: 'session.instructions.appended', client_event_id: rb.event_id as string });
    // 読上げの冒頭だけ出力されたところで「はい」
    s.emit({ type: 'session.output_transcript.delta', delta: '内容を確認します。日付', start_ms: 9000, end_ms: 9800, client_event_id: rb.event_id as string });
    await customerSays(s, 'はい', 10200);
    expect(s.conv.confirmation?.readbackDelivered).toBe(false);
    expect(s.conv.confirmation?.status).toBe('PENDING');
    expect(s.conv.jobIds.length).toBe(0);
  });
});

describe('Live：つなぎ言葉（D15）との両立', () => {
  it('分析が長引いて「確認いたします」を送った場合も、質問はその後に1回だけ送る', async () => {
    const s = setup('baseline', 30);
    // 未分析の発話がない委任 → 待機中に「確認いたします」→ その後に質問
    await customerSays(s, 'いいえ、不要です', 6000);
    const before = s.appended().length;
    s.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' }, offset_ms: 6600 });
    await wait(80);
    const filler = s.appended().slice(before);
    expect(filler.map((e) => String(e.content))).toEqual([expect.stringContaining('確認いたします')]);
    s.emit({ type: 'session.output_transcript.delta', delta: '確認いたします。', start_ms: 7000, end_ms: 7600, client_event_id: filler[0].event_id as string });
    await wait(1300);
    const after = s.appended().slice(before + 1);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ delegation_id: 'dlg_1' });
    const turn = s.conv.turns.at(-1)!;
    expect(turn.marks.filler_sent).toBeDefined();
  });
});

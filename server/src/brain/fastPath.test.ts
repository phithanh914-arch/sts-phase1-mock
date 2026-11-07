import { describe, it, expect } from 'vitest';
import { tryFastPath, questionWasSpoken } from './fastPath.js';
import { RuleBrain } from './ruleBrain.js';
import type { BrainContext, ReceptionBrain, ReceptionPlan } from './types.js';
import type { Utterance } from '../domain/types.js';
import { Harness } from '../eval/harness.js';
import { TURN_CASES, runTurnCase } from '../eval/turnBench.js';
import { SessionController } from '../session/controller.js';
import { TextSink } from '../eval/harness.js';

const u = (id: string, text: string, speaker: Utterance['speaker'] = 'customer', kind: Utterance['kind'] = 'input'): Utterance => ({ id, text, speaker, kind, at: '', source: 'text' });
const base = { lastQuestionKey: 'towing_requested', questionSpoken: true, confirmationPending: false, callActive: true };

describe('Fast Path：許可リストの完全一致だけを確定する', () => {
  it('質問IDがなければ使わない（「いいえ」を単体で解釈しない）', () => {
    expect(tryFastPath({ ...base, lastQuestionKey: null, pending: [u('U-1', 'いいえ')] })).toMatchObject({ hit: false, reason: 'no_question_id' });
  });
  it('対象外の質問（事故の状況など）はLLMへ', () => {
    expect(tryFastPath({ ...base, lastQuestionKey: 'accident_narrative', pending: [u('U-1', 'いいえ')] }).hit).toBe(false);
  });
  it('最終確認の読上げへの返事（同意）は対象外', () => {
    expect(tryFastPath({ ...base, confirmationPending: true, pending: [u('U-1', 'はい')] })).toMatchObject({ hit: false, reason: 'confirmation_pending' });
  });
  it('未分析の発話が2件以上ならLLMへ', () => {
    expect(tryFastPath({ ...base, pending: [u('U-1', 'いいえ'), u('U-2', '足が痛いです')] }).hit).toBe(false);
  });
  it('質問が実際に話されていなければLLMへ', () => {
    expect(tryFastPath({ ...base, questionSpoken: false, pending: [u('U-1', 'いいえ')] })).toMatchObject({ hit: false, reason: 'question_not_spoken' });
  });
  for (const t of ['レッカーは不要ですが、足を打っています', 'いいえ、でも煙が出ています', 'たぶん不要です', '不要だと思います', 'いいえ。あ、やっぱり必要です', 'ん', 'はい、大丈夫です']) {
    it(`「${t}」はFast Pathで処理しない`, () => {
      expect(tryFastPath({ ...base, pending: [u('U-1', t)] }).hit).toBe(false);
    });
  }
  it('「急ぎの状況はありますか」への「はい」は扱わない（何が起きているかの聴取が必要）', () => {
    expect(tryFastPath({ ...base, lastQuestionKey: 'safety_check', pending: [u('U-1', 'はい')] }).hit).toBe(false);
  });
  it('けがの質問への「はい」→ けがあり（有人転送はコードの振り分けで行う）', () => {
    const r = tryFastPath({ ...base, lastQuestionKey: 'injuries_present', pending: [u('U-1', 'はい')] });
    expect(r.hit && r.proposals).toEqual([expect.objectContaining({ key: 'injuries_present', value: true, evidenceRefs: ['U-1'] })]);
  });
  it('乗員の質問は肯定/否定の向きが逆（「乗っていた」→無人ではない）', () => {
    const yes = tryFastPath({ ...base, lastQuestionKey: 'parked_vehicle_unoccupied', pending: [u('U-1', 'はい、乗っていました')] });
    const no = tryFastPath({ ...base, lastQuestionKey: 'parked_vehicle_unoccupied', pending: [u('U-1', 'いいえ、誰も乗っていませんでした')] });
    expect(yes.hit && yes.proposals[0]).toMatchObject({ key: 'parked_vehicle_unoccupied', value: false });
    expect(no.hit && no.proposals[0]).toMatchObject({ key: 'parked_vehicle_unoccupied', value: true });
  });
  it('questionWasSpoken：直前の顧客発話より後のAI出力に質問文が含まれるか', () => {
    const us = [u('A-1', 'はい。', 'ai', 'spoken'), u('A-2', '事故でおけがをされた方や、痛みのある方はいらっしゃいますか。', 'ai', 'spoken'), u('U-3', 'いいえ')];
    expect(questionWasSpoken(us, 'U-3', '事故でおけがをされた方や、痛みのある方はいらっしゃいますか。')).toBe(true);
    expect(questionWasSpoken([u('A-1', 'はい。', 'ai', 'spoken'), u('U-2', 'いいえ')], 'U-2', '事故でおけがをされた方や、痛みのある方はいらっしゃいますか。')).toBe(false);
  });
});

describe('1ターン比較ケース（Hybrid × Deterministic）', () => {
  for (const tc of TURN_CASES) {
    it(`${tc.id} ${tc.category}「${tc.say}」→ Fast Path ${tc.fast}`, async () => {
      const r = await runTurnCase(new RuleBrain(), 'hybrid', tc);
      expect(r.fastPathCorrect, r.failures.join(' / ')).toBe(true);
      // Fast Pathで確定したケースは、事実・振り分けとも期待どおりであること（誤判定ゼロ）
      if (tc.fast === 'hit') expect(r.failures).toEqual([]);
    });
  }
});

/** 呼び出し回数を数えるBrain（LLMの代わり） */
class CountingBrain implements ReceptionBrain {
  readonly name = 'counting-llm-stub';
  calls = 0;
  constructor(private inner: ReceptionBrain, private override?: (p: ReceptionPlan) => ReceptionPlan) {}
  async analyze(ctx: BrainContext) { this.calls++; const p = await this.inner.analyze(ctx); return this.override ? this.override(p) : p; }
}

describe('Fast PathとLLMの二重処理・状態の整合', () => {
  it('Fast Pathで確定した発話はLLMに渡さない（同じ発話を二重に処理しない）', async () => {
    const b = new CountingBrain(new RuleBrain());
    const h = new Harness({ b }, 'b', { profile: 'hybrid' });
    await h.say('いいえ、不要です');
    expect(b.calls).toBe(0);
    expect(h.fact('towing_requested').value).toBe(false);
    expect(h.conv.analyses.map((a) => a.brain)).toEqual(['fast-path']);
    expect(h.conv.watermark).toBe(h.conv.utterances.find((x) => x.speaker === 'customer')!.id);
    expect(h.lastAi()).toBe('今、急いで対応が必要な状況はありますか。');
    await h.say('いいえ、でも車から煙が出ています');
    expect(b.calls).toBe(1);
    expect(h.conv.route.route).toBe('OPERATOR_EMERGENCY');
  });

  it('Shadow評価のLLM結果は、確定済みの状態を書き換えない', async () => {
    // LLMがわざと逆の値を返す
    const b = new CountingBrain(new RuleBrain(), (p) => ({ ...p, factProposals: [{ key: 'towing_requested', value: true, status: 'captured', evidenceRefs: p.evidenceRefs, isCorrection: false }] }));
    const ctl = new SessionController({ brains: { b }, defaultBrain: 'b', defaultProfile: 'hybrid', fastPathShadow: true, today: () => '2026-11-06' });
    const c = ctl.create('text', new TextSink(() => ctl), 'b');
    await ctl.customerSays(c, 'いいえ、不要です');
    await new Promise((r) => setTimeout(r, 30));
    expect(b.calls).toBe(1);
    expect(c.facts.towing_requested.value).toBe(false);
    expect(c.route.route).not.toBe('TOWING');
    expect(c.analyses[0].shadow?.status).toBe('disagree');
  });

  it('レッカーの「はい」→ レッカー転送（契約照合を待たない）', async () => {
    const h = new Harness({ b: new RuleBrain() }, 'b', { profile: 'hybrid' });
    await h.say('はい');
    expect(h.conv.route.route).toBe('TOWING');
    expect(h.conv.transfer?.target).toBe('TOWING_DESK');
  });
});

import { describe, it, expect } from 'vitest';
import { CASES, type MakeHarness } from './cases.js';
import { Harness } from './harness.js';
import { RuleBrain } from '../brain/ruleBrain.js';

// APIキー不要のDeterministic比較モードで業務ロジック（振り分け・ゲート・RPA状態）を検証する。
// LLM方式・音声の品質はこのテストの対象外。
const make: MakeHarness = (opts = {}) => {
  const base = new RuleBrain();
  const brain = opts.wrapBrain ? opts.wrapBrain(base) : base;
  return new Harness({ rule: brain }, 'rule', opts);
};

describe('acceptance-cases (rule brain, text path)', () => {
  for (const cd of CASES) {
    it(`${cd.id} ${cd.title} → ${cd.expected}`, async () => {
      const checks = await cd.run(make);
      const failed = checks.filter((c) => !c.pass);
      expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    }, 15000);
  }
});

describe('confirmation by short answer', () => {
  it('「はい」だけで最終確認に同意できる（読上げ直後のみ）', async () => {
    const h = make();
    await h.say('自分が所有する車庫の壁にバックでぶつけました。乗っていたのは私だけで、けがはありません。相手の人や車はいません。レッカーはいりません。今朝8時ごろです。後ろのバンパーを擦りました。');
    await h.say('場所は東京都千代田区です。運転していたのは私です。名前はテスト イチロウです。電話番号は00000000001です。証券番号はMOCK001です。SMSは大丈夫です。');
    expect(h.conv.receptionState).toBe('READY_FOR_CONFIRMATION');
    expect(h.fact('accident_description').value).toContain('車庫の壁');
    await h.say('はい');
    expect(h.conv.receptionState).toBe('CONFIRMED');
    await h.waitFor(() => h.conv.registrationState === 'REGISTERED');
    expect(h.coreRecords().length).toBe(1);
  });
});

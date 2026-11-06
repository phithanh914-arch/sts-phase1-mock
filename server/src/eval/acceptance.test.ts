import { describe, it, expect } from 'vitest';
import { CASES, type MakeHarness } from './cases.js';
import { Harness } from './harness.js';
import { RuleBrain } from '../brain/ruleBrain.js';
import type { ProfileName } from '../session/latency.js';

// APIキー不要のDeterministic比較モードで業務ロジック（振り分け・ゲート・RPA状態）を検証する。
// LLM方式・音声の品質はこのテストの対象外。
const makeFor = (profile: ProfileName): MakeHarness => (opts = {}) => {
  const base = new RuleBrain();
  const brain = opts.wrapBrain ? opts.wrapBrain(base) : base;
  return new Harness({ rule: brain }, 'rule', { profile, ...opts });
};
const make = makeFor('baseline');

// 改善前（A）・軽量化（B）・Hybrid（C）のすべてで既存39ケースが通ること（D16〜D18の回帰確認）
for (const profile of ['baseline', 'lightweight', 'hybrid'] as const) {
  describe(`acceptance-cases (rule brain, text path, profile=${profile})`, () => {
    for (const cd of CASES) {
      it(`${cd.id} ${cd.title} → ${cd.expected}`, async () => {
        const checks = await cd.run(makeFor(profile));
        const failed = checks.filter((c) => !c.pass);
        expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
      }, 15000);
    }
  });
}

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

describe('音声で多い短い返事（けがの質問）', () => {
  for (const [ans, exp] of [['いえ、大丈夫です', false], ['大丈夫です', false], ['はい、大丈夫です', false], ['特にないです', false], ['いいえ', false], ['はい、います', true]] as const) {
    it(`「${ans}」→ injuries_present=${exp}`, async () => {
      const h = make();
      await h.say('レッカーはいりません。');
      expect(h.lastAi()).toMatch(/おけが|痛み/);
      await h.say(ans);
      expect(h.fact('injuries_present').value).toBe(exp);
      if (!exp) expect(h.fact('all_occupants_injury_checked').value).toBe(true);
      else expect(h.conv.route.route).toBe('OPERATOR');
    });
  }
  it('「物は大丈夫です」はけがの回答として扱わない', async () => {
    const h = make();
    await h.say('レッカーはいりません。');
    await h.say('物は大丈夫です');
    expect(h.fact('injuries_present').status).toBe('missing');
  });
  it('AI発話が複数ターンに分かれても直前の質問に結び付ける', async () => {
    const h = make();
    await h.say('レッカーはいりません。');
    h.ctl.aiSpoke(h.conv, 'はい、ありがとうございます', 'text');
    await h.say('いえ、大丈夫です');
    // 直前の分割ターンには質問がないが、同じ応答区間の質問（けが）に結び付く
    expect(h.fact('injuries_present').value).toBe(false);
  });
});

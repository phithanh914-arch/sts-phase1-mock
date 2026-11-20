import { describe, expect, it } from 'vitest';
import { emptyFacts } from './facts.js';
import { nameFromEcho, nameReadingIsGuess, normalizePolicyNumber, policyQuestion, policyQuestionsExhausted, selectNextQuestion, spokenId } from './questions.js';
import type { Fact, RouteDecision } from './types.js';

const fact = (key: string, value: string, originalExpression?: string, status: Fact['status'] = 'captured'): Fact =>
  ({ key, value, status, origin: 'llm', evidenceRefs: [], originalExpression, lastUpdatedVersion: 1, history: [] }) as unknown as Fact;
const self: RouteDecision = { route: 'SELF_SERVICE', reasons: [], unresolved: [], safetyFlags: [] };

describe('D26 証券番号の表記ゆれ', () => {
  it.each([
    ['Cの123456789', 'C123456789'],
    ['シーの123456789', 'C123456789'],
    ['しーの123-456-789', 'C123456789'],
    ['Ｃ１２３４５６７８９', 'C123456789'],
    ['c 123 456 789 です', 'C123456789'],
    ['C123456789', 'C123456789'],
  ])('%s → %s', (raw, want) => expect(normalizePolicyNumber(raw)).toBe(want));

  it('読み取れない文字が残る場合は元の値のまま', () => expect(normalizePolicyNumber('分かりません')).toBe('分かりません'));
  it('読み上げ用に区切る', () => expect(spokenId('C123456789')).toBe('C・123・456・789'));
});

describe('D26 契約確認は同じ質問を繰り返さない', () => {
  it('1回目は証券番号か登録番号を聞く', () => {
    expect(policyQuestion(emptyFacts(), {})?.key).toBe('policy_match');
  });
  it('証券番号が見つからなければ、読み上げて登録番号を1回だけ聞く', () => {
    const facts = { ...emptyFacts(), policy_number: fact('policy_number', 'C123456789') };
    const pq = policyQuestion(facts, { policy_match: 1 });
    expect(pq?.key).toBe('policy_alt');
    expect(pq?.text).toContain('C・123・456・789');
    expect(policyQuestion(facts, { policy_match: 1, policy_alt: 1 })).toBeNull();
    expect(policyQuestionsExhausted(facts, { policy_match: 1, policy_alt: 1 })).toBe(true);
  });
  it('何も聞き取れなければ言い方を変えてもう1回、それでもだめなら終わり', () => {
    const pq = policyQuestion(emptyFacts(), { policy_match: 1 });
    expect(pq?.key).toBe('policy_match');
    expect(pq?.text).toContain('もう一度');
    expect(policyQuestion(emptyFacts(), { policy_match: 2 })).toBeNull();
  });
});

describe('D26 氏名の読みが漢字からの推測か', () => {
  it('漢字で文字起こしされた名前は推測扱い', () => {
    expect(nameReadingIsGuess(fact('caller_name_kana', 'キタガワ リュウジ', '北川隆司です'))).toBe(true);
  });
  it('発話にカナの読みがそのまま含まれていれば推測ではない', () => {
    expect(nameReadingIsGuess(fact('caller_name_kana', 'キタガワ タカトシ', '名前はキタガワタカトシです。東京都で事故')) ).toBe(false);
  });
  it('一文字ずつの読みは推測ではない', () => {
    expect(nameReadingIsGuess(fact('caller_name_kana', 'キタガワタカトシ', 'キ、タ、ガ、ワ、タ、カ、ト、シ'))).toBe(false);
  });
  it('確認済みなら聞かない', () => {
    expect(nameReadingIsGuess(fact('caller_name_kana', 'キタガワ リュウジ', '北川隆司', 'confirmed'))).toBe(false);
  });
  it('推測でも、読み方を一文字ずつ聞く質問はしない（D27）', () => {
    const facts = { ...emptyFacts(), caller_name_kana: fact('caller_name_kana', 'キタガワ リュウジ', '北川隆司です') };
    expect(selectNextQuestion({ facts, route: self, policyMatched: false, asked: {} })?.text ?? '').not.toContain('一文字ずつ');
  });
});

describe('D27 GPT-Live の復唱から読みを取る', () => {
  it.each([
    ['キタガワタカトシ様ですね。折り返しの…', 'キタガワタカトシ'],
    ['キタガワ タカトシ様ですね。', 'キタガワ タカトシ'],
    ['「キタガワタカトシ」さまですね', 'キタガワタカトシ'],
  ])('%s → %s', (spoken, want) => expect(nameFromEcho(spoken)).toBe(want));
  it.each(['北川隆司様ですね。', 'きたがわ様ですね', '折り返しのお電話番号を教えてください。'])('%s → 使わない', (spoken) => expect(nameFromEcho(spoken)).toBeNull());
});

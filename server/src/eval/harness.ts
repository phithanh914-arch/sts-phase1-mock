// acceptance-cases.json を実行可能にするためのハーネス（テキスト経路）。
// テキスト入力と音声入力は同じSessionControllerを通るため、業務ロジックの判定はこの経路で検証する。
// 音声品質・GPT-Liveの発話内容はここでは検証しない（人による確認が必要）。

import { SessionController, type SpeechDirective, type SpeechSink } from '../session/controller.js';
import type { Conversation } from '../session/conversation.js';
import type { ReceptionBrain } from '../brain/types.js';
import type { FaultConfig } from '../adapters/faults.js';

export class TextSink implements SpeechSink {
  constructor(private ctl: () => SessionController) {}
  deliver(conv: Conversation, d: SpeechDirective) {
    this.ctl().aiSpoke(conv, d.text, 'text', d.tag);
  }
}

export interface Check { name: string; pass: boolean; detail?: string }

export class Harness {
  ctl: SessionController;
  conv: Conversation;
  constructor(brains: Record<string, ReceptionBrain>, brain: string, opts: { brainTimeoutMs?: number; callWaitLimitMs?: number; faults?: Partial<FaultConfig> } = {}) {
    this.ctl = new SessionController({ brains, defaultBrain: brain, brainTimeoutMs: opts.brainTimeoutMs ?? 30000, callWaitLimitMs: opts.callWaitLimitMs ?? 600, today: () => '2026-11-06' });
    this.ctl.faults = { ...this.ctl.faults, rpaDurationMs: 150, rpaDelayMs: 2500, transferDelayMs: 60, ...opts.faults };
    this.conv = this.ctl.create('text', new TextSink(() => this.ctl), brain);
  }
  async say(text: string) { await this.ctl.customerSays(this.conv, text); }
  async waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  }
  sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
  aiTexts(): string[] { return this.conv.utterances.filter((u) => u.speaker === 'ai').map((u) => u.text); }
  lastAi(): string { const a = this.aiTexts(); return a[a.length - 1] ?? ''; }
  coreRecords() { return this.ctl.core.findByClaim(this.conv.claimId); }
  fact(k: string) { return this.conv.facts[k]; }
}

/** 共通の発話（合成データ。実顧客データではない） */
export const SCRIPT = {
  eligibleStory: 'レッカーはいりません。今朝8時ごろ、自分が所有する車庫の壁にバックでぶつけました。乗っていたのは私だけで、けがはありません。他の人や車は関係していません。車は走れます。後ろのバンパーを擦りました。',
  restInfo: '場所は東京都千代田区です。運転していたのは私です。名前はテスト イチロウです。電話番号は00000000001です。証券番号はMOCK001です。SMSは大丈夫です。',
};

export async function toDraftEligible(h: Harness) {
  await h.say(SCRIPT.eligibleStory);
}
export async function toReadyForConfirmation(h: Harness) {
  await toDraftEligible(h);
  await h.say(SCRIPT.restInfo);
}
export async function toConfirmed(h: Harness) {
  await toReadyForConfirmation(h);
  await h.say('はい、間違いありません。');
}

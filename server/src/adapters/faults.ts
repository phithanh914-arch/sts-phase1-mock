// テスト操作（障害注入）。画面とテストから設定する。

export type RpaFault = 'success' | 'delay' | 'precommit_fail' | 'commit_then_timeout' | 'field_error';
export type TransferFault = 'success' | 'fail';

export interface FaultConfig {
  rpa: RpaFault;
  transfer: TransferFault;
  /** 模擬RPAの通常処理時間(ms) */
  rpaDurationMs: number;
  /** delay時の処理時間(ms) */
  rpaDelayMs: number;
  transferDelayMs: number;
}

export function defaultFaults(): FaultConfig {
  return { rpa: 'success', transfer: 'success', rpaDurationMs: 2500, rpaDelayMs: 45000, transferDelayMs: 1500 };
}

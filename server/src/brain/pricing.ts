// Brainモデルの単価（USD / 100万トークン）。
// 出典：OpenAI公式モデルページ（developers.openai.com/api/docs/models/<model>、2026-11-06確認）。
// 単価が変わる可能性があるため、費用は「推定」として表示する。表にないモデルは費用を出さない（不明）。
export const PRICES_PER_MTOK: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-6-luna': { input: 0.10, cachedInput: 0.01, output: 0.50 },
  'gpt-6.1-terra': { input: 1.00, cachedInput: 0.05, output: 5.00 },
};

/** 公式ページで reasoning.effort として受け付けると記載のある値（2026-11-06確認）。minimal は記載なし */
export const SUPPORTED_EFFORTS: Record<string, string[]> = {
  'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-6.1-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export function estimateCostUsd(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): number | null {
  const p = PRICES_PER_MTOK[model];
  if (!p) return null;
  const uncached = Math.max(0, inputTokens - cachedTokens);
  return (uncached * p.input + cachedTokens * p.cachedInput + outputTokens * p.output) / 1_000_000;
}

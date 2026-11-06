import { describe, expect, it } from 'vitest';
import { buildLiveInstructions, LIVE_INSTRUCTIONS, normalizeStyle, SPEECH_SPEEDS, SPEECH_TONES } from './instructions.js';

describe('話し方（速さ・トーン）', () => {
  it('選んだ速さ・トーンの文がinstructionsに入る', () => {
    const s = buildLiveInstructions('slow', 'soft');
    expect(s).toContain(SPEECH_SPEEDS.slow.text);
    expect(s).toContain(SPEECH_TONES.soft.text);
    expect(s).not.toContain('{{STYLE}}');
  });
  it('不正値は既定（標準・丁寧）に戻す', () => {
    expect(normalizeStyle('turbo', 123)).toEqual({ speed: 'normal', tone: 'polite' });
    expect(normalizeStyle('__proto__', 'toString')).toEqual({ speed: 'normal', tone: 'polite' });
    expect(LIVE_INSTRUCTIONS).toContain(SPEECH_TONES.polite.text);
  });
});

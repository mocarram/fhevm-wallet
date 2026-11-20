import { describe, expect, it } from 'vitest';
import { stripUnsafeChars } from '../../src/utils/text.js';
import { sanitizeContractText } from '../../src/core/token/txErrors.js';

describe('stripUnsafeChars', () => {
  it.each([
    ['C0 / ESC', '\u001b[2J'],
    ['C1', '\u009b'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['Arabic letter mark', '\u061c'],
    ['word joiner', '\u2060'],
    ['invisible plus', '\u2064'],
    ['RLO', '\u202e'],
    ['isolate', '\u2067'],
    ['zero width space', '\u200b'],
    ['BOM', '\ufeff'],
  ])('removes %s', (_name, ch) => {
    expect(stripUnsafeChars(`a${ch}b`)).not.toContain(ch);
  });

  it('keeps ordinary text, including non-Latin letters', () => {
    expect(stripUnsafeChars('Ünïcødé トークン 1.5')).toBe('Ünïcødé トークン 1.5');
  });

  it('is what sanitizeContractText uses', () => {
    expect(sanitizeContractText('US\u2028D\u2060C')).toBe('US D C');
  });
});

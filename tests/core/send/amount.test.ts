import { describe, expect, it } from 'vitest';
import {
  formatBalance,
  formatExactAmount,
  parseFriendlyAmount,
} from '../../../src/core/send/amount.js';
import { MAX_EUINT64 } from '../../../src/core/token/limits.js';

const six = { decimals: 6, balance: 1_250_500_000n }; // 1,250.5 with 6 decimals

function value(input: string, opts = six): bigint {
  const r = parseFriendlyAmount(input, opts);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('parseFriendlyAmount', () => {
  it('parses plain numbers exactly in base units', () => {
    expect(value('25')).toBe(25_000_000n);
    expect(value('0.000001')).toBe(1n);
    expect(value(' 12.5 ')).toBe(12_500_000n);
  });

  it('accepts thousands separators', () => {
    expect(value('1,250.50')).toBe(1_250_500_000n);
    expect(value('1,000', { decimals: 0, balance: 5000n })).toBe(1000n);
  });

  it('rejects misplaced commas', () => {
    expect(parseFriendlyAmount('1,25', six).ok).toBe(false);
    expect(parseFriendlyAmount('12,3456', six).ok).toBe(false);
  });

  it('expands k without floating point', () => {
    expect(value('1k')).toBe(1_000_000_000n);
    expect(value('1.2K')).toBe(1_200_000_000n);
    expect(value('0.0015k')).toBe(1_500_000n);
  });

  it('applies the token decimals limit after the k shift', () => {
    expect(value('0.000001k', { decimals: 3, balance: 10n })).toBe(1n);
    const r = parseFriendlyAmount('0.0000001k', { decimals: 3, balance: 10n });
    expect(r.ok).toBe(false);
  });

  it('computes half and max from the decrypted balance', () => {
    expect(value('max')).toBe(1_250_500_000n);
    expect(value('ALL')).toBe(1_250_500_000n);
    expect(value('half')).toBe(625_250_000n);
    expect(value('half', { decimals: 0, balance: 3n })).toBe(1n);
  });

  it('needs the balance for half and max', () => {
    const r = parseFriendlyAmount('max', { decimals: 6 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not decrypted/);
  });

  it('rejects zero, junk and too many decimals', () => {
    expect(parseFriendlyAmount('0', six).ok).toBe(false);
    expect(parseFriendlyAmount('', six).ok).toBe(false);
    expect(parseFriendlyAmount('abc', six).ok).toBe(false);
    expect(parseFriendlyAmount('-5', six).ok).toBe(false);
    expect(parseFriendlyAmount('1e3', six).ok).toBe(false);
    const r = parseFriendlyAmount('1.1234567', six);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 6/);
  });

  it('rejects more than the balance, because ERC-7984 would move 0', () => {
    const r = parseFriendlyAmount('2k', six);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/send 0/);
  });

  it('rejects amounts above the euint64 limit', () => {
    const r = parseFriendlyAmount((MAX_EUINT64 + 1n).toString(), { decimals: 0 });
    expect(r.ok).toBe(false);
    expect(value(MAX_EUINT64.toString(), { decimals: 0 } as never)).toBe(MAX_EUINT64);
  });
});

describe('formatting', () => {
  it('formats exact amounts with grouping and all decimals', () => {
    expect(formatExactAmount(1_250_500_000n, 6)).toBe('1,250.5');
    expect(formatExactAmount(1n, 6)).toBe('0.000001');
    expect(formatExactAmount(1_000_000n, 0)).toBe('1,000,000');
  });

  it('formats balances compactly with two decimals', () => {
    expect(formatBalance(1_250_000_000n, 6)).toBe('1,250.00');
    expect(formatBalance(80_500_000n, 6)).toBe('80.50');
    expect(formatBalance(421_000_000_000_000_000n, 18, 4)).toBe('0.4210');
  });
});

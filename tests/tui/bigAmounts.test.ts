/**
 * Billions of a token: Home abbreviates (several tokens share one row), every other
 * screen shows the exact amount, and the tables keep their columns in line.
 */

import { describe, expect, it } from 'vitest';
import { formatCompactAmount } from '../../src/tui/format.js';
import type { HistoryRow } from '../../src/tui/state.js';
import { Harness } from './harness.js';

/** The largest confidential balance: euint64 base units (2^64 − 1). */
const MAX_EUINT64 = 2n ** 64n - 1n;

describe('formatCompactAmount', () => {
  it('is exact below a million', () => {
    expect(formatCompactAmount(999_999_500_000n, 6)).toBe('999,999.50');
    expect(formatCompactAmount(97_400_000n, 6)).toBe('97.40');
    expect(formatCompactAmount(0n, 6)).toBe('0.00');
  });

  it('shortens from a million up, rounding down so it never shows more than you hold', () => {
    expect(formatCompactAmount(1_000_000n * 10n ** 6n, 6)).toBe('1.00M');
    expect(formatCompactAmount(12_345_678_901_123_456n, 6)).toBe('12.34B');
    expect(formatCompactAmount(1_999_999_999n * 10n ** 6n, 6)).toBe('1.99B');
    expect(formatCompactAmount(MAX_EUINT64, 6)).toBe('18.44T');
    // 0 decimals: the whole euint64 range is units.
    expect(formatCompactAmount(MAX_EUINT64, 0)).toBe('18,446.74Q');
    expect(formatCompactAmount(-2_500_000n, 0)).toBe('-2.50M');
  });
});

/** Column where `needle` starts on the line that contains it. */
function columnOf(text: string, lineIncludes: string, needle: string): number {
  const row = text.split('\n').find((l) => l.includes(lineIncludes)) ?? '';
  return row.indexOf(needle);
}

describe('screens with billions', () => {
  function withBig(value: bigint): Harness {
    const h = new Harness({ unlocked: true });
    h.s.eth = { wei: 421n * 10n ** 15n, at: h.now };
    const t = h.s.data.tokens[0];
    h.s.balances[t.address.toLowerCase()] = { value, at: h.now, source: 'session' };
    return h;
  }

  it('Home shows 12.34B; Balances shows the exact amount with Contract still aligned', async () => {
    const h = withBig(12_345_678_901_123_456n);
    expect(h.text(104)).toMatch(/cUSDC 12\.34B/);
    expect(h.text(104)).not.toMatch(/12,345,678,901/);
    await h.keys('b');
    // Opening Balances refreshes from the mock; put the big value back for the frame.
    const t = h.s.data.tokens[0];
    h.s.balances[t.address.toLowerCase()] = {
      value: 12_345_678_901_123_456n,
      at: h.now,
      source: 'session',
    };
    const text = h.text(104);
    expect(text).toMatch(/12,345,678,901\.123456/);
    const contract = columnOf(text, 'Token ', 'Contract');
    expect(columnOf(text, 'native · pays gas', 'native')).toBe(contract);
    expect(columnOf(text, 'cUSDC ', '0x')).toBe(contract);
  });

  it('the euint64 maximum still fits: 18.44T on Home, every digit on Balances', async () => {
    const h = withBig(MAX_EUINT64);
    expect(h.text(104)).toMatch(/cUSDC 18\.44T/);
    await h.keys('b');
    const t = h.s.data.tokens[0];
    h.s.balances[t.address.toLowerCase()] = { value: MAX_EUINT64, at: h.now, source: 'session' };
    const text = h.text(104);
    expect(text).toMatch(/18,446,744,073,709\.551615/);
    expect(columnOf(text, 'cUSDC ', '0x')).toBe(columnOf(text, 'Token ', 'Contract'));
  });

  it('History keeps Token and With in line next to a huge amount', async () => {
    const h = withBig(1_000_000n);
    await h.keys('h');
    const row = (amount: string, token: string): HistoryRow => ({
      when: 'Nov 23 09:35',
      kind: 'received',
      amount,
      token,
      counterparty: 'bob',
      txHash: '0x' + '12'.repeat(32),
    });
    h.s.history = {
      rows: [row('+18,446,744,073,709.551615', 'cUSDC'), row('-0.25', 'cZAMA')],
      loading: false,
    };
    const text = h.text(104);
    const token = columnOf(text, 'When ', 'Token');
    expect(columnOf(text, '+18,446', 'cUSDC')).toBe(token);
    expect(columnOf(text, '-0.25', 'cZAMA')).toBe(token);
  });
});

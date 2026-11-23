import { describe, expect, it } from 'vitest';
import {
  approvalPlan,
  describeRate,
  describeWrapPlan,
  needsReset,
  planUnwrap,
  planWrap,
  planWrapAmount,
  smallestWrap,
  type WrapSides,
} from '../../../src/core/token/wrapMath.js';
import { MAX_EUINT64 } from '../../../src/core/token/limits.js';

/** cZAMA on Sepolia: 18-decimal ZAMA behind a 6-decimal wrapper. */
const CZAMA: WrapSides = {
  rate: 10n ** 12n,
  symbol: 'cZAMA',
  decimals: 6,
  underlying: { symbol: 'ZAMA', decimals: 18 },
};
/** cUSDT: same decimals on both sides. */
const CUSDT: WrapSides = {
  rate: 1n,
  symbol: 'cUSDT',
  decimals: 6,
  underlying: { symbol: 'USDT', decimals: 6 },
};
/** cWBTC: 8-decimal WBTC, rate 100. */
const CWBTC: WrapSides = {
  rate: 100n,
  symbol: 'cWBTC',
  decimals: 6,
  underlying: { symbol: 'WBTC', decimals: 8 },
};

describe('planWrapAmount', () => {
  it('refuses the amount that once wrapped to 0 (1e8 base units at rate 1e12)', () => {
    const p = planWrapAmount(100_000_000n, CZAMA);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toBe('That wraps to 0 cZAMA: the smallest amount is 0.000001 ZAMA.');
    expect(p.hint).toMatch(/Nothing was signed/);
  });

  it('rounds down to whole confidential units and reports the dust', () => {
    const p = planWrapAmount(2_000_000_500_000_000_000n, CZAMA); // 2.0000005 ZAMA
    expect(p).toMatchObject({ ok: true, wrapped: 2_000_000n, dust: 500_000_000_000n });
    if (!p.ok) return;
    expect(p.pull).toBe(2_000_000_000_000_000_000n);
    expect(p.pull + p.dust).toBe(p.amount);
    expect(describeWrapPlan(p, CZAMA)).toEqual({
      get: 'You get 2 cZAMA.',
      stays: '0.0000005 ZAMA stays in your wallet (below 1 cZAMA unit).',
    });
  });

  it('takes exactly one rate as the smallest wrap', () => {
    expect(smallestWrap(CZAMA)).toBe(10n ** 12n);
    expect(planWrapAmount(10n ** 12n, CZAMA)).toMatchObject({ ok: true, wrapped: 1n, dust: 0n });
    expect(planWrapAmount(10n ** 12n - 1n, CZAMA).ok).toBe(false);
  });

  it('has no dust at rate 1 and handles rate 100', () => {
    const u = planWrapAmount(25_000_000n, CUSDT);
    expect(u).toMatchObject({ ok: true, wrapped: 25_000_000n, dust: 0n, pull: 25_000_000n });
    if (u.ok) expect(describeWrapPlan(u, CUSDT).stays).toBeUndefined();
    expect(planWrapAmount(12_345n, CWBTC)).toMatchObject({
      ok: true,
      wrapped: 123n,
      dust: 45n,
      pull: 12_300n,
    });
  });

  it('checks the public balance, the 64-bit bound and the supply room', () => {
    expect(planWrapAmount(5n * 10n ** 18n, CZAMA, { balance: 10n ** 18n })).toMatchObject({
      ok: false,
      error: "That's more than the 1 ZAMA in this wallet.",
    });
    const over = (MAX_EUINT64 + 1n) * CZAMA.rate;
    expect(planWrapAmount(over, CZAMA)).toMatchObject({ ok: false, error: /64-bit limit/ });
    // 2^64-1 units of cZAMA is fine (≈ 18.4 trillion ZAMA): the limit is on wrapped units.
    expect(planWrapAmount(MAX_EUINT64 * CZAMA.rate, CZAMA).ok).toBe(true);
    expect(planWrapAmount(10n ** 18n, CZAMA, { supplyRoom: 10n })).toMatchObject({
      ok: false,
      error: /can only mint 0.00001 more cZAMA/,
    });
    expect(planWrapAmount(0n, CZAMA).ok).toBe(false);
  });
});

describe('planWrap (typed input)', () => {
  it('reads ZAMA amounts above the euint64 base-unit limit (18 decimals)', () => {
    // 20 ZAMA = 2e19 base units > 2^64-1, which the send parser would refuse.
    const p = planWrap('20', CZAMA, { balance: 100n * 10n ** 18n });
    expect(p).toMatchObject({ ok: true, wrapped: 20_000_000n, dust: 0n });
  });

  it('max and half use the public balance and show their dust', () => {
    const balance = 1_000_000_000_123_456_789_000n; // 1,000.000000123456789 DAI-like
    const max = planWrap('max', CZAMA, { balance });
    expect(max).toMatchObject({
      ok: true,
      wrapped: 1_000_000_000n,
      dust: 123_456_789_000n,
      meaning: 'your whole balance',
    });
    const half = planWrap('half', CZAMA, { balance });
    expect(half).toMatchObject({ ok: true, amount: balance / 2n });
    expect(planWrap('1k', CUSDT)).toMatchObject({ ok: true, wrapped: 1_000_000_000n });
  });

  it('refuses too many decimals, garbage and over-balance with wrap wording', () => {
    expect(planWrap('0.1234567', CUSDT)).toMatchObject({ ok: false, error: /at most 6/ });
    expect(planWrap('abc', CZAMA).ok).toBe(false);
    expect(planWrap('5', CUSDT, { balance: 1_000_000n })).toMatchObject({
      ok: false,
      hint: 'Only public USDT can be wrapped. Enter a smaller amount.',
    });
    expect(planWrap('0.0000000001', CZAMA)).toMatchObject({ ok: false, error: /wraps to 0 cZAMA/ });
  });
});

describe('planUnwrap', () => {
  it('converts confidential units to underlying units exactly', () => {
    expect(planUnwrap('10', CZAMA, { balance: 97_000_000n })).toMatchObject({
      ok: true,
      amount: 10_000_000n,
      receive: 10n * 10n ** 18n,
    });
    expect(planUnwrap('0.000001', CWBTC)).toMatchObject({ ok: true, amount: 1n, receive: 100n });
  });

  it('refuses more than the decrypted balance (a burn above it burns 0)', () => {
    expect(planUnwrap('98', CZAMA, { balance: 97_000_000n })).toMatchObject({
      ok: false,
      hint: 'ERC-7984 would burn 0 instead of failing, so this is blocked here.',
    });
    expect(planUnwrap('max', CZAMA, { balance: 97_000_000n })).toMatchObject({
      ok: true,
      amount: 97_000_000n,
    });
    expect(planUnwrap('max', CZAMA).ok).toBe(false); // needs the decrypted balance
  });
});

describe('approvals', () => {
  it('approves only when the allowance is short, and exactly the amount', () => {
    expect(approvalPlan(0n, 5n)).toBe('approve');
    expect(approvalPlan(4n, 5n)).toBe('approve');
    expect(approvalPlan(5n, 5n)).toBe('none');
    expect(approvalPlan(2n ** 256n - 1n, 5n)).toBe('none');
    expect(needsReset(0n)).toBe(false);
    expect(needsReset(3n)).toBe(true);
  });
});

describe('describeRate', () => {
  it('names the rate and the smallest wrap', () => {
    expect(describeRate(CZAMA)).toBe(
      '1 cZAMA = 1 ZAMA · amounts below 0.000001 ZAMA cannot be wrapped',
    );
    expect(describeRate(CUSDT)).toBe('1 cUSDT = 1 USDT');
  });
});

/**
 * ERC-20s with fewer than 6 decimals. The wrapper's decimals are then the ERC-20's own,
 * so the rate is 1: every amount wraps 1:1, with no dust and no smallest amount beyond one
 * base unit. These go through the same maths as USDC (rate 1); the tests pin it down.
 */
describe('ERC-20s with fewer than 6 decimals (rate 1)', () => {
  const CEUR2: WrapSides = {
    rate: 1n,
    symbol: 'cEURS',
    decimals: 2,
    underlying: { symbol: 'EURS', decimals: 2 },
  };
  const CPTS0: WrapSides = {
    rate: 1n,
    symbol: 'cPTS',
    decimals: 0,
    underlying: { symbol: 'PTS', decimals: 0 },
  };

  it('2 decimals: 12.34 EURS wraps to exactly 12.34 cEURS, and 0.01 is the smallest', () => {
    expect(planWrap('12.34', CEUR2, { balance: 10_000n })).toMatchObject({
      ok: true,
      amount: 1234n,
      wrapped: 1234n,
      pull: 1234n,
      dust: 0n,
    });
    expect(smallestWrap(CEUR2)).toBe(1n);
    expect(describeRate(CEUR2)).toBe('1 cEURS = 1 EURS');
    // A third decimal does not exist on a 2-decimal token: refused, not rounded.
    expect(planWrap('0.001', CEUR2).ok).toBe(false);
  });

  it('2 decimals: unwrapping 5.5 cEURS returns exactly 5.50 EURS', () => {
    expect(planUnwrap('5.5', CEUR2, { balance: 1234n })).toMatchObject({
      ok: true,
      amount: 550n,
      receive: 550n,
    });
  });

  it('0 decimals: whole units only, 1:1 both ways', () => {
    expect(planWrap('7', CPTS0, { balance: 10n })).toMatchObject({
      ok: true,
      wrapped: 7n,
      pull: 7n,
      dust: 0n,
    });
    expect(planWrap('0.5', CPTS0).ok).toBe(false);
    expect(planUnwrap('3', CPTS0, { balance: 7n })).toMatchObject({ ok: true, receive: 3n });
    expect(describeRate(CPTS0)).toBe('1 cPTS = 1 PTS');
  });
});

/**
 * Exact amount maths for ERC-20 ⇄ ERC-7984 wrapper tokens (OpenZeppelin
 * `ERC7984ERC20Wrapper`). Pure bigint code, shared by the CLI, the TUI and the backends.
 *
 * The wrapper converts at a fixed `rate`: `rate` base units of the public ERC-20 make one
 * base unit of the confidential token (`rate = 10^(underlying decimals − wrapper
 * decimals)`, e.g. 1e12 for an 18-decimal ERC-20 behind a 6-decimal wrapper).
 * `wrap(to, amount)` mints `amount / rate` and only pulls `amount − amount % rate`; it never
 * reverts for a small amount, it just mints 0. That is how a user once "wrapped" 1e8 base
 * units of ZAMA into nothing. So the wallet:
 *
 * - takes the wrap amount in the ERC-20's units, as the user thinks of it;
 * - computes `wrapped = amount / rate` and `dust = amount % rate` here, refuses
 *   `wrapped == 0` with the smallest amount that works, and shows the dust;
 * - sends `wrap(self, wrapped × rate)` and approves exactly that, so the dust never leaves
 *   the wallet and the approval is never larger than what is taken.
 */

import { formatExactAmount, parseFriendlyAmount } from '../send/amount.js';
import { MAX_EUINT64 } from './limits.js';

/** What the maths needs to know about a wrapper and its ERC-20. */
export interface WrapSides {
  /** Underlying base units per confidential base unit (≥ 1). */
  rate: bigint;
  /** The confidential token's symbol and decimals. */
  symbol: string;
  decimals: number;
  underlying: { symbol: string; decimals: number };
}

/** A checked wrap: what is taken, what is minted, what stays behind. */
export interface WrapPlan {
  ok: true;
  /** What the user asked for, in underlying base units. */
  amount: bigint;
  /** Confidential base units minted (`amount / rate`). */
  wrapped: bigint;
  /** Underlying base units the wrapper takes (`wrapped × rate`); also the approval. */
  pull: bigint;
  /** Underlying base units that stay in the wallet (`amount % rate`). */
  dust: bigint;
  /** How a friendly amount was read ("half of your balance"), or ''. */
  meaning: string;
}

/** A checked unwrap: what is burnt and what arrives. */
export interface UnwrapPlan {
  ok: true;
  /** Confidential base units to burn. */
  amount: bigint;
  /** Underlying base units that arrive once finished (`amount × rate`). */
  receive: bigint;
  meaning: string;
}

/** Why an amount cannot be used, with what to do instead. */
export interface AmountProblem {
  ok: false;
  error: string;
  hint: string;
}

/** The smallest wrap that mints anything, in underlying base units (= `rate`). */
export function smallestWrap(sides: WrapSides): bigint {
  return sides.rate;
}

/** "1 cZAMA = 1 ZAMA · amounts below 0.000001 ZAMA cannot be wrapped". */
export function describeRate(sides: WrapSides): string {
  const one = 10n ** BigInt(sides.decimals);
  const perOne = one * sides.rate;
  const base = `1 ${sides.symbol} = ${formatExactAmount(perOne, sides.underlying.decimals)} ${sides.underlying.symbol}`;
  if (sides.rate === 1n) return base;
  return `${base} · amounts below ${formatExactAmount(sides.rate, sides.underlying.decimals)} ${sides.underlying.symbol} cannot be wrapped`;
}

/**
 * Check a wrap of `amount` underlying base units. `balance` is the public ERC-20 balance
 * (when known); `supplyRoom` how many confidential units the wrapper can still mint
 * (`maxTotalSupply − inferredTotalSupply`, when known).
 */
export function planWrapAmount(
  amount: bigint,
  sides: WrapSides,
  opts: { balance?: bigint; supplyRoom?: bigint; meaning?: string } = {},
): WrapPlan | AmountProblem {
  const u = sides.underlying;
  if (amount <= 0n) {
    return { ok: false, error: 'Enter an amount greater than 0.', hint: 'Nothing was signed.' };
  }
  if (opts.balance !== undefined && amount > opts.balance) {
    return {
      ok: false,
      error: `That's more than the ${formatExactAmount(opts.balance, u.decimals)} ${u.symbol} in this wallet.`,
      hint: `Only public ${u.symbol} can be wrapped. Enter a smaller amount.`,
    };
  }
  const wrapped = amount / sides.rate;
  const dust = amount % sides.rate;
  if (wrapped === 0n) {
    return {
      ok: false,
      error: `That wraps to 0 ${sides.symbol}: the smallest amount is ${formatExactAmount(sides.rate, u.decimals)} ${u.symbol}.`,
      hint: `The wrapper keeps ${sides.decimals} decimals and would mint nothing. Nothing was signed.`,
    };
  }
  if (wrapped > MAX_EUINT64) {
    return {
      ok: false,
      error: `That is above the 64-bit limit for confidential amounts.`,
      hint: `The most one wrap can mint is ${formatExactAmount(MAX_EUINT64, sides.decimals)} ${sides.symbol}.`,
    };
  }
  if (opts.supplyRoom !== undefined && wrapped > opts.supplyRoom) {
    return {
      ok: false,
      error: `The ${sides.symbol} wrapper can only mint ${formatExactAmount(opts.supplyRoom < 0n ? 0n : opts.supplyRoom, sides.decimals)} more ${sides.symbol}.`,
      hint: 'Its total supply is capped at the 64-bit limit. Enter a smaller amount.',
    };
  }
  return {
    ok: true,
    amount,
    wrapped,
    pull: wrapped * sides.rate,
    dust,
    meaning: opts.meaning ?? '',
  };
}

/** True for the friendly amounts that are a share of the balance (`max`, `all`, `half`). */
function usesBalance(input: string): boolean {
  return /^(max|all|half)$/i.test(input.trim());
}

/** Parse what the user typed (`25`, `1k`, `max`, `half`) and check it as a wrap. */
export function planWrap(
  input: string,
  sides: WrapSides,
  opts: { balance?: bigint; supplyRoom?: bigint } = {},
): WrapPlan | AmountProblem {
  const parsed = parseFriendlyAmount(input, {
    decimals: sides.underlying.decimals,
    // Only `max` / `half` need the balance here; the over-balance check (with the
    // token's symbol) is planWrapAmount's.
    balance: usesBalance(input) ? opts.balance : undefined,
    // The euint64 bound applies to `amount / rate`, checked below.
    limit: null,
  });
  if (!parsed.ok) return parsed;
  return planWrapAmount(parsed.value, sides, { ...opts, meaning: parsed.meaning });
}

/**
 * Parse and check an unwrap, typed in confidential units. `balance` is the decrypted
 * confidential balance: burning more than it burns 0 (ERC-7984 does not revert).
 */
export function planUnwrap(
  input: string,
  sides: WrapSides,
  opts: { balance?: bigint } = {},
): UnwrapPlan | AmountProblem {
  const parsed = parseFriendlyAmount(input, {
    decimals: sides.decimals,
    balance: usesBalance(input) ? opts.balance : undefined,
  });
  if (!parsed.ok) return parsed;
  if (opts.balance !== undefined && parsed.value > opts.balance) {
    return {
      ok: false,
      error: `That's more than your ${formatExactAmount(opts.balance, sides.decimals)} ${sides.symbol}.`,
      hint: 'ERC-7984 would burn 0 instead of failing, so this is blocked here.',
    };
  }
  return {
    ok: true,
    amount: parsed.value,
    receive: parsed.value * sides.rate,
    meaning: parsed.meaning,
  };
}

/** Lines that say exactly what a wrap does ("You get …", "… stays in your wallet"). */
export function describeWrapPlan(
  plan: WrapPlan,
  sides: WrapSides,
): { get: string; stays?: string } {
  const u = sides.underlying;
  const get = `You get ${formatExactAmount(plan.wrapped, sides.decimals)} ${sides.symbol}.`;
  if (plan.dust === 0n) return { get };
  return {
    get,
    stays: `${formatExactAmount(plan.dust, u.decimals)} ${u.symbol} stays in your wallet (below 1 ${sides.symbol} unit).`,
  };
}

/** What a wrap needs before `wrap()`: nothing, or `approve(wrapper, pull)` exactly. */
export type ApprovalStep = 'none' | 'approve';

/**
 * Whether the wrapper may already take `pull`. The approval is always for exactly
 * `pull` (never unlimited): `approve` sets the allowance, so a smaller earlier one is
 * replaced, not added to. Some tokens (USDT) refuse changing a non-zero allowance to
 * another non-zero value; `needsReset` says when to set it to 0 first if the token
 * refused the direct change during simulation.
 */
export function approvalPlan(allowance: bigint, pull: bigint): ApprovalStep {
  return allowance >= pull ? 'none' : 'approve';
}

/** True when a refused `approve(pull)` may be retried as `approve(0)` then `approve(pull)`. */
export function needsReset(allowance: bigint): boolean {
  return allowance > 0n;
}

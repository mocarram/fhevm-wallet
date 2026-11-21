/**
 * Friendly amount parsing for sends: `25`, `1,250.50`, `1k`, `2.5k`, `half`, `max`.
 *
 * Shared by the TUI send wizard, the `:send` command bar and `fhew send`, so the same
 * text always means the same base-unit value. All arithmetic is done in bigint base units;
 * floating point never touches an amount.
 */

import { formatTokenAmount } from '../../utils/formatting.js';
import { MAX_EUINT64 } from '../token/limits.js';

/** Result of parsing what the user typed. */
export type AmountParse =
  | {
      ok: true;
      /** Exact amount in the token's smallest unit. */
      value: bigint;
      /** How the input was interpreted, e.g. "half of your balance" (empty for plain numbers). */
      meaning: string;
    }
  | { ok: false; error: string; hint: string };

/** Options for `parseFriendlyAmount`. */
export interface ParseAmountOptions {
  decimals: number;
  /** Decrypted balance in base units. Needed for `half` / `max` and the over-balance check. */
  balance?: bigint;
  /**
   * Largest accepted value in base units (default: the euint64 limit). Wrapping takes a
   * public ERC-20 amount, whose own limit is higher; its euint64 bound applies after the
   * wrapper's rate (wrapMath.ts), so it passes `null` here.
   */
  limit?: bigint | null;
}

const HINT = 'Numbers like 25 or 1,250.50, or 1k, half, max.';

/** Digits with optional comma thousands separators and an optional fraction. */
const NUMBER_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * Convert a decimal string (already validated against NUMBER_RE, commas removed) into base
 * units, multiplied by `scale` (1 for plain numbers, 1000 for `k`). Returns an error message
 * when the number has more decimal places than the token supports.
 */
function toBaseUnits(int: string, frac: string, decimals: number, scale: bigint): bigint | string {
  const scaleDigits = scale.toString().length - 1; // 1000 → 3
  // Shift the decimal point right by scaleDigits before applying the token's decimals.
  const shiftedInt = int + frac.slice(0, scaleDigits).padEnd(scaleDigits, '0');
  const shiftedFrac = frac.slice(scaleDigits);
  if (shiftedFrac.length > decimals) {
    return `Too many decimal places: this token supports at most ${decimals}.`;
  }
  return BigInt(shiftedInt + shiftedFrac.padEnd(decimals, '0'));
}

/**
 * Parse a friendly amount into exact base units.
 *
 * Rejects zero, values above the 64-bit limit, more decimals than the token has, and
 * (when the balance is known) anything above the balance: ERC-7984 would silently move 0
 * instead of failing, so the wallet stops it here.
 */
export function parseFriendlyAmount(input: string, opts: ParseAmountOptions): AmountParse {
  const { decimals, balance } = opts;
  const text = input.trim().toLowerCase();
  if (text === '') return { ok: false, error: 'Enter an amount greater than 0.', hint: HINT };

  let value: bigint;
  let meaning = '';
  if (text === 'max' || text === 'all' || text === 'half') {
    if (balance === undefined) {
      return {
        ok: false,
        error: `"${text}" needs your balance, which is not decrypted yet.`,
        hint: 'Unlock to decrypt it, or type a number.',
      };
    }
    value = text === 'half' ? balance / 2n : balance;
    meaning = text === 'half' ? 'half of your balance' : 'your whole balance';
  } else {
    const kMatch = text.match(/^(.*?)k$/);
    const numberText = kMatch ? kMatch[1] : text;
    const m = numberText.match(NUMBER_RE);
    if (!m) return { ok: false, error: `"${input.trim()}" isn't an amount.`, hint: HINT };
    const parsed = toBaseUnits(m[1].replace(/,/g, ''), m[2] ?? '', decimals, kMatch ? 1000n : 1n);
    if (typeof parsed === 'string')
      return { ok: false, error: parsed, hint: 'Use fewer decimals.' };
    value = parsed;
    if (kMatch) meaning = 'thousand';
  }

  if (value <= 0n) {
    return { ok: false, error: 'Enter an amount greater than 0.', hint: HINT };
  }
  const limit = opts.limit === undefined ? MAX_EUINT64 : opts.limit;
  if (limit !== null && value > limit) {
    return {
      ok: false,
      error: 'That is above the 64-bit limit for confidential amounts.',
      hint: `The most this token can send at once is ${formatTokenAmount(limit, decimals, decimals)}.`,
    };
  }
  if (balance !== undefined && value > balance) {
    return {
      ok: false,
      error: `That's more than your ${formatExactAmount(balance, decimals)}.`,
      hint: 'ERC-7984 would send 0 instead of failing, so this is blocked here.',
    };
  }
  return { ok: true, value, meaning };
}

/**
 * Format base units for display with thousands separators and every significant decimal,
 * so the review screen shows exactly what will be encrypted (e.g. `1,250.5`).
 */
export function formatExactAmount(value: bigint, decimals: number): string {
  const plain = formatTokenAmount(value, decimals, decimals);
  const [int, frac] = plain.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * True when `input` uses commas without a decimal point ("1,500"): read as thousands
 * here, but in many locales a comma is the decimal mark, so the UI should point it out.
 */
export function hasAmbiguousComma(input: string): boolean {
  const t = input.trim();
  return t.includes(',') && !t.includes('.');
}

/**
 * Format a balance for compact display: exactly `precision` decimals (truncated), grouped thousands.
 * Used on Home and in lists where the exact value is not needed.
 */
export function formatBalance(value: bigint, decimals: number, precision = 2): string {
  const plain = formatTokenAmount(value, decimals, precision);
  const [int, frac = ''] = plain.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${frac.padEnd(precision, '0')}`.replace(/\.$/, '');
}

/**
 * A network fee in ETH, shared by the CLI and the TUI: 4 decimals, or 2 significant digits below 0.0001 ETH, so a
 * cheap fee on Sepolia never reads "0.0000" (0.000021).
 */
export function formatEthFee(wei: bigint): string {
  if (wei <= 0n || wei >= 10n ** 14n) return formatBalance(wei, 18, 4);
  const digits = wei.toString().length; // wei < 1e14: at most 14 digits
  const keep = 10n ** BigInt(Math.max(0, digits - 2));
  // Round up: a fee is shown as an upper bound.
  const rounded = ((wei + keep - 1n) / keep) * keep;
  const s = rounded.toString().padStart(18, '0');
  return `0.${s}`.replace(/0+$/, '');
}

/** An ETH balance for summaries: 4 decimals, like the TUI (not ethers' 18). */
export function formatEthBalance(wei: bigint): string {
  return formatBalance(wei, 18, 4);
}

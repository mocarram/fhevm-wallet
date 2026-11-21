/**
 * Small display helpers shared by the status bar and screens: spinner, ETH, gas, ages.
 */

import { formatBalance, formatExactAmount } from '../core/send/amount.js';
import type { AppState } from './state.js';

/** Braille spinner frames, advanced every 120 ms. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * A token amount as the TUI shows it: exact (never rounded: 0.004 stays 0.004, it used
 * to read "0.00"), thousands grouped, and at least two decimals so columns of whole
 * amounts line up ("25.00").
 */
export function formatAmount(value: bigint, decimals: number): string {
  const exact = formatExactAmount(value, decimals);
  const [int, frac = ''] = exact.split('.');
  return decimals === 0 ? int : `${int}.${frac.padEnd(Math.min(2, decimals), '0')}`;
}

/** Spinner frame for `now`. */
export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 120) % SPINNER.length];
}

// The gas arithmetic lives in core so `fhew doctor` shares it; re-exported for screens.
export { LOW_GAS_SENDS, sendsLeft, TYPICAL_SEND_FEE_WEI } from '../core/send/gas.js';
import { LOW_GAS_SENDS, sendsLeft } from '../core/send/gas.js';

/** True when ETH for gas is known and low. */
export function isLowGas(s: AppState): boolean {
  return s.eth !== null && sendsLeft(s.eth.wei) < LOW_GAS_SENDS;
}

/** ETH balance with 4 decimals, e.g. "0.4210". */
export function formatEth(wei: bigint): string {
  return formatBalance(wei, 18, 4);
}

/**
 * A network fee in ETH: 4 decimals, or 2 significant digits below 0.0001 ETH, so a
 * cheap fee on Sepolia never reads "0.0000" (0.000021).
 */
export function formatFee(wei: bigint): string {
  if (wei <= 0n || wei >= 10n ** 14n) return formatEth(wei);
  const digits = wei.toString().length; // wei < 1e14: at most 14 digits
  const keep = 10n ** BigInt(Math.max(0, digits - 2));
  // Round up: a fee is shown as an upper bound.
  const rounded = ((wei + keep - 1n) / keep) * keep;
  const s = rounded.toString().padStart(18, '0');
  return `0.${s}`.replace(/0+$/, '');
}

/** "just now", "2m ago", "3h ago", "4d ago". */
export function age(at: number | undefined, now: number): string {
  if (at === undefined) return 'some time ago';
  const secs = Math.max(0, Math.floor((now - at) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Shorten a transaction hash for one-line notices: 0x8c41…e1d2. */
export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

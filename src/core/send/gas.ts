/**
 * Rough gas arithmetic for nudges (status bar, Home, Doctor). Real sends always use the
 * estimate from the simulation.
 */

/** Typical fee of one confidential transfer (~300k gas at 1 gwei). */
export const TYPICAL_SEND_FEE_WEI = 300_000n * 1_000_000_000n;
/** Below this many sends' worth of ETH the wallet warns about gas. */
export const LOW_GAS_SENDS = 5n;

/** About how many sends the ETH balance pays for. */
export function sendsLeft(wei: bigint): bigint {
  return wei / TYPICAL_SEND_FEE_WEI;
}

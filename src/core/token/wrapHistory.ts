/**
 * Wraps and unwrap requests in the local transaction history, shared by `fhew wrap|unwrap`
 * and the TUI.
 *
 * On-chain a wrap is a confidential mint to the wallet and an unwrap request a burn
 * from it, so a history sync finds both. Like a send, they are also recorded here as
 * soon as they confirm, and as *unconfirmed* (block 0, with the hash) when the receipt
 * did not arrive in time: the History screen and `fhew history` then show them instead
 * of nothing, and the next sync replaces the entry with the mined one (same hash).
 */

import type { NetworkName } from '../network/NetworkConfig.js';
import type { PreparedWrap, WrapHooks, WrapResult, WrapStep } from '../backend/wrapTypes.js';
import {
  listTransactions,
  recordLocalTransaction,
  type Transaction,
} from '../../storage/TransactionStore.js';
import { formatTokenAmount } from '../../utils/formatting.js';
import { translateTxError } from './txErrors.js';
import type { WrapperInfo } from './wrapper.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** What a wrap or unwrap request moved, for its history entry. */
export interface WrapHistoryContext {
  network: NetworkName;
  wallet: string;
  info: WrapperInfo;
  /** Confidential base units minted (wrap) or burnt (unwrap). */
  amount: bigint;
}

/**
 * Record a wrap (mint) or unwrap request (burn) in the local history. `blockNumber` 0
 * marks it unconfirmed. Best effort: history is a convenience and never fails a send.
 */
export function recordWrapHistory(
  kind: 'wrap' | 'unwrap',
  ctx: WrapHistoryContext,
  txHash: string,
  blockNumber: number,
): void {
  try {
    recordLocalTransaction({
      type: kind === 'wrap' ? 'mint' : 'burn',
      tokenAddress: ctx.info.address,
      tokenSymbol: ctx.info.symbol,
      from: kind === 'wrap' ? ZERO_ADDRESS : ctx.wallet,
      to: kind === 'wrap' ? ctx.wallet : ZERO_ADDRESS,
      amount: formatTokenAmount(ctx.amount, ctx.info.decimals, ctx.info.decimals),
      txHash,
      network: ctx.network,
      blockNumber,
    });
  } catch {
    // ignored: history is a convenience
  }
}

/**
 * Run `prepared.send` and record the wrap in history: confirmed with its block, or
 * unconfirmed when the wrap itself (not the approval before it) ended SENT_UNCONFIRMED.
 * Errors are rethrown unchanged.
 */
export async function sendWrapRecorded(
  prepared: PreparedWrap,
  ctx: WrapHistoryContext,
  hooks: WrapHooks = {},
): Promise<WrapResult> {
  let step: WrapStep | null = null;
  try {
    const r = await prepared.send({
      ...hooks,
      onStep: (s) => {
        step = s;
        hooks.onStep?.(s);
      },
    });
    recordWrapHistory('wrap', ctx, r.txHash, r.blockNumber);
    return r;
  } catch (err) {
    const e = translateTxError(err);
    if (step === 'wrap' && e.code === 'SENT_UNCONFIRMED' && e.txHash) {
      recordWrapHistory('wrap', ctx, e.txHash, 0);
    }
    throw err;
  }
}

/** An unconfirmed wrap older than this is not warned about any more (it was dropped). */
export const UNCONFIRMED_WRAP_WARN_MS = 24 * 3600_000;

/**
 * The most recent wrap of `token` into `wallet` that is recorded unconfirmed (block 0)
 * in `txs`, within `UNCONFIRMED_WRAP_WARN_MS` of `now`; null when there is none.
 */
export function unconfirmedWrapIn(
  txs: readonly Transaction[],
  wallet: string,
  token: string,
  now = Date.now(),
): Transaction | null {
  return (
    txs.find(
      (t) =>
        t.type === 'mint' &&
        t.blockNumber === 0 &&
        t.tokenAddress.toLowerCase() === token.toLowerCase() &&
        t.to.toLowerCase() === wallet.toLowerCase() &&
        now - Date.parse(t.timestamp) < UNCONFIRMED_WRAP_WARN_MS,
    ) ?? null
  );
}

/** `unconfirmedWrapIn` over the local history (best effort: null if it cannot be read). */
export function findUnconfirmedWrap(
  network: NetworkName,
  wallet: string,
  token: string,
): Transaction | null {
  try {
    return unconfirmedWrapIn(
      listTransactions({ walletAddress: wallet, network, limit: 10_000 }),
      wallet,
      token,
    );
  } catch {
    return null;
  }
}

/**
 * The warning before wrapping again while an earlier wrap may still be mined: a second
 * one would wrap (and pull) the amount twice. A warning, not a refusal: the earlier one
 * may have been dropped.
 */
export function unconfirmedWrapWarning(t: Pick<Transaction, 'txHash'>): string {
  return `An earlier wrap of this token (${t.txHash}) is not confirmed yet and may still be mined: wrapping again could wrap twice. Check it on the explorer first.`;
}

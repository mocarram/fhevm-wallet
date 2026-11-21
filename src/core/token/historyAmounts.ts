/**
 * Decrypted amounts for history: which confidential transfers still need decrypting,
 * decrypting them with the session, and reading what is already known. Shared by
 * `fhew history --decrypt` and the TUI History screen.
 */

import type { AmountRequest, Backend } from '../backend/types.js';
import type { DecryptSession } from '../fhe/DecryptSession.js';
import { normaliseHandle } from '../fhe/DecryptSession.js';
import { getAmountEntry, setCachedAmounts } from '../../storage/AmountCache.js';
import type { Transaction } from '../../storage/TransactionStore.js';
import type { TokenEntry } from './TokenRegistry.js';

/** Most handles asked for in one `decryptHistory` run (the session batches them). */
export const MAX_HISTORY_DECRYPT = 200;

/** A confidential amount that is known locally. */
export interface KnownAmount {
  value: bigint;
  /** Published on-chain by this wallet. */
  disclosed: boolean;
}

/** The decrypted amount of a confidential transfer, if this wallet has it cached. */
export function knownAmount(tx: Transaction): KnownAmount | null {
  if (!tx.amountHandle) return null;
  const e = getAmountEntry(tx.network, normaliseHandle(tx.amountHandle));
  return e ? { value: BigInt(e.value), disclosed: Boolean(e.disclosed) } : null;
}

/** Confidential transfers on tracked tokens whose amount is not known yet. */
export function amountsToDecrypt(txs: Transaction[], tokens: TokenEntry[]): AmountRequest[] {
  const tracked = new Set(tokens.map((t) => t.address.toLowerCase()));
  const seen = new Set<string>();
  const out: AmountRequest[] = [];
  for (const tx of txs) {
    if (tx.type === 'eth' || tx.amount !== null || !tx.amountHandle) continue;
    if (!tracked.has(tx.tokenAddress.toLowerCase())) continue;
    const handle = normaliseHandle(tx.amountHandle);
    if (seen.has(handle) || knownAmount(tx)) continue;
    seen.add(handle);
    out.push({ token: tx.tokenAddress, handle });
    if (out.length >= MAX_HISTORY_DECRYPT) break;
  }
  return out;
}

/** What `decryptHistoryAmounts` did. */
export interface HistoryDecryptResult {
  decrypted: number;
  /** Not allowed for this wallet: these stay "encrypted", without an error. */
  hidden: number;
  failed: number;
  /** The first failure, for a one-line explanation. */
  error?: unknown;
}

/**
 * Decrypt the amounts of `txs` that are not known yet, with the session's signature
 * (one for every tracked token), and cache them owner-only by handle.
 */
export async function decryptHistoryAmounts(
  backend: Backend,
  session: DecryptSession,
  txs: Transaction[],
  tokens: TokenEntry[],
): Promise<HistoryDecryptResult> {
  const requests = amountsToDecrypt(txs, tokens);
  const result: HistoryDecryptResult = { decrypted: 0, hidden: 0, failed: 0 };
  if (!requests.length) return result;
  let out: Record<string, bigint | null>;
  try {
    out = await backend.decryptAmounts(
      session,
      requests,
      tokens.map((t) => t.address),
    );
  } catch (err) {
    return { ...result, failed: requests.length, error: err };
  }
  const found: Array<{ handle: string; value: bigint }> = [];
  for (const r of requests) {
    const v = out[normaliseHandle(r.handle)];
    if (v === null) result.hidden += 1;
    else if (v === undefined) result.failed += 1;
    else found.push({ handle: r.handle, value: v });
  }
  setCachedAmounts(session.network, found);
  result.decrypted = found.length;
  return result;
}

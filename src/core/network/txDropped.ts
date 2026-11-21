/**
 * Prove that a signed transaction the RPC cannot find can never be mined, before the
 * wallet forgets it (`fhew unwrap --forget`) or sends a replacement (disclosure step 2).
 *
 * "No receipt and no transaction" alone is not proof: behind a load balancer (publicnode)
 * or after a fail-over it may sit in another node's mempool. The proof is that another
 * transaction took its nonce, read so that two inconsistent nodes cannot fake it:
 *
 * 1. The account's nonce at a *settled* block: the `finalized` block's number, then the
 *    count at that number (a node without the block errors instead of counting at another),
 *    or `latest − SETTLED_FALLBACK_BLOCKS` where an endpoint does not know `finalized`.
 *    `latest` alone can be reorged away. Any error or unreadable reply fails closed.
 * 2. Our receipt, read in one batch with `eth_blockNumber`, from a node whose head is at or
 *    past that settled block. A node behind it might simply not have our block yet: then
 *    the answer is `behind` ("try again in a minute"), never "dropped".
 */

import type { JsonRpcPayload, JsonRpcResult } from 'ethers';
import type { NetworkName } from './NetworkConfig.js';
import { getProvider } from './ProviderFactory.js';
import { translateTxError } from '../token/txErrors.js';

/** Blocks behind the head counted as settled where `finalized` is not supported. */
export const SETTLED_FALLBACK_BLOCKS = 64;

/**
 * - `dropped`: the nonce is taken at a settled block and our hash has no receipt on a node
 *   that has that block: it can never be mined.
 * - `nonce-open`: the nonce is not taken at a settled block yet; it may still be mined.
 * - `mined`: it has a receipt (just mined, or the first look was stale).
 * - `behind`: the node that answered is behind the settled block; ask again later.
 */
export type DropCheck = 'dropped' | 'nonce-open' | 'mined' | 'behind';

/** Raw results of one batch, by id; an error result throws (translated). */
async function batch(
  network: NetworkName,
  calls: Array<{ method: string; params: unknown[] }>,
): Promise<unknown[]> {
  const provider = getProvider(network);
  const payload: JsonRpcPayload[] = calls.map((c, i) => ({
    id: i + 1,
    jsonrpc: '2.0',
    method: c.method,
    params: c.params,
  }));
  let results: JsonRpcResult[];
  try {
    // One POST to one endpoint: the answers come from the same node (FailoverJsonRpcProvider
    // moves whole batches, never single calls of one).
    results = await provider._send(payload);
  } catch (err) {
    throw translateTxError(err, { action: 'transaction check' });
  }
  return payload.map((p) => {
    const r = results.find((x) => x.id === p.id) as
      (JsonRpcResult & { error?: { code?: number; message?: string } }) | undefined;
    if (!r || r.error) {
      throw Object.assign(new Error(r?.error?.message ?? 'missing response'), {
        rpcError: r?.error,
      });
    }
    return r.result;
  });
}

const hexNum = (v: unknown): number => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) throw new Error('bad number');
  return Number(BigInt(v));
};

/** The account's nonce at a settled block, and that block. */
export async function settledNonce(
  address: string,
  network: NetworkName,
): Promise<{ nonce: number; block: number }> {
  let finalized: number | null = null;
  try {
    const [block] = await batch(network, [
      { method: 'eth_getBlockByNumber', params: ['finalized', false] },
    ]);
    finalized = hexNum((block as { number?: unknown } | null)?.number);
  } catch {
    // No `finalized` here (or a garbled answer): count a fixed depth below the head.
  }
  if (finalized !== null) {
    // Counted at that block *number*, not the tag: a gateway may split a batch across
    // nodes, and a node without this block errors instead of counting at another one.
    try {
      const [count] = await batch(network, [
        { method: 'eth_getTransactionCount', params: [address, '0x' + finalized.toString(16)] },
      ]);
      return { nonce: hexNum(count), block: finalized };
    } catch (err) {
      throw translateTxError(err, { action: 'transaction check' });
    }
  }
  try {
    const [head] = await batch(network, [{ method: 'eth_blockNumber', params: [] }]);
    const settled = Math.max(0, hexNum(head) - SETTLED_FALLBACK_BLOCKS);
    const [count] = await batch(network, [
      { method: 'eth_getTransactionCount', params: [address, '0x' + settled.toString(16)] },
    ]);
    return { nonce: hexNum(count), block: settled };
  } catch (err) {
    throw translateTxError(err, { action: 'transaction check' });
  }
}

/** Whether the transaction `txHash` of `address`, signed with `nonce`, can never be mined. */
export async function checkTxDropped(
  address: string,
  nonce: number,
  txHash: string,
  network: NetworkName,
): Promise<DropCheck> {
  const settled = await settledNonce(address, network);
  if (settled.nonce <= nonce) return 'nonce-open';
  let head: unknown;
  let receipt: unknown;
  try {
    [head, receipt] = await batch(network, [
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_getTransactionReceipt', params: [txHash] },
    ]);
  } catch (err) {
    throw translateTxError(err, { action: 'transaction check' });
  }
  if (receipt) return 'mined';
  return hexNum(head) >= settled.block ? 'dropped' : 'behind';
}

/** The sentence for a DropCheck that is not `dropped` (what to do next). */
export function dropCheckMessage(check: Exclude<DropCheck, 'dropped'>, nonce: number): string {
  switch (check) {
    case 'nonce-open':
      return `The network does not know it yet, but it can still be mined: its nonce (${nonce}) is not used yet at a settled block. Wait; any later transaction from this wallet settles it, about 15 minutes after that one is mined.`;
    case 'mined':
      return 'It was mined after all (the first answer was out of date). Check it before doing anything else.';
    case 'behind':
      return "The node that answered is behind the chain, so it can't prove it was dropped. Try again in a minute.";
  }
}

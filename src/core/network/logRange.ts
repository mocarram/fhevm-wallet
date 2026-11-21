/**
 * Walk a block range in eth_getLogs-sized chunks that adapt to what the endpoint accepts.
 * Shared by the transaction-history sync and the Find tokens scan.
 *
 * - A chunk refused as too large shrinks to the limit the endpoint names ("maximum
 *   allowed is 50 blocks") or, when it names none, to half.
 * - A rate limit waits and retries the same chunk a few times, then stops.
 * - Any other error stops the walk; what was completed is reported (`scannedTo`) so the
 *   caller can save it and resume later.
 * - A request budget stops a walk that would otherwise send thousands of requests
 *   without the user knowing (public endpoints cap ranges at 50 blocks).
 */

import { isRangeTooLarge, isRateLimited, parseRangeLimit } from './rpcLimits.js';

/** Blocks per request to start with. */
export const DEFAULT_CHUNK = 10_000;

/** Waits before retrying a rate-limited chunk; one entry per retry. */
export const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

/**
 * Chunk size learned during one run. Shared between the walks of a run (each token, each
 * direction) so the second walk does not rediscover a 50-block cap.
 */
export interface ChunkState {
  size: number;
}

/** A fresh chunk state. */
export function newChunkState(size = DEFAULT_CHUNK): ChunkState {
  return { size: Math.max(1, Math.floor(size)) };
}

/** Requests left for this run; shared between walks. */
export interface RequestBudget {
  left: number;
}

/** Options for `walkBlockRange`. */
export interface WalkOptions {
  from: number;
  to: number;
  chunk: ChunkState;
  /**
   * Fetch and handle one chunk (inclusive). It may send several requests (`cost`). It is
   * called again for the same start block after a too-large or rate-limit refusal.
   */
  fetchChunk: (from: number, to: number) => Promise<void>;
  /** Requests one `fetchChunk` call sends (default 1). */
  cost?: number;
  budget?: RequestBudget;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Why a walk ended before `to`. */
export type WalkStop = 'cancelled' | 'budget' | 'error';

/** Outcome of a walk. `scannedTo` is the last block of the last completed chunk. */
export interface WalkResult {
  scannedTo: number;
  stopped?: WalkStop;
  error?: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Walk `from`..`to` (inclusive) in adaptive chunks. See the module comment. */
export async function walkBlockRange(opts: WalkOptions): Promise<WalkResult> {
  const cost = opts.cost ?? 1;
  const sleep = opts.sleep ?? defaultSleep;
  let next = Math.max(0, opts.from);
  let scannedTo = next - 1;
  let rateRetries = 0;
  while (next <= opts.to) {
    if (opts.signal?.aborted) return { scannedTo, stopped: 'cancelled' };
    if (opts.budget && opts.budget.left < cost) return { scannedTo, stopped: 'budget' };
    const size = opts.chunk.size;
    const end = Math.min(next + size - 1, opts.to);
    if (opts.budget) opts.budget.left -= cost;
    try {
      await opts.fetchChunk(next, end);
    } catch (err) {
      if (opts.signal?.aborted) return { scannedTo, stopped: 'cancelled' };
      if (isRangeTooLarge(err)) {
        const span = end - next + 1;
        const named = parseRangeLimit(err);
        // Trust a named limit only when it is smaller than what was refused; otherwise
        // (an off-by-one in how the endpoint counts) fall back to halving.
        const smaller = named !== null && named < span ? named : Math.floor(span / 2);
        if (smaller >= 1) {
          opts.chunk.size = smaller;
          continue;
        }
      } else if (isRateLimited(err) && rateRetries < RATE_LIMIT_BACKOFF_MS.length) {
        await sleep(RATE_LIMIT_BACKOFF_MS[rateRetries++]);
        continue;
      }
      return { scannedTo, stopped: 'error', error: err };
    }
    rateRetries = 0;
    scannedTo = end;
    next = end + 1;
  }
  return { scannedTo };
}

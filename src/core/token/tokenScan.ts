/**
 * Find token contracts that sent ERC-7984 transfers to a wallet, from the chain's logs:
 * `ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)`
 * with topic2 = the wallet, across all contracts (no address filter).
 *
 * eth_getLogs runs in adaptive chunks (`walkBlockRange`): a chunk refused as too large
 * shrinks to the limit the endpoint names, a rate limit is retried a few times, other
 * errors end the scan, keeping what was found so far. Cancellable between chunks, and
 * bounded by a request budget so a 50-block cap never turns into thousands of silent
 * requests.
 *
 * Topic-only queries are what public endpoints restrict most (publicnode refuses them,
 * nodies caps them at 50 blocks), so with the built-in endpoints the caller scans only a
 * recent window (`PUBLIC_SCAN_WINDOW`, RealBackend).
 *
 * Etherscan is not used: its logs API could not be confirmed to accept a topic-only
 * query without a contract address (its docs were unreachable when this was written), so
 * only the RPC path is implemented. See docs/token-lists.md.
 */

import { getAddress, id, zeroPadValue } from 'ethers';
import type { NetworkName } from '../network/NetworkConfig.js';
import {
  DEFAULT_CHUNK,
  newChunkState,
  walkBlockRange,
  type ChunkState,
} from '../network/logRange.js';

export { isRangeTooLarge } from '../network/rpcLimits.js';
export { DEFAULT_CHUNK };

/** topic0 of ConfidentialTransfer(address,address,bytes32). */
export const CONFIDENTIAL_TRANSFER_TOPIC0 = id('ConfidentialTransfer(address,address,bytes32)');

/**
 * Where a scan starts when nothing was scanned before. No ERC-7984 token predates 2025
 * (OpenZeppelin's first ERC-7984 release is v0.2.0, 2025-08-14), so these blocks from
 * early 2025 are a safe lower bound with margin. `--from-block` overrides them.
 */
export const SCAN_START_BLOCK: Record<NetworkName, number> = {
  mainnet: 21_500_000,
  sepolia: 7_400_000,
};

/**
 * Requests one scan may send. At a 10,000-block chunk this covers 10 million blocks; at
 * a 50-block cap, 50,000 blocks. Past it the scan stops and says so; progress is saved.
 */
export const SCAN_REQUEST_BUDGET = 1_000;

/**
 * Blocks scanned when the built-in public endpoints are in use and nothing was scanned
 * before: about 17 hours on Sepolia, 100 requests at nodies' 50-block cap.
 */
export const PUBLIC_SCAN_WINDOW = 5_000;

/** What the scan needs from a provider (ethers' JsonRpcProvider fits). */
export interface LogSource {
  getBlockNumber(): Promise<number>;
  getLogs(filter: {
    fromBlock: number;
    toBlock: number;
    topics: Array<string | null>;
  }): Promise<Array<{ address: string }>>;
}

/** Progress after each chunk. */
export interface ScanProgress {
  fromBlock: number;
  toBlock: number;
  /** Last block done so far. */
  current: number;
  found: number;
}

/** Outcome of a scan. `scannedTo` is the last block of the last completed chunk. */
export interface ScanResult {
  contracts: string[];
  fromBlock: number;
  toBlock: number;
  scannedTo: number;
  cancelled: boolean;
  /** Set when the scan stopped early because of an error (what was found is kept). */
  error?: unknown;
  /** True when the request budget ran out before `toBlock` (progress is kept). */
  budgetExhausted?: boolean;
  /** Set when the start was moved up to a recent window (public endpoints). */
  limitedFrom?: number;
}

/** Options for `scanIncoming`. */
export interface ScanOptions {
  fromBlock: number;
  toBlock?: number;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  /** Starting chunk size, or a state shared with other scans of the same run. */
  chunk?: number | ChunkState;
  /** Requests this scan may send (default `SCAN_REQUEST_BUDGET`). */
  maxRequests?: number;
  /** Injectable wait for rate-limit back-off (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Scan at most this many blocks back from `toBlock` (sets `limitedFrom` if it cuts). */
  recentWindow?: number;
  /**
   * The caller picked the start itself (saved progress or the default), so a backend
   * may cut it to a recent window when its endpoints cannot do more. False for a
   * user-given `--from-block`.
   */
  recentOnly?: boolean;
}

/** Scan for token contracts that sent to `wallet`. See the module comment. */
export async function scanIncoming(
  source: LogSource,
  wallet: string,
  opts: ScanOptions,
): Promise<ScanResult> {
  const toBlock = opts.toBlock ?? (await source.getBlockNumber());
  let fromBlock = Math.max(0, opts.fromBlock);
  let limitedFrom: number | undefined;
  if (opts.recentWindow !== undefined && fromBlock < toBlock - opts.recentWindow + 1) {
    fromBlock = limitedFrom = Math.max(0, toBlock - opts.recentWindow + 1);
  }
  const topic2 = zeroPadValue(getAddress(wallet), 32).toLowerCase();
  const found = new Set<string>();
  const chunk =
    typeof opts.chunk === 'object' ? opts.chunk : newChunkState(opts.chunk ?? DEFAULT_CHUNK);
  const walk = await walkBlockRange({
    from: fromBlock,
    to: toBlock,
    chunk,
    budget: { left: opts.maxRequests ?? SCAN_REQUEST_BUDGET },
    signal: opts.signal,
    sleep: opts.sleep,
    fetchChunk: async (from, to) => {
      const logs = await source.getLogs({
        fromBlock: from,
        toBlock: to,
        topics: [CONFIDENTIAL_TRANSFER_TOPIC0, null, topic2],
      });
      for (const log of logs) {
        try {
          found.add(getAddress(log.address));
        } catch {
          /* a malformed log entry is skipped */
        }
      }
      opts.onProgress?.({ fromBlock, toBlock, current: to, found: found.size });
    },
  });
  return {
    contracts: [...found],
    fromBlock,
    toBlock,
    scannedTo: walk.scannedTo,
    cancelled: walk.stopped === 'cancelled',
    ...(walk.stopped === 'error' ? { error: walk.error } : {}),
    ...(walk.stopped === 'budget' ? { budgetExhausted: true } : {}),
    ...(limitedFrom !== undefined ? { limitedFrom } : {}),
  };
}

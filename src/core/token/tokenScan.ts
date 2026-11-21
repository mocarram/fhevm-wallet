/**
 * Find token contracts that sent ERC-7984 transfers to a wallet, from the chain's logs:
 * `ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)`
 * with topic2 = the wallet, across all contracts (no address filter).
 *
 * eth_getLogs runs in chunks of blocks so public RPCs accept it. When an endpoint says a
 * chunk is too large ("block range", "more than 10000 results"), the chunk is halved and
 * retried, down to `MIN_CHUNK`. Rate limits and other errors are not "too large": they
 * end the scan, keeping what was found so far. Cancellable between chunks.
 *
 * Etherscan is not used: its logs API could not be confirmed to accept a topic-only
 * query without a contract address (its docs were unreachable when this was written), so
 * only the RPC path is implemented. See docs/token-lists.md.
 */

import { getAddress, id, zeroPadValue } from 'ethers';
import type { NetworkName } from '../network/NetworkConfig.js';
import { RATE_LIMIT_RE } from './txErrors.js';

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

/** Blocks per eth_getLogs request to start with, and the smallest after halving. */
export const DEFAULT_CHUNK = 10_000;
export const MIN_CHUNK = 125;

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
}

/** Options for `scanIncoming`. */
export interface ScanOptions {
  fromBlock: number;
  toBlock?: number;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  chunk?: number;
}

/** True when the endpoint refused a chunk for being too large, not for rate limits. */
export function isRangeTooLarge(err: unknown): boolean {
  const e = err as { message?: unknown; error?: { message?: unknown }; info?: unknown };
  const text = [e?.message, e?.error?.message, JSON.stringify(e?.info ?? '')]
    .filter((x) => typeof x === 'string')
    .join(' ');
  if (RATE_LIMIT_RE.test(text)) return false;
  return /block range|range (?:is )?too|too (?:large|wide|many blocks)|more than \d+ (?:results|logs)|query returned more than|response size|limit the query|exceeds? (?:the )?(?:max(?:imum)? )?(?:block )?range|log response size/i.test(
    text,
  );
}

/** Scan for token contracts that sent to `wallet`. See the module comment. */
export async function scanIncoming(
  source: LogSource,
  wallet: string,
  opts: ScanOptions,
): Promise<ScanResult> {
  const toBlock = opts.toBlock ?? (await source.getBlockNumber());
  const fromBlock = Math.max(0, opts.fromBlock);
  const topic2 = zeroPadValue(getAddress(wallet), 32).toLowerCase();
  const found = new Set<string>();
  let chunk = opts.chunk ?? DEFAULT_CHUNK;
  let next = fromBlock;
  let scannedTo = fromBlock - 1;
  const result = (extra: Partial<ScanResult> = {}): ScanResult => ({
    contracts: [...found],
    fromBlock,
    toBlock,
    scannedTo,
    cancelled: false,
    ...extra,
  });
  while (next <= toBlock) {
    if (opts.signal?.aborted) return result({ cancelled: true });
    const end = Math.min(next + chunk - 1, toBlock);
    let logs;
    try {
      logs = await source.getLogs({
        fromBlock: next,
        toBlock: end,
        topics: [CONFIDENTIAL_TRANSFER_TOPIC0, null, topic2],
      });
    } catch (err) {
      if (opts.signal?.aborted) return result({ cancelled: true });
      if (isRangeTooLarge(err) && chunk > MIN_CHUNK) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
        continue;
      }
      return result({ error: err });
    }
    for (const log of logs) {
      try {
        found.add(getAddress(log.address));
      } catch {
        /* a malformed log entry is skipped */
      }
    }
    scannedTo = end;
    next = end + 1;
    opts.onProgress?.({ fromBlock, toBlock, current: end, found: found.size });
  }
  return result();
}

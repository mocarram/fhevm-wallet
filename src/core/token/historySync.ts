/**
 * Pull a wallet's token and ETH transfers from the chain into the local transaction store.
 * Shared by `fhew history` and the real TUI backend.
 *
 * Progress is a cursor per wallet, network and source (each token, and `eth` for plain
 * ETH transfers): a token added later still gets its earlier history, and a sync that
 * stops half-way (an error, Ctrl+C, the request budget) resumes where it stopped.
 *
 * Two ways to read the chain:
 *
 * - **RPC** (`eth_getLogs`, no key): adaptive chunks (`walkBlockRange`), cursor saved
 *   after every chunk. Public endpoints keep only about a week of logs (publicnode:
 *   "pruned history unavailable") or cap a request at 50 blocks (nodies), so a first
 *   sync on the built-in endpoints covers only the last `PUBLIC_HISTORY_WINDOW` blocks
 *   and says so. A custom RPC URL starts at `SCAN_START_BLOCK`. A request budget stops a
 *   sync that would otherwise send thousands of requests; the next sync continues.
 * - **Etherscan** (fast, needs a key): full history, paged (1,000 rows per reply). Its
 *   index lags the chain head, so the cursor stops `ETHERSCAN_LAG_BLOCKS` behind the head
 *   and the next sync reads those blocks again (entries are upserted by hash + log index,
 *   so nothing is stored twice). A `status: "0"` reply is an error unless it is
 *   "No records found": treating a rate limit as "nothing new" would skip history.
 */

import { formatEther, getAddress, zeroPadValue } from 'ethers';
import { getProvider } from '../network/ProviderFactory.js';
import { getNetworkConfig, usesPublicRpc, type NetworkName } from '../network/NetworkConfig.js';
import {
  newChunkState,
  RATE_LIMIT_BACKOFF_MS,
  walkBlockRange,
  type ChunkState,
  type RequestBudget,
} from '../network/logRange.js';
import { RATE_LIMIT_RE } from '../network/rpcLimits.js';
import { CONFIDENTIAL_TRANSFER_TOPIC0, SCAN_START_BLOCK } from './tokenScan.js';
import type { TokenEntry } from './TokenRegistry.js';
import { WalletTxError } from './txErrors.js';
import { stripUnsafeChars } from '../../utils/text.js';
import {
  getSyncCursor,
  saveSyncCursor,
  upsertTransactions,
  type SyncCursor,
  type Transaction,
} from '../../storage/TransactionStore.js';

/** Where transfers are read from: the Etherscan API (fast, needs a key) or raw RPC logs. */
export type SyncMethod = 'etherscan' | 'rpc';

/**
 * Blocks a first RPC sync covers on the built-in public endpoints: about 5.5 days on
 * Sepolia. publicnode answered 30,000-block log queries but no longer had logs about
 * 50,000 blocks back when measured (Nov 2026).
 */
export const PUBLIC_HISTORY_WINDOW = 40_000;

/** Requests one RPC sync may send before it stops and leaves the rest for next time. */
export const HISTORY_REQUEST_BUDGET = 1_000;

/** Blocks an RPC sync reads again below its cursor, for small reorgs. */
export const RPC_RESCAN_BLOCKS = 12;

/** How far behind the head an Etherscan cursor stays (its index lags the chain). */
export const ETHERSCAN_LAG_BLOCKS = 64;

/** Rows per Etherscan reply (its maximum). */
export const ETHERSCAN_PAGE_SIZE = 1_000;

/** Pages read per source in one sync, so a broken paging answer cannot loop forever. */
const ETHERSCAN_MAX_PAGES = 100;

const ETHERSCAN_V2_API = 'https://api.etherscan.io/v2/api';

/** Etherscan requests give up after this long instead of hanging the history screen. */
const ETHERSCAN_TIMEOUT_MS = 15_000;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Cursor source for plain ETH transfers. */
const ETH_SOURCE = 'eth';

/** Progress after each chunk or page. */
export interface SyncProgress {
  /** Token symbol, or "ETH". */
  source: string;
  block: number;
  head: number;
}

/** Options for `syncTransactions`. */
export interface SyncOptions {
  signal?: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  /** Requests an RPC sync may send (default `HISTORY_REQUEST_BUDGET`). */
  maxRequests?: number;
  /** Injectable wait for rate-limit back-off (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** What a sync did. */
export interface SyncReport {
  /** Transfers stored for the first time. */
  added: number;
  /** False when some source did not reach the head (budget, cancel, page limit). */
  complete: boolean;
  head: number;
  /** Plain-English note on what was not covered and what to do, when something was not. */
  notice?: string;
}

/**
 * Fetch transfers since each source's cursor and store them. Throws on RPC / API
 * failures (progress up to the failure is saved); the caller decides how to recover.
 */
export async function syncTransactions(
  walletAddress: string,
  network: NetworkName,
  tokens: TokenEntry[],
  method: SyncMethod = 'etherscan',
  opts: SyncOptions = {},
): Promise<SyncReport> {
  const head = await getProvider(network).getBlockNumber();
  return method === 'etherscan'
    ? syncViaEtherscan(walletAddress, network, tokens, head, opts)
    : syncViaRpc(walletAddress, network, tokens, head, opts);
}

/** The topic for an address in an indexed event argument. */
function addressTopic(address: string): string {
  return zeroPadValue(getAddress(address), 32).toLowerCase();
}

/** The address in a 32-byte topic. */
function topicAddress(topic: string): string {
  return '0x' + topic.slice(-40);
}

/** mint (from zero), burn (to zero) or transfer. */
function transferType(from: string, to: string): Transaction['type'] {
  if (from.toLowerCase() === ZERO_ADDRESS) return 'mint';
  if (to.toLowerCase() === ZERO_ADDRESS) return 'burn';
  return 'transfer';
}

/** Etherscan writes zero as "0x"; parse that and normal hex. */
function hexNumber(value: string | undefined): number {
  if (!value || value === '0x') return 0;
  return Number(BigInt(value));
}

/** One ConfidentialTransfer log as a stored transaction. */
function transferEntry(
  log: { transactionHash: string; address: string; topics: readonly string[]; index: number },
  blockNumber: number,
  timestampSec: number,
  symbol: string,
  network: NetworkName,
): Transaction {
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  return {
    txHash: log.transactionHash,
    type: transferType(from, to),
    tokenAddress: log.address,
    tokenSymbol: symbol,
    from,
    to,
    amount: null, // encrypted; decrypted amounts live in AmountCache
    ...(log.topics[3] ? { amountHandle: log.topics[3] } : {}),
    network,
    blockNumber,
    logIndex: log.index,
    timestamp: new Date(timestampSec * 1000).toISOString(),
  };
}

/** Keep the first of each hash + log index (a self-transfer matches both queries). */
function dedupe(entries: Transaction[]): Transaction[] {
  const seen = new Set<string>();
  return entries.filter((t) => {
    const k = `${t.txHash.toLowerCase()}:${t.logIndex ?? t.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Where an RPC sync of one source starts, and the first block its range then covers. */
function rpcStart(
  cursor: SyncCursor | null,
  floor: number,
  head: number,
  publicRpc: boolean,
): { start: number; firstBlock: number } {
  if (cursor) {
    return {
      firstBlock: cursor.firstBlock,
      start: Math.max(cursor.firstBlock, cursor.lastBlock + 1 - RPC_RESCAN_BLOCKS),
    };
  }
  const first = publicRpc ? Math.max(floor, head - PUBLIC_HISTORY_WINDOW + 1) : floor;
  return { start: first, firstBlock: first };
}

/** The RPC sync. See the module comment. */
async function syncViaRpc(
  wallet: string,
  network: NetworkName,
  tokens: TokenEntry[],
  head: number,
  opts: SyncOptions,
): Promise<SyncReport> {
  const provider = getProvider(network);
  const me = addressTopic(wallet);
  const floor = SCAN_START_BLOCK[network];
  const publicRpc = usesPublicRpc(network);
  // Shared by every token: a 50-block cap learned on the first is used for the rest.
  const chunk: ChunkState = newChunkState();
  const budget: RequestBudget = { left: opts.maxRequests ?? HISTORY_REQUEST_BUDGET };
  let added = 0;
  let limitedFrom: number | null = null;
  let stoppedAt: number | null = null;

  for (const token of tokens) {
    const cursor = getSyncCursor(wallet, network, token.address);
    const { start, firstBlock } = rpcStart(cursor, floor, head, publicRpc);
    if (firstBlock > floor) limitedFrom = Math.max(limitedFrom ?? 0, firstBlock);
    const walk = await walkBlockRange({
      from: start,
      to: head,
      chunk,
      cost: 2,
      budget,
      signal: opts.signal,
      sleep: opts.sleep,
      fetchChunk: async (fromBlock, toBlock) => {
        const base = { address: token.address, fromBlock, toBlock };
        const [outgoing, incoming] = await Promise.all([
          provider.getLogs({ ...base, topics: [CONFIDENTIAL_TRANSFER_TOPIC0, me, null] }),
          provider.getLogs({ ...base, topics: [CONFIDENTIAL_TRANSFER_TOPIC0, null, me] }),
        ]);
        const logs = [...outgoing, ...incoming];
        const blocks = [...new Set(logs.map((l) => l.blockNumber))];
        budget.left -= blocks.length;
        const times = new Map<number, number>();
        await Promise.all(
          blocks.map(async (n) => {
            const block = await provider.getBlock(n);
            if (block) times.set(n, block.timestamp);
          }),
        );
        const entries = dedupe(
          logs.map((l) =>
            transferEntry(l, l.blockNumber, times.get(l.blockNumber) ?? 0, token.symbol, network),
          ),
        );
        if (entries.length) added += upsertTransactions(entries);
        // Saved after every chunk: a sync that stops later resumes from here.
        saveSyncCursor(wallet, network, token.address, { firstBlock, lastBlock: toBlock });
        opts.onProgress?.({ source: token.symbol, block: toBlock, head });
      },
    });
    if (walk.stopped === 'error') throw rpcHistoryError(walk.error);
    if (walk.stopped) {
      stoppedAt = walk.scannedTo;
      break;
    }
  }

  const notes: string[] = [];
  if (limitedFrom !== null && publicRpc) {
    notes.push(
      `History before block ${limitedFrom} was not searched: the public RPC endpoints keep only about a week of logs. Set an Etherscan API key (fhevm-wallet config --etherscan-key -) to get the full history.`,
    );
  }
  if (stoppedAt !== null && !opts.signal?.aborted) {
    notes.push(
      `Synced up to block ${Math.max(stoppedAt, 0)} of ${head}: this RPC endpoint allows only small log searches, so the rest is left for the next sync. Sync again to continue, or set an Etherscan API key.`,
    );
  }
  return {
    added,
    complete: stoppedAt === null,
    head,
    ...(notes.length ? { notice: notes.join(' ') } : {}),
  };
}

/** A malformed eth_getLogs reply surfaces as a TypeError deep inside ethers. */
function rpcHistoryError(err: unknown): unknown {
  if (err instanceof TypeError && !/fetch failed/i.test(err.message)) {
    return new WalletTxError(
      'RPC_BAD_ANSWER',
      'The RPC endpoint sent an answer the wallet could not read.',
      'Its reply to the transaction-history query did not have the expected shape.',
      'Try again, or set an Etherscan API key or another RPC URL with fhevm-wallet config.',
      err.message,
    );
  }
  return err;
}

interface EtherscanLog {
  transactionHash: string;
  address: string;
  topics: string[];
  blockNumber: string;
  timeStamp: string;
  logIndex?: string;
}

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: string;
  timeStamp: string;
  isError?: string;
}

/** An Etherscan failure in the wallet's words. Never includes the request URL (the key). */
function etherscanError(text: string, status?: number): WalletTxError {
  const reason = stripUnsafeChars(text).slice(0, 160);
  if (status === 429 || RATE_LIMIT_RE.test(text) || /max (?:calls|rate)/i.test(text)) {
    return new WalletTxError(
      'RPC_RATE_LIMITED',
      'Etherscan is limiting requests.',
      `It answered: ${reason}`,
      'Wait a minute and sync again. What was synced so far is saved.',
      text,
    );
  }
  if (/api key|apikey/i.test(text)) {
    return new WalletTxError(
      'RPC_AUTH',
      'Etherscan refused the API key.',
      `It answered: ${reason}`,
      'Check the key at etherscan.io, then set it again (fhevm-wallet config --etherscan-key -).',
      text,
    );
  }
  return new WalletTxError(
    'RPC_ERROR',
    `Etherscan returned an error: ${reason || (status ? `HTTP ${status}` : 'no details')}`,
    'Its reply was not a list of transactions.',
    'Try again later. What was synced so far is saved.',
    text,
  );
}

/**
 * One Etherscan API call: the rows, `[]` for "No records found", and an error for any
 * other `status: "0"` reply. A rate limit is retried with back-off a few times.
 */
async function etherscanRows<T>(params: Record<string, string>, opts: SyncOptions): Promise<T[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const url = new URL(ETHERSCAN_V2_API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(ETHERSCAN_TIMEOUT_MS);
    const res = await fetch(url.toString(), {
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
    let err: WalletTxError;
    if (!res.ok) {
      err = etherscanError(`HTTP ${res.status}`, res.status);
    } else {
      const body = (await res.json()) as { status?: string; message?: string; result?: unknown };
      if (body.status === '1' && Array.isArray(body.result)) return body.result as T[];
      const text = typeof body.result === 'string' ? body.result : (body.message ?? '');
      if (
        body.status === '0' &&
        (!Array.isArray(body.result) || body.result.length === 0) &&
        /no (?:records|transactions) found/i.test(`${body.message ?? ''} ${text}`)
      ) {
        return [];
      }
      err = etherscanError(text || 'unexpected reply');
    }
    // A daily quota does not come back after a few seconds.
    const retry = err.code === 'RPC_RATE_LIMITED' && !/daily/i.test(err.raw);
    if (!retry || attempt >= RATE_LIMIT_BACKOFF_MS.length) throw err;
    await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
  }
}

/**
 * Read every row from `fromBlock` to `toBlock`, 1,000 at a time. The next page starts at
 * the last row's block again (rows of one block may straddle pages; duplicates are
 * merged by the store), or asks for the next page number when a single block filled a
 * whole page. Returns the last block fully read.
 */
async function etherscanPaged<T>(
  params: Record<string, string>,
  range: { fromKey: string; toKey: string; fromBlock: number; toBlock: number },
  blockOf: (row: T) => number,
  opts: SyncOptions,
  onPage: (rows: T[]) => void,
): Promise<number> {
  let from = range.fromBlock;
  let page = 1;
  for (let n = 0; n < ETHERSCAN_MAX_PAGES; n++) {
    if (opts.signal?.aborted) return from - 1;
    const rows = await etherscanRows<T>(
      {
        ...params,
        [range.fromKey]: String(from),
        [range.toKey]: String(range.toBlock),
        page: String(page),
        offset: String(ETHERSCAN_PAGE_SIZE),
      },
      opts,
    );
    onPage(rows);
    if (rows.length < ETHERSCAN_PAGE_SIZE) return range.toBlock;
    const last = Math.max(...rows.map(blockOf));
    if (last > from) {
      from = last;
      page = 1;
    } else {
      page++;
    }
  }
  return from - 1;
}

/** The Etherscan sync. See the module comment. */
async function syncViaEtherscan(
  wallet: string,
  network: NetworkName,
  tokens: TokenEntry[],
  head: number,
  opts: SyncOptions,
): Promise<SyncReport> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    throw new WalletTxError(
      'RPC_AUTH',
      'No Etherscan API key is set.',
      'History from Etherscan needs a free API key.',
      'Set one with fhevm-wallet config --etherscan-key -, or sync without it (RPC).',
    );
  }
  const chainid = String(getNetworkConfig(network).chainIdNumber);
  const me = addressTopic(wallet);
  const floor = SCAN_START_BLOCK[network];
  const safeHead = head - ETHERSCAN_LAG_BLOCKS;
  let added = 0;
  let complete = true;

  /**
   * Where one source starts: after its cursor, or at the floor. Etherscan has the full
   * history, so a range an RPC sync on public endpoints left short (`firstBlock` above
   * the floor) is read again from the floor.
   */
  const startOf = (source: string): number => {
    const cursor = getSyncCursor(wallet, network, source);
    return !cursor || cursor.firstBlock > floor ? floor : cursor.lastBlock + 1;
  };
  /** Save the cursor: never past the lag margin, never backwards. */
  const finish = (source: string, start: number, fullyRead: number) => {
    if (fullyRead < head) complete = false;
    const lastBlock = Math.max(start - 1, Math.min(safeHead, fullyRead));
    saveSyncCursor(wallet, network, source, { firstBlock: floor, lastBlock });
  };
  const store = (entries: Transaction[]) => {
    if (entries.length) added += upsertTransactions(dedupe(entries));
  };

  for (const token of tokens) {
    const start = startOf(token.address);
    let fullyRead = head;
    for (const [topicKey, opr] of [
      ['topic1', 'topic0_1_opr'],
      ['topic2', 'topic0_2_opr'],
    ] as const) {
      const read = await etherscanPaged<EtherscanLog>(
        {
          chainid,
          module: 'logs',
          action: 'getLogs',
          address: token.address,
          topic0: CONFIDENTIAL_TRANSFER_TOPIC0,
          [topicKey]: me,
          [opr]: 'and',
          apikey: apiKey,
        },
        { fromKey: 'fromBlock', toKey: 'toBlock', fromBlock: start, toBlock: head },
        (row) => hexNumber(row.blockNumber),
        opts,
        (rows) => {
          store(
            rows
              .filter((l) => Array.isArray(l.topics) && l.topics.length >= 3)
              .map((l) =>
                transferEntry(
                  { ...l, index: hexNumber(l.logIndex) },
                  hexNumber(l.blockNumber),
                  hexNumber(l.timeStamp),
                  token.symbol,
                  network,
                ),
              ),
          );
          opts.onProgress?.({ source: token.symbol, block: head, head });
        },
      );
      fullyRead = Math.min(fullyRead, read);
    }
    finish(token.address, start, fullyRead);
  }

  // Plain ETH transfers (txlist covers both directions). Failed ones moved nothing.
  const ethStart = startOf(ETH_SOURCE);
  const ethRead = await etherscanPaged<EtherscanTx>(
    { chainid, module: 'account', action: 'txlist', address: wallet, sort: 'asc', apikey: apiKey },
    { fromKey: 'startblock', toKey: 'endblock', fromBlock: ethStart, toBlock: head },
    (row) => Number(row.blockNumber),
    opts,
    (rows) => {
      store(
        rows
          .filter((tx) => tx.value !== '0' && tx.isError !== '1')
          .map((tx) => ({
            txHash: tx.hash,
            type: 'eth' as const,
            tokenAddress: '',
            tokenSymbol: 'ETH',
            from: tx.from,
            to: tx.to,
            amount: trimEther(tx.value),
            network,
            blockNumber: Number(tx.blockNumber),
            timestamp: new Date(Number(tx.timeStamp) * 1000).toISOString(),
          })),
      );
      opts.onProgress?.({ source: 'ETH', block: head, head });
    },
  );
  finish(ETH_SOURCE, ethStart, ethRead);

  return { added, complete, head };
}

/** Wei as ETH with at most 6 decimals, trailing zeros dropped (exact: no float). */
function trimEther(wei: string): string {
  const [whole, frac = ''] = formatEther(BigInt(wei)).split('.');
  const short = frac.slice(0, 6).replace(/0+$/, '');
  return short ? `${whole}.${short}` : whole;
}

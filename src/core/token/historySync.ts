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
 *   after every chunk. Tokens with the same cursor are read together (one request per
 *   direction with an address list). Public endpoints keep only recent logs (publicnode
 *   answers "pruned history unavailable", unevenly behind its load balancer) or cap a
 *   request at 50 blocks (nodies), so a first sync on the built-in endpoints covers only
 *   the last `PUBLIC_HISTORY_WINDOW` blocks and says so; a "pruned" start moves forward
 *   (halving the distance to the head, remembered for the process) instead of walking
 *   old blocks 50 at a time. A custom RPC URL starts at `SCAN_START_BLOCK`. A request
 *   budget stops a sync that would otherwise send thousands of requests.
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
 * Blocks a first RPC sync covers on the built-in public endpoints: about 33 hours on
 * Sepolia, one request per direction. A live run (Nov 2026) found publicnode pruning
 * unevenly: 30k and 20k blocks back "pruned", 18k and 15k fine, 12.5k refused once,
 * 10k and less always fine.
 */
export const PUBLIC_HISTORY_WINDOW = 10_000;

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
  /**
   * RPC sync stopped early (request budget): the blocks still to search, first `from` the
   * stopped walk, up to the head. The next sync continues there.
   */
  unsearched?: { from: number; to: number };
}

/** The one-line outcome of a sync for a spinner or notice: "Synced" or "Synced up to block N". */
export function syncOutcomeText(r: Pick<SyncReport, 'added' | 'complete' | 'unsearched'>): {
  ok: boolean;
  text: string;
} {
  const added = r.added > 0 ? ` (${r.added} new)` : '';
  if (r.complete) return { ok: true, text: `Synced${added}` };
  return {
    ok: false,
    text: r.unsearched
      ? `Synced up to block ${r.unsearched.from - 1}${added}`
      : `Partly synced${added}`,
  };
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
  window: number | null,
): { start: number; firstBlock: number } {
  if (cursor) {
    return {
      firstBlock: cursor.firstBlock,
      start: Math.max(cursor.firstBlock, cursor.lastBlock + 1 - RPC_RESCAN_BLOCKS),
    };
  }
  const first = window !== null ? Math.max(floor, head - window + 1) : floor;
  return { start: first, firstBlock: first };
}

/**
 * Below this many blocks from the head, a "pruned" start is not moved forward again: the
 * rest is walked normally (on a 50-block fallback that is a handful of requests).
 */
const MIN_PRUNED_SKIP = 500;

/**
 * Per first endpoint, for the process: how far back (blocks from the head) its logs
 * were found after a "pruned" refusal. Later first syncs start inside it right away.
 */
const prunedReach = new Map<string, number>();

/** Forget learnt prune limits (tests). */
export function resetPrunedReach(): void {
  prunedReach.clear();
}

/** The chunk was refused as pruned history: the walk moves its start forward. */
class PrunedStart extends Error {}

/** Tokens synced together: equal cursors, so one eth_getLogs with an address list serves all. */
interface RpcGroup {
  tokens: TokenEntry[];
  start: number;
  firstBlock: number;
  /** No stored cursor yet: only then may a "pruned" start move forward. */
  fresh: boolean;
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
  const endpoint = provider.urls[0];
  const window = publicRpc
    ? Math.min(PUBLIC_HISTORY_WINDOW, prunedReach.get(endpoint) ?? PUBLIC_HISTORY_WINDOW)
    : null;
  // Shared by every walk: a 50-block cap learned on the first is used for the rest.
  const chunk: ChunkState = newChunkState();
  const budget: RequestBudget = { left: opts.maxRequests ?? HISTORY_REQUEST_BUDGET };
  let added = 0;
  // Per group: where its searched history starts (the notice names each token's start).
  const limited: Array<{ from: number; symbols: string[] }> = [];
  let stopped: { at: number; group: RpcGroup; later: number } | null = null;

  // Group tokens whose cursors give the same range (all of them on a first sync).
  const groups: RpcGroup[] = [];
  for (const token of tokens) {
    const cursor = getSyncCursor(wallet, network, token.address);
    const range = rpcStart(cursor, floor, head, window);
    const fresh = cursor === null;
    const g = groups.find(
      (x) => x.start === range.start && x.firstBlock === range.firstBlock && x.fresh === fresh,
    );
    if (g) g.tokens.push(token);
    else groups.push({ tokens: [token], ...range, fresh });
  }

  for (const group of groups) {
    const symbols = new Map(group.tokens.map((t) => [t.address.toLowerCase(), t.symbol]));
    const addresses = group.tokens.map((t) => t.address);
    let { start, firstBlock } = group;
    for (;;) {
      // Only a first sync (no stored cursor) may move its start: an existing cursor's
      // coverage is contiguous and must stay so. Its old blocks go through the fallback
      // in small chunks under the request budget instead; the next sync continues.
      const movable = publicRpc && group.fresh && head - start + 1 > MIN_PRUNED_SKIP;
      let skipTo: number | null = null;
      const walk = await walkBlockRange({
        from: start,
        to: head,
        chunk,
        cost: 2,
        budget,
        signal: opts.signal,
        sleep: opts.sleep,
        fetchChunk: async (fromBlock, toBlock) => {
          const base = {
            address: addresses.length === 1 ? addresses[0] : addresses,
            fromBlock,
            toBlock,
          };
          const refusedBefore = provider.prunedLogRefusals;
          let logs;
          try {
            const [outgoing, incoming] = await Promise.all([
              provider.getLogs({ ...base, topics: [CONFIDENTIAL_TRANSFER_TOPIC0, me, null] }),
              provider.getLogs({ ...base, topics: [CONFIDENTIAL_TRANSFER_TOPIC0, null, me] }),
            ]);
            logs = [...outgoing, ...incoming];
          } catch (err) {
            // An endpoint said "pruned" for this chunk (a fallback then refused its range,
            // or there is none): the logs are not this old there. Start later instead of
            // creeping through old blocks 50 at a time on a capped fallback.
            if (movable && fromBlock === start && provider.prunedLogRefusals > refusedBefore) {
              // publicnode prunes unevenly behind a load balancer: halve the distance.
              skipTo = Math.max(
                (provider.newestPrunedFrom ?? fromBlock) + 1,
                fromBlock + Math.ceil((head - fromBlock + 1) / 2),
              );
              throw new PrunedStart();
            }
            throw err;
          }
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
              transferEntry(
                l,
                l.blockNumber,
                times.get(l.blockNumber) ?? 0,
                symbols.get(l.address.toLowerCase()) ?? '',
                network,
              ),
            ),
          );
          if (entries.length) added += upsertTransactions(entries);
          // Saved after every chunk, for every token of the group: a sync that stops later
          // resumes from here.
          for (const t of group.tokens) {
            saveSyncCursor(wallet, network, t.address, { firstBlock, lastBlock: toBlock });
          }
          opts.onProgress?.({
            source: group.tokens.map((t) => t.symbol).join(', '),
            block: toBlock,
            head,
          });
        },
      });
      if (walk.stopped === 'error' && walk.error instanceof PrunedStart && skipTo !== null) {
        start = Math.min(skipTo, head);
        firstBlock = start;
        prunedReach.set(
          endpoint,
          Math.min(prunedReach.get(endpoint) ?? Infinity, head - start + 1),
        );
        continue;
      }
      if (walk.stopped === 'error') throw rpcHistoryError(walk.error);
      if (firstBlock > floor) {
        limited.push({ from: firstBlock, symbols: group.tokens.map((t) => t.symbol) });
      }
      if (walk.stopped) {
        stopped = {
          at: walk.scannedTo,
          group,
          later: groups.length - 1 - groups.indexOf(group),
        };
      }
      break;
    }
    if (stopped) break;
  }

  const notes: string[] = [];
  if (limited.length && publicRpc) {
    const where = limited
      .map((l) => `block ${l.from} for ${l.symbols.join(', ')}`)
      .join('; before ');
    notes.push(
      `History before ${where} was not searched: the public RPC endpoints keep only recent logs (a few days or less). Set an Etherscan API key (fhevm-wallet config --etherscan-key -) to get the full history.`,
    );
  }
  const unsearched = stopped
    ? { from: Math.max(stopped.at + 1, stopped.group.start), to: head }
    : undefined;
  if (stopped && unsearched && !opts.signal?.aborted) {
    const from = unsearched.from;
    const others = stopped.later
      ? ` (and ${stopped.later} more token group${stopped.later === 1 ? '' : 's'} not synced this time)`
      : '';
    notes.push(
      `Synced up to block ${from - 1}. History from block ${from} to ${head} not searched yet for ${stopped.group.tokens.map((t) => t.symbol).join(', ')}${others}: this RPC endpoint allows only small log searches. Sync again to continue, or set an Etherscan API key.`,
    );
  }
  return {
    added,
    complete: stopped === null,
    head,
    ...(notes.length ? { notice: notes.join(' ') } : {}),
    ...(unsearched ? { unsearched } : {}),
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

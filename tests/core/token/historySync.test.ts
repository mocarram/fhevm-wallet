/**
 * The real history sync (RPC and Etherscan paths) against a local stub node and a stubbed
 * Etherscan, with the refusals public endpoints send. The mock backend never runs this
 * code, which is how a 50-block cap, pruned history and an ignored Etherscan rate limit
 * went unnoticed before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id, zeroPadValue } from 'ethers';
import { startStubRpc, type StubLog, type StubNode } from '../../helpers/stubRpc.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const net = vi.hoisted(() => ({ urls: [] as string[], publicRpc: false }));
vi.mock('../../../src/core/network/NetworkConfig.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/network/NetworkConfig.js')>();
  return { ...orig, getRpcUrls: () => net.urls, usesPublicRpc: () => net.publicRpc };
});

const { syncTransactions, PUBLIC_HISTORY_WINDOW, ETHERSCAN_LAG_BLOCKS } =
  await import('../../../src/core/token/historySync.js');
const { SCAN_START_BLOCK, CONFIDENTIAL_TRANSFER_TOPIC0 } =
  await import('../../../src/core/token/tokenScan.js');
const { clearProviderCache, resetRefusedEndpoints } =
  await import('../../../src/core/network/ProviderFactory.js');
const { getSyncCursor, listTransactions } =
  await import('../../../src/storage/TransactionStore.js');

const FLOOR = SCAN_START_BLOCK.sepolia;
const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const token = (address: string, symbol: string) => ({
  address,
  symbol,
  name: symbol,
  decimals: 6,
  network: 'sepolia' as const,
  addedAt: new Date(0).toISOString(),
});
const topic = (a: string) => zeroPadValue(a, 32).toLowerCase();
let seq = 0;
/** A ConfidentialTransfer log; `out` = sent by the wallet. */
function transfer(tokenAddr: string, block: number, out: boolean, extra: Partial<StubLog> = {}) {
  seq++;
  return {
    address: tokenAddr,
    topics: [
      CONFIDENTIAL_TRANSFER_TOPIC0,
      topic(out ? WALLET : OTHER),
      topic(out ? OTHER : WALLET),
      '0x' + seq.toString(16).padStart(64, 'a'),
    ],
    blockNumber: block,
    transactionHash: id(`tx${seq}`),
    logIndex: 0,
    ...extra,
  };
}

const nodes: StubNode[] = [];
async function node(opts: Parameters<typeof startStubRpc>[0]) {
  const n = await startStubRpc(opts);
  nodes.push(n);
  return n;
}
const noSleep = async () => {};

beforeEach(() => {
  wipeTestDataDir();
  clearProviderCache();
  resetRefusedEndpoints();
  net.publicRpc = false;
  delete process.env.ETHERSCAN_API_KEY;
});
afterEach(async () => {
  clearProviderCache();
  vi.unstubAllGlobals();
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

describe('RPC history sync', () => {
  it('works with a 50-block cap and saves the cursor after every chunk (H1)', async () => {
    const head = FLOOR + 299;
    const rpc = await node({
      head,
      maxRange: 50,
      logs: [transfer(A, FLOOR + 10, false), transfer(A, FLOOR + 260, true)],
    });
    net.urls = [rpc.url];
    const seen: Array<[number, number | undefined]> = [];
    const r = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc', {
      onProgress: (p) => seen.push([p.block, getSyncCursor(WALLET, 'sepolia', A)?.lastBlock]),
    });
    expect(r).toMatchObject({ added: 2, complete: true, head });
    expect(r.notice).toBeUndefined();
    // Started at the network's start block, not block 0.
    expect(Math.min(...rpc.ranges.map(([f]) => f))).toBe(FLOOR);
    // Straight to the named cap (no halving below it); only occasional tries to grow.
    expect(rpc.ranges.every(([f, t]) => t - f + 1 >= 50)).toBe(true);
    expect(rpc.ranges.filter(([f, t]) => t - f + 1 > 50).length).toBeLessThanOrEqual(4);
    expect(seen.length).toBe(6);
    for (const [block, cursor] of seen) expect(cursor).toBe(block);
    expect(listTransactions({ walletAddress: WALLET, network: 'sepolia' })).toHaveLength(2);
  });

  it('fails over when the first endpoint has pruned the blocks (H1, M3)', async () => {
    net.publicRpc = true;
    const head = FLOOR + 100_000;
    const windowStart = head - PUBLIC_HISTORY_WINDOW + 1;
    const log = transfer(A, windowStart + 5, false);
    const pruned = await node({ head, prunedBelow: head - 30_000, logs: [log] });
    const archive = await node({ head, maxRange: 10_000, logs: [log] });
    net.urls = [pruned.url, archive.url];
    const r = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc');
    expect(r.added).toBe(1);
    expect(r.complete).toBe(true);
    // A first sync on public endpoints covers a recent window, and says so.
    expect(Math.min(...archive.ranges.map(([f]) => f))).toBe(windowStart);
    expect(r.notice).toMatch(/History before block \d+ was not searched.*Etherscan API key/);
  });

  it('stops at the request budget and the next sync resumes from the cursor', async () => {
    const head = FLOOR + 999;
    const rpc = await node({ head, maxRange: 50, logs: [transfer(A, FLOOR + 900, false)] });
    net.urls = [rpc.url];
    const first = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc', {
      maxRequests: 20,
    });
    expect(first.complete).toBe(false);
    expect(first.added).toBe(0);
    expect(first.notice).toMatch(/Synced up to block \d+ of \d+.*Sync again to continue/);
    const cursor = getSyncCursor(WALLET, 'sepolia', A)!;
    expect(cursor.firstBlock).toBe(FLOOR);
    expect(cursor.lastBlock).toBeGreaterThan(FLOOR);
    rpc.ranges.length = 0;
    const second = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc');
    expect(second).toMatchObject({ added: 1, complete: true });
    expect(Math.min(...rpc.ranges.map(([f]) => f))).toBe(cursor.lastBlock + 1 - 12);
  });

  it('gives a token added later its earlier history (H3)', async () => {
    const head = FLOOR + 20_000;
    const rpc = await node({
      head,
      logs: [transfer(A, FLOOR + 100, false), transfer(B, FLOOR + 50, true)],
    });
    net.urls = [rpc.url];
    await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc');
    rpc.ranges.length = 0;
    const r = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA'), token(B, 'cB')], 'rpc');
    expect(r.added).toBe(1);
    expect(getSyncCursor(WALLET, 'sepolia', B)).toEqual({ firstBlock: FLOOR, lastBlock: head });
    const symbols = listTransactions({ walletAddress: WALLET, network: 'sepolia' }).map(
      (t) => t.tokenSymbol,
    );
    expect(symbols.sort()).toEqual(['cA', 'cB']);
  });

  it('keeps two transfers of one transaction apart (M9)', async () => {
    const head = FLOOR + 100;
    const first = transfer(A, FLOOR + 10, false, { logIndex: 3 });
    const second = transfer(A, FLOOR + 10, false, {
      logIndex: 7,
      transactionHash: first.transactionHash,
    });
    const rpc = await node({ head, logs: [first, second] });
    net.urls = [rpc.url];
    const r = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc');
    expect(r.added).toBe(2);
    const rows = listTransactions({ walletAddress: WALLET, network: 'sepolia' });
    expect(rows.map((t) => t.logIndex).sort()).toEqual([3, 7]);
    // A second sync over the same blocks adds nothing.
    clearProviderCache();
    expect((await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc')).added).toBe(0);
  });

  it('waits and retries on a JSON-RPC rate limit', async () => {
    const rpc = await node({
      head: FLOOR + 10,
      rateLimitFirst: 2,
      logs: [transfer(A, FLOOR, false)],
    });
    net.urls = [rpc.url];
    const waits: number[] = [];
    const r = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc', {
      // Longer than ethers' 250 ms cache of identical requests, shorter than the real wait.
      sleep: async (ms) => {
        waits.push(ms);
        await new Promise((res) => setTimeout(res, 300));
      },
    });
    expect(r.added).toBe(1);
    expect(waits[0]).toBe(1_000);
  });

  it('a malformed eth_getLogs reply is RPC_BAD_ANSWER, not a raw TypeError', async () => {
    const rpc = await node({ head: FLOOR + 10, malformedLogs: true });
    net.urls = [rpc.url];
    await expect(
      syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc', { sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'RPC_BAD_ANSWER' });
  });
});

describe('Etherscan history sync', () => {
  type Reply = { status: string; message: string; result: unknown };
  /** Stub fetch; `route` answers each Etherscan request from its query parameters. */
  function etherscan(route: (q: URLSearchParams) => Reply) {
    const seen: URLSearchParams[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        // The JSON-RPC transport uses fetch too: let it reach the stub node.
        if (!String(url).startsWith('https://api.etherscan.io/')) return realFetch(url, init);
        const q = new URL(url).searchParams;
        seen.push(q);
        return new Response(JSON.stringify(route(q)), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return seen;
  }
  const none: Reply = { status: '0', message: 'No records found', result: [] };
  const rateLimited: Reply = {
    status: '0',
    message: 'NOTOK',
    result: 'Max calls per sec rate limit reached (3/sec)',
  };
  const row = (block: number, logIndex = '0x') => ({
    address: A,
    topics: [CONFIDENTIAL_TRANSFER_TOPIC0, topic(OTHER), topic(WALLET), '0x' + '1'.repeat(64)],
    blockNumber: '0x' + block.toString(16),
    timeStamp: '0x6553f100',
    logIndex,
    transactionHash: id(`es${block}:${logIndex}`),
  });

  beforeEach(() => {
    process.env.ETHERSCAN_API_KEY = 'TESTKEY';
  });

  async function head(n: number) {
    const rpc = await node({ head: n });
    net.urls = [rpc.url];
  }

  it('retries a status-0 rate limit, then stores the rows (H2)', async () => {
    await head(FLOOR + 1_000);
    let limited = 2;
    etherscan((q) => {
      if (q.get('module') === 'logs' && q.get('topic2') && limited-- > 0) return rateLimited;
      if (q.get('module') === 'logs' && q.get('topic2'))
        return { status: '1', message: 'OK', result: [row(FLOOR + 5)] };
      return none;
    });
    const waits: number[] = [];
    const r = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'etherscan', {
      sleep: async (ms) => void waits.push(ms),
    });
    expect(r.added).toBe(1);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it('a lasting rate limit is an error and the cursor does not jump to the head (H2)', async () => {
    await head(FLOOR + 1_000);
    etherscan(() => rateLimited);
    await expect(
      syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'etherscan', { sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'RPC_RATE_LIMITED' });
    expect(getSyncCursor(WALLET, 'sepolia', A)).toBeNull();
  });

  it('an invalid key is reported as such', async () => {
    await head(FLOOR + 1_000);
    etherscan(() => ({ status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)|x' }));
    await expect(
      syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'etherscan'),
    ).rejects.toMatchObject({ code: 'RPC_AUTH' });
  });

  it('pages past 1,000 rows from the last block read', async () => {
    await head(FLOOR + 5_000);
    const full = Array.from({ length: 1_000 }, (_, i) =>
      row(FLOOR + 1 + Math.floor(i / 10), '0x' + (i % 10).toString(16)),
    );
    const seen = etherscan((q) => {
      if (q.get('module') !== 'logs' || !q.get('topic2')) return none;
      return Number(q.get('fromBlock')) === FLOOR
        ? { status: '1', message: 'OK', result: full }
        : { status: '1', message: 'OK', result: [row(FLOOR + 100, '0x9'), row(FLOOR + 101)] };
    });
    const r = await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'etherscan');
    const incoming = seen.filter((q) => q.get('topic2'));
    expect(incoming.map((q) => Number(q.get('fromBlock')))).toEqual([FLOOR, FLOOR + 100]);
    // Block FLOOR+100's row 0x9 straddled the pages: stored once.
    expect(r.added).toBe(1_001);
  });

  it('keeps the cursor behind the head and reads those blocks again next time', async () => {
    const h = FLOOR + 5_000;
    await head(h);
    const seen = etherscan(() => none);
    await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'etherscan');
    expect(getSyncCursor(WALLET, 'sepolia', A)).toEqual({
      firstBlock: FLOOR,
      lastBlock: h - ETHERSCAN_LAG_BLOCKS,
    });
    expect(getSyncCursor(WALLET, 'sepolia', 'eth')?.lastBlock).toBe(h - ETHERSCAN_LAG_BLOCKS);
    seen.length = 0;
    await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'etherscan');
    expect(Number(seen.find((q) => q.get('module') === 'logs')!.get('fromBlock'))).toBe(
      h - ETHERSCAN_LAG_BLOCKS + 1,
    );
  });

  it('backfills from the start block what a public-RPC sync left out', async () => {
    net.publicRpc = true;
    const h = FLOOR + 100_000;
    const rpc = await node({ head: h });
    net.urls = [rpc.url];
    await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'rpc');
    expect(getSyncCursor(WALLET, 'sepolia', A)!.firstBlock).toBeGreaterThan(FLOOR);
    const seen = etherscan(() => none);
    await syncTransactions(WALLET, 'sepolia', [token(A, 'cA')], 'etherscan');
    expect(Number(seen[0].get('fromBlock'))).toBe(FLOOR);
    expect(getSyncCursor(WALLET, 'sepolia', A)!.firstBlock).toBe(FLOOR);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { getAddress, zeroPadValue } from 'ethers';
import {
  CONFIDENTIAL_TRANSFER_TOPIC0,
  isRangeTooLarge,
  scanIncoming,
  type LogSource,
} from '../../../src/core/token/tokenScan.js';
import {
  knownTokens,
  refreshTokenList,
  shippedTokens,
  tokensFromList,
} from '../../../src/core/token/tokenLists.js';
import { findTokens, sourceLabel } from '../../../src/core/token/findTokens.js';
import {
  MockBackend,
  mockGiftToken,
  mockNonConfidentialToken,
} from '../../../src/core/backend/MockBackend.js';
import { getScanState } from '../../../src/storage/ScanStateStore.js';
import { addTokenWithInfo } from '../../../src/core/token/TokenRegistry.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

beforeEach(() => wipeTestDataDir());

/** A fake chain: logs at given blocks; refuses ranges wider than `maxRange`. */
function chain(head: number, logs: Array<{ block: number; address: string }>, maxRange = Infinity) {
  const calls: Array<[number, number]> = [];
  const src: LogSource = {
    getBlockNumber: async () => head,
    getLogs: async (f) => {
      calls.push([f.fromBlock, f.toBlock]);
      expect(f.topics[0]).toBe(CONFIDENTIAL_TRANSFER_TOPIC0);
      expect(f.topics[1]).toBeNull();
      expect(f.topics[2]).toBe(zeroPadValue(WALLET, 32).toLowerCase());
      if (f.toBlock - f.fromBlock + 1 > maxRange) {
        throw Object.assign(new Error('could not coalesce error'), {
          error: { code: -32602, message: 'query exceeds max block range 1000' },
        });
      }
      return logs.filter((l) => l.block >= f.fromBlock && l.block <= f.toBlock);
    },
  };
  return { src, calls };
}

describe('scanIncoming', () => {
  it('scans in chunks with progress, any contract, deduplicated', async () => {
    const { src, calls } = chain(25_000, [
      { block: 10, address: A.toLowerCase() },
      { block: 12_000, address: A },
      { block: 24_999, address: B },
    ]);
    const progress: number[] = [];
    const r = await scanIncoming(src, WALLET, {
      fromBlock: 0,
      onProgress: (p) => progress.push(p.current),
    });
    expect(r.contracts.sort()).toEqual([getAddress(A), getAddress(B)]);
    expect(calls).toHaveLength(3);
    expect(progress).toEqual([9999, 19999, 25000]);
    expect(r.scannedTo).toBe(25_000);
  });

  it('halves the chunk when the endpoint says the range is too large', async () => {
    const { src, calls } = chain(3000, [{ block: 2500, address: A }], 1000);
    const r = await scanIncoming(src, WALLET, { fromBlock: 0 });
    expect(r.error).toBeUndefined();
    expect(r.contracts).toEqual([getAddress(A)]);
    expect(calls.filter(([f, t]) => t - f + 1 <= 1000).length).toBeGreaterThan(0);
  });

  it('retries a rate limit with back-off, then stops keeping progress; can be cancelled', async () => {
    let n = 0;
    const src: LogSource = {
      getBlockNumber: async () => 50_000,
      getLogs: async () => {
        if (++n >= 2) throw new Error('429 Too Many Requests: rate limit');
        return [{ address: A }];
      },
    };
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const r = await scanIncoming(src, WALLET, { fromBlock: 0, sleep });
    expect(r.error).toBeDefined();
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(r.scannedTo).toBe(9999);
    expect(r.contracts).toEqual([getAddress(A)]);
    const ac = new AbortController();
    ac.abort();
    const c = await scanIncoming(src, WALLET, { fromBlock: 0, signal: ac.signal });
    expect(c.cancelled).toBe(true);
    expect(c.scannedTo).toBe(-1);
  });

  it('goes straight to the limit an endpoint names (nodies: 50 blocks)', async () => {
    const calls: Array<[number, number]> = [];
    const src: LogSource = {
      getBlockNumber: async () => 1_149,
      getLogs: async (f) => {
        calls.push([f.fromBlock, f.toBlock]);
        if (f.toBlock - f.fromBlock + 1 > 50) {
          throw Object.assign(new Error('could not coalesce error'), {
            error: {
              code: -32001,
              message: 'Block range too large: maximum allowed is 50 blocks on your current plan.',
            },
          });
        }
        return [];
      },
    };
    const r = await scanIncoming(src, WALLET, { fromBlock: 1_000 });
    expect(r.error).toBeUndefined();
    expect(r.scannedTo).toBe(1_149);
    // One refusal, then three 50-block chunks: no halving down from 10,000.
    expect(calls).toEqual([
      [1000, 1149],
      [1000, 1049],
      [1050, 1099],
      [1100, 1149],
    ]);
  });

  it('stops at the request budget instead of looping silently', async () => {
    const { src, calls } = chain(1_000_000, [], 1000);
    const r = await scanIncoming(src, WALLET, { fromBlock: 0, maxRequests: 20 });
    expect(r.budgetExhausted).toBe(true);
    expect(calls).toHaveLength(20);
    expect(r.scannedTo).toBeGreaterThan(0);
    expect(r.scannedTo).toBeLessThan(1_000_000);
  });

  it('scans only a recent window when asked to', async () => {
    const { src } = chain(100_000, [
      { block: 10, address: A },
      { block: 99_000, address: B },
    ]);
    const r = await scanIncoming(src, WALLET, { fromBlock: 0, recentWindow: 5_000 });
    expect(r.limitedFrom).toBe(95_001);
    expect(r.contracts).toEqual([getAddress(B)]);
  });

  it('tells range errors from rate limits', () => {
    expect(isRangeTooLarge(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeTooLarge(new Error('block range is too wide'))).toBe(true);
    expect(isRangeTooLarge(new Error('rate limit exceeded'))).toBe(false);
    expect(isRangeTooLarge(new Error('fetch failed'))).toBe(false);
    expect(isRangeTooLarge({ error: { code: 4444, message: 'pruned history unavailable' } })).toBe(
      false,
    );
  });
});

describe('token lists', () => {
  it('ships empty lists (no verified addresses yet)', () => {
    expect(shippedTokens('mainnet')).toEqual([]);
    expect(shippedTokens('sepolia')).toEqual([]);
  });

  it('keeps valid entries for the chain, checksummed and sanitised', () => {
    const list = {
      tokens: [
        {
          chainId: 11155111,
          address: A.toLowerCase(),
          name: 'Conf\u001b[31m USD',
          symbol: 'cUSD',
          decimals: 6,
        },
        { chainId: 1, address: B, name: 'Main', symbol: 'M', decimals: 6 },
        { chainId: 11155111, address: 'nope', name: 'Bad', symbol: 'B', decimals: 6 },
      ],
    };
    const t = tokensFromList(list, 'sepolia', 'x');
    expect(t).toHaveLength(1);
    expect(t[0].address).toBe(getAddress(A));
    expect(t[0].name).not.toContain('\u001b');
    expect(() => tokensFromList({ nope: 1 }, 'sepolia', 'x')).toThrow(/not a token list/);
  });

  it('stops reading a chunked token list once it passes the size limit', async () => {
    // Regression: res.text() buffered the whole body when Content-Length was missing.
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const chunked = (async () => new Response(endless, { status: 200 })) as typeof fetch;
    await expect(refreshTokenList('https://lists.example/big.json', chunked)).rejects.toThrow(
      /too large/,
    );
    expect(cancelled).toBe(true);
    // 1 MB of 64 KiB chunks, plus the stream's small read-ahead.
    expect(pulled).toBeLessThan(25);
  });

  it('refreshes from a URL with checks, caches it, and falls back on failure', async () => {
    const body = JSON.stringify({
      tokens: [{ chainId: 11155111, address: A, name: 'Listed', symbol: 'cLST', decimals: 6 }],
    });
    const ok = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const down = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    const url = 'https://lists.example/tokens.json';
    await expect(refreshTokenList('http://lists.example/x.json', ok)).rejects.toThrow(/https/);
    const big = (async () => new Response('x'.repeat(1_000_001))) as typeof fetch;
    await expect(refreshTokenList(url, big)).rejects.toThrow(/too large/);
    const r = await knownTokens('sepolia', { url, fetchImpl: ok });
    expect(r.tokens.map((t) => t.symbol)).toEqual(['cLST']);
    expect(r.tokens[0].list).toBe('lists.example');
    const again = await knownTokens('sepolia', { url, refresh: true, fetchImpl: down });
    expect(again.tokens.map((t) => t.symbol)).toEqual(['cLST']);
    expect(again.listError).toMatch(/did not answer/);
  });
});

describe('findTokens (mock backend)', () => {
  const backend = () => new MockBackend({ latencyMs: 0, sleep: async () => {} });

  it('labels and verifies candidates from both sources and saves progress', async () => {
    const b = backend();
    const progress: number[] = [];
    const r = await findTokens(b, WALLET, 'sepolia', {
      onProgress: (p) => progress.push(p.current),
    });
    const [cusdc, cdai] = b.catalogue('sepolia');
    const by = (a: string) => r.candidates.find((c) => c.address === a)!;
    expect(by(cusdc.address)).toMatchObject({ status: 'verified', sources: ['known'] });
    expect(by(cdai.address)).toMatchObject({ status: 'verified', sources: ['known', 'history'] });
    expect(sourceLabel(by(cdai.address))).toBe('known list · found in your history');
    expect(by(mockGiftToken('sepolia'))).toMatchObject({ status: 'unverified', symbol: 'cGIFT' });
    expect(by(mockNonConfidentialToken('sepolia')).status).toBe('not-erc7984');
    expect(r.candidates[0].status).toBe('verified');
    expect(progress.length).toBeGreaterThan(1);
    expect(getScanState(WALLET, 'sepolia')?.contracts).toHaveLength(3);

    // A second run resumes after the saved block and still lists earlier finds.
    const again = await findTokens(b, WALLET, 'sepolia');
    expect(again.scan?.upToDate).toBe(true);
    expect(again.candidates).toHaveLength(4);
  });

  it('names a tracked token found only in history from the registry', async () => {
    // Regression: it showed as "??? / Unknown token" with 0 decimals.
    const b = backend();
    const gift = mockGiftToken('sepolia');
    addTokenWithInfo(
      { address: gift, name: 'Gift Token', symbol: 'cGIFT', decimals: 6 },
      'sepolia',
    );
    const r = await findTokens(b, WALLET, 'sepolia');
    expect(r.candidates.find((c) => c.address === gift)).toMatchObject({
      status: 'tracked',
      name: 'Gift Token',
      symbol: 'cGIFT',
      decimals: 6,
    });
  });

  it('marks tracked tokens and keeps partial progress when cancelled', async () => {
    const b = backend();
    addTokenWithInfo(b.catalogue('sepolia')[0], 'sepolia');
    const ac = new AbortController();
    const r = await findTokens(b, WALLET, 'sepolia', {
      signal: ac.signal,
      onProgress: () => ac.abort(),
    });
    expect(r.scan?.cancelled).toBe(true);
    expect(r.candidates.find((c) => c.symbol === 'cUSDC')?.status).toBe('tracked');
    expect(getScanState(WALLET, 'sepolia')?.lastBlock).toBeGreaterThan(0);
  });
});

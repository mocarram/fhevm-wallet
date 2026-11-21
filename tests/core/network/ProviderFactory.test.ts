import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { BrowserProvider, FetchRequest, Network } from 'ethers';
import { abortableGetUrl } from '../../../src/core/network/abortableGetUrl.js';
import {
  assertRpcChain,
  describeProbeFailure,
  clearProviderCache,
  clearProviderForNetwork,
  FailoverJsonRpcProvider,
  getProvider,
  toEip1193,
  toEip1193Error,
  WrongChainError,
} from '../../../src/core/network/ProviderFactory.js';

beforeEach(() => {
  clearProviderCache();
});

afterEach(() => {
  clearProviderCache();
});

describe('ProviderFactory', () => {
  it('returns the same instance across calls (cache hit)', () => {
    const a = getProvider('sepolia');
    const b = getProvider('sepolia');
    expect(a).toBe(b);
  });

  it('returns distinct instances per network', () => {
    const sepolia = getProvider('sepolia');
    const mainnet = getProvider('mainnet');
    expect(sepolia).not.toBe(mainnet);
  });

  it('clearProviderForNetwork removes only the targeted network', () => {
    const sepolia1 = getProvider('sepolia');
    const mainnet1 = getProvider('mainnet');

    clearProviderForNetwork('sepolia');

    const sepolia2 = getProvider('sepolia');
    const mainnet2 = getProvider('mainnet');

    expect(sepolia2).not.toBe(sepolia1);
    expect(mainnet2).toBe(mainnet1);
  });

  it('clearProviderCache wipes all entries', () => {
    const sepolia1 = getProvider('sepolia');
    const mainnet1 = getProvider('mainnet');

    clearProviderCache();

    const sepolia2 = getProvider('sepolia');
    const mainnet2 = getProvider('mainnet');

    expect(sepolia2).not.toBe(sepolia1);
    expect(mainnet2).not.toBe(mainnet1);
  });

  it('exposes the configured static chainId without RPC', async () => {
    const provider = getProvider('sepolia');
    const network = await provider.getNetwork();
    expect(network.chainId).toBe(11155111n);
  });
});

describe('FailoverJsonRpcProvider', () => {
  // Small local JSON-RPC servers; no external network needed.
  const servers: Server[] = [];
  const calls: Record<string, string[]> = {};

  /** Start a server that answers like a node on `chainIdHex`, or fails with HTTP `status`. */
  async function startNode(
    name: string,
    opts: {
      chainIdHex?: string;
      status?: number;
      failExcept?: string[];
      /** Fail this many requests with 503 before answering normally. */
      failFirst?: number;
      /** JSON-RPC error replies by method (a revert, say). */
      rpcErrors?: Record<string, { code: number; message: string; data?: string }>;
    },
  ) {
    let failuresLeft = opts.failFirst ?? 0;
    calls[name] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = [JSON.parse(body)].flat() as { id: number; method: string }[];
        calls[name].push(...msgs.map((m) => m.method));
        const failing = opts.failExcept && msgs.some((m) => !opts.failExcept!.includes(m.method));
        if (opts.status || failing || failuresLeft > 0) {
          failuresLeft--;
          res.statusCode = opts.status ?? 503;
          res.end('down');
          return;
        }
        const reply = (m: { id: number; method: string }) =>
          opts.rpcErrors?.[m.method]
            ? { jsonrpc: '2.0', id: m.id, error: opts.rpcErrors[m.method] }
            : {
                jsonrpc: '2.0',
                id: m.id,
                result: m.method === 'eth_chainId' ? (opts.chainIdHex ?? '0xaa36a7') : '0x10',
              };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(msgs.length === 1 ? reply(msgs[0]) : msgs.map(reply)));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const sepolia = Network.from({ name: 'sepolia', chainId: 11155111 });

  afterAll(() => servers.forEach((s) => s.close()));

  it('moves on to the next URL when one is down', async () => {
    const down = await startNode('down', { status: 503 });
    const up = await startNode('up', {});
    const provider = new FailoverJsonRpcProvider([down, up], sepolia, 2_000);
    expect(await provider.getBlockNumber()).toBe(16);
    expect(provider.currentUrl).toBe(up);
    provider.destroy();
  });

  it('lets ethers follow a 307 redirect (the transport does not follow it alone)', async () => {
    const target = await startNode('redirected', {});
    let hops = 0;
    const redirector = createServer((req, res) => {
      hops++;
      req.resume();
      res.statusCode = 307;
      res.setHeader('location', target);
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    servers.push(redirector);
    const from = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;

    // The raw transport hands the 307 back instead of following it itself...
    const req = new FetchRequest(from);
    req.timeout = 2_000;
    const raw = await abortableGetUrl(req);
    expect(raw.statusCode).toBe(307);
    expect(raw.headers.location).toBe(target);

    // ...and ethers' own redirect handling (limit, https-to-http refusal) takes over.
    const provider = new FailoverJsonRpcProvider([from], sepolia, 2_000);
    expect(await provider.getBlockNumber()).toBe(16);
    expect(hops).toBeGreaterThanOrEqual(2); // chain check and the call both redirected
    expect(calls.redirected).toEqual(['eth_chainId', 'eth_blockNumber']);
    provider.destroy();
  });

  it('a probe that gets HTTP 500 says the endpoint returned an error', async () => {
    const url = await startNode('probe500', { status: 500 });
    await expect(assertRpcChain(url, 11155111n)).rejects.toThrow(/returned an error \(HTTP 500\)/);
    expect(describeProbeFailure({ code: 'TIMEOUT' })).toMatch(/did not answer/);
    expect(describeProbeFailure(new Error('No chain ID in the reply'))).toMatch(
      /not like an Ethereum JSON-RPC node/,
    );
  });

  it('checks the chain ID once before the first request', async () => {
    const url = await startNode('once', {});
    const provider = new FailoverJsonRpcProvider([url], sepolia, 2_000);
    await provider.getBlockNumber();
    await provider.getBlockNumber();
    expect(calls.once.filter((m) => m === 'eth_chainId')).toHaveLength(1);
    provider.destroy();
  });

  it('refuses to work with an endpoint on the wrong chain', async () => {
    const url = await startNode('wrong', { chainIdHex: '0x1' });
    const provider = new FailoverJsonRpcProvider([url], sepolia, 2_000);
    await expect(provider.getBlockNumber()).rejects.toBeInstanceOf(WrongChainError);
    expect(calls.wrong).not.toContain('eth_blockNumber');
    provider.destroy();
  });

  it('never resends a raw transaction to another node', async () => {
    // Answers the chain check, but fails the broadcast and any other call.
    const flaky = await startNode('flaky', { failExcept: ['eth_chainId'] });
    const other = await startNode('other', {});
    const provider = new FailoverJsonRpcProvider([flaky, other], sepolia, 2_000);
    await expect(provider.send('eth_sendRawTransaction', ['0x00'])).rejects.toThrow();
    expect(calls.other).not.toContain('eth_sendRawTransaction');
    // An ordinary read in the same situation does fail over.
    expect(await provider.getBlockNumber()).toBe(16);
    expect(calls.other).toContain('eth_blockNumber');
    provider.destroy();
  });

  it('does not remember a transport error during the chain check', async () => {
    const url = await startNode('blip', { failFirst: 1 });
    const provider = new FailoverJsonRpcProvider([url], sepolia, 2_000);
    // provider.send, not getBlockNumber: ethers briefly caches getBlockNumber results.
    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow();
    expect(await provider.send('eth_blockNumber', [])).toBe('0x10');
    provider.destroy();
  });

  it('skips an endpoint on the wrong chain and verifies the next one', async () => {
    const wrong = await startNode('wrongFirst', { chainIdHex: '0x1' });
    const good = await startNode('goodSecond', {});
    const provider = new FailoverJsonRpcProvider([wrong, good], sepolia, 2_000);
    expect(await provider.getBlockNumber()).toBe(16);
    expect(provider.currentUrl).toBe(good);
    expect(calls.goodSecond).toContain('eth_chainId'); // the new URL was checked too
    expect(calls.wrongFirst).not.toContain('eth_blockNumber');
    provider.destroy();
  });

  it('re-checks the chain after switching to another URL', async () => {
    const flakyGood = await startNode('flakyGood', { failExcept: ['eth_chainId'] });
    const wrongBackup = await startNode('wrongBackup', { chainIdHex: '0x1' });
    const provider = new FailoverJsonRpcProvider([flakyGood, wrongBackup], sepolia, 2_000);
    // The first URL passes the check, then fails; the backup must be checked, not trusted.
    await expect(provider.getBlockNumber()).rejects.toBeDefined();
    expect(calls.wrongBackup).toContain('eth_chainId');
    expect(calls.wrongBackup).not.toContain('eth_blockNumber');
    provider.destroy();
  });

  describe('EIP-1193 wrapper for the relayer SDK', () => {
    it('answers eth_chainId locally and keeps revert data decodable', async () => {
      const revertData = '0x08c379a0' + '00'.repeat(32); // Error(string) selector + junk
      const url = await startNode('sdk', {
        rpcErrors: { eth_call: { code: 3, message: 'execution reverted', data: revertData } },
      });
      const target = new FailoverJsonRpcProvider([url], sepolia, 2_000);
      const eip1193 = toEip1193(() => target);
      expect(await eip1193.request({ method: 'eth_chainId' })).toBe('0xaa36a7');

      const browser = new BrowserProvider(eip1193);
      expect((await browser.getNetwork()).chainId).toBe(11155111n);
      const err = await browser
        .call({ to: '0x000000000000000000000000000000000000dEaD', data: '0x' })
        .catch((e: unknown) => e as { code?: string; data?: string });
      expect(err.code).toBe('CALL_EXCEPTION');
      expect(err.data).toBe(revertData);
      // Network detection was answered locally: the server only saw the eth_call
      // (plus the provider's own one-time chain check).
      expect(calls.sdk.filter((m) => m === 'eth_chainId')).toHaveLength(1);
      browser.destroy();
      target.destroy();
    });

    it('rethrows transport failures with a numeric code and no URL', async () => {
      const KEY = 'WRAPPERSECRETKEY12345';
      const err = toEip1193Error(
        Object.assign(new Error(`server response 500 (info={ "requestUrl": "http://h/${KEY}" })`), {
          code: 'SERVER_ERROR',
        }),
      );
      expect(typeof err.code).toBe('number');
      expect(err.message).not.toContain(KEY);
    });
  });

  it('getRpcUrls lists fallbacks only when no custom URL is set', async () => {
    const { getRpcUrls, DEFAULT_RPC_URLS, FALLBACK_RPC_URLS } =
      await import('../../../src/core/network/NetworkConfig.js');
    delete process.env.SEPOLIA_RPC_URL;
    expect(getRpcUrls('sepolia')).toEqual([DEFAULT_RPC_URLS.sepolia, ...FALLBACK_RPC_URLS.sepolia]);
    process.env.SEPOLIA_RPC_URL = 'https://my.node';
    expect(getRpcUrls('sepolia')).toEqual(['https://my.node']);
    delete process.env.SEPOLIA_RPC_URL;
  });

  it('getRpcUrls ignores a custom URL that fails validation, with one notice', async () => {
    const { getRpcUrls, DEFAULT_RPC_URLS } =
      await import('../../../src/core/network/NetworkConfig.js');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      process.env.SEPOLIA_RPC_URL = 'http://remote.example/v2/KEY';
      expect(getRpcUrls('sepolia')[0]).toBe(DEFAULT_RPC_URLS.sepolia);
      getRpcUrls('sepolia');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/Ignoring SEPOLIA_RPC_URL: .*https/);
      expect(writes[0]).not.toContain('KEY');
    } finally {
      spy.mockRestore();
      delete process.env.SEPOLIA_RPC_URL;
    }
  });
});

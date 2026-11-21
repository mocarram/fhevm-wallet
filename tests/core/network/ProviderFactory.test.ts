import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { BrowserProvider, FetchRequest, Network } from 'ethers';
import {
  abortableGetUrl,
  nextRedirect,
  withCredentialsAsHeader,
} from '../../../src/core/network/abortableGetUrl.js';
import {
  assertRpcChain,
  describeProbeFailure,
  probeRpc,
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

  /** A server that answers every request with a 307 to `target`. */
  async function redirectTo(target: string) {
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
    return {
      url: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`,
      hops: () => hops,
    };
  }

  it('follows a 307 inside the transport, keeping the method and body', async () => {
    const target = await startNode('redirected', {});
    const from = await redirectTo(target);
    const req = new FetchRequest(from.url);
    req.timeout = 2_000;
    req.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    req.setHeader('content-type', 'application/json');
    const raw = await abortableGetUrl(req);
    expect(raw.statusCode).toBe(200); // ethers never sees the redirect
    expect(calls.redirected).toEqual(['eth_chainId']);

    const provider = new FailoverJsonRpcProvider([from.url], sepolia, 2_000);
    expect(await provider.getBlockNumber()).toBe(16);
    expect(from.hops()).toBeGreaterThanOrEqual(3);
    provider.destroy();
  });

  it('a redirect to an always-429 server still fails fast (3 tries, not 12)', async () => {
    const limited = await startNode('limited-after-redirect', { status: 429 });
    const from = await redirectTo(limited);
    const provider = new FailoverJsonRpcProvider([from.url], sepolia, 15_000);
    const started = Date.now();
    await expect(provider.getBlockNumber()).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(calls['limited-after-redirect'].length).toBeLessThanOrEqual(3);
    provider.destroy();
  });

  it('a redirect to a server that never answers ends at the request timeout', async () => {
    const { createServer: createTcp } = await import('net');
    const opened: import('net').Socket[] = [];
    const stall = createTcp((sock) => {
      opened.push(sock);
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', () => r()));
    const from = await redirectTo(`http://127.0.0.1:${(stall.address() as AddressInfo).port}`);
    const provider = new FailoverJsonRpcProvider([from.url], sepolia, 1_500);
    const started = Date.now();
    // Our transport's own timer (not only ethers' deadline) ends it: TIMEOUT, on time.
    await expect(provider.getBlockNumber()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(opened.length).toBeGreaterThan(0); // the redirect was followed
    provider.destroy();
    opened.forEach((x) => x.destroy());
    stall.close();
  });

  it('refuses redirects from https to http and to other protocols', () => {
    expect(() => nextRedirect('https://a.example/x', 'http://b.example/')).toThrow(
      /unsupported redirect/,
    );
    expect(() => nextRedirect('http://a.example/x', 'file:///etc/passwd')).toThrow(
      /unsupported redirect/,
    );
    expect(nextRedirect('http://a.example/x', 'https://b.example/y')).toBe('https://b.example/y');
    expect(nextRedirect('https://a.example/x/y', '/z')).toBe('https://a.example/z');
  });

  it('sends user:password@ from the URL as a Basic Authorization header', async () => {
    let seen: string | undefined;
    let path: string | undefined;
    const node = createServer((req, res) => {
      seen = req.headers.authorization;
      path = req.url;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const m = JSON.parse(body) as { id: number };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: '0xaa36a7' }));
      });
    });
    await new Promise<void>((r) => node.listen(0, '127.0.0.1', () => r()));
    servers.push(node);
    const url = `http://al%40ice:p%3Ass@127.0.0.1:${(node.address() as AddressInfo).port}/rpc`;
    const probe = await probeRpc(url);
    expect(probe.chainId).toBe(11155111n);
    expect(seen).toBe(`Basic ${Buffer.from('al@ice:p:ss').toString('base64')}`);
    expect(path).toBe('/rpc');
    // An Authorization header set by the caller wins.
    expect(withCredentialsAsHeader(url, { Authorization: 'Bearer x' }).headers).toEqual({
      Authorization: 'Bearer x',
    });
  });

  it('gives up on a rate-limited (429) endpoint after a few tries, not 12', async () => {
    const url = await startNode('limited', { status: 429 });
    const provider = new FailoverJsonRpcProvider([url], sepolia, 15_000);
    const started = Date.now();
    await expect(provider.getBlockNumber()).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(calls.limited.length).toBeLessThanOrEqual(3);
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

  describe('fail-over on JSON-RPC limit replies (M2/M3)', () => {
    const LIMIT_50 = {
      code: -32001,
      message:
        'Block range too large: maximum allowed is 50 blocks on your current plan. Upgrade your subscription at https://nodies.app/pricing for larger ranges.',
    };
    const PRUNED = { code: 4444, message: 'pruned history unavailable' };
    const getLogs = (p: FailoverJsonRpcProvider) =>
      p.send('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x100', topics: [] }]);

    it('asks the next endpoint when one says its history is pruned, and stays there', async () => {
      const pruned = await startNode('pruned', { rpcErrors: { eth_getLogs: PRUNED } });
      const archive = await startNode('archive', {});
      const provider = new FailoverJsonRpcProvider([pruned, archive], sepolia, 2_000);
      expect(await getLogs(provider)).toBe('0x10');
      expect(provider.currentUrl).toBe(archive);
      await getLogs(provider);
      expect(calls.pruned.filter((m) => m === 'eth_getLogs')).toHaveLength(1);
      provider.destroy();
    });

    it('reports the block-range cap when every endpoint refuses, not the last error', async () => {
      const capped = await startNode('capped', { rpcErrors: { eth_getLogs: LIMIT_50 } });
      const pruned = await startNode('pruned2', { rpcErrors: { eth_getLogs: PRUNED } });
      const provider = new FailoverJsonRpcProvider([capped, pruned], sepolia, 2_000);
      await expect(getLogs(provider)).rejects.toThrow(/maximum allowed is 50 blocks/);
      provider.destroy();
    });

    it('fails over on a JSON-RPC rate limit for reads but never re-sends a transaction', async () => {
      const limited = await startNode('limited', {
        rpcErrors: {
          eth_blockNumber: { code: -32005, message: 'rate limit exceeded' },
          eth_sendRawTransaction: { code: -32005, message: 'rate limit exceeded' },
        },
      });
      const spare = await startNode('spare', {});
      const provider = new FailoverJsonRpcProvider([limited, spare], sepolia, 2_000);
      expect(await provider.send('eth_blockNumber', [])).toBe('0x10');
      const again = new FailoverJsonRpcProvider([limited, spare], sepolia, 2_000);
      await again.send('eth_chainId', []).catch(() => undefined);
      await expect(again.send('eth_sendRawTransaction', ['0x00'])).rejects.toThrow(/rate limit/);
      expect(calls.spare).not.toContain('eth_sendRawTransaction');
      provider.destroy();
      again.destroy();
    });

    it('a revert is a real answer and is not sent to the next endpoint', async () => {
      const reverting = await startNode('reverting', {
        rpcErrors: { eth_call: { code: 3, message: 'execution reverted', data: '0x' } },
      });
      const other = await startNode('other-r', {});
      const provider = new FailoverJsonRpcProvider([reverting, other], sepolia, 2_000);
      await expect(
        provider.send('eth_call', [{ to: '0x' + '1'.repeat(40) }, 'latest']),
      ).rejects.toThrow(/revert/);
      expect(calls['other-r'] ?? []).not.toContain('eth_call');
      provider.destroy();
    });

    it('remembers an endpoint that refused with HTTP 400 for the process', async () => {
      const refusing = await startNode('refusing', { status: 400 });
      const good = await startNode('good', {});
      const first = new FailoverJsonRpcProvider([refusing, good], sepolia, 2_000);
      expect(await first.send('eth_blockNumber', [])).toBe('0x10');
      const seen = calls.refusing.length;
      first.destroy();
      // A new provider (a settings change rebuilds them) does not ask it again.
      const second = new FailoverJsonRpcProvider([refusing, good], sepolia, 2_000);
      expect(second.currentUrl).toBe(good);
      expect(await second.send('eth_blockNumber', [])).toBe('0x10');
      expect(calls.refusing.length).toBe(seen);
      second.destroy();
    });

    it("reports the preferred endpoint's failure, not a free-plan refusal from a fallback", async () => {
      const down = await startNode('down2', { status: 503 });
      const planOnly = await startNode('plan', { status: 400 });
      const provider = new FailoverJsonRpcProvider([down, planOnly], sepolia, 2_000);
      const err = (await provider.send('eth_blockNumber', []).catch((e) => e)) as {
        response?: { statusCode?: number };
      };
      expect(err.response?.statusCode).toBe(503);
      provider.destroy();
    });

    it('says the endpoint did not report its chain when eth_chainId is not hex', async () => {
      const odd = await startNode('odd', { chainIdHex: 'sepolia' });
      const provider = new FailoverJsonRpcProvider([odd], sepolia, 2_000);
      await expect(provider.send('eth_blockNumber', [])).rejects.toThrow(
        /did not report its chain/,
      );
      await expect(probeRpc(odd, 2_000)).rejects.toThrow(/No chain ID/);
      provider.destroy();
    });
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

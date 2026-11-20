import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Network } from 'ethers';
import {
  clearProviderCache,
  clearProviderForNetwork,
  FailoverJsonRpcProvider,
  getProvider,
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
    opts: { chainIdHex?: string; status?: number; failExcept?: string[] },
  ) {
    calls[name] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = [JSON.parse(body)].flat() as { id: number; method: string }[];
        calls[name].push(...msgs.map((m) => m.method));
        const failing = opts.failExcept && msgs.some((m) => !opts.failExcept!.includes(m.method));
        if (opts.status || failing) {
          res.statusCode = opts.status ?? 503;
          res.end('down');
          return;
        }
        const reply = (m: { id: number; method: string }) => ({
          jsonrpc: '2.0',
          id: m.id,
          result: m.method === 'eth_chainId' ? (opts.chainIdHex ?? '0xaa36a7') : '0x10',
        });
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

  it('getRpcUrls lists fallbacks only when no custom URL is set', async () => {
    const { getRpcUrls, DEFAULT_RPC_URLS, FALLBACK_RPC_URLS } =
      await import('../../../src/core/network/NetworkConfig.js');
    delete process.env.SEPOLIA_RPC_URL;
    expect(getRpcUrls('sepolia')).toEqual([DEFAULT_RPC_URLS.sepolia, ...FALLBACK_RPC_URLS.sepolia]);
    process.env.SEPOLIA_RPC_URL = 'https://my.node';
    expect(getRpcUrls('sepolia')).toEqual(['https://my.node']);
    delete process.env.SEPOLIA_RPC_URL;
  });
});

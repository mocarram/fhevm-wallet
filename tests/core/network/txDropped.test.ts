/**
 * The "can never be mined" proof (txDropped.ts) against the stub RPC: the nonce at a
 * settled block, then the receipt from a node that has that block (round-2 review).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStubRpc, type StubNode } from '../../helpers/stubRpc.js';
import { wipeTestDataDir } from '../../helpers/dataDir.js';

const net = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../../../src/core/network/NetworkConfig.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/network/NetworkConfig.js')>();
  return { ...orig, getRpcUrls: () => net.urls };
});

const { checkTxDropped, SETTLED_FALLBACK_BLOCKS } =
  await import('../../../src/core/network/txDropped.js');
const { clearProviderCache, resetRefusedEndpoints } =
  await import('../../../src/core/network/ProviderFactory.js');

const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const HASH = '0x' + 'ab'.repeat(32);
const HEAD = 9_000_000;
const nodes: StubNode[] = [];
async function node(opts: Parameters<typeof startStubRpc>[0]) {
  const n = await startStubRpc(opts);
  nodes.push(n);
  net.urls = [n.url];
  return n;
}

beforeEach(() => {
  wipeTestDataDir();
  clearProviderCache();
  resetRefusedEndpoints();
});
afterEach(async () => {
  clearProviderCache();
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

describe('checkTxDropped', () => {
  it('dropped: nonce taken at the finalized block, no receipt on a node that has it', async () => {
    const n = await node({ head: HEAD, finalized: HEAD - 70, nonceAt: () => 6 });
    expect(await checkTxDropped(WALLET, 5, HASH, 'sepolia')).toBe('dropped');
    // Counted at the finalized block's number, never at the tag (a split batch could
    // answer the tag from another node).
    expect(n.countTags).toEqual(['0x' + (HEAD - 70).toString(16)]);
  });

  it('a nonce taken only at latest (reorg-able) is not enough', async () => {
    await node({ head: HEAD, finalized: HEAD - 70, nonceAt: (b) => (b === HEAD ? 6 : 5) });
    expect(await checkTxDropped(WALLET, 5, HASH, 'sepolia')).toBe('nonce-open');
  });

  it('a stale receipt read (node behind the settled block) is refused, never "dropped"', async () => {
    // The finalized answer came from a node at the tip; the receipt from one 100 behind.
    await node({ head: HEAD - 100, finalized: HEAD - 64, nonceAt: () => 6 });
    expect(await checkTxDropped(WALLET, 5, HASH, 'sepolia')).toBe('behind');
  });

  it('a receipt found in the second look means mined', async () => {
    await node({
      head: HEAD,
      finalized: HEAD - 70,
      nonceAt: () => 6,
      receipts: { [HASH]: { status: 1, blockNumber: HEAD - 80 } },
    });
    expect(await checkTxDropped(WALLET, 5, HASH, 'sepolia')).toBe('mined');
  });

  it('without "finalized", counts at latest - 64', async () => {
    const n = await node({
      head: HEAD,
      finalized: 'unsupported',
      nonceAt: (b) => (b <= HEAD - SETTLED_FALLBACK_BLOCKS ? 6 : 7),
    });
    expect(await checkTxDropped(WALLET, 5, HASH, 'sepolia')).toBe('dropped');
    expect(n.countTags).toEqual(['0x' + (HEAD - SETTLED_FALLBACK_BLOCKS).toString(16)]);
    // And there, too, only the settled count decides.
    const m = await node({
      head: HEAD,
      finalized: 'unsupported',
      nonceAt: (b) => (b <= HEAD - SETTLED_FALLBACK_BLOCKS ? 5 : 6),
    });
    clearProviderCache();
    expect(await checkTxDropped(WALLET, 5, HASH, 'sepolia')).toBe('nonce-open');
    expect(m.countTags.length).toBe(1);
  });

  it('fails closed on an error entry in a batch reply', async () => {
    await node({
      head: HEAD,
      finalized: HEAD - 70,
      nonceAt: () => 6,
      rpcErrors: { eth_getTransactionReceipt: { code: -32000, message: 'internal error' } },
    });
    await expect(checkTxDropped(WALLET, 5, HASH, 'sepolia')).rejects.toBeDefined();
  });

  it('fails closed when the count at the finalized block errors (node without it)', async () => {
    await node({
      head: HEAD,
      finalized: HEAD - 70,
      rpcErrors: { eth_getTransactionCount: { code: -32000, message: 'header not found' } },
    });
    await expect(checkTxDropped(WALLET, 5, HASH, 'sepolia')).rejects.toBeDefined();
  });

  it('fails closed on one error object without ids for a whole batch', async () => {
    await node({
      head: HEAD,
      finalized: HEAD - 70,
      nonceAt: () => 6,
      batchErrorFor: 'eth_getTransactionReceipt',
    });
    await expect(checkTxDropped(WALLET, 5, HASH, 'sepolia')).rejects.toBeDefined();
  });

  it('a fail-over mid-check to a node behind the settled block is never "dropped"', async () => {
    // Node 1 answers the settled nonce (chain id, finalized block, count), then goes away.
    const first = await startStubRpc({
      head: HEAD,
      finalized: HEAD - 64,
      nonceAt: () => 6,
      httpErrorAfter: 3,
    });
    const second = await startStubRpc({ head: HEAD - 100, nonceAt: () => 5 });
    nodes.push(first, second);
    net.urls = [first.url, second.url];
    const r = await checkTxDropped(WALLET, 5, HASH, 'sepolia').catch(() => 'error');
    expect(r).not.toBe('dropped');
    expect(second.calls).toContain('eth_getTransactionReceipt');
  });
});

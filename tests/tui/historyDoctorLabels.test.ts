/**
 * Labels that read badly in real screenshots (Sepolia, 2.0.0): History named the zero
 * address as the other side of a wrap or unwrap, and the Doctor RPC row printed "· ·"
 * and the full URL, which did not fit 104 columns.
 */

import { describe, expect, it } from 'vitest';
import { toHistoryRow } from '../../src/tui/flows/history.js';
import { rpcHost } from '../../src/core/doctor.js';
import type { Transaction } from '../../src/storage/TransactionStore.js';
import { Harness } from './harness.js';

const WALLET = '0x12ac1188C78Ec055f09dBb5a674b801A98047a8f';
const TOKEN = '0x85E3A388B8b8939Ab4f41e0B1eF70A998b23F938';
const ZERO = '0x0000000000000000000000000000000000000000';

function tx(over: Partial<Transaction>): Transaction {
  return {
    txHash: '0x' + 'ab'.repeat(32),
    type: 'transfer',
    tokenAddress: TOKEN,
    tokenSymbol: 'cZAMA',
    from: WALLET,
    to: ZERO,
    amount: '0.01',
    network: 'sepolia',
    blockNumber: 1,
    timestamp: '2026-11-21T19:59:00Z',
    ...over,
  };
}

describe('History: wraps and unwraps name the ERC-20, not the zero address', () => {
  const wrappers = { [TOKEN.toLowerCase()]: { underlying: { symbol: 'ZAMA' } } };
  const names = new Map<string, string>();

  it('a mint of a wrapper token is "from ZAMA", a burn is "to ZAMA"', () => {
    const mint = toHistoryRow(
      tx({ type: 'mint', from: ZERO, to: WALLET }),
      WALLET,
      names,
      [],
      wrappers,
    );
    const burn = toHistoryRow(
      tx({ type: 'burn', from: WALLET, to: ZERO }),
      WALLET,
      names,
      [],
      wrappers,
    );
    expect(mint.counterparty).toBe('from ZAMA');
    expect(burn.counterparty).toBe('to ZAMA');
  });

  it('a mint or burn of a token that is not a known wrapper shows no party, not 0x0000…0000', () => {
    const row = toHistoryRow(tx({ type: 'burn' }), WALLET, names, []);
    expect(row.counterparty).toBe('—');
    expect(row.counterparty).not.toMatch(/0x0000/);
  });

  it('ordinary transfers keep the contact name or short address', () => {
    const bob = '0x57811Bf05D1C6D79f5e8EFC2560681985E0534df';
    const named = toHistoryRow(
      tx({ to: bob }),
      WALLET,
      new Map([[bob.toLowerCase(), 'bob']]),
      [],
      wrappers,
    );
    expect(named.counterparty).toBe('bob');
  });
});

describe('Doctor: RPC rows', () => {
  it('show the host of an http(s) URL and leave other URLs whole', () => {
    expect(rpcHost('https://ethereum-sepolia-rpc.publicnode.com')).toBe(
      'ethereum-sepolia-rpc.publicnode.com',
    );
    expect(rpcHost('https://eth-sepolia.example.com:8545/v2/••••')).toBe(
      'eth-sepolia.example.com:8545',
    );
    expect(rpcHost('mock://rpc')).toBe('mock://rpc');
    expect(rpcHost('not a url')).toBe('not a url');
  });

  it('print one separator between the row and its details, never "· ·"', async () => {
    const h = new Harness();
    await h.keys('d');
    expect(h.text()).toMatch(/RPC mock:\/\/rpc · chain 11155111 · block \d+ · \d+ ms/);
    expect(h.text()).not.toMatch(/· ·/);
  });
});

describe('History screen wiring', () => {
  it('names the ERC-20 of a cached wrapper on a real History screen, even when the check is old', async () => {
    const { setCachedWrapper } = await import('../../src/storage/WrapperCache.js');
    const { upsertTransaction } = await import('../../src/storage/TransactionStore.js');
    const h = new Harness();
    const t = h.s.data.tokens[0];
    setCachedWrapper('sepolia', t.address, {
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      rate: 1n,
      underlying: {
        address: '0x' + '11'.repeat(20),
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
      },
      hasRequester: true,
    });
    upsertTransaction(
      tx({
        txHash: '0x' + 'cd'.repeat(32),
        type: 'mint',
        tokenAddress: t.address,
        tokenSymbol: t.symbol,
        from: ZERO,
        to: h.s.wallet!.address,
        amount: '5',
      }),
    );
    // A week and a day later the cache entry is stale for signing, not for this label.
    h.now += 8 * 24 * 3600_000;
    const realNow = Date.now;
    Date.now = () => realNow() + 8 * 24 * 3600_000;
    try {
      await h.keys('h');
      expect(h.text(104)).toMatch(/mint\s+\+5\.00\s+cUSDC\s+from USDC/);
    } finally {
      Date.now = realNow;
    }
  });
});

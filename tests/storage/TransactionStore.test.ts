import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTransactions,
  getEncryptedTransactions,
  getSyncCursor,
  saveSyncCursor,
  getTransactionByHash,
  listTransactions,
  recordLocalTransaction,
  updateTransactionAmount,
  upsertTransaction,
  upsertTransactions,
} from '../../src/storage/TransactionStore.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const WALLET = '0x52908400098527886E0F7030069857D2E4169EE7';
const TOKEN = '0xde709f2102306220921060314715629080e2fb77';
const COUNTERPARTY = '0x000000000000000000000000000000000000dEaD';

beforeEach(() => {
  wipeTestDataDir();
});

describe('TransactionStore sync state', () => {
  it('returns null when no cursor exists', () => {
    expect(getSyncCursor(WALLET, 'sepolia', TOKEN)).toBeNull();
  });

  it('keeps one cursor per network and source (token or eth)', () => {
    saveSyncCursor(WALLET, 'sepolia', TOKEN, { firstBlock: 10, lastBlock: 100 });
    saveSyncCursor(WALLET, 'mainnet', TOKEN, { firstBlock: 5, lastBlock: 50 });
    saveSyncCursor(WALLET, 'sepolia', 'eth', { firstBlock: 1, lastBlock: 7 });
    expect(getSyncCursor(WALLET, 'sepolia', TOKEN.toUpperCase().replace('0X', '0x'))).toEqual({
      firstBlock: 10,
      lastBlock: 100,
    });
    expect(getSyncCursor(WALLET, 'mainnet', TOKEN)?.lastBlock).toBe(50);
    expect(getSyncCursor(WALLET, 'sepolia', 'eth')?.lastBlock).toBe(7);
    expect(getSyncCursor(WALLET, 'sepolia', COUNTERPARTY)).toBeNull();
  });
});

describe('TransactionStore CRUD', () => {
  const baseTx = {
    txHash: '0xabc',
    type: 'transfer' as const,
    tokenAddress: TOKEN,
    tokenSymbol: 'cTKN',
    from: WALLET,
    to: COUNTERPARTY,
    amount: '100',
    network: 'sepolia' as const,
    blockNumber: 10,
    timestamp: '2025-01-01T00:00:00.000Z',
  };

  it('upsertTransaction inserts then preserves prior amount on null update', () => {
    upsertTransaction(baseTx);
    upsertTransaction({ ...baseTx, amount: null });
    expect(getTransactionByHash('0xabc')?.amount).toBe('100');
  });

  it('keeps transfers of one transaction apart by log index (M9)', () => {
    const synced = { ...baseTx, amount: null, amountHandle: '0x01' };
    expect(
      upsertTransactions([
        { ...synced, logIndex: 1 },
        { ...synced, logIndex: 4, amountHandle: '0x04' },
      ]),
    ).toBe(2);
    expect(listTransactions({ walletAddress: WALLET, network: 'sepolia' })).toHaveLength(2);
    expect(upsertTransactions([{ ...synced, logIndex: 4, amountHandle: '0x04' }])).toBe(0);
  });

  it('a synced transfer merges into the send recorded locally before it', () => {
    recordLocalTransaction({ ...baseTx, amount: '5' });
    upsertTransactions([{ ...baseTx, amount: null, amountHandle: '0x01', logIndex: 2 }]);
    const rows = listTransactions({ walletAddress: WALLET, network: 'sepolia' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: '5', amountHandle: '0x01', logIndex: 2 });
  });

  it('upsertTransactions batch dedupes by hash', () => {
    upsertTransactions([baseTx, { ...baseTx, blockNumber: 11 }]);
    expect(listTransactions({ walletAddress: WALLET, network: 'sepolia' })).toHaveLength(1);
    expect(getTransactionByHash('0xabc')?.blockNumber).toBe(11);
  });

  it('listTransactions sorts descending by block and respects limit', () => {
    upsertTransactions([
      { ...baseTx, txHash: '0x01', blockNumber: 1 },
      { ...baseTx, txHash: '0x03', blockNumber: 3 },
      { ...baseTx, txHash: '0x02', blockNumber: 2 },
    ]);
    const list = listTransactions({ walletAddress: WALLET, network: 'sepolia', limit: 2 });
    expect(list.map((t) => t.txHash)).toEqual(['0x03', '0x02']);
  });

  it('getEncryptedTransactions returns only those with null amount', () => {
    upsertTransaction(baseTx);
    upsertTransaction({ ...baseTx, txHash: '0xenc', amount: null });
    const enc = getEncryptedTransactions({ walletAddress: WALLET, network: 'sepolia' });
    expect(enc.map((t) => t.txHash)).toEqual(['0xenc']);
  });

  it('updateTransactionAmount sets a previously-encrypted amount', () => {
    upsertTransaction({ ...baseTx, amount: null });
    expect(updateTransactionAmount('0xabc', '42')).toBe(true);
    expect(getTransactionByHash('0xabc')?.amount).toBe('42');
    expect(updateTransactionAmount('0xmissing', '1')).toBe(false);
  });

  it('recordLocalTransaction adds with timestamp', () => {
    const tx = recordLocalTransaction({
      txHash: '0xlocal',
      tokenAddress: TOKEN,
      tokenSymbol: 'cTKN',
      from: WALLET,
      to: COUNTERPARTY,
      amount: '5',
      network: 'sepolia',
      blockNumber: 100,
    });
    expect(tx.type).toBe('transfer');
    expect(tx.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(getTransactionByHash('0xlocal')).not.toBeNull();
  });

  it('clearTransactions resets the store', () => {
    upsertTransaction(baseTx);
    clearTransactions();
    expect(listTransactions({ walletAddress: WALLET, network: 'sepolia' })).toEqual([]);
  });
});

describe('listTransactions order (V2)', () => {
  it('lists unconfirmed entries (block 0) first, so a limit never cuts them', () => {
    for (let i = 1; i <= 12; i++) {
      upsertTransaction({
        txHash: '0x' + i.toString(16).padStart(64, '0'),
        type: 'transfer',
        tokenAddress: TOKEN,
        tokenSymbol: 'cT',
        from: COUNTERPARTY,
        to: WALLET,
        amount: null,
        network: 'sepolia',
        blockNumber: 1000 + i,
        logIndex: 0,
        timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      });
    }
    const pending = recordLocalTransaction({
      txHash: '0x' + 'ff'.repeat(32),
      tokenAddress: TOKEN,
      tokenSymbol: 'cT',
      from: WALLET,
      to: COUNTERPARTY,
      amount: '1',
      network: 'sepolia',
      blockNumber: 0,
    });
    const ten = listTransactions({ walletAddress: WALLET, network: 'sepolia', limit: 10 });
    expect(ten).toHaveLength(10);
    expect(ten[0].txHash).toBe(pending.txHash);
    expect(ten.slice(1).map((t) => t.blockNumber)).toEqual([
      1012, 1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004,
    ]);
  });
});

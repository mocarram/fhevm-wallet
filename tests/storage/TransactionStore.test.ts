import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTransactions,
  getEncryptedTransactions,
  getLastSyncedBlock,
  getTransactionByHash,
  listTransactions,
  recordLocalTransaction,
  updateSyncState,
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
  it('returns 0 when no sync state exists', () => {
    expect(getLastSyncedBlock(WALLET, 'sepolia')).toBe(0);
  });

  it('persists per-network sync state independently', () => {
    updateSyncState(WALLET, 'sepolia', 100);
    updateSyncState(WALLET, 'mainnet', 50);
    expect(getLastSyncedBlock(WALLET, 'sepolia')).toBe(100);
    expect(getLastSyncedBlock(WALLET, 'mainnet')).toBe(50);
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

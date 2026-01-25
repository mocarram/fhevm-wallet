/**
 * Transaction history storage with blockchain sync
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { NetworkName } from '../core/network/NetworkConfig.js';
import { DATA_DIR, ensureDataDir } from './paths.js';

export const TransactionType = z.enum(['transfer', 'mint', 'burn', 'eth']);

const TransactionSchema = z.object({
  txHash: z.string(),
  type: TransactionType.default('transfer'),
  tokenAddress: z.string(),
  tokenSymbol: z.string(),
  from: z.string(),
  to: z.string(),
  amount: z.string().nullable(), // null = encrypted (needs decryption)
  network: z.enum(['mainnet', 'sepolia']),
  blockNumber: z.number(),
  timestamp: z.string(),
});

const SyncStateSchema = z.record(
  z.string(),
  z.object({
    lastBlock: z.number(),
    lastSyncedAt: z.string(),
  }),
);

const TransactionStoreSchema = z.object({
  transactions: z.array(TransactionSchema),
  syncState: SyncStateSchema,
});

export type Transaction = z.infer<typeof TransactionSchema>;
type TransactionStoreData = z.infer<typeof TransactionStoreSchema>;

const TRANSACTIONS_FILE = join(DATA_DIR, 'transactions.json');

/**
 * Load transaction store from file
 */
function loadStore(): TransactionStoreData {
  ensureDataDir();

  if (!existsSync(TRANSACTIONS_FILE)) {
    return { transactions: [], syncState: {} };
  }

  try {
    const data = readFileSync(TRANSACTIONS_FILE, 'utf-8');
    return TransactionStoreSchema.parse(JSON.parse(data));
  } catch {
    return { transactions: [], syncState: {} };
  }
}

/**
 * Save transaction store to file
 */
function saveStore(store: TransactionStoreData): void {
  ensureDataDir();
  writeFileSync(TRANSACTIONS_FILE, JSON.stringify(store, null, 2));
}

/**
 * Get sync state key
 */
function getSyncKey(walletAddress: string, network: NetworkName): string {
  return `${walletAddress.toLowerCase()}:${network}`;
}

/**
 * Get last synced block for a wallet/network
 */
export function getLastSyncedBlock(walletAddress: string, network: NetworkName): number {
  const store = loadStore();
  const key = getSyncKey(walletAddress, network);
  return store.syncState[key]?.lastBlock ?? 0;
}

/**
 * Update last synced block
 */
export function updateSyncState(
  walletAddress: string,
  network: NetworkName,
  blockNumber: number,
): void {
  const store = loadStore();
  const key = getSyncKey(walletAddress, network);
  store.syncState[key] = {
    lastBlock: blockNumber,
    lastSyncedAt: new Date().toISOString(),
  };
  saveStore(store);
}

/**
 * Upsert a transaction (insert or update by txHash)
 */
export function upsertTransaction(tx: Transaction): void {
  const store = loadStore();

  const existingIndex = store.transactions.findIndex(
    (t) => t.txHash.toLowerCase() === tx.txHash.toLowerCase(),
  );

  if (existingIndex >= 0) {
    // Merge: keep existing amount if new one is null
    const existing = store.transactions[existingIndex];
    store.transactions[existingIndex] = {
      ...tx,
      amount: tx.amount ?? existing.amount,
    };
  } else {
    store.transactions.push(tx);
  }

  saveStore(store);
}

/**
 * Batch upsert transactions
 */
export function upsertTransactions(txs: Transaction[]): void {
  const store = loadStore();

  for (const tx of txs) {
    const existingIndex = store.transactions.findIndex(
      (t) => t.txHash.toLowerCase() === tx.txHash.toLowerCase(),
    );

    if (existingIndex >= 0) {
      const existing = store.transactions[existingIndex];
      store.transactions[existingIndex] = {
        ...tx,
        amount: tx.amount ?? existing.amount,
      };
    } else {
      store.transactions.push(tx);
    }
  }

  saveStore(store);
}

/**
 * Update transaction amount (after decryption)
 */
export function updateTransactionAmount(txHash: string, amount: string): boolean {
  const store = loadStore();

  const tx = store.transactions.find((t) => t.txHash.toLowerCase() === txHash.toLowerCase());

  if (!tx) {
    return false;
  }

  tx.amount = amount;
  saveStore(store);
  return true;
}

/**
 * Get transaction by hash
 */
export function getTransactionByHash(txHash: string): Transaction | null {
  const store = loadStore();
  return store.transactions.find((t) => t.txHash.toLowerCase() === txHash.toLowerCase()) ?? null;
}

/**
 * List transactions for a wallet
 */
export function listTransactions(options: {
  walletAddress: string;
  network: NetworkName;
  limit?: number;
}): Transaction[] {
  const store = loadStore();
  const addr = options.walletAddress.toLowerCase();

  let transactions = store.transactions.filter(
    (t) =>
      t.network === options.network &&
      (t.from.toLowerCase() === addr || t.to.toLowerCase() === addr),
  );

  // Sort by block number descending (most recent first)
  transactions = transactions.sort((a, b) => b.blockNumber - a.blockNumber);

  const limit = options.limit ?? 10;
  return transactions.slice(0, limit);
}

/**
 * Get transactions with encrypted amounts (for decrypt option)
 */
export function getEncryptedTransactions(options: {
  walletAddress: string;
  network: NetworkName;
}): Transaction[] {
  const store = loadStore();
  const addr = options.walletAddress.toLowerCase();

  return store.transactions.filter(
    (t) =>
      t.network === options.network &&
      (t.from.toLowerCase() === addr || t.to.toLowerCase() === addr) &&
      t.amount === null,
  );
}

/**
 * Record a local transaction (from CLI send)
 */
export function recordLocalTransaction(params: {
  txHash: string;
  tokenAddress: string;
  tokenSymbol: string;
  from: string;
  to: string;
  amount: string;
  network: NetworkName;
  blockNumber: number;
  type?: 'transfer' | 'mint' | 'burn' | 'eth';
}): Transaction {
  const tx: Transaction = {
    ...params,
    type: params.type || 'transfer',
    timestamp: new Date().toISOString(),
  };

  upsertTransaction(tx);
  return tx;
}

/**
 * Clear all transactions (for testing)
 */
export function clearTransactions(): void {
  saveStore({ transactions: [], syncState: {} });
}

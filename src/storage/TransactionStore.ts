/**
 * Transaction history storage with blockchain sync
 */

import { existsSync, readFileSync } from 'fs';
import { writeSecureFile } from './secureFs.js';
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
  /**
   * Handle of the encrypted amount (ConfidentialTransfer topic 3), for "decrypt amounts"
   * and disclosure. Never the plaintext: decrypted amounts live in AmountCache.
   */
  amountHandle: z.string().optional(),
  network: z.enum(['mainnet', 'sepolia']),
  blockNumber: z.number(),
  /**
   * Position of the ConfidentialTransfer log in its block. One transaction can emit
   * several (a batch, a router), so synced transfers are keyed by hash + log index.
   * Absent for ETH transfers and for sends recorded locally before the sync saw them.
   */
  logIndex: z.number().int().nonnegative().optional(),
  timestamp: z.string(),
});

const SyncStateSchema = z.record(
  z.string(),
  z.object({
    /** Last block whose transfers are all stored (inclusive). */
    lastBlock: z.number(),
    /**
     * First block the stored history covers (inclusive). Older entries have none: they
     * were written by a version that started at block 0 or at an unknown block.
     */
    firstBlock: z.number().optional(),
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
  writeSecureFile(TRANSACTIONS_FILE, JSON.stringify(store, null, 2));
}

/** What one sync cursor covers: blocks `firstBlock`..`lastBlock`, both inclusive. */
export interface SyncCursor {
  firstBlock: number;
  lastBlock: number;
}

/**
 * Cursor key: one per wallet, network and source (a token address, or `eth` for plain
 * ETH transfers). Per token, so a token added later still gets its earlier history.
 * The `wallet:network` keys of earlier versions are ignored: they covered every token at
 * once and so could not say which tokens were complete.
 */
function getSyncKey(walletAddress: string, network: NetworkName, source: string): string {
  return `${walletAddress.toLowerCase()}:${network}:${source.toLowerCase()}`;
}

/** The saved cursor for one wallet, network and source (token address or `eth`), or null. */
export function getSyncCursor(
  walletAddress: string,
  network: NetworkName,
  source: string,
): SyncCursor | null {
  const entry = loadStore().syncState[getSyncKey(walletAddress, network, source)];
  if (!entry || entry.firstBlock === undefined) return null;
  return { firstBlock: entry.firstBlock, lastBlock: entry.lastBlock };
}

/** Save the cursor for one wallet, network and source. */
export function saveSyncCursor(
  walletAddress: string,
  network: NetworkName,
  source: string,
  cursor: SyncCursor,
): void {
  const store = loadStore();
  store.syncState[getSyncKey(walletAddress, network, source)] = {
    ...cursor,
    lastSyncedAt: new Date().toISOString(),
  };
  saveStore(store);
}

/** Forget every cursor of a wallet on a network, so the next sync starts over. */
export function clearSyncCursors(walletAddress: string, network: NetworkName): void {
  const store = loadStore();
  const prefix = `${walletAddress.toLowerCase()}:${network}`;
  for (const key of Object.keys(store.syncState)) {
    if (key === prefix || key.startsWith(prefix + ':')) delete store.syncState[key];
  }
  saveStore(store);
}

/**
 * Index of the stored entry `tx` updates, or -1. A transfer with a log index matches the
 * same hash and log index; failing that, an entry of the same hash and token without one
 * (a send recorded locally before the sync saw it, or an entry from an older version).
 * An entry without a log index matches the same hash and kind (ETH or token).
 */
function findEntry(list: Transaction[], tx: Transaction): number {
  const hash = tx.txHash.toLowerCase();
  const sameHash = (t: Transaction) => t.txHash.toLowerCase() === hash;
  const isEth = (t: Transaction) => t.type === 'eth';
  if (tx.logIndex !== undefined) {
    const exact = list.findIndex((t) => sameHash(t) && t.logIndex === tx.logIndex);
    if (exact >= 0) return exact;
    return list.findIndex(
      (t) =>
        sameHash(t) &&
        t.logIndex === undefined &&
        !isEth(t) &&
        t.tokenAddress.toLowerCase() === tx.tokenAddress.toLowerCase(),
    );
  }
  return list.findIndex((t) => sameHash(t) && isEth(t) === isEth(tx));
}

/** Insert `tx` or merge it into the entry it updates, keeping known amounts. True if new. */
function upsertInto(list: Transaction[], tx: Transaction): boolean {
  const i = findEntry(list, tx);
  if (i < 0) {
    list.push(tx);
    return true;
  }
  const existing = list[i];
  const logIndex = tx.logIndex ?? existing.logIndex;
  list[i] = {
    ...tx,
    amount: tx.amount ?? existing.amount,
    amountHandle: tx.amountHandle ?? existing.amountHandle,
    ...(logIndex !== undefined ? { logIndex } : {}),
  };
  return false;
}

/** Insert or update one transaction (see `findEntry` for what counts as the same). */
export function upsertTransaction(tx: Transaction): void {
  const store = loadStore();
  upsertInto(store.transactions, tx);
  saveStore(store);
}

/** Insert or update several transactions in one write. Returns how many were new. */
export function upsertTransactions(txs: Transaction[]): number {
  const store = loadStore();
  let added = 0;
  for (const tx of txs) if (upsertInto(store.transactions, tx)) added++;
  saveStore(store);
  return added;
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
 * True when `handle` is the amount handle of a stored transfer from or to `walletAddress`
 * on `network` (and that transfer's token is `tokenAddress`).
 */
export function isTransferAmountHandle(options: {
  walletAddress: string;
  network: NetworkName;
  tokenAddress: string;
  handle: string;
}): boolean {
  const h = normaliseHex32(options.handle);
  const token = options.tokenAddress.toLowerCase();
  return listTransactions({ ...options, limit: Number.MAX_SAFE_INTEGER }).some(
    (t) =>
      t.amountHandle !== undefined &&
      t.tokenAddress.toLowerCase() === token &&
      normaliseHex32(t.amountHandle) === h,
  );
}

/** Lower-case 0x + 64 hex digits, whatever the padding or case of `hex`. */
function normaliseHex32(hex: string): string {
  return '0x' + hex.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
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

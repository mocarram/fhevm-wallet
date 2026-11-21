/**
 * Pull a wallet's token and ETH transfers from the chain into the local transaction store.
 * Shared by `fhew history` and the real TUI backend.
 */

import { getProvider } from '../network/ProviderFactory.js';
import { NetworkName } from '../network/NetworkConfig.js';
import { getWalletTransactions, getWalletTransactionsViaRPC } from './TokenService.js';
import type { TokenEntry } from './TokenRegistry.js';
import {
  getLastSyncedBlock,
  updateSyncState,
  upsertTransactions,
  Transaction,
} from '../../storage/TransactionStore.js';

/** Where transfers are read from: the Etherscan API (fast, needs a key) or raw RPC logs. */
export type SyncMethod = 'etherscan' | 'rpc';

/**
 * Fetch transfers since the last synced block and store them. Returns how many were new
 * or updated. Throws on RPC / API failures; the caller decides how to recover.
 */
export async function syncTransactions(
  walletAddress: string,
  network: NetworkName,
  tokens: TokenEntry[],
  method: SyncMethod = 'etherscan',
): Promise<number> {
  const lastBlock = getLastSyncedBlock(walletAddress, network);
  const provider = getProvider(network);
  const currentBlock = await provider.getBlockNumber();

  // Get token addresses and create a lookup map
  const tokenAddresses = tokens.map((t) => t.address);
  const tokenMap = new Map(tokens.map((t) => [t.address.toLowerCase(), { symbol: t.symbol }]));

  // Fetch transactions using the specified method
  const walletTxs =
    method === 'etherscan'
      ? await getWalletTransactions(
          walletAddress,
          tokenAddresses,
          tokenMap,
          network,
          lastBlock > 0 ? lastBlock + 1 : 0,
        )
      : await getWalletTransactionsViaRPC(
          walletAddress,
          tokenAddresses,
          tokenMap,
          network,
          lastBlock > 0 ? lastBlock + 1 : 0,
        );

  // Convert to our transaction format
  const transactions: Transaction[] = walletTxs.map((tx) => ({
    txHash: tx.txHash,
    type: tx.type,
    tokenAddress: tx.tokenAddress,
    tokenSymbol: tx.tokenSymbol,
    from: tx.from,
    to: tx.to,
    amount: tx.amount, // ETH transfers have amount, token transfers are null
    ...(tx.amountHandle ? { amountHandle: tx.amountHandle } : {}),
    network,
    blockNumber: tx.blockNumber,
    timestamp: new Date(tx.timestamp * 1000).toISOString(),
  }));

  if (transactions.length > 0) {
    upsertTransactions(transactions);
  }

  // Update sync state
  updateSyncState(walletAddress, network, currentBlock);

  return transactions.length;
}

/**
 * `fhew history --json`: sync, then print the saved transfers as one JSON document.
 * No recovery prompts (those are for people at a terminal): a failed sync is reported in
 * `sync.error`, the saved history is still printed, and the exit code is 1, like the
 * text command.
 */

import { listTransactions } from '../../storage/TransactionStore.js';
import { listTokens } from '../../core/token/TokenRegistry.js';
import { syncTransactions } from '../../core/token/historySync.js';
import { getDefaultNetwork } from '../../storage/ConfigStore.js';
import { clearProviderForNetwork } from '../../core/network/ProviderFactory.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import { getNameByAddress } from '../../storage/AddressBook.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';
import { failJson, jsonErrorOf, printJson, printJsonError } from '../utils/json.js';

/** Options shared with `fhew history`. */
export interface HistoryJsonOptions {
  network?: string;
  address?: string;
  limit?: string;
}

/** Print `{address, network, sync, transactions[]}`. */
export async function historyJson(options: HistoryJsonOptions): Promise<void> {
  try {
    let network: NetworkName = getDefaultNetwork();
    if (options.network) {
      if (!isValidNetwork(options.network)) {
        return printJsonError('INVALID_NETWORK', 'Invalid network. Use "sepolia" or "mainnet"');
      }
      network = options.network;
    }
    if (!options.address || !isValidAddress(options.address)) {
      return printJsonError('INVALID_ADDRESS', 'Pass a valid wallet address with --address');
    }
    const limit = options.limit === undefined ? 10 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return printJsonError('INVALID_LIMIT', '--limit must be a whole number from 1 to 1000');
    }
    const address = options.address;
    const tokens = listTokens(network);
    if (tokens.length === 0) {
      return printJsonError(
        'NO_TOKENS',
        `No tokens tracked on ${network}. Add one with: fhevm-wallet token add <address>`,
      );
    }

    const method = process.env.ETHERSCAN_API_KEY ? 'etherscan' : 'rpc';
    let sync: { method: string; newCount?: number; error?: { code: string; message: string } };
    try {
      sync = { method, newCount: await syncTransactions(address, network, tokens, method) };
    } catch (err) {
      clearProviderForNetwork(network);
      sync = { method, error: jsonErrorOf(err, 'Sync failed') };
      process.exitCode = 1;
    }

    const me = address.toLowerCase();
    const transactions = listTransactions({ walletAddress: address, network, limit }).map((t) => {
      const outgoing = t.from.toLowerCase() === me;
      const counterparty = outgoing ? t.to : t.from;
      return {
        txHash: t.txHash,
        type: t.type ?? 'transfer',
        direction: outgoing ? 'out' : 'in',
        tokenAddress: t.tokenAddress,
        tokenSymbol: t.tokenSymbol,
        from: t.from,
        to: t.to,
        counterpartyName: getNameByAddress(counterparty) ?? null,
        // null: the amount is encrypted on-chain and was not decrypted locally.
        amount: t.amount,
        blockNumber: t.blockNumber,
        timestamp: t.timestamp,
      };
    });
    printJson({ address, network, sync, transactions });
  } catch (err) {
    failJson(err, 'Failed to load history');
  }
}

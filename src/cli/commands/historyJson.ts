/**
 * `fhew history --json`: sync, then print the saved transfers as one JSON document.
 * No recovery prompts (those are for people at a terminal): a failed sync is reported in
 * `sync.error`, the saved history is still printed, and the exit code is 1, like the
 * text command.
 *
 * `--decrypt` (needs `--password-stdin`) decrypts the shown confidential amounts with one
 * signature first and reports the run in `decrypt`; amounts decrypted earlier (here or in
 * the TUI) are filled in from the owner-only cache either way.
 */

import { getWalletAddress, hasWallet } from '../../core/wallet/index.js';
import { listTransactions } from '../../storage/TransactionStore.js';
import { listTokens } from '../../core/token/TokenRegistry.js';
import { syncTransactions } from '../../core/token/historySync.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { clearProviderForNetwork } from '../../core/network/ProviderFactory.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import { getNameByAddress } from '../../storage/AddressBook.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';
import { failJson, jsonErrorOf, printJson, printJsonError } from '../utils/json.js';
import { createBackend } from '../../core/backend/select.js';
import { normaliseHandle } from '../../core/fhe/DecryptSession.js';
import {
  amountsToDecrypt,
  decryptHistoryAmounts,
  knownAmount,
} from '../../core/token/historyAmounts.js';
import { formatTokenAmount } from '../../utils/formatting.js';
import { pickWallet, startJsonOutput, unlockWallet } from '../utils/txFlow.js';

/** Options shared with `fhew history`. */
export interface HistoryJsonOptions {
  network?: string;
  address?: string;
  limit?: string;
  decrypt?: boolean;
  wallet?: string;
  passwordStdin?: boolean;
}

/** Print `{address, network, sync, transactions[]}`. */
export async function historyJson(options: HistoryJsonOptions): Promise<void> {
  // pickWallet/unlockWallet print their errors as JSON and their notes on stderr.
  const restore = startJsonOutput();
  try {
    let network: NetworkName = getDefaultNetwork();
    if (options.network) {
      if (!isValidNetwork(options.network)) {
        return printJsonError('INVALID_NETWORK', 'Invalid network. Use "sepolia" or "mainnet"');
      }
      network = options.network;
    }
    // --decrypt works on a wallet: its address is the one shown.
    let decryptWallet: { name: string; address: string } | null = null;
    if (options.decrypt) {
      if (!options.passwordStdin) {
        return printJsonError(
          'PASSWORD_STDIN_REQUIRED',
          'With --json --decrypt, pass the password on standard input with --password-stdin.',
        );
      }
      decryptWallet = pickWallet(options.wallet);
      if (!decryptWallet) return;
      if (
        options.address &&
        options.address.toLowerCase() !== decryptWallet.address.toLowerCase()
      ) {
        return printJsonError(
          'INVALID_ADDRESS',
          '--address and the wallet to decrypt with differ. Drop --address.',
        );
      }
      options.address = decryptWallet.address;
    }
    options.address ??= defaultWalletAddress(options.wallet) ?? undefined;
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

    const backend = createBackend();
    const method =
      backend.kind === 'mock' ? 'mock' : process.env.ETHERSCAN_API_KEY ? 'etherscan' : 'rpc';
    let sync: { method: string; newCount?: number; error?: { code: string; message: string } };
    try {
      const newCount =
        backend.kind === 'mock'
          ? (await backend.syncHistory(address, network, tokens)).newCount
          : await syncTransactions(address, network, tokens, method as 'etherscan' | 'rpc');
      sync = { method, newCount };
    } catch (err) {
      clearProviderForNetwork(network);
      sync = { method, error: jsonErrorOf(err, 'Sync failed') };
      process.exitCode = 1;
    }

    const saved = listTransactions({ walletAddress: address, network, limit });
    let decrypt:
      | {
          decrypted: number;
          hidden: number;
          failed: number;
          error?: { code: string; message: string };
        }
      | undefined;
    if (decryptWallet) {
      decrypt = { decrypted: 0, hidden: 0, failed: 0 };
      if (amountsToDecrypt(saved, tokens).length) {
        const notReady = backend.readinessProblem(network);
        if (notReady) return printJsonError('FHE_NOT_READY', notReady);
        const signer = await unlockWallet(decryptWallet.name, network, true);
        if (!signer) return;
        // One signature for every tracked token; dropped as soon as we are done.
        const session = backend.newDecryptSession(signer, network);
        try {
          const r = await decryptHistoryAmounts(backend, session, saved, tokens);
          decrypt = { decrypted: r.decrypted, hidden: r.hidden, failed: r.failed };
          if (r.failed) {
            decrypt.error = jsonErrorOf(r.error, 'Could not decrypt the amounts');
            process.exitCode = 1;
          }
        } finally {
          session.clear();
        }
      }
    }

    const me = address.toLowerCase();
    const transactions = saved.map((t) => {
      const outgoing = t.from.toLowerCase() === me;
      const counterparty = outgoing ? t.to : t.from;
      // Decrypted earlier or just now, cached by handle; never in the transaction store.
      const known = t.amount === null ? knownAmount(t) : null;
      const decimals = tokens.find(
        (k) => k.address.toLowerCase() === t.tokenAddress.toLowerCase(),
      )?.decimals;
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
        amount:
          t.amount ??
          (known && decimals !== undefined
            ? formatTokenAmount(known.value, decimals, decimals)
            : null),
        // Only for a confidential amount this wallet decrypted: base units and whether
        // it was made public on-chain.
        amountBaseUnits: known?.value,
        disclosed: known ? known.disclosed : undefined,
        amountHandle: t.amountHandle ? normaliseHandle(t.amountHandle) : undefined,
        blockNumber: t.blockNumber,
        timestamp: t.timestamp,
      };
    });
    printJson({ address, network, sync, decrypt, transactions });
  } catch (err) {
    failJson(err, 'Failed to load history');
  } finally {
    restore();
  }
}

/**
 * The address `history` shows without `--address`: the `-w` wallet, else the default
 * wallet, like the other commands. Null when there is neither (or `-w` names none).
 */
export function defaultWalletAddress(name?: string): string | null {
  const walletName = name || getDefaultWallet();
  if (!walletName || !hasWallet(walletName)) return null;
  return getWalletAddress(walletName) ?? null;
}

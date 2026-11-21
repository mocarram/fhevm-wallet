/**
 * Transaction history CLI command with blockchain sync
 */

import { Command } from 'commander';
import { spinner as ora } from '../utils/spinner.js';
import Table from 'cli-table3';
import chalk from 'chalk';
import { prompts, SECRET_MASK } from '../utils/prompts.js';
import { listTransactions, Transaction } from '../../storage/TransactionStore.js';
import { listTokens, TokenEntry } from '../../core/token/TokenRegistry.js';
import { syncTransactions } from '../../core/token/historySync.js';
import { getDefaultNetwork } from '../../storage/ConfigStore.js';
import { clearProviderForNetwork, clearProviderCache } from '../../core/network/ProviderFactory.js';
import {
  formatAddress,
  formatNetworkName,
  error,
  bold,
  tableStyle,
} from '../../utils/formatting.js';
import { isValidNetwork, isValidAddress } from '../../utils/validation.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getNameByAddress } from '../../storage/AddressBook.js';
import { saveEnvVar, getEnvVar, loadEnv } from '../../storage/paths.js';
import { RPC_ENV_KEYS, setCustomRpc, validateRpcUrl } from '../../core/network/rpcSettings.js';
import { maskUrl } from '../../utils/redact.js';
import { maskUrlWhenAnswered } from '../utils/secretInput.js';
import { describeError } from '../utils/userError.js';
import { defaultWalletAddress, historyJson } from './historyJson.js';
import { PASSWORD_STDIN_HELP } from '../utils/passwordInput.js';
import { pickWallet, unlockWallet } from '../utils/txFlow.js';
import { createBackend } from '../../core/backend/select.js';
import {
  amountsToDecrypt,
  decryptHistoryAmounts,
  knownAmount,
} from '../../core/token/historyAmounts.js';
import { formatTokenAmount } from '../../utils/formatting.js';

interface HistoryOptions {
  network?: string;
  address?: string;
  decrypt?: boolean;
  wallet?: string;
  passwordStdin?: boolean;
  limit?: string;
  json?: boolean;
}

/**
 * Format date for display
 */
function formatShortDate(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get transaction type icon
 */
function getTypeIcon(type: string): string {
  switch (type) {
    case 'mint':
      return chalk.green('⬇');
    case 'burn':
      return chalk.red('🔥');
    case 'eth':
      return chalk.cyan('◆');
    default:
      return chalk.green('✔');
  }
}

/**
 * Get direction info based on transaction type
 */
function getDirectionInfo(tx: Transaction, walletAddress: string): { label: string } {
  const type = tx.type || 'transfer';

  if (type === 'mint') {
    return { label: chalk.green('Mint') };
  }
  if (type === 'burn') {
    return { label: chalk.red('Burn') };
  }

  const isSend = tx.from.toLowerCase() === walletAddress.toLowerCase();
  const arrow = isSend ? '→' : '←';
  const counterparty = isSend ? tx.to : tx.from;

  // Check if counterparty is in address book
  const contactName = getNameByAddress(counterparty);
  const displayName = contactName || formatAddress(counterparty, 6);

  return { label: `${arrow} ${displayName}` };
}

/**
 * Format amount with color
 */
function formatAmount(tx: Transaction, walletAddress: string, tokens: TokenEntry[]): string {
  const type = tx.type || 'transfer';

  if (tx.amount === null) {
    // Decrypted earlier (fhew history --decrypt or the TUI) and cached by handle.
    const known = knownAmount(tx);
    const token = tokens.find((t) => t.address.toLowerCase() === tx.tokenAddress.toLowerCase());
    if (!known || !token) return chalk.dim('encrypted');
    const isSend = tx.from.toLowerCase() === walletAddress.toLowerCase();
    const text = `${isSend ? '-' : '+'}${formatTokenAmount(known.value, token.decimals, token.decimals)}`;
    return (
      (isSend ? chalk.red(text) : chalk.green(text)) + (known.disclosed ? chalk.dim(' public') : '')
    );
  }

  if (type === 'mint') {
    return chalk.green(`+${tx.amount}`);
  }
  if (type === 'burn') {
    return chalk.red(`-${tx.amount}`);
  }

  const isSend = tx.from.toLowerCase() === walletAddress.toLowerCase();
  const prefix = isSend ? '-' : '+';
  const color = isSend ? chalk.red : chalk.green;
  return color(`${prefix}${tx.amount}`);
}

/**
 * Handle sync errors gracefully and offer recovery options.
 * Returns true if a retry synced or the user chose to skip; the CLI command exits 1
 * otherwise.
 */
async function handleSyncError(
  err: unknown,
  walletAddress: string,
  network: NetworkName,
  tokens: TokenEntry[],
): Promise<boolean> {
  // Clear the broken provider from cache to stop retry loop
  clearProviderForNetwork(network);

  // Detect on the raw text (never printed: it can contain the RPC URL and its key).
  const raw = err instanceof Error ? err.message : String(err);
  const message = describeError(err, 'Unknown error');

  // Check for common RPC block range errors
  const isBlockRangeError =
    raw.includes('block range') ||
    raw.includes('query returned more than') ||
    raw.includes('exceed maximum') ||
    raw.includes('Log response size exceeded');

  if (isBlockRangeError) {
    console.log(chalk.yellow('\nRPC provider limits the block range for queries.'));
  } else {
    console.log(chalk.yellow(`\nSync error: ${message}`));
  }

  // Without a terminal there is nobody to ask: say what to do, show what is saved, exit 1.
  if (!process.stdin.isTTY) {
    console.log(
      'Showing transactions saved earlier. Set an Etherscan API key or another RPC URL with `fhevm-wallet config`, then try again.',
    );
    return false;
  }

  const action = await prompts.select({
    message: 'How would you like to proceed?',
    choices: [
      { name: 'Set Etherscan API key (recommended)', value: 'set_key' },
      { name: 'Set custom RPC URL', value: 'set_rpc' },
      { name: 'Skip sync for now', value: 'skip' },
    ],
  });

  if (action === 'set_key') {
    const apiKey = await prompts.password({
      message: 'Enter Etherscan API key:',
      mask: SECRET_MASK,
      validate: (input: string) => input.trim().length > 0 || 'API key cannot be empty',
    });

    // A key that cannot be saved (a space in it, say) must not skip the saved history.
    try {
      saveEnvVar('ETHERSCAN_API_KEY', apiKey.trim());
    } catch (err) {
      console.log(error(describeError(err, 'Could not save the key')));
      return false;
    }
    loadEnv();
    console.log(chalk.green('✔ API key saved'));

    // Retry with Etherscan
    const retrySpinner = ora('Retrying sync with Etherscan...').start();
    try {
      const synced = await syncTransactions(walletAddress, network, tokens, 'etherscan');
      const newTxCount = synced.added;
      retrySpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
      if (synced.notice) console.log(chalk.yellow(synced.notice));
      return true;
    } catch (retryErr) {
      retrySpinner.fail('Sync failed');
      console.log(error(describeError(retryErr, 'Unknown error')));
      return false;
    }
  }
  if (action === 'set_rpc') {
    const currentCustom = getEnvVar(RPC_ENV_KEYS[network]);

    const url = await prompts.input({
      // No prefilled default: it would print the saved URL (and its API key) on screen.
      message: currentCustom
        ? `Enter ${network} RPC URL (current: ${maskUrl(currentCustom)}):`
        : `Enter ${network} RPC URL:`,
      validate: (input: string) => validateRpcUrl(input) ?? true,
      // Once answered, show only scheme and host: the key must not stay on screen.
      transformer: (input: string, { isFinal }: { isFinal: boolean }) =>
        maskUrlWhenAnswered(input, undefined, { isFinal }),
    });

    // Same path as `fhew config --rpc-*`: probe the chain before saving.
    try {
      await setCustomRpc(network, url);
    } catch (err) {
      console.log(error(describeError(err, 'Could not set RPC URL')));
      return false;
    }
    clearProviderCache();
    console.log(chalk.green(`✔ ${network} RPC URL saved`));

    // Retry with new RPC
    const retrySpinner = ora('Retrying sync with new RPC...').start();
    try {
      const synced = await syncTransactions(walletAddress, network, tokens, 'rpc');
      const newTxCount = synced.added;
      retrySpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
      if (synced.notice) console.log(chalk.yellow(synced.notice));
      return true;
    } catch (retryErr) {
      retrySpinner.fail('Sync failed');
      console.log(error(describeError(retryErr, 'Unknown error')));
      return false;
    }
  }
  // 'skip': the user chose to go on with the saved history, which is not a failure.
  return action === 'skip';
}

/**
 * Display transaction history table
 */
function displayTransactionTable(
  transactions: Transaction[],
  walletAddress: string,
  tokens: TokenEntry[],
): void {
  if (transactions.length === 0) {
    console.log('\nNo transactions found.');
    return;
  }

  const table = new Table({
    head: ['', 'Date', 'Token', 'To/From', 'Amount'],
    style: tableStyle(),
    chars: {
      mid: '─',
      'left-mid': '├',
      'mid-mid': '┼',
      'right-mid': '┤',
    },
  });

  for (const tx of transactions) {
    const icon = getTypeIcon(tx.type || 'transfer');
    const { label } = getDirectionInfo(tx, walletAddress);
    const amount = formatAmount(tx, walletAddress, tokens);
    // Block 0: sent, but this wallet has seen no receipt yet (SENT_UNCONFIRMED).
    const shown = tx.blockNumber === 0 ? `${amount} ${chalk.yellow('(unconfirmed)')}` : amount;

    table.push([icon, formatShortDate(tx.timestamp), tx.tokenSymbol, label, shown]);
  }

  console.log(table.toString());
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('View transaction history')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-a, --address <address>', 'Wallet address to view')
    .option('--decrypt', 'Decrypt confidential amounts (asks for the wallet password)')
    .option('-w, --wallet <name>', 'Wallet to decrypt with (default: the default wallet)')
    .option('--password-stdin', PASSWORD_STDIN_HELP)
    .option('--limit <n>', 'With --json: how many transfers to print (default 10)')
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: HistoryOptions) => {
      if (options.json) return historyJson(options);
      try {
        // Validate network if provided
        let network: NetworkName = getDefaultNetwork();
        if (options.network) {
          if (!isValidNetwork(options.network)) {
            process.exitCode = 1;
            console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
            return;
          }
          network = options.network;
        }

        // --decrypt works on a wallet: its address is the one shown.
        let decryptWallet: { name: string; address: string } | null = null;
        if (options.decrypt) {
          decryptWallet = pickWallet(options.wallet);
          if (!decryptWallet) return;
          if (
            options.address &&
            options.address.toLowerCase() !== decryptWallet.address.toLowerCase()
          ) {
            process.exitCode = 1;
            console.log(error('--address and the wallet to decrypt with differ. Drop --address.'));
            return;
          }
          options.address = decryptWallet.address;
        }

        // Without --address: the -w wallet or the default wallet, like other commands.
        options.address ??= defaultWalletAddress(options.wallet) ?? undefined;
        if (!options.address) {
          process.exitCode = 1;
          console.log(
            error('No default wallet. Pass a wallet address with --address, or -w <name>.'),
          );
          return;
        }

        if (!isValidAddress(options.address)) {
          process.exitCode = 1;
          console.log(error('Invalid wallet address'));
          return;
        }

        const walletAddress = options.address;
        const tokens = listTokens(network);

        if (tokens.length === 0) {
          process.exitCode = 1;
          console.log(
            error(
              `No tokens tracked on ${network}. Add one with: fhevm-wallet token add <address>`,
            ),
          );
          return;
        }

        // Sync from blockchain
        const hasApiKey = !!process.env.ETHERSCAN_API_KEY;
        const backend = createBackend();

        if (backend.kind === 'mock') {
          const r = await backend.syncHistory(walletAddress, network, tokens);
          console.log(chalk.dim(`Synced (mock${r.newCount ? `, ${r.newCount} new` : ''})`));
        } else if (hasApiKey) {
          // Use Etherscan API (fast)
          const syncSpinner = ora('Syncing transactions from blockchain...').start();
          const synced = await syncTransactions(walletAddress, network, tokens, 'etherscan');
          const newTxCount = synced.added;
          syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
          if (synced.notice) console.log(chalk.yellow(synced.notice));
        } else {
          // Default to RPC with hint
          const syncSpinner = ora('Syncing via RPC...').start();
          syncSpinner.suffixText = chalk.dim(
            '(tip: set Etherscan API key in Settings for faster sync)',
          );
          try {
            const synced = await syncTransactions(walletAddress, network, tokens, 'rpc');
            const newTxCount = synced.added;
            syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
            if (synced.notice) console.log(chalk.yellow(synced.notice));
          } catch (err) {
            syncSpinner.fail('RPC sync failed');
            if (!(await handleSyncError(err, walletAddress, network, tokens))) {
              process.exitCode = 1; // the history below is only what was saved earlier
            }
          }
        }

        // Get last 10 transactions
        const transactions = listTransactions({
          walletAddress,
          network,
          limit: 10,
        });

        console.log();
        console.log(bold('Transaction History'));
        console.log(chalk.dim(`Wallet: ${formatAddress(walletAddress)}`));
        console.log(chalk.dim(`Network: ${formatNetworkName(network)}`));
        console.log();

        if (decryptWallet) {
          const enc = amountsToDecrypt(transactions, tokens);
          if (enc.length === 0) {
            console.log(chalk.dim('No encrypted amounts to decrypt.'));
          } else {
            const notReady = backend.readinessProblem(network);
            if (notReady) {
              process.exitCode = 1;
              console.log(error(notReady));
            } else {
              const signer = await unlockWallet(decryptWallet.name, network, options.passwordStdin);
              if (!signer) return;
              // One signature for every tracked token; dropped as soon as we are done.
              const session = backend.newDecryptSession(signer, network);
              const spin = ora(`Decrypting ${enc.length} amount(s)...`).start();
              try {
                const r = await decryptHistoryAmounts(backend, session, transactions, tokens);
                if (r.failed) {
                  process.exitCode = 1;
                  spin.warn(
                    `Decrypted ${r.decrypted}; ${r.failed} failed: ${describeError(r.error, 'unknown error')}`,
                  );
                } else {
                  spin.succeed(
                    `Decrypted ${r.decrypted} amount(s)${r.hidden ? `; ${r.hidden} not decryptable by this wallet` : ''}`,
                  );
                }
              } finally {
                session.clear();
              }
            }
          }
        }

        displayTransactionTable(transactions, walletAddress, tokens);
      } catch (err) {
        process.exitCode = 1;
        console.log(error(describeError(err, 'Failed to load history')));
      }
    });
}

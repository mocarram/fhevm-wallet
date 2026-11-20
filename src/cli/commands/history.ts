/**
 * Transaction history CLI command with blockchain sync
 */

import { Command } from 'commander';
import ora from 'ora';
import Table from 'cli-table3';
import chalk from 'chalk';
import { prompts, SECRET_MASK } from '../utils/prompts.js';
import { listTransactions, Transaction } from '../../storage/TransactionStore.js';
import { listTokens, TokenEntry } from '../../core/token/TokenRegistry.js';
import { syncTransactions } from '../../core/token/historySync.js';
import { getDefaultNetwork } from '../../storage/ConfigStore.js';
import { clearProviderForNetwork, clearProviderCache } from '../../core/network/ProviderFactory.js';
import { formatAddress, formatNetworkName, error, bold } from '../../utils/formatting.js';
import { isValidNetwork, isValidAddress } from '../../utils/validation.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getNameByAddress } from '../../storage/AddressBook.js';
import { saveEnvVar, getEnvVar, loadEnv } from '../../storage/paths.js';
import { RPC_ENV_KEYS, setCustomRpc, validateRpcUrl } from '../../core/network/rpcSettings.js';
import { maskUrl } from '../../utils/redact.js';
import { maskUrlWhenAnswered } from '../utils/secretInput.js';
import { describeError } from '../utils/userError.js';

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
function formatAmount(tx: Transaction, walletAddress: string): string {
  const type = tx.type || 'transfer';

  if (tx.amount === null) {
    return chalk.dim('encrypted');
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
    console.log(chalk.green('✓ API key saved'));

    // Retry with Etherscan
    const retrySpinner = ora('Retrying sync with Etherscan...').start();
    try {
      const newTxCount = await syncTransactions(walletAddress, network, tokens, 'etherscan');
      retrySpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
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
    console.log(chalk.green(`✓ ${network} RPC URL saved`));

    // Retry with new RPC
    const retrySpinner = ora('Retrying sync with new RPC...').start();
    try {
      const newTxCount = await syncTransactions(walletAddress, network, tokens, 'rpc');
      retrySpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
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
function displayTransactionTable(transactions: Transaction[], walletAddress: string): void {
  if (transactions.length === 0) {
    console.log('\nNo transactions found.');
    return;
  }

  const table = new Table({
    head: ['', 'Date', 'Token', 'To/From', 'Amount'],
    style: { head: ['cyan'] },
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
    const amount = formatAmount(tx, walletAddress);

    table.push([icon, formatShortDate(tx.timestamp), tx.tokenSymbol, label, amount]);
  }

  console.log(table.toString());
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('View transaction history')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-a, --address <address>', 'Wallet address to view')
    .action(async (options: { network?: string; address?: string }) => {
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

        // Require wallet address for CLI
        if (!options.address) {
          process.exitCode = 1;
          console.log(error('Please specify a wallet address with --address'));
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

        if (hasApiKey) {
          // Use Etherscan API (fast)
          const syncSpinner = ora('Syncing transactions from blockchain...').start();
          const newTxCount = await syncTransactions(walletAddress, network, tokens, 'etherscan');
          syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
        } else {
          // Default to RPC with hint
          const syncSpinner = ora('Syncing via RPC...').start();
          syncSpinner.suffixText = chalk.dim(
            '(tip: set Etherscan API key in Settings for faster sync)',
          );
          try {
            const newTxCount = await syncTransactions(walletAddress, network, tokens, 'rpc');
            syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
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

        displayTransactionTable(transactions, walletAddress);
      } catch (err) {
        process.exitCode = 1;
        console.log(error(describeError(err, 'Failed to load history')));
      }
    });
}

/**
 * Display transaction history in interactive mode
 */
export async function displayHistoryInteractive(
  walletAddress: string,
  network: NetworkName,
): Promise<void> {
  const tokens = listTokens(network);

  if (tokens.length === 0) {
    console.log(error(`\nNo tokens tracked on ${network}. Add one first.`));
    return;
  }

  // Check for API key
  const hasApiKey = !!process.env.ETHERSCAN_API_KEY;

  if (hasApiKey) {
    // Use Etherscan API (fast)
    const syncSpinner = ora('Syncing transactions from blockchain...').start();
    const newTxCount = await syncTransactions(walletAddress, network, tokens, 'etherscan');
    syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
  } else {
    // Default to RPC with hint
    const syncSpinner = ora('Syncing via RPC...').start();
    syncSpinner.suffixText = chalk.dim('(tip: set Etherscan API key in Settings for faster sync)');
    try {
      const newTxCount = await syncTransactions(walletAddress, network, tokens, 'rpc');
      syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
    } catch (err) {
      syncSpinner.fail('RPC sync failed');
      await handleSyncError(err, walletAddress, network, tokens);
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

  displayTransactionTable(transactions, walletAddress);
}

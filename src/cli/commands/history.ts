/**
 * Transaction history CLI command with blockchain sync
 */

import { Command } from 'commander';
import ora from 'ora';
import Table from 'cli-table3';
import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  listTransactions,
  getLastSyncedBlock,
  updateSyncState,
  upsertTransactions,
  Transaction,
} from '../../storage/TransactionStore.js';
import {
  getWalletTransactions,
  getWalletTransactionsViaRPC,
} from '../../core/token/TokenService.js';
import { listTokens, TokenEntry } from '../../core/token/TokenRegistry.js';
import { getDefaultNetwork } from '../../storage/ConfigStore.js';
import { getProvider, clearProviderForNetwork } from '../../core/network/ProviderFactory.js';
import { formatAddress, formatNetworkName, error, bold } from '../../utils/formatting.js';
import { isValidNetwork, isValidAddress } from '../../utils/validation.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getNameByAddress } from '../../storage/AddressBook.js';
import { saveEnvVar, loadEnv } from '../../storage/paths.js';

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

type SyncMethod = 'etherscan' | 'rpc';

/**
 * Sync transactions from blockchain via Etherscan API
 */
async function syncTransactions(
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

/**
 * Handle sync errors gracefully and offer recovery options
 */
async function handleSyncError(
  err: unknown,
  walletAddress: string,
  network: NetworkName,
  tokens: TokenEntry[],
): Promise<void> {
  // Clear the broken provider from cache to stop retry loop
  clearProviderForNetwork(network);

  const message = err instanceof Error ? err.message : 'Unknown error';

  // Check for common RPC block range errors
  const isBlockRangeError =
    message.includes('block range') ||
    message.includes('query returned more than') ||
    message.includes('exceed maximum') ||
    message.includes('Log response size exceeded');

  if (isBlockRangeError) {
    console.log(chalk.yellow('\nRPC provider limits the block range for queries.'));
  } else {
    console.log(chalk.yellow(`\nSync error: ${message}`));
  }

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'How would you like to proceed?',
      choices: [
        { name: 'Set Etherscan API key (recommended)', value: 'set_key' },
        { name: 'Skip sync for now', value: 'skip' },
      ],
    },
  ]);

  if (action === 'set_key') {
    const { apiKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter Etherscan API key:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key cannot be empty',
      },
    ]);

    saveEnvVar('ETHERSCAN_API_KEY', apiKey.trim());
    loadEnv();
    console.log(chalk.green('✓ API key saved'));

    // Retry with Etherscan
    const retrySpinner = ora('Retrying sync with Etherscan...').start();
    try {
      const newTxCount = await syncTransactions(walletAddress, network, tokens, 'etherscan');
      retrySpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
    } catch (retryErr) {
      retrySpinner.fail('Sync failed');
      console.log(error(retryErr instanceof Error ? retryErr.message : 'Unknown error'));
    }
  }
  // 'skip' action: do nothing, proceed to show cached transactions
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
            console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
            return;
          }
          network = options.network;
        }

        // Require wallet address for CLI
        if (!options.address) {
          console.log(error('Please specify a wallet address with --address'));
          return;
        }

        if (!isValidAddress(options.address)) {
          console.log(error('Invalid wallet address'));
          return;
        }

        const walletAddress = options.address;
        const tokens = listTokens(network);

        if (tokens.length === 0) {
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
      } catch (err) {
        console.log(error(err instanceof Error ? err.message : 'Failed to load history'));
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

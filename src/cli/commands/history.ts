/**
 * Transaction history CLI command with blockchain sync
 */

import { Command } from 'commander';
import ora from 'ora';
import Table from 'cli-table3';
import chalk from 'chalk';
import {
  listTransactions,
  getLastSyncedBlock,
  updateSyncState,
  upsertTransactions,
  Transaction,
} from '../../storage/TransactionStore.js';
import { getWalletTransactions } from '../../core/token/TokenService.js';
import { listTokens, TokenEntry } from '../../core/token/TokenRegistry.js';
import { getDefaultNetwork } from '../../storage/ConfigStore.js';
import { getProvider } from '../../core/network/ProviderFactory.js';
import { formatAddress, error, bold } from '../../utils/formatting.js';
import { isValidNetwork, isValidAddress } from '../../utils/validation.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';

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
    case 'mint': return chalk.green('⬇');
    case 'burn': return chalk.red('🔥');
    case 'eth': return chalk.cyan('◆');
    default: return chalk.green('✔');
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

  return { label: `${arrow} ${formatAddress(counterparty, 6)}` };
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
 * Sync transactions from blockchain via Etherscan API
 */
async function syncTransactions(
  walletAddress: string,
  network: NetworkName,
  tokens: TokenEntry[],
): Promise<number> {
  const lastBlock = getLastSyncedBlock(walletAddress, network);
  const provider = getProvider(network);
  const currentBlock = await provider.getBlockNumber();

  // Get token addresses and create a lookup map
  const tokenAddresses = tokens.map(t => t.address);
  const tokenMap = new Map(tokens.map(t => [t.address.toLowerCase(), { symbol: t.symbol }]));

  // Fetch transactions from Etherscan
  const walletTxs = await getWalletTransactions(
    walletAddress,
    tokenAddresses,
    tokenMap,
    network,
    lastBlock > 0 ? lastBlock + 1 : 0,
  );

  // Convert to our transaction format
  const transactions: Transaction[] = walletTxs.map(tx => ({
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
      'mid': '─', 'left-mid': '├', 'mid-mid': '┼', 'right-mid': '┤'
    }
  });

  for (const tx of transactions) {
    const icon = getTypeIcon(tx.type || 'transfer');
    const { label } = getDirectionInfo(tx, walletAddress);
    const amount = formatAmount(tx, walletAddress);

    table.push([
      icon,
      formatShortDate(tx.timestamp),
      tx.tokenSymbol,
      label,
      amount,
    ]);
  }

  console.log(table.toString());
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('View transaction history')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-a, --address <address>', 'Wallet address to view')
    .action(async (options: {
      network?: string;
      address?: string;
    }) => {
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
          console.log(error(`No tokens tracked on ${network}. Add one with: fhe-wallet token add <address>`));
          return;
        }

        // Sync from blockchain (requires ETHERSCAN_API_KEY)
        const hasApiKey = !!process.env.ETHERSCAN_API_KEY;

        if (hasApiKey) {
          const syncSpinner = ora('Syncing transactions from blockchain...').start();
          const newTxCount = await syncTransactions(walletAddress, network, tokens);
          syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
        } else {
          console.log(chalk.dim('Tip: Set ETHERSCAN_API_KEY in .env to sync on-chain transactions'));
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
        console.log(chalk.dim(`Network: ${network}`));
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

  // Sync from blockchain (requires ETHERSCAN_API_KEY)
  const hasApiKey = !!process.env.ETHERSCAN_API_KEY;

  if (hasApiKey) {
    const syncSpinner = ora('Syncing transactions from blockchain...').start();
    const newTxCount = await syncTransactions(walletAddress, network, tokens);
    syncSpinner.succeed(`Synced${newTxCount > 0 ? ` (${newTxCount} new)` : ''}`);
  } else {
    console.log(chalk.dim('Tip: Set ETHERSCAN_API_KEY in .env to sync on-chain transactions'));
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
  console.log(chalk.dim(`Network: ${network}`));
  console.log();

  displayTransactionTable(transactions, walletAddress);
}


/**
 * Token CLI commands
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import Table from 'cli-table3';
import { addToken, removeToken, listTokens } from '../../core/token/TokenRegistry.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getDefaultNetwork } from '../../storage/ConfigStore.js';
import { formatAddress, success, error } from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';

export function registerTokenCommands(program: Command): void {
  const token = program.command('token').description('Manage tracked tokens');

  // Add token
  token
    .command('add')
    .description('Add a token to track')
    .argument('[address]', 'Token contract address')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .action(async (address?: string, options?: { network?: string }) => {
      try {
        // Determine network
        let network: NetworkName = getDefaultNetwork();
        if (options?.network) {
          if (!isValidNetwork(options.network)) {
            console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
            return;
          }
          network = options.network;
        }

        // Prompt for address if not provided
        if (!address) {
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'address',
              message: 'Enter token contract address:',
              validate: (input) => isValidAddress(input) || 'Invalid Ethereum address',
            },
          ]);
          address = answers.address;
        }

        if (!isValidAddress(address!)) {
          console.log(error('Invalid Ethereum address'));
          return;
        }

        const spinner = ora(`Fetching token info from ${network}...`).start();

        const entry = await addToken(address!, network);

        spinner.succeed('Token added');

        console.log();
        console.log(`  Name:     ${entry.name}`);
        console.log(`  Symbol:   ${entry.symbol}`);
        console.log(`  Decimals: ${entry.decimals}`);
        console.log(`  Address:  ${entry.address}`);
        console.log(`  Network:  ${entry.network}`);
      } catch (err) {
        console.log(error(err instanceof Error ? err.message : 'Failed to add token'));
      }
    });

  // List tokens
  token
    .command('list')
    .alias('ls')
    .description('List tracked tokens')
    .option('-n, --network <network>', 'Filter by network')
    .option('--full', 'Show full token addresses')
    .action((options?: { network?: string; full?: boolean }) => {
      let network: NetworkName | undefined;
      if (options?.network) {
        if (!isValidNetwork(options.network)) {
          console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
          return;
        }
        network = options.network;
      }

      const tokens = listTokens(network);

      if (tokens.length === 0) {
        console.log('No tokens tracked. Add one with: fhevm-wallet token add <address>');
        return;
      }

      const table = new Table({
        head: ['Symbol', 'Name', 'Address', 'Network', 'Decimals'],
        style: { head: ['cyan'] },
      });

      for (const t of tokens) {
        table.push([
          t.symbol,
          t.name,
          options?.full ? t.address : formatAddress(t.address),
          t.network,
          t.decimals.toString(),
        ]);
      }

      console.log(table.toString());
    });

  // Remove token
  token
    .command('remove')
    .alias('rm')
    .description('Remove a tracked token')
    .argument('<address>', 'Token contract address')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-f, --force', 'Skip confirmation')
    .action(async (address: string, options: { network?: string; force?: boolean }) => {
      // Determine network
      let network: NetworkName = getDefaultNetwork();
      if (options?.network) {
        if (!isValidNetwork(options.network)) {
          console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
          return;
        }
        network = options.network;
      }

      if (!isValidAddress(address)) {
        console.log(error('Invalid Ethereum address'));
        return;
      }

      if (!options.force) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Remove token ${formatAddress(address)} from ${network}?`,
            default: false,
          },
        ]);

        if (!confirm) {
          console.log('Cancelled');
          return;
        }
      }

      const removed = removeToken(address, network);

      if (removed) {
        console.log(success('Token removed'));
      } else {
        console.log(error('Token not found'));
      }
    });
}

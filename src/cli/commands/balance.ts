/**
 * Balance CLI command
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import Table from 'cli-table3';
import chalk from 'chalk';
import { loadWallet, listWallets, hasWallet } from '../../core/wallet/index.js';
import { listTokens, getToken, TokenEntry } from '../../core/token/TokenRegistry.js';
import { getDecryptedBalance } from '../../core/token/TokenService.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { formatTokenAmount, formatAddress, error, warning, bold } from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('View encrypted token balances')
    .option('-w, --wallet <name>', 'Wallet to use')
    .option('-t, --token <address>', 'Specific token address')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .action(async (options: { wallet?: string; token?: string; network?: string }) => {
      try {
        // Determine network
        let network: NetworkName = getDefaultNetwork();
        if (options.network) {
          if (!isValidNetwork(options.network)) {
            console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
            return;
          }
          network = options.network;
        }

        // Determine wallet
        let walletName = options.wallet || getDefaultWallet();

        if (!walletName) {
          const wallets = listWallets();
          if (wallets.length === 0) {
            console.log(error('No wallets found. Create one with: fhe-wallet wallet create'));
            return;
          }

          const { name } = await inquirer.prompt([
            {
              type: 'list',
              name: 'name',
              message: 'Select wallet:',
              choices: wallets.map(w => ({
                name: `${w.name} (${formatAddress(w.address)})`,
                value: w.name,
              })),
            },
          ]);
          walletName = name;
        }

        const selectedWallet = walletName!;

        if (!hasWallet(selectedWallet)) {
          console.log(error(`Wallet "${selectedWallet}" not found`));
          return;
        }

        // Get password
        const { password } = await inquirer.prompt([
          {
            type: 'password',
            name: 'password',
            message: 'Enter wallet password:',
            mask: '*',
          },
        ]);

        // Load wallet
        const loadSpinner = ora('Decrypting wallet...').start();
        let wallet;
        try {
          wallet = await loadWallet(selectedWallet, password, network);
          loadSpinner.succeed('Wallet loaded');
        } catch (err) {
          loadSpinner.fail('Failed to decrypt wallet');
          console.log(error(err instanceof Error ? err.message : 'Invalid password'));
          return;
        }

        // Get tokens to check
        let tokens: TokenEntry[];
        if (options.token) {
          if (!isValidAddress(options.token)) {
            console.log(error('Invalid token address'));
            return;
          }
          const token = getToken(options.token, network);
          if (!token) {
            console.log(warning(`Token ${options.token} not tracked. Add it with: fhe-wallet token add ${options.token}`));
            return;
          }
          tokens = [token];
        } else {
          tokens = listTokens(network);
        }

        if (tokens.length === 0) {
          console.log('No tokens tracked. Add one with: fhe-wallet token add <address>');
          return;
        }

        console.log();
        console.log(bold(`Balances for ${selectedWallet}`));
        console.log(chalk.dim(`Address: ${wallet.address}`));
        console.log(chalk.dim(`Network: ${network}`));
        console.log();

        const table = new Table({
          head: ['Token', 'Balance', 'Address'],
          style: { head: ['cyan'] },
        });

        for (const token of tokens) {
          const spinner = ora(`Fetching ${token.symbol} balance...`).start();

          try {
            const balance = await getDecryptedBalance(token.address, wallet, network);
            const formatted = formatTokenAmount(balance, token.decimals);

            spinner.succeed(`${token.symbol}: ${formatted}`);

            table.push([
              token.symbol,
              formatted,
              formatAddress(token.address),
            ]);
          } catch (err) {
            spinner.fail(`${token.symbol}: Failed to fetch`);
            console.log(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));

            table.push([
              token.symbol,
              chalk.red('Error'),
              formatAddress(token.address),
            ]);
          }
        }

        console.log();
        console.log(table.toString());
      } catch (err) {
        console.log(error(err instanceof Error ? err.message : 'Failed to fetch balances'));
      }
    });
}

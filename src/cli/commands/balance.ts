/**
 * Balance CLI command
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { loadWallet, listWallets, hasWallet } from '../../core/wallet/index.js';
import { listTokens, getToken, TokenEntry } from '../../core/token/TokenRegistry.js';
import { getDecryptedBalance } from '../../core/token/TokenService.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getProvider } from '../../core/network/ProviderFactory.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { formatTokenAmount, formatAddress, error, warning, bold, shortErrorMessage } from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';
import { DynamicBalanceTable } from '../utils/DynamicBalanceTable.js';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('View encrypted token balances')
    .option('-w, --wallet <name>', 'Wallet to use')
    .option('-t, --token <address>', 'Specific token address')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-r, --refresh', 'Force refresh balances (bypass cache)')
    .action(
      async (options: { wallet?: string; token?: string; network?: string; refresh?: boolean }) => {
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
                choices: wallets.map((w) => ({
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
              console.log(
                warning(
                  `Token ${options.token} not tracked. Add it with: fhe-wallet token add ${options.token}`,
                ),
              );
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

          // Fetch ETH balance
          const provider = getProvider(network);
          const ethBalance = await provider.getBalance(wallet.address);
          const ethFormatted = formatTokenAmount(ethBalance, 18);

          const headerLines = [
            '',
            bold(`Balances for ${selectedWallet}`),
            chalk.dim(`Address: ${wallet.address}`),
            chalk.dim(`Network: ${network}`),
            '',
          ].join('\n');

          const dynamicTable = new DynamicBalanceTable({
            tokens,
            header: headerLines,
            ethBalance: ethFormatted,
          });
          dynamicTable.start();

          for (let i = 0; i < tokens.length; i++) {
            dynamicTable.setLoading(i);
            try {
              const balance = await getDecryptedBalance(tokens[i].address, wallet, network, {
                forceRefresh: options.refresh,
              });
              const formatted = formatTokenAmount(balance, tokens[i].decimals);
              dynamicTable.setSuccess(i, formatted);
            } catch (err) {
              dynamicTable.setError(i, shortErrorMessage(err));
            }
          }

          dynamicTable.stop();
        } catch (err) {
          console.log(error(shortErrorMessage(err)));
        }
      },
    );
}

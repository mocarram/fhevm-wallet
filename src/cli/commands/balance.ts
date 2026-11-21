/**
 * Balance CLI command
 */

import { Command } from 'commander';
import { PASSWORD_STDIN_HELP, walletPassword } from '../utils/passwordInput.js';
import { prompts } from '../utils/prompts.js';
import ora from 'ora';
import chalk from 'chalk';
import { loadWallet, listWallets, hasWallet } from '../../core/wallet/index.js';
import { listTokens, getToken, TokenEntry } from '../../core/token/TokenRegistry.js';
import { getDecryptedBalance } from '../../core/token/TokenService.js';
import { checkFheReadiness } from '../../core/fhe/FheService.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getProvider } from '../../core/network/ProviderFactory.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import {
  formatTokenAmount,
  formatAddress,
  formatNetworkName,
  error,
  warning,
  bold,
} from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';
import { DynamicBalanceTable } from '../utils/DynamicBalanceTable.js';
import { balanceJson } from './balanceJson.js';
import { describeError, describeErrorShort } from '../utils/userError.js';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('View encrypted token balances')
    .option('-w, --wallet <name>', 'Wallet to use')
    .option('-t, --token <address>', 'Specific token address')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-r, --refresh', 'Force refresh balances (bypass cache)')
    .option('--password-stdin', PASSWORD_STDIN_HELP)
    .option('--json', 'Print machine-readable JSON (needs --password-stdin)')
    .action(
      async (options: {
        wallet?: string;
        token?: string;
        network?: string;
        refresh?: boolean;
        passwordStdin?: boolean;
        json?: boolean;
      }) => {
        if (options.json) return balanceJson(options);
        try {
          // Determine network
          let network: NetworkName = getDefaultNetwork();
          if (options.network) {
            if (!isValidNetwork(options.network)) {
              process.exitCode = 1;
              console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
              return;
            }
            network = options.network;
          }

          // Check if FHE operations are ready for this network
          const fheError = checkFheReadiness(network);
          if (fheError) {
            process.exitCode = 1;
            console.log(error(fheError));
            return;
          }

          // Determine wallet
          let walletName = options.wallet || getDefaultWallet();

          if (!walletName) {
            const wallets = listWallets();
            if (wallets.length === 0) {
              process.exitCode = 1;
              console.log(error('No wallets found. Create one with: fhevm-wallet wallet create'));
              return;
            }

            const name = await prompts.select({
              message: 'Select wallet:',
              choices: wallets.map((w) => ({
                name: `${w.name} (${formatAddress(w.address)})`,
                value: w.name,
              })),
            });
            walletName = name;
          }

          const selectedWallet = walletName!;

          if (!hasWallet(selectedWallet)) {
            process.exitCode = 1;
            console.log(error(`Wallet "${selectedWallet}" not found`));
            return;
          }

          // Get password
          const password = await walletPassword(options.passwordStdin);

          // Load wallet
          const loadSpinner = ora('Decrypting wallet...').start();
          let wallet;
          try {
            wallet = await loadWallet(selectedWallet, password, network);
            loadSpinner.succeed('Wallet loaded');
          } catch (err) {
            loadSpinner.fail('Failed to decrypt wallet');
            process.exitCode = 1;
            console.log(error(describeError(err, 'Invalid password')));
            return;
          }

          // Get tokens to check
          let tokens: TokenEntry[];
          if (options.token) {
            if (!isValidAddress(options.token)) {
              process.exitCode = 1;
              console.log(error('Invalid token address'));
              return;
            }
            const token = getToken(options.token, network);
            if (!token) {
              console.log(
                warning(
                  `Token ${options.token} not tracked. Add it with: fhevm-wallet token add ${options.token}`,
                ),
              );
              return;
            }
            tokens = [token];
          } else {
            tokens = listTokens(network);
          }

          if (tokens.length === 0) {
            console.log('No tokens tracked. Add one with: fhevm-wallet token add <address>');
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
            chalk.dim(`Network: ${formatNetworkName(network)}`),
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
              dynamicTable.setError(i, describeErrorShort(err));
            }
          }

          dynamicTable.stop();

          // Show interactive menu after displaying balances (not in scripts: stdin is
          // the password pipe there, and nobody is there to answer).
          let continueLoop = Boolean(process.stdin.isTTY) && !options.passwordStdin;
          while (continueLoop) {
            console.log('');
            const action = await prompts.select({
              message: 'What would you like to do?',
              choices: [
                { name: 'Refresh', value: 'refresh' },
                { name: 'Force decrypt', value: 'force' },
                { name: 'Back', value: 'back' },
              ],
            });

            if (action === 'back') {
              continueLoop = false;
            } else if (action === 'refresh' || action === 'force') {
              const forceRefresh = action === 'force';

              // Refresh ETH balance
              const refreshedEthBalance = await provider.getBalance(wallet.address);
              const refreshedEthFormatted = formatTokenAmount(refreshedEthBalance, 18);

              // Refresh balances
              const refreshTable = new DynamicBalanceTable({
                tokens,
                header: headerLines,
                ethBalance: refreshedEthFormatted,
              });
              refreshTable.start();

              for (let i = 0; i < tokens.length; i++) {
                refreshTable.setLoading(i);
                try {
                  const balance = await getDecryptedBalance(tokens[i].address, wallet, network, {
                    forceRefresh,
                  });
                  const formatted = formatTokenAmount(balance, tokens[i].decimals);
                  refreshTable.setSuccess(i, formatted);
                } catch (err) {
                  refreshTable.setError(i, describeErrorShort(err));
                }
              }

              refreshTable.stop();
            }
          }
        } catch (err) {
          process.exitCode = 1;
          console.log(error(describeError(err, 'Could not load balances')));
        }
      },
    );
}

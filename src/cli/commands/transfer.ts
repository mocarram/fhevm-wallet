/**
 * Transfer CLI command
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { loadWallet, listWallets, hasWallet } from '../../core/wallet/index.js';
import { listTokens, getToken, TokenEntry } from '../../core/token/TokenRegistry.js';
import { confidentialTransfer, getTxExplorerUrl } from '../../core/token/TokenService.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { formatTokenAmount, parseTokenAmount, formatAddress, error, success, warning, bold } from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork, isValidAmount } from '../../utils/validation.js';

export function registerTransferCommand(program: Command): void {
  program
    .command('send')
    .description('Send tokens confidentially')
    .argument('[to]', 'Recipient address')
    .argument('[amount]', 'Amount to send')
    .option('-t, --token <address>', 'Token contract address')
    .option('-w, --wallet <name>', 'Wallet to use')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .action(async (to?: string, amount?: string, options?: {
      token?: string;
      wallet?: string;
      network?: string;
    }) => {
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

        // Get tokens for this network
        const tokens = listTokens(network);
        if (tokens.length === 0) {
          console.log(error(`No tokens tracked on ${network}. Add one with: fhe-wallet token add <address>`));
          return;
        }

        // Determine token
        let token: TokenEntry | null = null;
        if (options?.token) {
          if (!isValidAddress(options.token)) {
            console.log(error('Invalid token address'));
            return;
          }
          token = getToken(options.token, network);
          if (!token) {
            console.log(error(`Token ${options.token} not tracked. Add it with: fhe-wallet token add ${options.token}`));
            return;
          }
        } else if (tokens.length === 1) {
          token = tokens[0];
        } else {
          const { tokenAddress } = await inquirer.prompt([
            {
              type: 'list',
              name: 'tokenAddress',
              message: 'Select token:',
              choices: tokens.map(t => ({
                name: `${t.symbol} - ${t.name} (${formatAddress(t.address)})`,
                value: t.address,
              })),
            },
          ]);
          token = getToken(tokenAddress, network)!;
        }

        // Prompt for recipient if not provided
        if (!to) {
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'to',
              message: 'Enter recipient address:',
              validate: (input) => isValidAddress(input) || 'Invalid Ethereum address',
            },
          ]);
          to = answers.to;
        }

        if (!isValidAddress(to!)) {
          console.log(error('Invalid recipient address'));
          return;
        }

        // Prompt for amount if not provided
        if (!amount) {
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'amount',
              message: `Enter amount (${token.symbol}):`,
              validate: (input) => isValidAmount(input) || 'Invalid amount',
            },
          ]);
          amount = answers.amount;
        }

        if (!isValidAmount(amount!)) {
          console.log(error('Invalid amount'));
          return;
        }

        // Determine wallet
        let walletName = options?.wallet || getDefaultWallet();

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

        // Parse amount
        const amountBigInt = parseTokenAmount(amount!, token.decimals);

        // Confirm transaction
        console.log();
        console.log(bold('Transaction Summary'));
        console.log(`  From:    ${wallet.address}`);
        console.log(`  To:      ${to}`);
        console.log(`  Amount:  ${amount} ${token.symbol}`);
        console.log(`  Token:   ${token.name}`);
        console.log(`  Network: ${network}`);
        console.log();

        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Confirm transaction?',
            default: false,
          },
        ]);

        if (!confirm) {
          console.log('Transaction cancelled');
          return;
        }

        // Execute transfer
        console.log();
        const encryptSpinner = ora('Encrypting amount...').start();

        try {
          encryptSpinner.text = 'Sending transaction...';

          const result = await confidentialTransfer(
            wallet,
            token.address,
            to!,
            amountBigInt,
            network,
          );

          encryptSpinner.succeed('Transaction sent');

          console.log();
          console.log(success('Transfer successful!'));
          console.log(`  Transaction: ${result.txHash}`);
          console.log(`  Explorer:    ${getTxExplorerUrl(result.txHash, network)}`);
          console.log();

          if (result.receipt.status === 1) {
            console.log(chalk.green('Transaction confirmed'));
          } else {
            console.log(chalk.red('Transaction may have failed'));
          }
        } catch (err) {
          encryptSpinner.fail('Transaction failed');
          console.log(error(err instanceof Error ? err.message : 'Unknown error'));
        }
      } catch (err) {
        console.log(error(err instanceof Error ? err.message : 'Failed to send transaction'));
      }
    });
}

/**
 * Transfer CLI command
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { loadWallet, listWallets, hasWallet } from '../../core/wallet/index.js';
import { listTokens, getToken, TokenEntry } from '../../core/token/TokenRegistry.js';
import {
  confidentialTransfer,
  getTxExplorerUrl,
  recordTransferTransaction,
} from '../../core/token/TokenService.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { checkFheReadiness } from '../../core/fhe/FheService.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import {
  parseTokenAmount,
  formatAddress,
  formatNetworkName,
  error,
  success,
  bold,
} from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork, isValidAmount } from '../../utils/validation.js';
import { listAddresses, getAddressByName } from '../../storage/AddressBook.js';

export function registerTransferCommand(program: Command): void {
  program
    .command('send')
    .description('Send tokens confidentially')
    .argument('[to]', 'Recipient address')
    .argument('[amount]', 'Amount to send')
    .option('-t, --token <address>', 'Token contract address')
    .option('-w, --wallet <name>', 'Wallet to use')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-c, --contact <name>', 'Use address book contact as recipient')
    .action(
      async (
        to?: string,
        amount?: string,
        options?: {
          token?: string;
          wallet?: string;
          network?: string;
          contact?: string;
        },
      ) => {
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

          // Check if FHE operations are ready for this network
          const fheError = checkFheReadiness(network);
          if (fheError) {
            console.log(error(fheError));
            return;
          }

          // Get tokens for this network
          const tokens = listTokens(network);
          if (tokens.length === 0) {
            console.log(
              error(
                `No tokens tracked on ${network}. Add one with: fhevm-wallet token add <address>`,
              ),
            );
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
              console.log(
                error(
                  `Token ${options.token} not tracked. Add it with: fhevm-wallet token add ${options.token}`,
                ),
              );
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
                choices: [
                  ...tokens.map((t) => ({
                    name: `${t.symbol} - ${t.name} (${formatAddress(t.address)})`,
                    value: t.address,
                  })),
                  { name: '← Cancel', value: '__cancel__' },
                ],
              },
            ]);
            if (tokenAddress === '__cancel__') {
              return;
            }
            token = getToken(tokenAddress, network)!;
          }

          // Resolve recipient from contact or prompt
          if (options?.contact) {
            const contact = getAddressByName(options.contact);
            if (!contact) {
              console.log(error(`Contact "${options.contact}" not found`));
              return;
            }
            to = contact.address;
            console.log(`Using contact: ${contact.name} (${formatAddress(contact.address)})`);
          } else if (!to) {
            // Offer address book selection if contacts exist
            const contacts = listAddresses();

            if (contacts.length > 0) {
              const choices = [
                ...contacts.map((c) => ({
                  name: `${c.name} (${formatAddress(c.address)})`,
                  value: c.address,
                })),
                { name: 'Enter new address...', value: '__new__' },
                { name: '← Cancel', value: '__cancel__' },
              ];

              const { recipient } = await inquirer.prompt([
                {
                  type: 'list',
                  name: 'recipient',
                  message: 'Select recipient:',
                  choices,
                },
              ]);

              if (recipient === '__cancel__') {
                return;
              }

              if (recipient === '__new__') {
                const { address } = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'address',
                    message: 'Enter recipient address (empty to cancel):',
                    validate: (input) => {
                      if (input === '') return true;
                      return isValidAddress(input) || 'Invalid Ethereum address';
                    },
                  },
                ]);
                if (!address) {
                  return;
                }
                to = address;
              } else {
                to = recipient;
              }
            } else {
              const answers = await inquirer.prompt([
                {
                  type: 'input',
                  name: 'to',
                  message: 'Enter recipient address (empty to cancel):',
                  validate: (input) => {
                    if (input === '') return true;
                    return isValidAddress(input) || 'Invalid Ethereum address';
                  },
                },
              ]);
              if (!answers.to) {
                return;
              }
              to = answers.to;
            }
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
                message: `Enter amount in ${token.symbol} (empty to cancel):`,
                validate: (input) => {
                  if (input === '') return true;
                  return isValidAmount(input) || 'Invalid amount';
                },
              },
            ]);
            if (!answers.amount) {
              return;
            }
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
              console.log(error('No wallets found. Create one with: fhevm-wallet wallet create'));
              return;
            }

            const { name } = await inquirer.prompt([
              {
                type: 'list',
                name: 'name',
                message: 'Select wallet:',
                choices: [
                  ...wallets.map((w) => ({
                    name: `${w.name} (${formatAddress(w.address)})`,
                    value: w.name,
                  })),
                  { name: '← Cancel', value: '__cancel__' },
                ],
              },
            ]);
            if (name === '__cancel__') {
              return;
            }
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
          console.log(`  Network: ${formatNetworkName(network)}`);
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

            // Record transaction in history
            recordTransferTransaction({
              tokenAddress: token.address,
              tokenSymbol: token.symbol,
              from: wallet.address,
              to: to!,
              amount: amount!,
              txHash: result.txHash,
              network,
              blockNumber: result.receipt.blockNumber,
            });

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
      },
    );
}

/**
 * Transfer CLI command
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { loadWallet, listWallets, hasWallet } from '../../core/wallet/index.js';
import { listTokens, getToken, TokenEntry } from '../../core/token/TokenRegistry.js';
import {
  prepareConfidentialTransfer,
  getTxExplorerUrl,
  recordTransferTransaction,
} from '../../core/token/TokenService.js';
import { formatTxError, translateTxError } from '../../core/token/txErrors.js';
import { formatEther } from 'ethers';
import { describeBalanceCheck } from '../utils/transferReport.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { checkFheReadiness } from '../../core/fhe/FheService.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import {
  parseTokenAmount,
  formatAddress,
  formatNetworkName,
  error,
  success,
  warning,
  bold,
} from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork, isValidAmount } from '../../utils/validation.js';
import { listAddresses, getAddressByName } from '../../storage/AddressBook.js';
import { describeError } from '../utils/userError.js';

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
            console.log(error(describeError(err, 'Invalid password')));
            return;
          }

          // Parse amount strictly: excess decimals are an error, not silently dropped.
          let amountBigInt: bigint;
          try {
            amountBigInt = parseTokenAmount(amount!, token.decimals);
          } catch (err) {
            console.log(error(describeError(err, 'Invalid amount')));
            return;
          }

          // Encrypt and simulate before asking for confirmation, so a doomed send
          // is caught before anything is signed.
          const checkSpinner = ora('Encrypting amount and simulating the transfer...').start();
          let prepared;
          try {
            prepared = await prepareConfidentialTransfer(
              wallet,
              token.address,
              to!,
              amountBigInt,
              network,
            );
            checkSpinner.succeed('Simulation passed');
          } catch (err) {
            checkSpinner.fail('Send stopped. Nothing was signed or sent.');
            console.log(error(formatTxError(translateTxError(err))));
            return;
          }

          // Confirm transaction
          console.log();
          console.log(bold('Transaction Summary'));
          console.log(`  From:    ${wallet.address}`);
          console.log(`  To:      ${to}`);
          console.log(`  Amount:  ${amount} ${token.symbol} (encrypted on-chain)`);
          console.log(`  Token:   ${token.name}`);
          console.log(`  Network: ${formatNetworkName(network)}`);
          console.log(
            `  Fee:     up to ${formatEther(prepared.feeWei)} ETH (you have ${formatEther(prepared.ethBalanceWei)} ETH)`,
          );
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

          console.log();
          const sendSpinner = ora('Sending transaction and waiting for confirmation...').start();

          let result;
          try {
            result = await prepared.send();
            sendSpinner.succeed('Transaction confirmed');
          } catch (err) {
            const txErr = translateTxError(err);
            // After broadcast the transfer may still confirm: never present that as a failure.
            if (txErr.code === 'SENT_UNCONFIRMED') sendSpinner.warn('Sent, not confirmed yet');
            else if (txErr.code === 'TX_REPLACED') sendSpinner.warn('Transaction replaced');
            else
              sendSpinner.fail(
                txErr.code === 'TX_REVERTED' ? 'Transaction reverted' : 'Transaction failed',
              );
            console.log(error(formatTxError(txErr)));
            return;
          }

          // Local history is a convenience; failing to save it must not hide a confirmed transfer.
          try {
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
          } catch {
            console.log(warning("Couldn't save this transfer to local history."));
          }

          console.log();
          console.log(success('Transfer confirmed on-chain.'));
          console.log(`  Transaction: ${result.txHash}`);
          console.log(`  Explorer:    ${getTxExplorerUrl(result.txHash, network)}`);
          for (const line of describeBalanceCheck(result, token.symbol, token.decimals)) {
            console.log(line);
          }
        } catch (err) {
          console.log(error(describeError(err, 'Failed to send transaction')));
        }
      },
    );
}

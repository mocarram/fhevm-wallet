/**
 * Wallet CLI commands
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import {
  createWallet,
  importWalletFromMnemonic,
  importWalletFromPrivateKey,
  listWallets,
  removeWallet,
  hasWallet,
} from '../../core/wallet/index.js';
import { setDefaultWallet, getDefaultWallet } from '../../storage/ConfigStore.js';
import { formatAddress, formatDate, success, error, warning, bold } from '../../utils/formatting.js';
import { isValidWalletName, isValidMnemonic, isValidPrivateKey } from '../../utils/validation.js';

export function registerWalletCommands(program: Command): void {
  const wallet = program
    .command('wallet')
    .description('Manage wallets');

  // Create new wallet
  wallet
    .command('create')
    .description('Create a new wallet')
    .argument('[name]', 'Wallet name')
    .option('--set-default', 'Set as default wallet')
    .action(async (name?: string, options?: { setDefault?: boolean }) => {
      try {
        // Prompt for name if not provided
        if (!name) {
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Enter wallet name:',
              validate: (input) => {
                if (!isValidWalletName(input)) {
                  return 'Wallet name must be 1-32 alphanumeric characters, hyphens, or underscores';
                }
                if (hasWallet(input)) {
                  return `Wallet "${input}" already exists`;
                }
                return true;
              },
            },
          ]);
          name = answers.name;
        }

        // Prompt for password
        const { password, confirmPassword } = await inquirer.prompt([
          {
            type: 'password',
            name: 'password',
            message: 'Enter password to encrypt wallet:',
            mask: '*',
            validate: (input) => input.length >= 8 || 'Password must be at least 8 characters',
          },
          {
            type: 'password',
            name: 'confirmPassword',
            message: 'Confirm password:',
            mask: '*',
          },
        ]);

        if (password !== confirmPassword) {
          console.log(error('Passwords do not match'));
          return;
        }

        const spinner = ora('Creating wallet...').start();

        const result = await createWallet(name!, password);

        spinner.succeed('Wallet created');

        console.log();
        console.log(bold('Wallet Details'));
        console.log(`  Name:    ${name}`);
        console.log(`  Address: ${result.address}`);
        console.log();
        console.log(warning('IMPORTANT: Save your recovery phrase securely!'));
        console.log(warning('Anyone with this phrase can access your wallet.'));
        console.log();
        console.log(bold('Recovery Phrase:'));
        console.log(chalk.cyan(`  ${result.mnemonic}`));
        console.log();

        if (options?.setDefault) {
          setDefaultWallet(name!);
          console.log(success(`Set "${name}" as default wallet`));
        }
      } catch (err) {
        console.log(error(err instanceof Error ? err.message : 'Failed to create wallet'));
      }
    });

  // Import wallet
  wallet
    .command('import')
    .description('Import a wallet from mnemonic or private key')
    .argument('[name]', 'Wallet name')
    .option('-m, --mnemonic', 'Import from mnemonic phrase')
    .option('-k, --key', 'Import from private key')
    .option('--set-default', 'Set as default wallet')
    .action(async (name?: string, options?: { mnemonic?: boolean; key?: boolean; setDefault?: boolean }) => {
      try {
        // Determine import type
        let importType = options?.mnemonic ? 'mnemonic' : options?.key ? 'key' : null;

        if (!importType) {
          const { type } = await inquirer.prompt([
            {
              type: 'list',
              name: 'type',
              message: 'Import from:',
              choices: [
                { name: 'Mnemonic phrase (12 or 24 words)', value: 'mnemonic' },
                { name: 'Private key', value: 'key' },
              ],
            },
          ]);
          importType = type;
        }

        // Prompt for name if not provided
        if (!name) {
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Enter wallet name:',
              validate: (input) => {
                if (!isValidWalletName(input)) {
                  return 'Wallet name must be 1-32 alphanumeric characters, hyphens, or underscores';
                }
                if (hasWallet(input)) {
                  return `Wallet "${input}" already exists`;
                }
                return true;
              },
            },
          ]);
          name = answers.name;
        }

        let address: string;

        if (importType === 'mnemonic') {
          const { mnemonic, password, confirmPassword } = await inquirer.prompt([
            {
              type: 'password',
              name: 'mnemonic',
              message: 'Enter mnemonic phrase:',
              mask: '*',
              validate: (input) => isValidMnemonic(input) || 'Invalid mnemonic phrase',
            },
            {
              type: 'password',
              name: 'password',
              message: 'Enter password to encrypt wallet:',
              mask: '*',
              validate: (input) => input.length >= 8 || 'Password must be at least 8 characters',
            },
            {
              type: 'password',
              name: 'confirmPassword',
              message: 'Confirm password:',
              mask: '*',
            },
          ]);

          if (password !== confirmPassword) {
            console.log(error('Passwords do not match'));
            return;
          }

          const spinner = ora('Importing wallet...').start();
          address = await importWalletFromMnemonic(name!, mnemonic, password);
          spinner.succeed('Wallet imported');
        } else {
          const { privateKey, password, confirmPassword } = await inquirer.prompt([
            {
              type: 'password',
              name: 'privateKey',
              message: 'Enter private key:',
              mask: '*',
              validate: (input) => isValidPrivateKey(input) || 'Invalid private key',
            },
            {
              type: 'password',
              name: 'password',
              message: 'Enter password to encrypt wallet:',
              mask: '*',
              validate: (input) => input.length >= 8 || 'Password must be at least 8 characters',
            },
            {
              type: 'password',
              name: 'confirmPassword',
              message: 'Confirm password:',
              mask: '*',
            },
          ]);

          if (password !== confirmPassword) {
            console.log(error('Passwords do not match'));
            return;
          }

          const spinner = ora('Importing wallet...').start();
          address = await importWalletFromPrivateKey(name!, privateKey, password);
          spinner.succeed('Wallet imported');
        }

        console.log();
        console.log(bold('Wallet Details'));
        console.log(`  Name:    ${name}`);
        console.log(`  Address: ${address}`);
        console.log();

        if (options?.setDefault) {
          setDefaultWallet(name!);
          console.log(success(`Set "${name}" as default wallet`));
        }
      } catch (err) {
        console.log(error(err instanceof Error ? err.message : 'Failed to import wallet'));
      }
    });

  // List wallets
  wallet
    .command('list')
    .alias('ls')
    .description('List all wallets')
    .action(() => {
      const wallets = listWallets();
      const defaultWallet = getDefaultWallet();

      if (wallets.length === 0) {
        console.log('No wallets found. Create one with: fhe-wallet wallet create');
        return;
      }

      const table = new Table({
        head: ['Name', 'Address', 'Created', 'Default'],
        style: { head: ['cyan'] },
      });

      for (const w of wallets) {
        const isDefault = w.name === defaultWallet;
        table.push([
          w.name,
          formatAddress(w.address),
          formatDate(w.createdAt),
          isDefault ? chalk.green('*') : '',
        ]);
      }

      console.log(table.toString());
    });

  // Remove wallet
  wallet
    .command('remove')
    .alias('rm')
    .description('Remove a wallet')
    .argument('<name>', 'Wallet name to remove')
    .option('-f, --force', 'Skip confirmation')
    .action(async (name: string, options: { force?: boolean }) => {
      if (!hasWallet(name)) {
        console.log(error(`Wallet "${name}" not found`));
        return;
      }

      if (!options.force) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Are you sure you want to remove wallet "${name}"? This cannot be undone.`,
            default: false,
          },
        ]);

        if (!confirm) {
          console.log('Cancelled');
          return;
        }
      }

      const removed = removeWallet(name);

      if (removed) {
        console.log(success(`Wallet "${name}" removed`));

        // Clear default if this was the default wallet
        const defaultWallet = getDefaultWallet();
        if (defaultWallet === name) {
          setDefaultWallet('');
        }
      } else {
        console.log(error(`Failed to remove wallet "${name}"`));
      }
    });

  // Set default wallet
  wallet
    .command('set-default')
    .description('Set the default wallet')
    .argument('<name>', 'Wallet name')
    .action((name: string) => {
      if (!hasWallet(name)) {
        console.log(error(`Wallet "${name}" not found`));
        return;
      }

      setDefaultWallet(name);
      console.log(success(`Set "${name}" as default wallet`));
    });
}

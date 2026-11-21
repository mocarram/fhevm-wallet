/**
 * Wallet CLI commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { formatPhrase, showSecretScreen } from '../utils/secretScreen.js';
import Table from 'cli-table3';
import { prompts, SECRET_MASK } from '../utils/prompts.js';
import {
  createWallet,
  importWalletFromMnemonic,
  importWalletFromPrivateKey,
  listWallets,
  removeWallet,
  hasWallet,
  exportWalletPrivateKey,
  exportKeystoreFile,
} from '../../core/wallet/index.js';
import { setDefaultWallet, getDefaultWallet } from '../../storage/ConfigStore.js';
import {
  formatAddress,
  formatDate,
  success,
  error,
  warning,
  bold,
} from '../../utils/formatting.js';
import {
  isValidWalletName,
  isValidMnemonic,
  isValidPrivateKey,
  passwordStrengthHint,
} from '../../utils/validation.js';
import { describeError } from '../utils/userError.js';

/** Validation for a new wallet's name: allowed characters and not already taken. */
function validateNewWalletName(input: string): string | true {
  if (!isValidWalletName(input)) {
    return 'Wallet name must be 1-32 alphanumeric characters, hyphens, or underscores';
  }
  if (hasWallet(input)) {
    return `Wallet "${input}" already exists`;
  }
  return true;
}

/** Ask for a new wallet password twice; the caller compares the two. */
async function askNewPassword(): Promise<{ password: string; confirmPassword: string }> {
  const password = await prompts.password({
    message: 'Enter password to encrypt wallet:',
    mask: SECRET_MASK,
    validate: (input) => input.length >= 8 || 'Password must be at least 8 characters',
  });
  const confirmPassword = await prompts.password({
    message: 'Confirm password:',
    mask: SECRET_MASK,
  });
  return { password, confirmPassword };
}

export function registerWalletCommands(program: Command): void {
  const wallet = program.command('wallet').description('Manage wallets');

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
          name = await prompts.input({
            message: 'Enter wallet name:',
            validate: validateNewWalletName,
          });
        }

        // Prompt for password
        const { password, confirmPassword } = await askNewPassword();

        if (password !== confirmPassword) {
          process.exitCode = 1;
          console.log(error('Passwords do not match'));
          return;
        }
        // Soft advice only; never blocks wallet creation.
        const strengthHint = passwordStrengthHint(password);
        if (strengthHint) console.log(warning(strengthHint));

        const spinner = ora('Creating wallet...').start();

        const result = await createWallet(name!, password);

        spinner.succeed('Wallet created');

        console.log();
        console.log(bold('Wallet Details'));
        console.log(`  Name:    ${name}`);
        console.log(`  Address: ${result.address}`);
        console.log();
        console.log(warning('Next: your recovery phrase opens on a private screen.'));
        console.log(warning('Anyone with this phrase can access your wallet.'));
        const wiped = await showSecretScreen(
          'Recovery phrase for ' + name,
          formatPhrase(result.mnemonic!),
        );
        if (wiped) console.log(success('Recovery phrase screen wiped.'));

        if (options?.setDefault) {
          setDefaultWallet(name!);
          console.log(success(`Set "${name}" as default wallet`));
        }
      } catch (err) {
        process.exitCode = 1;
        console.log(error(describeError(err, 'Failed to create wallet')));
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
    .action(
      async (
        name?: string,
        options?: { mnemonic?: boolean; key?: boolean; setDefault?: boolean },
      ) => {
        try {
          // Determine import type
          let importType = options?.mnemonic ? 'mnemonic' : options?.key ? 'key' : null;

          if (!importType) {
            importType = await prompts.select({
              message: 'Import from:',
              choices: [
                { name: 'Mnemonic phrase (12 or 24 words)', value: 'mnemonic' },
                { name: 'Private key', value: 'key' },
              ],
            });
          }

          // Prompt for name if not provided
          if (!name) {
            name = await prompts.input({
              message: 'Enter wallet name:',
              validate: validateNewWalletName,
            });
          }

          let address: string;

          if (importType === 'mnemonic') {
            const mnemonic = await prompts.password({
              message: 'Enter mnemonic phrase:',
              mask: SECRET_MASK,
              validate: (input) => isValidMnemonic(input) || 'Invalid mnemonic phrase',
            });
            const { password, confirmPassword } = await askNewPassword();

            if (password !== confirmPassword) {
              process.exitCode = 1;
              console.log(error('Passwords do not match'));
              return;
            }
            // Soft advice only; never blocks wallet creation.
            const strengthHint = passwordStrengthHint(password);
            if (strengthHint) console.log(warning(strengthHint));

            const spinner = ora('Importing wallet...').start();
            address = await importWalletFromMnemonic(name!, mnemonic, password);
            spinner.succeed('Wallet imported');
          } else {
            const privateKey = await prompts.password({
              message: 'Enter private key:',
              mask: SECRET_MASK,
              validate: (input) => isValidPrivateKey(input) || 'Invalid private key',
            });
            const { password, confirmPassword } = await askNewPassword();

            if (password !== confirmPassword) {
              process.exitCode = 1;
              console.log(error('Passwords do not match'));
              return;
            }
            // Soft advice only; never blocks wallet creation.
            const strengthHint = passwordStrengthHint(password);
            if (strengthHint) console.log(warning(strengthHint));

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
          process.exitCode = 1;
          console.log(error(describeError(err, 'Failed to import wallet')));
        }
      },
    );

  // List wallets
  wallet
    .command('list')
    .alias('ls')
    .description('List all wallets')
    .option('--full', 'Show full wallet addresses')
    .action((options: { full?: boolean }) => {
      const wallets = listWallets();
      const defaultWallet = getDefaultWallet();

      if (wallets.length === 0) {
        console.log('No wallets found. Create one with: fhevm-wallet wallet create');
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
          options.full ? w.address : formatAddress(w.address),
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
        process.exitCode = 1;
        console.log(error(`Wallet "${name}" not found`));
        return;
      }

      if (!options.force) {
        const confirm = await prompts.confirm({
          message: `Are you sure you want to remove wallet "${name}"? This cannot be undone.`,
          default: false,
        });

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
        process.exitCode = 1;
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
        process.exitCode = 1;
        console.log(error(`Wallet "${name}" not found`));
        return;
      }

      setDefaultWallet(name);
      console.log(success(`Set "${name}" as default wallet`));
    });

  // Export wallet private key
  wallet
    .command('export')
    .description('Export wallet private key, or its encrypted keystore file with --keystore')
    .argument('<name>', 'Wallet name')
    .option(
      '-k, --keystore <file>',
      'Write the encrypted keystore (still password-protected) to <file> instead',
    )
    .action(async (name: string, options?: { keystore?: string }) => {
      if (options?.keystore) {
        // The safer export: no decryption, the file stays protected by the wallet password.
        try {
          const path = exportKeystoreFile(name, options.keystore);
          console.log(success(`Encrypted keystore saved to ${path} (owner-only access)`));
        } catch (err) {
          process.exitCode = 1;
          console.log(error(describeError(err, 'Export failed')));
        }
        return;
      }

      if (!hasWallet(name)) {
        process.exitCode = 1;
        console.log(error(`Wallet "${name}" not found`));
        return;
      }

      console.log();
      console.log(warning('WARNING: Your private key grants full access to your wallet.'));
      console.log(warning('Never share it with anyone or enter it on untrusted websites.'));
      console.log();

      let confirm: boolean;
      try {
        confirm = await prompts.confirm({
          message: 'Do you understand the risks and want to continue?',
          default: false,
        });
      } catch (err) {
        // No terminal (or Ctrl+C): one "✗" line like every other refusal, never "Error:".
        process.exitCode = 1;
        console.log(error(describeError(err, 'Cancelled')));
        return;
      }

      if (!confirm) {
        console.log('Cancelled');
        return;
      }

      const password = await prompts.password({
        message: 'Enter wallet password:',
        mask: SECRET_MASK,
      });

      const spinner = ora('Decrypting wallet...').start();

      try {
        const privateKey = await exportWalletPrivateKey(name, password);
        spinner.succeed('Wallet decrypted');

        const wiped = await showSecretScreen('Private key for ' + name, [privateKey]);
        if (wiped) console.log(success('Private key screen wiped.'));
      } catch (err) {
        spinner.fail('Failed to decrypt wallet');
        process.exitCode = 1;
        console.log(error(describeError(err, 'Invalid password')));
      }
    });
}

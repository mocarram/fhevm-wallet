/**
 * Wallet CLI commands
 */

import { Command, Option } from 'commander';
import { mockJson, printJson } from '../utils/json.js';
import chalk from 'chalk';
import { spinner as ora } from '../utils/spinner.js';
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
  tableStyle,
} from '../../utils/formatting.js';
import {
  isValidWalletName,
  isValidMnemonic,
  isValidPrivateKey,
  passwordStrengthHint,
} from '../../utils/validation.js';
import { describeError } from '../utils/userError.js';
import {
  isWrongPassword,
  newPasswordProblem,
  passwordStdinNeeded,
  readPasswordFromStdin,
  readSecretAndPasswordFromStdin,
  wrongPasswordMessage,
} from '../utils/passwordInput.js';

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

const NAME_NEEDED = 'Give the wallet a name: there is no terminal to ask for one.';

/** Refuse with one red line and exit code 1. */
function refuse(message: string): void {
  process.exitCode = 1;
  console.log(error(message));
}

/**
 * A password read from a pipe, in the shape `askNewPassword` returns (nothing to
 * confirm); the length rule still applies.
 */
async function piped(password: string): Promise<{ password: string; confirmPassword: string }> {
  const problem = newPasswordProblem(password);
  if (problem) throw new Error(problem);
  return { password, confirmPassword: password };
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
    .option(
      '--password-stdin',
      'Read the new password from stdin (for scripts; the phrase is then printed, not shown on a private screen)',
    )
    .action(async (name?: string, options?: { setDefault?: boolean; passwordStdin?: boolean }) => {
      try {
        // Prompt for name if not provided
        if (!name) {
          if (!process.stdin.isTTY) return refuse(NAME_NEEDED);
          name = await prompts.input({
            message: 'Enter wallet name:',
            validate: validateNewWalletName,
          });
        } else {
          const bad = validateNewWalletName(name);
          if (bad !== true) return refuse(bad);
        }

        // Prompt for password (or read it from a pipe)
        if (!options?.passwordStdin && !process.stdin.isTTY) {
          return refuse(passwordStdinNeeded(false, 'wallet create <name>')!);
        }
        const { password, confirmPassword } = options?.passwordStdin
          ? await piped(await readPasswordFromStdin())
          : await askNewPassword();

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
    .option(
      '--password-stdin',
      'Read from stdin: the phrase (or key) on the first line, the new password on the second',
    )
    .action(
      async (
        name?: string,
        options?: {
          mnemonic?: boolean;
          key?: boolean;
          setDefault?: boolean;
          passwordStdin?: boolean;
        },
      ) => {
        try {
          // Determine import type
          let importType = options?.mnemonic ? 'mnemonic' : options?.key ? 'key' : null;
          const scripted = Boolean(options?.passwordStdin);
          if (scripted || !process.stdin.isTTY) {
            // No prompts: everything comes from the options and the pipe.
            if (!importType) return refuse('Say what to import: add --mnemonic or --key.');
            if (!name) return refuse(NAME_NEEDED);
            if (!scripted) {
              return refuse(
                'No terminal to ask for the secret. Pipe it in with --password-stdin: the phrase (or key) on the first line, the new password on the second.',
              );
            }
          }
          if (name) {
            const bad = validateNewWalletName(name);
            if (bad !== true) return refuse(bad);
          }
          const fromPipe = scripted ? await readSecretAndPasswordFromStdin() : null;

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
            const mnemonic = fromPipe
              ? fromPipe.secret
              : await prompts.password({
                  message: 'Enter mnemonic phrase:',
                  mask: SECRET_MASK,
                  validate: (input) => isValidMnemonic(input) || 'Invalid mnemonic phrase',
                });
            if (!isValidMnemonic(mnemonic)) return refuse('Invalid mnemonic phrase');
            const { password, confirmPassword } = fromPipe
              ? await piped(fromPipe.password)
              : await askNewPassword();

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
            const privateKey = fromPipe
              ? fromPipe.secret
              : await prompts.password({
                  message: 'Enter private key:',
                  mask: SECRET_MASK,
                  validate: (input) => isValidPrivateKey(input) || 'Invalid private key',
                });
            if (!isValidPrivateKey(privateKey)) return refuse('Invalid private key');
            const { password, confirmPassword } = fromPipe
              ? await piped(fromPipe.password)
              : await askNewPassword();

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
    .option('--json', 'Print machine-readable JSON')
    .action((options: { full?: boolean; json?: boolean }) => {
      const wallets = listWallets();
      const defaultWallet = getDefaultWallet();

      if (options.json) {
        printJson({
          mock: mockJson(),
          wallets: wallets.map((w) => ({
            name: w.name,
            address: w.address,
            createdAt: w.createdAt,
            isDefault: w.name === defaultWallet,
          })),
        });
        return;
      }

      if (wallets.length === 0) {
        console.log('No wallets found. Create one with: fhevm-wallet wallet create');
        return;
      }

      const table = new Table({
        head: ['Name', 'Address', 'Created', 'Default'],
        style: tableStyle(),
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
    .option('-y, --yes', 'Remove without asking')
    .addOption(new Option('-f, --force', 'Same as --yes (older name)').hideHelp())
    .action(async (name: string, options: { yes?: boolean; force?: boolean }) => {
      if (!hasWallet(name)) {
        process.exitCode = 1;
        console.log(error(`Wallet "${name}" not found`));
        return;
      }

      const skipConfirm = options.yes || options.force;
      if (!skipConfirm && !process.stdin.isTTY) {
        return refuse(
          `No terminal to confirm removing "${name}". Add --yes to remove it without asking (back it up first).`,
        );
      }
      if (!skipConfirm) {
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
        console.log(
          error(
            isWrongPassword(err)
              ? wrongPasswordMessage(name)
              : describeError(err, 'Could not decrypt the wallet'),
          ),
        );
      }
    });
}

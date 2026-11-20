/**
 * CLI setup with Commander.js
 */

import { Command } from 'commander';
import { createRequire } from 'module';
import chalk from 'chalk';
import { registerWalletCommands } from './commands/wallet.js';
import { registerTokenCommands } from './commands/token.js';
import { registerBalanceCommand } from './commands/balance.js';
import { registerTransferCommand } from './commands/transfer.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerInteractiveCommand } from './commands/interactive.js';
import { updateConfig, loadConfig } from '../storage/ConfigStore.js';
import { isValidNetwork } from '../utils/validation.js';
import { NetworkName, DEFAULT_RPC_URLS } from '../core/network/NetworkConfig.js';
import { saveEnvVar, getEnvVar } from '../storage/paths.js';
import { setCustomRpc } from '../core/network/rpcSettings.js';
import { clearProviderCache } from '../core/network/ProviderFactory.js';
import { describeError } from './utils/userError.js';
import { maskUrl } from '../utils/redact.js';
import { resolveSecretOption, secretOptionHelp } from './utils/secretInput.js';

/**
 * Read the version from package.json at runtime so `--version` can never drift from the
 * published package. Resolved relative to this module: src/cli or dist/cli → ../../.
 */
function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../../package.json') as { version: string }).version;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('fhevm-wallet')
    .description('CLI wallet for managing encrypted ERC-7984 tokens using Zama FHE')
    .version(packageVersion());

  // Global options
  program
    .option('-n, --network <network>', 'Network to use (sepolia or mainnet)')
    .hook('preAction', (thisCommand) => {
      const options = thisCommand.opts();
      if (options.network) {
        if (!isValidNetwork(options.network)) {
          console.log(chalk.red('Invalid network. Use "sepolia" or "mainnet"'));
          process.exit(1);
        }
        // Temporarily set network for this command
        process.env.OVERRIDE_NETWORK = options.network;
      }
    })
    // Destroy cached providers once a command is done, so nothing (a pending poll, a
    // keep-alive socket) holds the process open after its output is printed.
    .hook('postAction', () => {
      clearProviderCache();
    });

  // Register all commands
  registerWalletCommands(program);
  registerTokenCommands(program);
  registerBalanceCommand(program);
  registerTransferCommand(program);
  registerHistoryCommand(program);
  registerInteractiveCommand(program);

  // Config command
  program
    .command('config')
    .description('View or update configuration')
    .option('--network <network>', 'Set default network')
    .option('--show', 'Show current configuration')
    .option('--rpc-mainnet <url>', 'Set Mainnet RPC URL')
    .option('--rpc-sepolia <url>', 'Set Sepolia RPC URL')
    .option('--etherscan-key [key]', secretOptionHelp('the Etherscan API key'))
    .option('--zama-key [key]', secretOptionHelp('the Zama mainnet API key'))
    .action(
      async (options: {
        network?: string;
        show?: boolean;
        rpcMainnet?: string;
        rpcSepolia?: string;
        etherscanKey?: string | true;
        zamaKey?: string | true;
      }) => {
        const hasSetOption =
          options.network ||
          options.rpcMainnet ||
          options.rpcSepolia ||
          options.etherscanKey ||
          options.zamaKey;

        if (options.show || !hasSetOption) {
          const config = loadConfig();
          const mainnetRpc = getEnvVar('MAINNET_RPC_URL');
          const sepoliaRpc = getEnvVar('SEPOLIA_RPC_URL');
          const etherscanKey = getEnvVar('ETHERSCAN_API_KEY');
          const zamaKey = getEnvVar('ZAMA_MAINNET_API_KEY');

          console.log('Current configuration:');
          console.log(`  Default network: ${config.defaultNetwork}`);
          console.log(`  Default wallet:  ${config.defaultWallet || '(none)'}`);
          console.log();
          console.log('RPC Endpoints:');
          console.log(
            `  Mainnet: ${mainnetRpc ? maskUrl(mainnetRpc) : DEFAULT_RPC_URLS.mainnet}${mainnetRpc ? chalk.cyan(' (custom)') : chalk.dim(' (default)')}`,
          );
          console.log(
            `  Sepolia: ${sepoliaRpc ? maskUrl(sepoliaRpc) : DEFAULT_RPC_URLS.sepolia}${sepoliaRpc ? chalk.cyan(' (custom)') : chalk.dim(' (default)')}`,
          );
          console.log();
          console.log('API Keys:');
          console.log(
            `  Etherscan: ${etherscanKey ? '••••' + etherscanKey.slice(-4) : chalk.dim('(not set)')}`,
          );
          console.log(
            `  Zama:      ${zamaKey ? '••••' + zamaKey.slice(-4) : chalk.dim('(not set)')}`,
          );
          return;
        }

        if (options.network) {
          if (!isValidNetwork(options.network)) {
            console.log(chalk.red('Invalid network. Use "sepolia" or "mainnet"'));
            process.exitCode = 1;
            return;
          }
          updateConfig({ defaultNetwork: options.network as NetworkName });
          console.log(chalk.green(`Default network set to ${options.network}`));
        }

        if (options.rpcMainnet) {
          try {
            const probe = await setCustomRpc('mainnet', options.rpcMainnet);
            console.log(chalk.green(`Mainnet RPC URL updated (answered in ${probe.latencyMs} ms)`));
          } catch (err) {
            console.log(chalk.red(describeError(err, 'Could not set RPC URL')));
            process.exitCode = 1;
          }
        }

        if (options.rpcSepolia) {
          try {
            const probe = await setCustomRpc('sepolia', options.rpcSepolia);
            console.log(chalk.green(`Sepolia RPC URL updated (answered in ${probe.latencyMs} ms)`));
          } catch (err) {
            console.log(chalk.red(describeError(err, 'Could not set RPC URL')));
            process.exitCode = 1;
          }
        }

        if (options.etherscanKey) {
          try {
            const key = await resolveSecretOption(options.etherscanKey, 'Etherscan API key');
            if (!key) throw new Error('No key entered; nothing was saved.');
            saveEnvVar('ETHERSCAN_API_KEY', key);
            console.log(chalk.green('Etherscan API key saved'));
          } catch (err) {
            console.log(chalk.red(describeError(err, 'Could not save key')));
            process.exitCode = 1;
          }
        }

        if (options.zamaKey) {
          try {
            const key = await resolveSecretOption(options.zamaKey, 'Zama mainnet API key');
            if (!key) throw new Error('No key entered; nothing was saved.');
            saveEnvVar('ZAMA_MAINNET_API_KEY', key);
            console.log(chalk.green('Zama Mainnet API key saved'));
          } catch (err) {
            console.log(chalk.red(describeError(err, 'Could not save key')));
            process.exitCode = 1;
          }
        }
      },
    );

  return program;
}

export { runInteractiveMode } from './commands/interactive.js';

/**
 * CLI setup with Commander.js
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { registerWalletCommands } from './commands/wallet.js';
import { registerTokenCommands } from './commands/token.js';
import { registerBalanceCommand } from './commands/balance.js';
import { registerTransferCommand } from './commands/transfer.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerInteractiveCommand, runInteractiveMode } from './commands/interactive.js';
import { updateConfig, loadConfig } from '../storage/ConfigStore.js';
import { isValidNetwork } from '../utils/validation.js';
import { NetworkName } from '../core/network/NetworkConfig.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('fhe-wallet')
    .description('CLI wallet for managing encrypted ERC-7984 tokens using Zama FHE')
    .version('1.0.0');

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
    .action((options: { network?: string; show?: boolean }) => {
      if (options.show || (!options.network)) {
        const config = loadConfig();
        console.log('Current configuration:');
        console.log(`  Default network: ${config.defaultNetwork}`);
        console.log(`  Default wallet:  ${config.defaultWallet || '(none)'}`);
        return;
      }

      if (options.network) {
        if (!isValidNetwork(options.network)) {
          console.log(chalk.red('Invalid network. Use "sepolia" or "mainnet"'));
          return;
        }
        updateConfig({ defaultNetwork: options.network as NetworkName });
        console.log(chalk.green(`Default network set to ${options.network}`));
      }
    });

  return program;
}

export { runInteractiveMode } from './commands/interactive.js';

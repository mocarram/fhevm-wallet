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
import { registerDoctorCommand } from './commands/doctor.js';
import { updateConfig, loadConfig } from '../storage/ConfigStore.js';
import { isValidNetwork } from '../utils/validation.js';
import { NetworkName, DEFAULT_RPC_URLS, invalidRpcReason } from '../core/network/NetworkConfig.js';
import { saveEnvVar, settingSource, SettingSource } from '../storage/paths.js';
import { setCustomRpc } from '../core/network/rpcSettings.js';
import { clearProviderCache } from '../core/network/ProviderFactory.js';
import { describeError } from './utils/userError.js';
import { adoptTypedNetwork } from './utils/networkOption.js';
import { maskUrl } from '../utils/redact.js';
import { validateTokenListUrl } from '../core/token/tokenLists.js';
import { enterJsonMode, printJson, printJsonError } from './utils/json.js';
import { resolveSecretOption, rpcOptionHelp, secretOptionHelp } from './utils/secretInput.js';

/**
 * Read the version from package.json at runtime so `--version` can never drift from the
 * published package. Resolved relative to this module: src/cli or dist/cli → ../../.
 */
function packageVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../../package.json') as { version: string }).version;
}

/** How `config --show` names where a setting comes from. */
const SOURCE_LABELS: Record<SettingSource, string> = {
  settings: 'from settings',
  cwd: 'from ./.env',
  environment: 'from the environment',
};

/** Where an RPC setting comes from, and whether it is used, for `config --show --json`. */
function rpcJson(key: 'MAINNET_RPC_URL' | 'SEPOLIA_RPC_URL', fallback: string) {
  const value = process.env[key];
  const source = settingSource(key);
  const invalid = invalidRpcReason(key);
  if (value && source && !invalid) {
    return { url: maskUrl(value), custom: true, source };
  }
  return {
    url: fallback,
    custom: false,
    source: 'default',
    ...(value && source && invalid ? { ignored: { source, reason: invalid } } : {}),
  };
}

/** Keys are shown as "set" plus their last 4 characters, like the text output. */
function keyJson(key: string) {
  const value = process.env[key];
  const source = settingSource(key);
  return value && source ? { set: true, last4: value.slice(-4), source } : { set: false };
}

/** `config --show --json`: stable keys, URLs masked, API keys never in full. */
function configJson(config: {
  defaultNetwork: string;
  defaultWallet?: string;
  tokenListUrl?: string;
}) {
  return {
    defaultNetwork: config.defaultNetwork,
    defaultWallet: config.defaultWallet ?? null,
    tokenListUrl: config.tokenListUrl ? maskUrl(config.tokenListUrl) : null,
    rpc: {
      mainnet: rpcJson('MAINNET_RPC_URL', DEFAULT_RPC_URLS.mainnet),
      sepolia: rpcJson('SEPOLIA_RPC_URL', DEFAULT_RPC_URLS.sepolia),
    },
    apiKeys: {
      etherscan: keyJson('ETHERSCAN_API_KEY'),
      zama: keyJson('ZAMA_MAINNET_API_KEY'),
    },
  };
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
    .hook('preAction', (thisCommand, actionCommand) => {
      const options = thisCommand.opts();
      // --json: no colours anywhere, and errors as JSON (see utils/json.ts).
      const json = Boolean(actionCommand.opts().json);
      if (json) enterJsonMode();
      if (options.network && !isValidNetwork(options.network)) {
        if (json) printJsonError('INVALID_NETWORK', 'Invalid network. Use "sepolia" or "mainnet"');
        else console.log(chalk.red('Invalid network. Use "sepolia" or "mainnet"'));
        process.exit(1);
      }
      // `fhew balance -n mainnet`: commander hands -n to this program-level option, so
      // pass it on to the subcommand's own option (see utils/networkOption.ts).
      adoptTypedNetwork(actionCommand);
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
  registerDoctorCommand(program);

  // Config command
  program
    .command('config')
    .description('View or update configuration')
    .option('--network <network>', 'Set default network')
    .option('--show', 'Show current configuration')
    .option('--rpc-mainnet <url>', rpcOptionHelp('Mainnet'))
    .option('--rpc-sepolia <url>', rpcOptionHelp('Sepolia'))
    .option('--etherscan-key [key]', secretOptionHelp('the Etherscan API key'))
    .option('--zama-key [key]', secretOptionHelp('the Zama mainnet API key'))
    .option(
      '--token-list-url <url>',
      'Token list (token-list JSON) for "token find"; "none" clears it',
    )
    .option('--json', 'With --show (or no other option): print machine-readable JSON')
    .action(
      async (options: {
        network?: string;
        show?: boolean;
        rpcMainnet?: string;
        rpcSepolia?: string;
        etherscanKey?: string | true;
        zamaKey?: string | true;
        tokenListUrl?: string;
        json?: boolean;
      }) => {
        const hasSetOption =
          options.network ||
          options.rpcMainnet ||
          options.rpcSepolia ||
          options.etherscanKey ||
          options.zamaKey ||
          options.tokenListUrl;

        if (options.json && hasSetOption) {
          printJsonError(
            'JSON_NOT_SUPPORTED',
            '--json only works with --show. Change settings without --json.',
          );
          return;
        }
        if (options.show || !hasSetOption) {
          const config = loadConfig();
          if (options.json) {
            printJson(configJson(config));
            return;
          }
          // Show what is in effect (saved settings, ./.env or the environment), masked,
          // and where it comes from: a ./.env in this folder can change the RPC.
          const rpcLine = (key: 'MAINNET_RPC_URL' | 'SEPOLIA_RPC_URL', fallback: string) => {
            const value = process.env[key];
            const source = settingSource(key);
            // A URL that fails the https check is not used: say so, not "(custom)".
            const invalid = invalidRpcReason(key);
            if (value && source && invalid) {
              return `${fallback}${chalk.yellow(` (default; ${key} ${SOURCE_LABELS[source]} ignored: ${invalid})`)}`;
            }
            return value && source
              ? `${maskUrl(value)}${chalk.cyan(` (custom, ${SOURCE_LABELS[source]})`)}`
              : `${fallback}${chalk.dim(' (default)')}`;
          };
          const keyLine = (key: string) => {
            const value = process.env[key];
            const source = settingSource(key);
            return value && source
              ? `••••${value.slice(-4)}${chalk.dim(` (${SOURCE_LABELS[source]})`)}`
              : chalk.dim('(not set)');
          };

          console.log('Current configuration:');
          console.log(`  Default network: ${config.defaultNetwork}`);
          console.log(`  Default wallet:  ${config.defaultWallet || '(none)'}`);
          console.log();
          console.log('RPC Endpoints:');
          console.log(`  Mainnet: ${rpcLine('MAINNET_RPC_URL', DEFAULT_RPC_URLS.mainnet)}`);
          console.log(`  Sepolia: ${rpcLine('SEPOLIA_RPC_URL', DEFAULT_RPC_URLS.sepolia)}`);
          console.log();
          console.log('Token list:');
          console.log(
            `  ${config.tokenListUrl ? maskUrl(config.tokenListUrl) : chalk.dim('(none; only the lists shipped with the wallet)')}`,
          );
          console.log();
          console.log('API Keys:');
          console.log(`  Etherscan: ${keyLine('ETHERSCAN_API_KEY')}`);
          console.log(`  Zama:      ${keyLine('ZAMA_MAINNET_API_KEY')}`);
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

        if (options.tokenListUrl) {
          const url = options.tokenListUrl.trim();
          if (url.toLowerCase() === 'none') {
            updateConfig({ tokenListUrl: undefined });
            console.log(chalk.green('Token list URL cleared'));
          } else {
            const problem = validateTokenListUrl(url);
            if (problem) {
              console.log(chalk.red(problem));
              process.exitCode = 1;
            } else {
              updateConfig({ tokenListUrl: url });
              console.log(
                chalk.green(
                  `Token list URL saved. "fhew token find" downloads it (${maskUrl(url)}).`,
                ),
              );
            }
          }
        }

        if (options.rpcMainnet) {
          try {
            const url = await resolveSecretOption(options.rpcMainnet, 'Mainnet RPC URL');
            if (!url) throw new Error('No URL entered; nothing was saved.');
            const probe = await setCustomRpc('mainnet', url);
            console.log(chalk.green(`Mainnet RPC URL updated (answered in ${probe.latencyMs} ms)`));
          } catch (err) {
            console.log(chalk.red(describeError(err, 'Could not set RPC URL')));
            process.exitCode = 1;
          }
        }

        if (options.rpcSepolia) {
          try {
            const url = await resolveSecretOption(options.rpcSepolia, 'Sepolia RPC URL');
            if (!url) throw new Error('No URL entered; nothing was saved.');
            const probe = await setCustomRpc('sepolia', url);
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

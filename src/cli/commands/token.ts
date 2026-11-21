/**
 * Token CLI commands
 */

import { Command, Option } from 'commander';
import { resolveToken } from '../../core/send/index.js';
import { prompts } from '../utils/prompts.js';
import { spinner as ora } from '../utils/spinner.js';
import Table from 'cli-table3';
import {
  addTokenWithInfo,
  isTokenRegistered,
  listTokens,
  removeToken,
} from '../../core/token/TokenRegistry.js';
import { createBackend } from '../../core/backend/select.js';
import { describeNonCompliant } from '../../core/token/erc7984Check.js';
import { NetworkName } from '../../core/network/NetworkConfig.js';
import { getDefaultNetwork } from '../../storage/ConfigStore.js';
import { formatAddress, success, error, warning, tableStyle } from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';
import { describeError } from '../utils/userError.js';
import { mockJson, printJson, printJsonError } from '../utils/json.js';
import { registerTokenFind } from './tokenFind.js';

const NETWORK_ERROR = 'Invalid network. Use "sepolia" or "mainnet"';

export function registerTokenCommands(program: Command): void {
  const token = program.command('token').description('Manage tracked tokens');

  // Add token
  token
    .command('add')
    .description('Add a token to track (checked for ERC-7984 first)')
    .argument('[address]', 'Token contract address')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-f, --force', 'Add it even if it fails the ERC-7984 check')
    .action(async (address?: string, options?: { network?: string; force?: boolean }) => {
      try {
        // Determine network
        let network: NetworkName = getDefaultNetwork();
        if (options?.network) {
          if (!isValidNetwork(options.network)) {
            process.exitCode = 1;
            console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
            return;
          }
          network = options.network;
        }

        // Prompt for address if not provided
        if (!address) {
          const enteredAddress = await prompts.input({
            message: 'Enter token contract address:',
            validate: (input) => isValidAddress(input) || 'Invalid Ethereum address',
          });
          address = enteredAddress;
        }

        if (!isValidAddress(address!)) {
          process.exitCode = 1;
          console.log(error('Invalid Ethereum address'));
          return;
        }
        if (isTokenRegistered(address!, network)) {
          process.exitCode = 1;
          console.log(error(`That token is already tracked on ${network}.`));
          return;
        }

        const backend = createBackend();
        const spinner = ora(`Checking the token contract on ${network}...`).start();
        let check;
        try {
          check = await backend.checkToken(address!, network);
        } catch (err) {
          spinner.fail('Could not check the token');
          throw err;
        }
        if (!check.compliant) {
          spinner.warn('This contract failed the ERC-7984 check');
          const d = describeNonCompliant(check, network);
          console.log(error(d.title));
          if (check.info) for (const p of check.problems) console.log(`  - ${p}`);
          else console.log(`  ${d.hint}`);
          if (!options?.force || !check.info) {
            process.exitCode = 1;
            console.log(
              check.info
                ? 'Nothing was added. If you know this contract and trust it, add it anyway with --force.'
                : 'Nothing was added: it has no token name, symbol or decimals, so it cannot be tracked.',
            );
            return;
          }
        }
        const entry = addTokenWithInfo(check.info!, network);
        if (check.compliant) spinner.succeed('Token added');
        else console.log(warning('Added anyway (--force), although the ERC-7984 check failed.'));
        for (const w of check.warnings) console.log(warning(w));

        console.log();
        console.log(`  Name:     ${entry.name}`);
        console.log(`  Symbol:   ${entry.symbol}`);
        console.log(`  Decimals: ${entry.decimals}`);
        console.log(`  Address:  ${entry.address}`);
        console.log(`  Network:  ${entry.network}`);
      } catch (err) {
        process.exitCode = 1;
        console.log(error(describeError(err, 'Failed to add token')));
      }
    });

  registerTokenFind(token);

  // List tokens
  token
    .command('list')
    .alias('ls')
    .description('List tracked tokens')
    .option('-n, --network <network>', 'Filter by network')
    .option('--full', 'Show full token addresses')
    .option('--json', 'Print machine-readable JSON')
    .action((options?: { network?: string; full?: boolean; json?: boolean }) => {
      let network: NetworkName | undefined;
      if (options?.network) {
        if (!isValidNetwork(options.network)) {
          if (options.json) return printJsonError('INVALID_NETWORK', NETWORK_ERROR);
          process.exitCode = 1;
          console.log(error(NETWORK_ERROR));
          return;
        }
        network = options.network;
      }

      const tokens = listTokens(network);

      if (options?.json) {
        printJson({
          mock: mockJson(),
          // null: every network (no -n given).
          network: network ?? null,
          tokens: tokens.map((t) => ({
            address: t.address,
            name: t.name,
            symbol: t.symbol,
            decimals: t.decimals,
            network: t.network,
            addedAt: t.addedAt,
          })),
        });
        return;
      }

      if (tokens.length === 0) {
        console.log('No tokens tracked. Add one with: fhevm-wallet token add <address>');
        return;
      }

      const table = new Table({
        head: ['Symbol', 'Name', 'Address', 'Network', 'Decimals'],
        style: tableStyle(),
      });

      for (const t of tokens) {
        table.push([
          t.symbol,
          t.name,
          options?.full ? t.address : formatAddress(t.address),
          t.network,
          t.decimals.toString(),
        ]);
      }

      console.log(table.toString());
    });

  // Remove token
  token
    .command('remove')
    .alias('rm')
    .description('Remove a tracked token')
    .argument('<token>', 'Token symbol or contract address')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-y, --yes', 'Remove without asking')
    .addOption(new Option('-f, --force', 'Same as --yes (older name)').hideHelp())
    .action(
      async (tokenText: string, options: { network?: string; yes?: boolean; force?: boolean }) => {
        // Determine network
        let network: NetworkName = getDefaultNetwork();
        if (options?.network) {
          if (!isValidNetwork(options.network)) {
            process.exitCode = 1;
            console.log(error('Invalid network. Use "sepolia" or "mainnet"'));
            return;
          }
          network = options.network;
        }

        // A symbol (cusdc) or an address, like `fhew send`.
        let address = tokenText;
        if (!isValidAddress(tokenText)) {
          const r = resolveToken(tokenText, listTokens(network));
          if (!r.ok) {
            process.exitCode = 1;
            console.log(
              error(
                tokenText.toLowerCase().startsWith('0x') ? 'Invalid Ethereum address' : r.error,
              ),
            );
            return;
          }
          address = r.token.address;
        }

        const skipConfirm = options.yes || options.force;
        if (!skipConfirm && !process.stdin.isTTY) {
          process.exitCode = 1;
          console.log(
            error('No terminal to confirm. Add --yes to remove the token without asking.'),
          );
          return;
        }
        if (!skipConfirm) {
          const confirm = await prompts.confirm({
            message: `Remove token ${formatAddress(address)} from ${network}?`,
            default: false,
          });

          if (!confirm) {
            console.log('Cancelled');
            return;
          }
        }

        const removed = removeToken(address, network);

        if (removed) {
          console.log(success('Token removed'));
        } else {
          process.exitCode = 1;
          console.log(error('Token not found'));
        }
      },
    );
}

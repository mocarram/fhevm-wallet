/**
 * `fhew doctor`: check Node, the data folder, every RPC endpoint, the Zama relayer, ETH
 * for gas and each tracked token (ERC-7984). Exit code 1 when any check fails.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createBackend } from '../../core/backend/select.js';
import { doctorFailed, runDoctorChecks, type DoctorRow } from '../../core/doctor.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import { listTokens } from '../../core/token/TokenRegistry.js';
import { listWallets } from '../../core/wallet/index.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { DATA_DIR } from '../../storage/paths.js';
import { isValidNetwork } from '../../utils/validation.js';
import { error, formatNetworkName } from '../../utils/formatting.js';
import { describeError } from '../utils/userError.js';
import { failJson, printJson, printJsonError } from '../utils/json.js';

const MARKS: Record<DoctorRow['status'], string> = {
  ok: chalk.green('✓'),
  warn: chalk.yellow('!'),
  fail: chalk.red('✗'),
  info: chalk.dim('·'),
};

/** Register `fhew doctor`. */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check your setup: Node, data folder, RPC, relayer, gas and tokens')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('-w, --wallet <name>', 'Wallet whose ETH to check (default: the default wallet)')
    .option('--json', 'Print machine-readable JSON')
    .action(async (options: { network?: string; wallet?: string; json?: boolean }) => {
      try {
        let network: NetworkName = getDefaultNetwork();
        if (options.network) {
          if (!isValidNetwork(options.network)) {
            const msg = 'Invalid network. Use "sepolia" or "mainnet"';
            if (options.json) return printJsonError('INVALID_NETWORK', msg);
            process.exitCode = 1;
            console.log(error(msg));
            return;
          }
          network = options.network;
        }
        // The address comes from the wallet's metadata: no password needed.
        const wallets = listWallets();
        const name = options.wallet ?? getDefaultWallet() ?? wallets[0]?.name;
        const wallet = wallets.find((w) => w.name === name);
        if (options.wallet && !wallet) {
          const msg = `Wallet "${options.wallet}" not found`;
          if (options.json) return printJsonError('WALLET_NOT_FOUND', msg);
          process.exitCode = 1;
          console.log(error(msg));
          return;
        }
        const backend = createBackend();
        const rows = await runDoctorChecks({
          backend,
          network,
          address: wallet?.address,
          tokens: listTokens(network),
          dataDir: DATA_DIR,
          etherscanKey: Boolean(process.env.ETHERSCAN_API_KEY),
        });
        const failed = doctorFailed(rows);
        if (failed) process.exitCode = 1;

        if (options.json) {
          printJson({
            network,
            mock: backend.kind === 'mock',
            wallet: wallet ? { name: wallet.name, address: wallet.address } : null,
            ok: !failed,
            checks: rows.map((r) => ({
              id: r.id,
              status: r.status,
              text: r.text,
              detail: r.detail ?? null,
            })),
          });
          return;
        }

        console.log(
          `Checking ${formatNetworkName(network)}${wallet ? ` for ${wallet.name}` : ''}${backend.kind === 'mock' ? chalk.yellow(' (MOCK: simulated, no real funds)') : ''}`,
        );
        console.log();
        for (const r of rows) {
          console.log(`  ${MARKS[r.status]} ${r.text}`);
          if (r.detail) console.log(chalk.dim(`      ${r.detail}`));
        }
        console.log();
        const fails = rows.filter((r) => r.status === 'fail').length;
        const warns = rows.filter((r) => r.status === 'warn').length;
        console.log(
          failed
            ? chalk.red(`${fails} problem(s) need fixing before the wallet can work fully.`)
            : warns
              ? chalk.yellow(`Everything needed works. ${warns} thing(s) worth a look.`)
              : chalk.green('Everything looks good.'),
        );
      } catch (err) {
        if (options.json) return failJson(err, 'Doctor could not run');
        process.exitCode = 1;
        console.log(error(describeError(err, 'Doctor could not run')));
      }
    });
}

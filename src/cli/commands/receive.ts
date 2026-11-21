/**
 * `fhew receive`: show a wallet's address with a terminal QR code (or as JSON).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { NETWORK_CONFIGS, type NetworkName } from '../../core/network/NetworkConfig.js';
import { eip681, qrLines } from '../../core/qr.js';
import { listWallets } from '../../core/wallet/index.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { error, formatNetworkName } from '../../utils/formatting.js';
import { isValidNetwork } from '../../utils/validation.js';
import { printJson, printJsonError } from '../utils/json.js';

/** Register `fhew receive`. */
export function registerReceiveCommand(program: Command): void {
  program
    .command('receive')
    .description('Show your address and a QR code to receive tokens or ETH')
    .option('-w, --wallet <name>', 'Wallet (default: the default wallet)')
    .option('-n, --network <network>', 'Network (sepolia or mainnet)')
    .option('--eip681', 'Encode an EIP-681 link (ethereum:<address>@<chainId>) in the QR code')
    .option('--no-qr', 'Print the address only')
    .option('--json', 'Print machine-readable JSON (no QR code)')
    .action(
      (options: {
        wallet?: string;
        network?: string;
        eip681?: boolean;
        qr?: boolean;
        json?: boolean;
      }) => {
        const fail = (code: string, message: string) => {
          if (options.json) return printJsonError(code, message);
          process.exitCode = 1;
          console.log(error(message));
        };
        let network: NetworkName = getDefaultNetwork();
        if (options.network) {
          if (!isValidNetwork(options.network)) {
            return fail('INVALID_NETWORK', 'Invalid network. Use "sepolia" or "mainnet"');
          }
          network = options.network;
        }
        const wallets = listWallets();
        const name = options.wallet ?? getDefaultWallet() ?? wallets[0]?.name;
        const wallet = wallets.find((w) => w.name === name);
        if (!wallet) {
          return fail(
            options.wallet ? 'WALLET_NOT_FOUND' : 'NO_WALLET',
            options.wallet
              ? `Wallet "${options.wallet}" not found`
              : 'No wallet yet. Create one with: fhevm-wallet wallet create',
          );
        }
        const chainId = NETWORK_CONFIGS[network].chainIdNumber;
        const uri = eip681(wallet.address, chainId);
        if (options.json) {
          printJson({ wallet: wallet.name, address: wallet.address, network, chainId, uri });
          return;
        }
        console.log(`Send tokens or ETH on ${formatNetworkName(network)} to ${wallet.name}:`);
        console.log();
        console.log(`  ${chalk.bold(wallet.address)}`);
        if (options.qr !== false) {
          console.log();
          for (const l of qrLines(options.eip681 ? uri : wallet.address)) console.log(`  ${l}`);
          console.log(
            chalk.dim(
              options.eip681
                ? `  QR: ${uri}`
                : '  QR: the address only. Use --eip681 to include the network.',
            ),
          );
        }
      },
    );
}

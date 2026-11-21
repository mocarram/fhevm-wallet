/**
 * `fhew balance --json`: the same reads as `fhew balance`, printed as one JSON document.
 * Kept apart from the interactive table so neither path has to know about the other.
 */

import { walletPassword } from '../utils/passwordInput.js';
import { loadWallet, hasWallet } from '../../core/wallet/index.js';
import { listTokens, getToken, type TokenEntry } from '../../core/token/TokenRegistry.js';
import { getDecryptedBalance } from '../../core/token/TokenService.js';
import { checkFheReadiness } from '../../core/fhe/FheService.js';
import type { NetworkName } from '../../core/network/NetworkConfig.js';
import { getProvider } from '../../core/network/ProviderFactory.js';
import { getDefaultNetwork, getDefaultWallet } from '../../storage/ConfigStore.js';
import { formatTokenAmount } from '../../utils/formatting.js';
import { isValidAddress, isValidNetwork } from '../../utils/validation.js';
import { describeErrorShort } from '../utils/userError.js';
import { failJson, jsonErrorOf, printJson, printJsonError } from '../utils/json.js';

/** Options shared with `fhew balance`. */
export interface BalanceJsonOptions {
  wallet?: string;
  token?: string;
  network?: string;
  refresh?: boolean;
  passwordStdin?: boolean;
}

/**
 * Print `{wallet, address, network, eth, tokens[]}`. A token that cannot be decrypted
 * gets `balance: null` and an `error`; the command still exits 0 when the rest worked,
 * like the table, which shows the error in that row.
 */
export async function balanceJson(options: BalanceJsonOptions): Promise<void> {
  try {
    let network: NetworkName = getDefaultNetwork();
    if (options.network) {
      if (!isValidNetwork(options.network)) {
        return printJsonError('INVALID_NETWORK', 'Invalid network. Use "sepolia" or "mainnet"');
      }
      network = options.network;
    }
    const notReady = checkFheReadiness(network);
    if (notReady) return printJsonError('FHE_NOT_READY', notReady);

    const walletName = options.wallet || getDefaultWallet();
    if (!walletName) {
      return printJsonError(
        'NO_WALLET',
        'No wallet chosen. Pass --wallet <name> or set a default.',
      );
    }
    if (!hasWallet(walletName)) {
      return printJsonError('WALLET_NOT_FOUND', `Wallet "${walletName}" not found`);
    }
    // A password prompt would write to stdout and break the JSON.
    if (!options.passwordStdin) {
      return printJsonError(
        'PASSWORD_STDIN_REQUIRED',
        'With --json, pass the password on standard input with --password-stdin.',
      );
    }

    let tokens: TokenEntry[];
    if (options.token) {
      if (!isValidAddress(options.token)) {
        return printJsonError('INVALID_ADDRESS', 'Invalid token address');
      }
      const t = getToken(options.token, network);
      if (!t) {
        return printJsonError(
          'TOKEN_NOT_TRACKED',
          `Token ${options.token} not tracked. Add it with: fhevm-wallet token add ${options.token}`,
        );
      }
      tokens = [t];
    } else {
      tokens = listTokens(network);
    }

    const password = await walletPassword(true);
    let wallet;
    try {
      wallet = await loadWallet(walletName, password, network);
    } catch (err) {
      return failJson(err, 'Invalid password');
    }

    const ethWei = await getProvider(network).getBalance(wallet.address);
    const rows = [];
    for (const t of tokens) {
      try {
        const balance = await getDecryptedBalance(t.address, wallet, network, {
          forceRefresh: options.refresh,
        });
        rows.push({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          balance,
          formatted: formatTokenAmount(balance, t.decimals),
        });
      } catch (err) {
        rows.push({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          balance: null,
          formatted: null,
          error: { code: jsonErrorOf(err, 'Failed').code, message: describeErrorShort(err, 200) },
        });
      }
    }
    printJson({
      wallet: walletName,
      address: wallet.address,
      network,
      eth: { wei: ethWei, formatted: formatTokenAmount(ethWei, 18) },
      tokens: rows,
    });
  } catch (err) {
    failJson(err, 'Could not load balances');
  }
}
